/**
 * Ingest pipeline: validate → normalize → classify → persist.
 *
 * Validation REJECTS rather than coerces. A silently-coerced bad row is worse
 * than a missing one: it enters a baseline and quietly moves every score built
 * on it, with nothing in the data to show it happened. Rejects are stored with
 * their raw payload and a reason code.
 */

import {
  classifyComparability,
  dowBucketFor,
  extractAttributes,
  matchRoomType,
  normalizeRoomName,
  seasonBandFor,
  type MatchOptions,
  type MealPlan,
  type RateAudience,
  type RefundPolicy,
  type RoomTypeCandidate,
} from '@wahpi/core';
import { db, type Queryable } from '@wahpi/data';

import type { RawRateRecord } from '../adapters/RateSourceAdapter.js';

export interface IngestOptions {
  readonly sourceCode: string;
  readonly captureSlotMinutes: number;
  /** Observations must fall within this many nights. */
  readonly maxNights: number;
  /** Reject a rate more than this multiple away from the hotel's known level. */
  readonly sanityBandMultiple: number;
  /**
   * Create a canonical `room_type` the first time a source room code is seen.
   *
   * The matching ladder (docs/mvp/01 §3) resolves a raw room string against the
   * room types a hotel already has. It does not say where the first one comes
   * from — and on a cold start there are none, so every rate is UNMATCHED and
   * nothing is ever collected. Discovery closes that gap.
   *
   * Requires a source room code (U9). Without one there is no stable identity
   * to key on, and creating a room type per raw marketing string would fragment
   * the very baselines §3 exists to protect — so those stay UNMATCHED and go to
   * the reject queue for review.
   *
   * Discovery runs only AFTER the full ladder has failed, so an existing room
   * type is always preferred to a new one.
   */
  readonly discoverRoomTypes: boolean;
  /**
   * Tuning for the room-type matching ladder (docs/mvp/01 §3).
   *
   * Sources that emit machine-generated, stable room names should raise
   * `fuzzyMinSimilarity` close to 1, which leaves the exact and source-code
   * steps in place and disables fuzzy merging. Measured on live WhataHotel
   * data at the default 0.45: a Presidential Suite merged with a Corner
   * Suite, and Bayfront with Cityscape, because the names share a long
   * boilerplate tail and differ by one word. Fuzzy matching earns its place
   * against human-typed names, not against these.
   */
  readonly roomMatch?: MatchOptions;
}

export const DEFAULT_INGEST_OPTIONS: IngestOptions = {
  sourceCode: 'SYNTHETIC_DEV',
  captureSlotMinutes: 60,
  maxNights: 30,
  sanityBandMultiple: 8,
  discoverRoomTypes: false,
};

export interface IngestResult {
  readonly batchId: number;
  readonly received: number;
  readonly inserted: number;
  readonly duplicate: number;
  readonly rejected: number;
  readonly rejectReasons: Record<string, number>;
  /** Room types created by discovery in this batch. Non-zero only on cold start. */
  readonly discoveredRoomTypes: number;
}

export type RejectReason =
  | 'UNKNOWN_HOTEL'
  | 'MISSING_ROOM_NAME'
  | 'NON_POSITIVE_AMOUNT'
  | 'MISSING_CURRENCY'
  | 'CHECK_IN_IN_PAST'
  | 'NIGHTS_OUT_OF_RANGE'
  | 'OCCUPANCY_OUT_OF_RANGE'
  | 'UNMATCHED_ROOM_TYPE'
  | 'IMPLAUSIBLE_AMOUNT';

export function validateRecord(
  record: RawRateRecord,
  observedDate: string,
  options: IngestOptions,
): RejectReason | null {
  if (!record.rawRoomName || record.rawRoomName.trim() === '') return 'MISSING_ROOM_NAME';
  if (!Number.isFinite(record.totalAmountMinor) || record.totalAmountMinor <= 0) {
    return 'NON_POSITIVE_AMOUNT';
  }
  if (!record.currency || record.currency.length !== 3) return 'MISSING_CURRENCY';
  if (record.nights < 1 || record.nights > options.maxNights) return 'NIGHTS_OUT_OF_RANGE';
  if (record.adults < 1 || record.adults > 10) return 'OCCUPANCY_OUT_OF_RANGE';
  if (record.children < 0 || record.children > 10) return 'OCCUPANCY_OUT_OF_RANGE';

  // Matches the DB constraint; one day of slack for timezone edges.
  const leadDays =
    (Date.parse(`${record.checkIn}T00:00:00Z`) - Date.parse(`${observedDate}T00:00:00Z`)) /
    86_400_000;
  if (leadDays < -1) return 'CHECK_IN_IN_PAST';

  return null;
}

