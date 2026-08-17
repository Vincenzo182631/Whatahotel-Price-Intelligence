/**
 * Supporting endpoints: search, room types, history, comparables, health, meta.
 */

import { dowBucketFor, leadBucketFor, seasonBandFor } from '@wahpi/core';
import {
  countStaleBaselines,
  db,
  findAnalysisByPublicId,
  findAvailableRoomTypes,
  findComparableRates,
  findHotelByWahId,
  findSameStaySeries,
  findSeriesGaps,
  loadActiveConfig,
  searchHotels,
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

export const healthHandler: Handler = async (_req, res) => {
  const { config, fromDatabase } = await loadActiveConfig();

  const { rows } = await db().query(`
    SELECT (SELECT max(finished_at) FROM ingest_batch WHERE status IN ('SUCCESS','PARTIAL')) AS last_ingest,
           (SELECT count(*) FROM rate_observation)                                           AS observations,
           (SELECT count(*) FROM rate_baseline)                                              AS baselines,
           (SELECT COALESCE(sum(rows_rejected),0)::float
                 / NULLIF(sum(rows_received),0) FROM ingest_batch
             WHERE started_at > now() - interval '24 hours')                                 AS reject_rate_24h
  `);
  const row = rows[0] ?? {};

  // Where the stored rates actually came from.
  //
  // Reported rather than left to callers to infer: the demo harness used to
  // carry a hardcoded "synthetic data" banner, which meant it went on claiming
  // no number was real after the database filled with live rates. MIXED is the
  // state that matters most — fabricated rows sitting indistinguishably beside
  // real ones (CLAUDE.md rule 7) — and it is the one nobody would think to
  // check for.
  const { rows: sourceRows } = await db().query(`
    SELECT s.code, s.display_name, s.is_synthetic, count(o.id)::bigint AS observations
      FROM source s
      LEFT JOIN rate_observation o ON o.source_id = s.id
     GROUP BY s.id, s.code, s.display_name, s.is_synthetic
     HAVING count(o.id) > 0
     ORDER BY s.code
  `);

  const sources = sourceRows.map((s) => ({
    code: s.code as string,
    display_name: s.display_name as string,
    is_synthetic: s.is_synthetic as boolean,
    observations: Number(s.observations),
  }));

  const anySynthetic = sources.some((s) => s.is_synthetic);
  const anyReal = sources.some((s) => !s.is_synthetic);
  const dataProvenance =
    anySynthetic && anyReal ? 'MIXED' : anySynthetic ? 'SYNTHETIC' : anyReal ? 'REAL' : 'EMPTY';

  const lastIngest = row.last_ingest as Date | null;
  const minutesSince =
    lastIngest === null ? null : Math.round((Date.now() - lastIngest.getTime()) / 60_000);
  const staleBaselines = await countStaleBaselines(config.baseline.maxAgeHours);

  // Stale ingest is the condition that quietly destroys correctness while every
  // service still reports healthy, so it degrades the status.
  const degraded = minutesSince === null || minutesSince > 24 * 60 || !fromDatabase;

  sendJson(res, degraded ? 503 : 200, {
    status: degraded ? 'degraded' : 'ok',
    database: 'ok',
    config_source: fromDatabase ? 'database' : 'compiled_defaults',
    ingest: {
      last_success_at: lastIngest?.toISOString() ?? null,
      minutes_since: minutesSince,
      reject_rate_24h: row.reject_rate_24h === null ? 0 : Number(row.reject_rate_24h),
    },
    data: {
      observations: Number(row.observations ?? 0),
      baselines: Number(row.baselines ?? 0),
      stale_baselines: staleBaselines,
      /** REAL | SYNTHETIC | MIXED | EMPTY — see the query above. */
      provenance: dataProvenance,
      sources,
    },
    config_version: config.version,
  });
};

export const searchHotelsHandler: Handler = async (_req, res, ctx) => {
  // `q` is optional: without it the endpoint lists hotels, which the host page
  // needs for a browsable picker rather than type-ahead.
  const raw = ctx.url.searchParams.get('q');
  const term = raw === null || raw.trim() === '' ? null : raw.trim();
  if (term !== null && term.length < 2) {
    throw new ApiError('INVALID_PARAMETER', 'q must be at least 2 characters', { value: term });
  }
  const limit = optionalInt(ctx.url, 'limit', 10, 1, 50);

  const { config } = await loadActiveConfig();
  const hotels = await searchHotels(term, limit, config.baseline.minObsAbs);
  sendJson(
    res,
    200,
    {
      query: term,
      hotels: hotels.map((h) => ({
        hotel_id: h.wahHotelId,
        name: h.name,
        brand: h.brand,
        destination: h.destination,
        luxury_tier: h.luxuryTier,
        star_rating: h.starRating,
        // Lets the UI avoid walking a customer into a guaranteed
        // INSUFFICIENT_DATA result.
        has_price_intelligence: h.hasPriceIntelligence,
      })),
    },
    cacheHeaders(300, 1800),
  );
};

export const hotelDetailHandler: Handler = async (_req, res, ctx) => {
  const hotel = await findHotelByWahId(ctx.params.hotel_id ?? '');
  if (!hotel) throw new ApiError('HOTEL_NOT_FOUND', 'No such hotel.');

  sendJson(
    res,
    200,
    {
      hotel_id: hotel.wahHotelId,
      name: hotel.name,
      brand: hotel.brand,
      destination: hotel.destination,
      luxury_tier: hotel.luxuryTier,
      star_rating: hotel.starRating,
      currency: hotel.baseCurrency,
    },
    cacheHeaders(600, 3600),
  );
};

export const roomTypesHandler: Handler = async (_req, res, ctx) => {
  const hotel = await findHotelByWahId(ctx.params.hotel_id ?? '');
  if (!hotel) throw new ApiError('HOTEL_NOT_FOUND', 'No such hotel.');

  const checkIn = requireDate(ctx.url, 'check_in');
  const checkOut = requireDate(ctx.url, 'check_out');
  const nights = nightsBetween(checkIn, checkOut);
  const adults = optionalInt(ctx.url, 'adults', 2, 1, 10);
  const children = optionalInt(ctx.url, 'children', 0, 0, 10);
  const currency = (ctx.url.searchParams.get('currency') ?? 'USD').toUpperCase();

  const { config } = await loadActiveConfig();
  const rooms = await findAvailableRoomTypes(hotel.id, checkIn, nights, adults, children, currency);

  sendJson(
    res,
    200,
    {
      hotel_id: hotel.wahHotelId,
      stay: { check_in: checkIn, check_out: checkOut, nights, adults, children },
      room_types: rooms.map((r) => ({
        room_type_id: String(r.roomTypeId),
        name: r.canonicalName,
        room_class: r.roomClass,
        nightly: money(r.nightlyMinor, currency),
        comparability_class: r.comparabilityClass,
        n_observations: r.nObservations,
        intelligence_available: r.nObservations >= config.baseline.minObsAbs,
        observed_at: r.observedAt,
      })),
    },
    cacheHeaders(300, 1800),
  );
};

export const priceHistoryHandler: Handler = async (_req, res, ctx) => {
  const hotel = await findHotelByWahId(ctx.params.hotel_id ?? '');
  if (!hotel) throw new ApiError('HOTEL_NOT_FOUND', 'No such hotel.');

  const checkIn = requireDate(ctx.url, 'check_in');
  const checkOut = requireDate(ctx.url, 'check_out');
  const nights = nightsBetween(checkIn, checkOut);
  const adults = optionalInt(ctx.url, 'adults', 2, 1, 10);
  const children = optionalInt(ctx.url, 'children', 0, 0, 10);
  const currency = (ctx.url.searchParams.get('currency') ?? 'USD').toUpperCase();
  const windowDays = optionalInt(ctx.url, 'window', 90, 1, 365);

  const rooms = await findAvailableRoomTypes(hotel.id, checkIn, nights, adults, children, currency);
  const requested = ctx.url.searchParams.get('room_type_id');
  const room =
    requested === null ? rooms[0] : rooms.find((r) => String(r.roomTypeId) === requested);
  if (!room) throw new ApiError('ROOM_TYPE_NOT_FOUND', 'No rate for this room and stay.');

  const series = await findSameStaySeries(
    {
      hotelId: hotel.id,
      roomTypeId: room.roomTypeId,
      comparabilityClass: room.comparabilityClass,
      checkIn,
      nights,
      adults,
      children,
      currency,
    },
    windowDays,
  );

  sendJson(
    res,
    200,
    {
      hotel_id: hotel.wahHotelId,
      room_type_id: String(room.roomTypeId),
      window_days: windowDays,
      currency,
      series: series.map((p) => ({
        date: p.observedAt.slice(0, 10),
        nightly_minor: p.nightlyMinor,
      })),
      gaps: findSeriesGaps(series, windowDays),
      current: series.length > 0 ? series[series.length - 1] : null,
    },
    cacheHeaders(900, 3600),
  );
};

export const comparablesHandler: Handler = async (_req, res, ctx) => {
  const hotel = await findHotelByWahId(ctx.params.hotel_id ?? '');
  if (!hotel) throw new ApiError('HOTEL_NOT_FOUND', 'No such hotel.');

  const checkIn = requireDate(ctx.url, 'check_in');
  const checkOut = requireDate(ctx.url, 'check_out');
  const nights = nightsBetween(checkIn, checkOut);
  const adults = optionalInt(ctx.url, 'adults', 2, 1, 10);
  const children = optionalInt(ctx.url, 'children', 0, 0, 10);
  const currency = (ctx.url.searchParams.get('currency') ?? 'USD').toUpperCase();
  const limit = optionalInt(ctx.url, 'limit', 6, 1, 20);

  const { config } = await loadActiveConfig();

  // Comparables are class-specific, so the endpoint needs to know which class
  // the caller means. Default to the room the analysis would have picked.
  const rooms = await findAvailableRoomTypes(hotel.id, checkIn, nights, adults, children, currency);
  const requestedClass = ctx.url.searchParams.get('comparability_class');
  const comparabilityClass = requestedClass ?? rooms[0]?.comparabilityClass;
  if (!comparabilityClass)
    throw new ApiError('NO_CURRENT_RATE', 'No available rate for these dates.');

  const comps = await findComparableRates(
    hotel.id,
    checkIn,
    nights,
    adults,
    children,
    currency,
    comparabilityClass,
    limit,
    config.rec.maxCurrentAgeHours,
  );

  sendJson(
    res,
    200,
    {
      hotel_id: hotel.wahHotelId,
      n_fresh_comps: comps.length,
      min_required: config.score.market.minComps,
      comparables: comps.map((c) => ({
        hotel_id: c.hotelId,
        name: c.hotelName,
        nightly: money(c.currentNightlyMinor, currency),
        typical_nightly: money(c.baselineMedianMinor, currency),
        discount_index: Number((c.currentNightlyMinor / c.baselineMedianMinor).toFixed(3)),
        observed_at: c.observedAt,
      })),
    },
    cacheHeaders(600, 3600),
  );
};

export const metaConfigHandler: Handler = async (_req, res) => {
  const { config, fromDatabase } = await loadActiveConfig();
  sendJson(res, 200, {
    config_version: config.version,
    source: fromDatabase ? 'database' : 'compiled_defaults',
    // The thresholds a client may legitimately need to interpret a response.
    thresholds: {
      score_bands: config.score.band,
      confidence_bands: config.confidence.band,
      book_confidence_min: config.rec.book.confidenceMin,
      min_observations: config.baseline.minObsAbs,
    },
  });
};

/** Internal: the full decision trace behind a stored analysis. */
export const analysisDebugHandler: Handler = async (_req, res, ctx) => {
  const row = await findAnalysisByPublicId(ctx.params.public_id ?? '');
  if (!row) throw new ApiError('NOT_FOUND', 'No such analysis.');

  const leadBucket =
    row.check_in instanceof Date
      ? leadBucketFor(
          Math.round((row.check_in.getTime() - (row.computed_at as Date).getTime()) / 86_400_000),
        )
      : null;

  sendJson(res, 200, {
    ...row,
    derived: {
      lead_bucket: leadBucket,
      season_band:
        row.check_in instanceof Date
          ? seasonBandFor(row.check_in.toISOString().slice(0, 10))
          : null,
      dow_bucket:
        row.check_in instanceof Date ? dowBucketFor(row.check_in.toISOString().slice(0, 10)) : null,
    },
  });
};
