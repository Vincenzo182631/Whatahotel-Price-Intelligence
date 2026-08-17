/**
 * GET /api/v1/live-intelligence — the live-market answer.
 *
 * Sibling of /price-intelligence, not a replacement. That endpoint scores a
 * rate against this hotel's accrued history; this one scores it against the
 * market as it stands today — the comp set, nearby bookable dates, and how much
 * of the comparable market is left. It needs no baseline, which is what makes
 * it usable from the first week of collection.
 *
 * ── THIS ENDPOINT DOES NOT PREDICT ────────────────────────────────────────
 *
 * Nothing in the response may state or imply a future price. `verdict:
 * "BOOK_NOW"` means "this is a good rate against today's market", never "book
 * before it goes up". Every field below is a measurement of something that
 * exists right now.
 *
 * Absent signals are reported as absent, with the reason. They are never
 * substituted with a neutral value, and a missing score is `null` rather than
 * zero — a zero renders to a customer as "terrible deal".
 */

import { liveBandLabel, liveVerdictLabel } from '@wahpi/core';
import { isLiveLoadFailure, loadActiveConfig, loadLiveIntelligence } from '@wahpi/data';

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

/**
 * Short, because the answer is only as good as the rates behind it. A cached
 * comp-set index outlives the freshness bound its own inputs were filtered on
 * if this runs long.
 */
const TTL_SECONDS = 300;

/**
 * Rounded for transport, not for computation.
 *
 * The engine works in full precision and the score is already composed by the
 * time these are read; publishing `113.60519107104696` only invites a client to
 * re-derive a band from a figure it should be reading directly.
 */
const round1 = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 10) / 10;

const round3 = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 1000) / 1000;

export const liveIntelligenceHandler: Handler = async (_req, res, ctx) => {
  const { url } = ctx;

  const wahHotelId = requireString(url, 'hotel_id');
  const checkIn = requireDate(url, 'check_in');
  const checkOut = requireDate(url, 'check_out');
  const nights = nightsBetween(checkIn, checkOut);
  const adults = optionalInt(url, 'adults', 2, 1, 10);
  const children = optionalInt(url, 'children', 0, 0, 10);
  const currency = (url.searchParams.get('currency') ?? 'USD').toUpperCase();
  const roomTypeParam = url.searchParams.get('room_type_id');

  const roomTypeId = roomTypeParam === null ? null : Number(roomTypeParam);
  if (roomTypeParam !== null && !Number.isInteger(roomTypeId)) {
    throw new ApiError('INVALID_PARAMETER', 'room_type_id must be an integer', {
      value: roomTypeParam,
    });
  }

  const { config } = await loadActiveConfig();
  const now = new Date();

  const loaded = await loadLiveIntelligence(
    { wahHotelId, checkIn, nights, adults, children, currency, roomTypeId, now },
    config,
  );

  if (isLiveLoadFailure(loaded)) {
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

  const { result, compSet, calendar, compression } = loaded;

  /**
   * The renormalized weight for a signal.
   *
   * Read from `result.signals`, NOT from the CompSetResult/CalendarResult the
   * signal came in on: composeLiveScore renormalizes into fresh objects and
   * leaves the originals untouched, so the originals still carry the
   * pre-composition `weightApplied` of 0. Reading them reported every signal as
   * contributing nothing to a score they demonstrably produced.
   */
  const applied = (code: string): number => {
    const signal = result.signals.find((s) => s.code === code);
    return round3(signal?.weightApplied ?? 0) ?? 0;
  };

  const body = {
    generated_at: now.toISOString(),
    model: 'LIVE_MARKET',
    config_version: config.version,

    subject: {
      hotel: {
        hotel_id: loaded.hotel.wahHotelId,
        name: loaded.hotel.name,
        destination: loaded.hotel.destination,
        luxury_tier: loaded.hotel.luxuryTier,
      },
      room_type: {
        room_type_id: String(loaded.roomTypeId),
        name: loaded.roomName,
        selected_by: loaded.roomSelectedBy,
        comparability_class: loaded.comparabilityClass,
      },
      stay: { check_in: checkIn, check_out: checkOut, nights, adults, children },
    },

    price: {
      nightly: money(loaded.nightlyMinor, currency),
      total: money(loaded.totalMinor, currency),
      observed_at: loaded.observedAt,
      age_hours: Math.round(loaded.rateAgeHours * 10) / 10,
    },

    verdict: {
      // Both forms: the 0–100 the engine works in and the 0–10 the customer
      // reads. Deriving the second in the client would let a rounding rule
      // drift out of step with the bands.
      score: result.score,
      out_of_ten: result.outOfTen,
      band: result.band,
      band_label: result.band === null ? null : liveBandLabel(result.band),
      verdict: result.verdict,
      verdict_label: liveVerdictLabel(result.verdict),
      // A word, not a number. See assessLiveConfidence — a two-decimal
      // confidence would invite a precision the inputs do not support.
      confidence: result.confidence,
      weight_coverage: round3(result.weightCoverage),
      reasons: result.reasons,
    },

    signals: {
      comp_set: {
        available: compSet.signal.available,
        unavailable_reason: compSet.signal.unavailableReason,
        sub_score: compSet.signal.subScore,
        weight: compSet.signal.weight,
        weight_applied: applied('S1_COMP_SET'),
        index: round1(compSet.csi),
        band: compSet.band,
        pct_below_median: round1(compSet.pctBelowMedian),
        median_competitor_nightly: money(compSet.medianCompetitorNightlyMinor, currency),
        // Named competitor rates are deliberately not returned. The counts are
        // the evidence a customer needs; the individual prices are another
        // hotel's commercial data.
        comps_used: compSet.compsUsed,
        comps_excluded: compSet.compsExcluded,
      },
      calendar: {
        available: calendar.signal.available,
        unavailable_reason: calendar.signal.unavailableReason,
        sub_score: calendar.signal.subScore,
        weight: calendar.signal.weight,
        weight_applied: applied('S2_CALENDAR'),
        delta_pct: round1(calendar.deltaPct),
        band: calendar.band,
        median_nearby_nightly: money(calendar.medianNearbyNightlyMinor, currency),
        neighbours_used: calendar.neighboursUsed,
        // Whether the comparison held day-of-week fixed. A customer asking
        // about a Thursday deserves to know if we measured it against weekends.
        same_weekday_only: calendar.sameDowOnly,
        window_days: config.live.calendar.windowDays,
      },
      compression: {
        available: compression.signal.available,
        unavailable_reason: compression.signal.unavailableReason,
        sub_score: compression.signal.subScore,
        weight: compression.signal.weight,
        weight_applied: applied('S3_COMPRESSION'),
        sold_out_share: round3(compression.soldOutShare),
        band: compression.band,
        checked: compression.checked,
        sold_out: compression.soldOut,
      },
    },
  };

  sendJson(res, 200, body, {
    ...cacheHeaders(TTL_SECONDS, TTL_SECONDS * 2),
    'x-request-id': ctx.requestId,
  });
};