export function observationSlot(observedAt: string, slotMinutes: number): string {
  const ms = Date.parse(observedAt);
  const slotMs = slotMinutes * 60_000;
  return new Date(Math.floor(ms / slotMs) * slotMs).toISOString();
}

interface HotelContext {
  readonly hotelId: number;
  readonly candidates: RoomTypeCandidate[];
  readonly roomTypeIdByKey: Map<string, number>;
}

async function loadHotelContext(hotelId: number, q?: Queryable): Promise<HotelContext> {
  const { rows } = await db(q).query(
    `SELECT rt.id, rt.normalized_name, rt.room_class, rt.view_type,
            COALESCE(array_agg(DISTINCT a.source_room_code)
                     FILTER (WHERE a.source_room_code IS NOT NULL), '{}') AS source_codes,
            COALESCE(array_agg(DISTINCT a.normalized_value)
                     FILTER (WHERE a.normalized_value IS NOT NULL), '{}') AS aliases
       FROM room_type rt
       LEFT JOIN room_type_alias a ON a.room_type_id = rt.id
      WHERE rt.hotel_id = $1 AND rt.is_active
      GROUP BY rt.id, rt.normalized_name, rt.room_class, rt.view_type`,
    [hotelId],
  );

  const candidates: RoomTypeCandidate[] = rows.map((row) => ({
    roomTypeId: String(row.id),
    normalizedName: row.normalized_name as string,
    roomClass: row.room_class as RoomTypeCandidate['roomClass'],
    // Blocks an OCEANFRONT/CITY merge in the same way room_class blocks
    // ROOM/SUITE. Omitting it would silently make that rule permissive.
    view: row.view_type as RoomTypeCandidate['view'],
    sourceCodes: row.source_codes as string[],
    aliases: row.aliases as string[],
  }));

  return {
    hotelId,
    candidates,
    roomTypeIdByKey: new Map(rows.map((r) => [String(r.id), r.id as number])),
  };
}

/**
 * Create the canonical `room_type` for a source room code seen for the first
 * time, and register the code as a confirmed alias so it resolves by SOURCE_ID
 * from now on.
 *
 * Returns null when nothing was created — either the hotel already had a room
 * type under this normalized name (a race, or two codes for one name), or the
 * raw name normalizes to nothing.
 *
 * The mutation of `context` is deliberate: a single batch typically carries
 * several rates for the same new room, and without it each one would try to
 * create the room type again.
 */
async function discoverRoomType(
  record: RawRateRecord,
  hotelId: number,
  sourceId: number,
  context: HotelContext,
  q?: Queryable,
): Promise<number | null> {
  const normalized = normalizeRoomName(record.rawRoomName);
  if (!normalized) return null;

  const attributes = extractAttributes(normalized);

  const { rows } = await db(q).query(
    `INSERT INTO room_type (hotel_id, canonical_name, normalized_name,
                            room_class, bed_config, view_type)
     VALUES ($1,$2,$3,$4::room_class_t,$5::bed_config_t,$6::view_t)
     ON CONFLICT (hotel_id, normalized_name) DO UPDATE SET is_active = true
     RETURNING id`,
    [
      hotelId,
      // canonical_name is customer-facing; rawRoomName is the matching key.
      (record.displayRoomName ?? record.rawRoomName).trim(),
      normalized,
      attributes.roomClass,
      attributes.bedConfig,
      attributes.view,
    ],
  );
  const roomTypeId = rows[0]?.id as number | undefined;
  if (!roomTypeId) return null;

  // Confirmed, not provisional: the code came from the source itself, so there
  // is no human judgement to defer. This is the SOURCE_ID path, not a guess.
  await db(q).query(
    `INSERT INTO room_type_alias (hotel_id, room_type_id, source_id, raw_value,
                                  normalized_value, source_room_code, match_method,
                                  match_confidence, is_confirmed)
     VALUES ($1,$2,$3,$4,$5,$6,'SOURCE_ID',1.00,true)
     ON CONFLICT (hotel_id, source_id, normalized_value)
       DO UPDATE SET source_room_code = COALESCE(room_type_alias.source_room_code,
                                                 EXCLUDED.source_room_code)`,
    [hotelId, roomTypeId, sourceId, record.rawRoomName, normalized, record.sourceRoomCode ?? null],
  );

  const key = String(roomTypeId);
  const existing = context.candidates.find((c) => c.roomTypeId === key);
  if (existing) {
    // Same room type, additional source code — extend rather than duplicate.
    if (record.sourceRoomCode && !existing.sourceCodes?.includes(record.sourceRoomCode)) {
      (existing.sourceCodes as string[]).push(record.sourceRoomCode);
    }
  } else {
    context.candidates.push({
      roomTypeId: key,
      normalizedName: normalized,
      roomClass: attributes.roomClass,
      view: attributes.view,
      sourceCodes: record.sourceRoomCode ? [record.sourceRoomCode] : [],
      aliases: [normalized],
    });
    context.roomTypeIdByKey.set(key, roomTypeId);
  }

  return roomTypeId;
}

