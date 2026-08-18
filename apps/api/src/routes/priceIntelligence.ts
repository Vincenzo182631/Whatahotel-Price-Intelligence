/**
 * GET /api/v1/price-intelligence — the analysis. The product.
 *
 * Reads STORED observations and one precomputed baseline row. It never calls a
 * rate source synchronously: that is what keeps p95 latency flat as the fact
 * table grows and decouples external API cost from traffic (docs/mvp/06 §2).
 */

import { analyze } from '@wahpi/core';
import {
  isLoadFailure,
  loadActiveConfig,
  loadScoringInput,
  newPublicId,
  persistAnalysis,
} from '@wahpi/data';

import {
  ApiError,
  cacheHeaders,
  money,
  nightsBetween,
  optionalInt,
  requireDate,
  requireString,
  sendJson,
  type Handler,
} from '../http.js';

export const priceIntelligenceHandler: Handler = async (_req, res, ctx) => {
  const { url } = ctx;

  const wahHotelId = requireString(url, 'hotel_id');
  const checkIn = requireDate(url, 'check_in');
  const checkOut = requireDate(url, 'check_out');
  const nights = nightsBetween(checkIn, checkOut);
  const adults = optionalInt(url, 'adults', 2, 1, 10);
  const children = optionalInt(url, 'children', 0, 0, 10);
  const currency = (url.searchParams.get('currency') ?? 'USD').toUpperCase();
  const roomTypeParam = url.searchParams.get('room_type_id');
  const include = new Set((url.searchParams.get('include') ?? 'explanation').split(','));

  const roomTypeId = roomTypeParam === null ? null : Number(roomTypeParam);
  if (roomTypeParam !== null && !Number.isInteger(roomTypeId)) {
    throw new ApiError('INVALID_PARAMETER', 'room_type_id must be an integer', {
      value: roomTypeParam,
    });
  }

  const { config } = await loadActiveConfig();

  const loaded = await loadScoringInput(
    { wahHotelId, checkIn, nights, adults, children, currency, roomTypeId },
    config,
  );

  if (isLoadFailure(loaded)) {
    switch (loaded.kind) {
      case 'HOTEL_NOT_FOUND':
        throw new ApiError('HOTEL_NOT_FOUND', 'No such hotel.', { hotel_id: wahHotelId });
      case 'ROOM_TYPE_NOT_FOUND':
        throw new ApiError('ROOM_TYPE_NOT_FOUND', 'No such room type for this hotel.', {
          room_type_id: roomTypeParam,
        });
      case 'NO_CURRENT_RATE':
        throw new ApiError('NO_CURRENT_RATE', 'No available rate for these dates.', {
          hotel_id: wahHotelId,
          check_in: checkIn,
        });
    }
  }

  const { analysis, bundle, explanation } = analyze(loaded.input, config);

  const publicId = newPublicId();
  // Persisted for reproducibility and for the calibration runbook. A failure to
  // record must not deny the customer an answer they can already see.
  let persisted = true;
  try {
    await persistAnalysis({
      publicId,
      hotelId: loaded.hotel.id,
      roomTypeId: loaded.roomTypeId,
      ratePlanId: loaded.ratePlanId,
      analysis,
      bundle,
    });
  } catch (err) {
    persisted = false;
    console.error(`[${ctx.requestId}] failed to persist analysis:`, (err as Error).message);
  }

  const cur = analysis.query.currency;
  const insufficient = analysis.recommendation === 'INSUFFICIENT_DATA';

  const body: Record<string, unknown> = {
    analysis_id: publicId,
    generated_at: new Date().toISOString(),
    persisted,

    subject: {
      hotel: {
        hotel_id: loaded.hotel.wahHotelId,
        name: loaded.hotel.name,
        destination: loaded.hotel.destination,
        luxury_tier: loaded.hotel.luxuryTier,
      },
      room_type: {
        room_type_id: String(loaded.roomTypeId),
        name: analysis.query.roomTypeName,
        selected_by: loaded.roomSelectedBy,
      },
      rate_plan: {
        summary: loaded.rateTerms,
        comparability_class: analysis.query.comparabilityClass,
      },
      stay: {
        check_in: checkIn,
        check_out: checkOut,
        nights,
        adults,
        children,
        lead_time_days: (analysis.decisionTrace as Record<string, unknown>).leadTimeDays,
      },
    },

    price: {
      nightly: money(analysis.currentNightlyMinor, cur),
      total: money(analysis.currentTotalMinor, cur),
      effective_nightly: money(analysis.effectiveNightlyMinor, cur),
      benefit_value_per_night: money(analysis.benefitValuePerNightMinor, cur),
      tax_basis: loaded.input.current.taxBasis,
      observed_at: analysis.dataAsOf,
    },

    verdict: {
      deal_score: analysis.dealScore,
      deal_score_band: analysis.dealScoreBand,
      confidence: analysis.confidence,
      confidence_band: analysis.confidenceBand,
      recommendation: analysis.recommendation,
      recommendation_label: LABELS[analysis.recommendation],
      // Which gate fired: the UI uses it to explain WHY, and "good rate and
      // rising" (G3) is a materially different message from "excellent rate" (G2).
      gate_fired: analysis.gateFired,
    },

    baseline: {
      level: analysis.baseline.level,
      lookback_days: analysis.baseline.lookbackDays,
      n_observations: analysis.baseline.nObservations,
      typical_nightly: money(analysis.baseline.typicalNightlyMinor, cur),
      lowest_observed: money(analysis.baseline.lowestMinor, cur),
      highest_observed: money(analysis.baseline.highestMinor, cur),
      p10: money(analysis.baseline.p10Minor, cur),
      p90: money(analysis.baseline.p90Minor, cur),
      percentile_rank:
        analysis.baseline.percentileRank === null
          ? null
          : Math.round(analysis.baseline.percentileRank * 100),
      pct_below_typical:
        analysis.baseline.pctBelowTypical === null
          ? null
          : Number(analysis.baseline.pctBelowTypical.toFixed(1)),
    },

    factors: analysis.factors.map((f) => ({
      code: f.code,
      name: f.name,
      available: f.available,
      sub_score: f.subScore,
      weight: f.weight,
      weight_applied: Number(f.weightApplied.toFixed(4)),
      value: f.rawValue === null ? null : Number(f.rawValue.toFixed(2)),
      unit: f.unit,
      unavailable_reason: f.unavailableReason,
    })),

    reasons: bundle.factors.map((r) => ({
      code: r.code,
      direction: r.direction,
      text: r.fact,
    })),
    caveats: bundle.caveats.map((c) => ({ code: c.code, text: c.text })),

    data_as_of: analysis.dataAsOf,
    config_version: analysis.configVersion,
    engine_version: analysis.engineVersion,
  };

  if (include.has('explanation')) {
    body.explanation = { text: explanation.text, generator: explanation.generator };
  }

  if (include.has('history')) {
    body.history = {
      granularity: 'DAILY',
      series: loaded.input.series.map((p) => ({
        date: p.observedAt.slice(0, 10),
        nightly_minor: p.nightlyMinor,
      })),
      // Explicit, so the chart breaks the line rather than inventing history.
      gaps: loaded.seriesGaps,
      reference: {
        typical: money(analysis.baseline.typicalNightlyMinor, cur),
        p10: money(analysis.baseline.p10Minor, cur),
        p90: money(analysis.baseline.p90Minor, cur),
      },
    };
  }

  if (include.has('comparables')) {
    body.comparables = {
      n_fresh_comps: loaded.compCount,
      min_required: config.score.market.minComps,
      hotels: loaded.input.comparables.map((c) => ({
        hotel_id: c.hotelId,
        name: c.hotelName,
        nightly: money(c.currentNightlyMinor, cur),
        typical_nightly: money(c.baselineMedianMinor, cur),
        discount_index: Number((c.currentNightlyMinor / c.baselineMedianMinor).toFixed(3)),
        observed_at: c.observedAt,
      })),
    };
  }

  // INSUFFICIENT_DATA is cached for less time than a scored result: it should
  // recover as data arrives, and a long TTL would hold the customer on a stale
  // "we don't know" after we do.
  const ttl = insufficient
    ? Number(process.env.API_INSUFFICIENT_TTL ?? 300)
    : Number(process.env.API_CACHE_TTL ?? 900);

  sendJson(res, 200, body, {
    ...cacheHeaders(ttl, ttl * 4),
    'x-request-id': ctx.requestId,
  });
};

const LABELS: Record<string, string> = {
  BOOK_NOW: 'Book now',
  CONSIDER: 'Worth considering',
  INSUFFICIENT_DATA: 'Not enough data yet',
};