/**
 * Rate plans are slow-changing reference data, but a naive implementation
 * upserts one per observation. Cached per batch keyed by (hotel, plan code),
 * which is the difference between a seed run taking seconds and minutes.
 */
type RatePlanCache = Map<string, { ratePlanId: number; comparabilityClass: string }>;

async function resolveRatePlan(
  hotelId: number,
  sourceId: number,
  record: RawRateRecord,
  cache: RatePlanCache,
  q?: Queryable,
): Promise<{ ratePlanId: number; comparabilityClass: string }> {
  const cacheKey = `${hotelId}|${record.sourcePlanCode ?? 'DEFAULT'}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const terms = {
    mealPlan: (record.mealPlan ?? 'UNKNOWN') as MealPlan,
    refundPolicy: (record.refundPolicy ?? 'UNKNOWN') as RefundPolicy,
    audience: (record.audience ?? 'UNKNOWN') as RateAudience,
  };
  // A source-supplied class wins over the semantic one: it is used precisely
  // when the source knows its rate plans are distinct but does not tell us why.
  const semantic = classifyComparability(terms);
  const comparabilityClass = record.comparabilityClassOverride ?? semantic.comparabilityClass;

  const { rows } = await db(q).query(
    `INSERT INTO rate_plan (hotel_id, source_id, source_plan_code, display_name,
                            meal_plan, refund_policy, is_prepaid, audience, comparability_class)
     VALUES ($1,$2,$3,$4,$5::meal_plan_t,$6::refund_policy_t,$7,$8::rate_audience_t,$9)
     ON CONFLICT (hotel_id, source_id, source_plan_code)
       DO UPDATE SET meal_plan = EXCLUDED.meal_plan,
                     refund_policy = EXCLUDED.refund_policy,
                     audience = EXCLUDED.audience,
                     comparability_class = EXCLUDED.comparability_class
     RETURNING id`,
    [
      hotelId,
      sourceId,
      record.sourcePlanCode ?? 'DEFAULT',
      record.rawPlanName ?? null,
      terms.mealPlan,
      terms.refundPolicy,
      record.isPrepaid ?? null,
      terms.audience,
      comparabilityClass,
    ],
  );

  const resolved = { ratePlanId: rows[0]?.id as number, comparabilityClass };
  cache.set(cacheKey, resolved);
  return resolved;
}

export async function ingestRecords(
  records: readonly RawRateRecord[],
  options: IngestOptions = DEFAULT_INGEST_OPTIONS,
  q?: Queryable,
): Promise<IngestResult> {
  const client = db(q);

  const { rows: sourceRows } = await client.query('SELECT id FROM source WHERE code = $1', [
    options.sourceCode,
  ]);
  const sourceId = sourceRows[0]?.id as number;
  if (!sourceId) throw new Error(`Unknown source code: ${options.sourceCode}`);

  const { rows: batchRows } = await client.query(
    'INSERT INTO ingest_batch (source_id, rows_received) VALUES ($1,$2) RETURNING id',
    [sourceId, records.length],
  );
  const batchId = batchRows[0]?.id as number;

  const { rows: hotelRows } = await client.query(
    'SELECT id, wah_hotel_id FROM hotel WHERE is_active',
  );
  const hotelIdByWahId = new Map<string, number>(
    hotelRows.map((r) => [r.wah_hotel_id as string, r.id as number]),
  );

  const contexts = new Map<number, HotelContext>();
  const ratePlanCache: RatePlanCache = new Map();
  const rejectReasons: Record<string, number> = {};
  let inserted = 0;
  let duplicate = 0;
  let rejected = 0;
  let discoveredRoomTypes = 0;

  const reject = async (record: RawRateRecord, reason: RejectReason): Promise<void> => {
    rejected += 1;
    rejectReasons[reason] = (rejectReasons[reason] ?? 0) + 1;
    await client.query(
      'INSERT INTO ingest_reject (ingest_batch_id, reason_code, raw) VALUES ($1,$2,$3)',
      [batchId, reason, JSON.stringify(record.raw ?? record)],
    );
  };

  for (const record of records) {
    const observedDate = record.observedAt.slice(0, 10);

    const validationError = validateRecord(record, observedDate, options);
    if (validationError) {
      await reject(record, validationError);
      continue;
    }

    const hotelId = hotelIdByWahId.get(record.wahHotelId);
    if (!hotelId) {
      await reject(record, 'UNKNOWN_HOTEL');
      continue;
    }

    let context = contexts.get(hotelId);
    if (!context) {
      context = await loadHotelContext(hotelId, q);
      contexts.set(hotelId, context);
    }

    let match = matchRoomType(
      record.rawRoomName,
      context.candidates,
      options.roomMatch ?? {},
      record.sourceRoomCode ?? null,
    );

    if (match.roomTypeId === null && options.discoverRoomTypes && record.sourceRoomCode) {
      const discovered = await discoverRoomType(record, hotelId, sourceId, context, q);
      if (discovered) {
        discoveredRoomTypes += 1;
        // Re-run the ladder rather than assuming the new row: it now resolves
        // via SOURCE_ID at confidence 1.00, and the match_method stored on the
        // observation stays the one the ladder actually produced.
        match = matchRoomType(
          record.rawRoomName,
          context.candidates,
          {},
          record.sourceRoomCode ?? null,
        );
      }
    }

    if (match.roomTypeId === null) {
      // Stored as a reject rather than as an UNMATCHED observation: an
      // observation with no room type cannot enter any baseline anyway, and a
      // reject row carries the reason and the payload for review.
      await reject(record, 'UNMATCHED_ROOM_TYPE');
      continue;
    }

    const roomTypeId = context.roomTypeIdByKey.get(match.roomTypeId);
    if (!roomTypeId) {
      await reject(record, 'UNMATCHED_ROOM_TYPE');
      continue;
    }

    // Learn the alias so the next capture upgrades to ALIAS_EXACT.
    if (match.method === 'ALIAS_FUZZY' || match.method === 'ATTRIBUTE_INFERRED') {
      await client.query(
        `INSERT INTO room_type_alias (hotel_id, room_type_id, source_id, raw_value,
                                      normalized_value, source_room_code, match_method,
                                      match_confidence, is_confirmed)
         VALUES ($1,$2,$3,$4,$5,$6,$7::match_method_t,$8,false)
         ON CONFLICT (hotel_id, source_id, normalized_value)
           DO UPDATE SET times_seen = room_type_alias.times_seen + 1`,
        [
          hotelId,
          roomTypeId,
          sourceId,
          record.rawRoomName,
          normalizeRoomName(record.rawRoomName),
          record.sourceRoomCode ?? null,
          match.method,
          match.confidence,
        ],
      );
    }

    const { ratePlanId, comparabilityClass } = await resolveRatePlan(
      hotelId,
      sourceId,
      record,
      ratePlanCache,
      q,
    );

    const checkOut = new Date(
      Date.parse(`${record.checkIn}T00:00:00Z`) + record.nights * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);

    const { rowCount } = await client.query(
      `INSERT INTO rate_observation (
          observed_at, source_id, hotel_id, room_type_id, rate_plan_id,
          check_in, nights, check_out, adults, children,
          currency, total_amount_minor, total_gross_amount_minor, taxes_fees_minor,
          tax_basis, observed_date, observation_slot, stay_dow_bucket, stay_season_band,
          rooms_left, is_available, match_method, match_confidence,
          comparability_class, ingest_batch_id, raw
       ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
          $15::tax_basis_t,$16,$17,$18::dow_bucket_t,$19::season_band_t,
          $20,$21,$22::match_method_t,$23,$24,$25,$26
       )
       ON CONFLICT DO NOTHING`,
      [
        record.observedAt,
        sourceId,
        hotelId,
        roomTypeId,
        ratePlanId,
        record.checkIn,
        record.nights,
        checkOut,
        record.adults,
        record.children,
        record.currency,
        record.totalAmountMinor,
        record.totalGrossAmountMinor ?? null,
        record.taxesFeesMinor ?? null,
        record.taxBasis,
        observedDate,
        observationSlot(record.observedAt, options.captureSlotMinutes),
        dowBucketFor(record.checkIn),
        seasonBandFor(record.checkIn),
        record.roomsLeft ?? null,
        record.isAvailable,
        match.method,
        match.confidence,
        comparabilityClass,
        batchId,
        JSON.stringify(record.raw ?? {}),
      ],
    );

    if ((rowCount ?? 0) > 0) inserted += 1;
    else duplicate += 1;
  }

  await client.query(
    `UPDATE ingest_batch
        SET finished_at = now(), rows_inserted = $2, rows_duplicate = $3,
            rows_rejected = $4, status = $5
      WHERE id = $1`,
    [batchId, inserted, duplicate, rejected, rejected > 0 ? 'PARTIAL' : 'SUCCESS'],
  );

  return {
    batchId,
    received: records.length,
    inserted,
    duplicate,
    rejected,
    rejectReasons,
    discoveredRoomTypes,
  };
}
