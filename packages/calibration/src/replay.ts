/**
 * Point-in-time replay.
 *
 * Reconstructs what the engine WOULD have seen at a past moment, using only
 * observations captured on or before it, then lets the caller compare that
 * verdict against what the price actually did afterwards. This is what makes
 * calibration a measurement rather than an opinion.
 *
 * It is possible only because `rate_observation` is append-only with a capture
 * timestamp — the reason doc 01 §5 insists on that is precisely this.
 *
 * Two honest approximations, both flagged in the returned metadata:
 *  - benefits and demand context are read at their CURRENT values, not as of the
 *    replay instant. Both are slow-changing reference data with no history
 *    table, so a true as-of read is not available.
 *  - the comparable SET is today's; only the comparables' RATES are as-of.
 */

import {
  BASELINE_LEVELS,
  buildDistribution,
  classifyComparability,
  dowBucketFor,
  leadBucketFor,
  seasonBandFor,
  selectBaselineLevel,
  type BaselineDistribution,
  type BaselineLevel,
  type ComparableRate,
  type DistributionObservation,
  type MatchMethod,
  type MealPlan,
  type RateAudience,
  type RefundPolicy,
  type ScoringConfig,
  type ScoringInput,
  type SeriesPoint,
  type TaxBasis,
} from '@wahpi/core';
import { db, findBenefits, findDemand, type Queryable } from '@wahpi/data';

export interface ReplayTarget {
  readonly hotelId: number;
  readonly wahHotelId: string;
  readonly hotelName: string;
  readonly destinationId: number | null;
  readonly roomTypeId: number;
  readonly roomTypeName: string;
  readonly comparabilityClass: string;
  readonly checkIn: string;
  readonly nights: number;
  readonly adults: number;
  readonly children: number;
  readonly currency: string;
}

export interface ReplayResult {
  readonly input: ScoringInput;
  readonly asOf: Date;
  readonly approximations: readonly string[];
}

interface PoolRow {
  readonly roomTypeId: number;
  readonly nightlyMinor: number;
  readonly matchConfidence: number;
  readonly sourceId: number;
  readonly comparabilityClass: string;
  readonly seasonBand: string;
  readonly dowBucket: string;
  readonly leadTimeDays: number;
}

/**
 * Candidate stays worth replaying: those with enough captured history on both
 * sides of a replay point to produce a verdict AND an outcome.
 */
export async function sampleReplayTargets(
  limit: number,
  minObservations: number,
  q?: Queryable,
): Promise<ReplayTarget[]> {
  const { rows } = await db(q).query(
    `SELECT o.hotel_id, h.wah_hotel_id, h.name AS hotel_name, h.destination_id,
            o.room_type_id, rt.canonical_name AS room_name,
            o.comparability_class, o.check_in, o.nights, o.adults, o.children,
            o.currency, count(*)::int AS n_observations,
            min(o.observed_at) AS first_observed, max(o.observed_at) AS last_observed
       FROM rate_observation o
       JOIN hotel h     ON h.id = o.hotel_id
       JOIN room_type rt ON rt.id = o.room_type_id
      WHERE o.is_available AND o.room_type_id IS NOT NULL
        AND o.comparability_class <> 'UNRESOLVED'
      GROUP BY o.hotel_id, h.wah_hotel_id, h.name, h.destination_id,
               o.room_type_id, rt.canonical_name, o.comparability_class,
               o.check_in, o.nights, o.adults, o.children, o.currency
     HAVING count(*) >= $2
        -- Needs a real span of capture history, or there is no "before" and
        -- "after" to replay between.
        AND max(o.observed_at) - min(o.observed_at) > interval '10 days'
      ORDER BY count(*) DESC, o.hotel_id, o.check_in
      LIMIT $1`,
    [limit, minObservations],
  );

  return rows.map((r) => ({
    hotelId: r.hotel_id as number,
    wahHotelId: r.wah_hotel_id as string,
    hotelName: r.hotel_name as string,
    destinationId: (r.destination_id as number) ?? null,
    roomTypeId: r.room_type_id as number,
    roomTypeName: r.room_name as string,
    comparabilityClass: r.comparability_class as string,
    checkIn: (r.check_in as Date).toISOString().slice(0, 10),
    nights: r.nights as number,
    adults: r.adults as number,
    children: r.children as number,
    currency: r.currency as string,
  }));
}

/** Capture instants at which this stay could be replayed, oldest first. */
export async function replayPointsFor(target: ReplayTarget, q?: Queryable): Promise<Date[]> {
  const { rows } = await db(q).query(
    `SELECT DISTINCT observed_date FROM rate_observation
      WHERE hotel_id = $1 AND room_type_id = $2 AND comparability_class = $3
        AND check_in = $4 AND nights = $5 AND adults = $6 AND children = $7
        AND currency = $8 AND is_available
      ORDER BY observed_date`,
    [
      target.hotelId,
      target.roomTypeId,
      target.comparabilityClass,
      target.checkIn,
      target.nights,
      target.adults,
      target.children,
      target.currency,
    ],
  );
  // End of day, so a replay point includes everything captured that day.
  return rows.map(
    (r) => new Date(`${(r.observed_date as Date).toISOString().slice(0, 10)}T23:59:59Z`),
  );
}

export async function replayAt(
  target: ReplayTarget,
  asOf: Date,
  config: ScoringConfig,
  q?: Queryable,
): Promise<ReplayResult | null> {
  const client = db(q);
  const asOfIso = asOf.toISOString();

  // ── the current rate as it stood at asOf ────────────────────────────────
  const { rows: currentRows } = await client.query(
    `SELECT o.*, rp.meal_plan, rp.refund_policy, rp.audience, rp.id AS plan_id,
            NOT EXISTS (
              SELECT 1 FROM rate_observation f
                JOIN rate_plan frp ON frp.id = f.rate_plan_id
               WHERE f.hotel_id = o.hotel_id AND f.room_type_id = o.room_type_id
                 AND f.check_in = o.check_in AND f.nights = o.nights
                 AND f.adults = o.adults AND f.children = o.children
                 AND f.observed_at <= $9 AND f.is_available
                 AND frp.refund_policy = 'REFUNDABLE'
            ) AS only_non_refundable
       FROM rate_observation o
       JOIN rate_plan rp ON rp.id = o.rate_plan_id
      WHERE o.hotel_id = $1 AND o.room_type_id = $2 AND o.comparability_class = $3
        AND o.check_in = $4 AND o.nights = $5 AND o.adults = $6 AND o.children = $7
        AND o.currency = $8 AND o.is_available AND o.observed_at <= $9
      ORDER BY o.observed_at DESC
      LIMIT 1`,
    [
      target.hotelId,
      target.roomTypeId,
      target.comparabilityClass,
      target.checkIn,
      target.nights,
      target.adults,
      target.children,
      target.currency,
      asOfIso,
    ],
  );

  const current = currentRows[0];
  if (!current) return null;

  // A replay whose stay has already begun is meaningless — the engine would
  // never have been asked.
  const asOfDate = asOfIso.slice(0, 10);
  const leadTimeDays = Math.round(
    (Date.parse(`${target.checkIn}T00:00:00Z`) - Date.parse(`${asOfDate}T00:00:00Z`)) / 86_400_000,
  );
  if (leadTimeDays < 0) return null;

  // ── the observation pool, subject room plus siblings for the L4 rung ────
  const { rows: siblingRows } = await client.query(
    `SELECT sib.id FROM room_type rt
       JOIN room_type sib ON sib.hotel_id = rt.hotel_id
                         AND sib.room_class = rt.room_class
                         AND sib.id <> rt.id AND sib.is_active
      WHERE rt.id = $1`,
    [target.roomTypeId],
  );
  const siblingIds = siblingRows.map((r) => r.id as number);

  const { rows: poolRows } = await client.query(
    `SELECT room_type_id, nightly_amount_minor, match_confidence, source_id,
            comparability_class, stay_season_band, stay_dow_bucket, lead_time_days
       FROM rate_observation
      WHERE hotel_id = $1 AND comparability_class = $2 AND currency = $3
        AND is_available AND match_confidence >= $4
        AND observed_at <= $5
        AND observed_at > $5::timestamptz - ($6 || ' days')::interval
        AND (room_type_id = $7 OR room_type_id = ANY($8::bigint[]))`,
    [
      target.hotelId,
      target.comparabilityClass,
      target.currency,
      config.rec.matchMin,
      asOfIso,
      config.score.lookbackDays,
      target.roomTypeId,
      siblingIds,
    ],
  );

  const pool: PoolRow[] = poolRows.map((r) => ({
    roomTypeId: r.room_type_id as number,
    nightlyMinor: r.nightly_amount_minor as number,
    matchConfidence: r.match_confidence as number,
    sourceId: r.source_id as number,
    comparabilityClass: r.comparability_class as string,
    seasonBand: r.stay_season_band as string,
    dowBucket: r.stay_dow_bucket as string,
    leadTimeDays: r.lead_time_days as number,
  }));

  const baseline = buildLadder(pool, target, leadTimeDays, config, asOfIso);

  // ── same-stay series, one point per capture day ─────────────────────────
  const { rows: seriesRows } = await client.query(
    `SELECT DISTINCT ON (observed_date) observed_at, nightly_amount_minor
       FROM rate_observation
      WHERE hotel_id = $1 AND room_type_id = $2 AND comparability_class = $3
        AND check_in = $4 AND nights = $5 AND adults = $6 AND children = $7
        AND currency = $8 AND is_available AND observed_at <= $9
        AND observed_at > $9::timestamptz - ($10 || ' days')::interval
      ORDER BY observed_date, observed_at DESC`,
    [
      target.hotelId,
      target.roomTypeId,
      target.comparabilityClass,
      target.checkIn,
      target.nights,
      target.adults,
      target.children,
      target.currency,
      asOfIso,
      config.score.lookbackDays,
    ],
  );
  const series: SeriesPoint[] = seriesRows.map((r) => ({
    observedAt: (r.observed_at as Date).toISOString(),
    nightlyMinor: r.nightly_amount_minor as number,
  }));

  const comparables = await replayComparables(target, asOfIso, config, client);

  const benefits = await findBenefits(
    target.hotelId,
    current.plan_id as number,
    target.checkIn,
    client,
  );
  const demand = await findDemand(
    target.destinationId,
    target.checkIn,
    target.nights,
    (current.rooms_left as number) ?? null,
    client,
  );

  const terms = {
    mealPlan: current.meal_plan as MealPlan,
    refundPolicy: current.refund_policy as RefundPolicy,
    audience: current.audience as RateAudience,
  };

  const input: ScoringInput = {
    query: {
      hotelId: target.wahHotelId,
      hotelName: target.hotelName,
      roomTypeId: String(target.roomTypeId),
      roomTypeName: target.roomTypeName,
      comparabilityClass: classifyComparability(terms).comparabilityClass,
      checkIn: target.checkIn,
      nights: target.nights,
      adults: target.adults,
      children: target.children,
      currency: target.currency,
    },
    current: {
      nightlyMinor: current.nightly_amount_minor as number,
      totalMinor: current.total_amount_minor as number,
      observedAt: (current.observed_at as Date).toISOString(),
      taxBasis: current.tax_basis as TaxBasis,
      refundable: current.refund_policy === 'REFUNDABLE',
      matchMethod: current.match_method as MatchMethod,
      matchConfidence: current.match_confidence as number,
      comparabilityClass: current.comparability_class as string,
      roomsLeft: (current.rooms_left as number) ?? null,
      onlyNonRefundableAvailable: current.only_non_refundable === true,
    },
    baseline,
    series,
    comparables,
    seasonality: null,
    demand,
    benefits,
    // The replay instant IS the clock. Everything downstream is deterministic
    // given it, which is what makes a replayed score reproducible.
    now: asOf,
  };

  return {
    input,
    asOf,
    approximations: [
      'benefits read at current values (no benefit history table)',
      'demand/events read at current values (no event history)',
      'comparable set is current; comparable rates are as-of',
    ],
  };
}

/** Build every ladder level from the pool, then apply the same selection the engine uses. */
function buildLadder(
  pool: readonly PoolRow[],
  target: ReplayTarget,
  leadTimeDays: number,
  config: ScoringConfig,
  asOfIso: string,
): BaselineDistribution | null {
  const season = seasonBandFor(target.checkIn);
  const dow = dowBucketFor(target.checkIn);
  const lead = leadBucketFor(leadTimeDays);

  const subject = pool.filter((p) => p.roomTypeId === target.roomTypeId);
  const siblings = pool.filter((p) => p.roomTypeId !== target.roomTypeId);

  const toObservation = (p: PoolRow): DistributionObservation => ({
    nightlyMinor: p.nightlyMinor,
    matchConfidence: p.matchConfidence,
    sourceId: p.sourceId,
    comparabilityClass: p.comparabilityClass,
  });

  const candidates: Array<{
    level: BaselineLevel;
    nObservations: number;
    distribution: BaselineDistribution;
  }> = [];

  for (const level of BASELINE_LEVELS) {
    const source = level === 'L4' ? siblings : subject;
    const filtered = source.filter((p) => {
      if (level === 'L0') {
        return (
          p.seasonBand === season && p.dowBucket === dow && leadBucketFor(p.leadTimeDays) === lead
        );
      }
      if (level === 'L1') return p.seasonBand === season && p.dowBucket === dow;
      if (level === 'L2') return p.seasonBand === season;
      return true;
    });

    const distribution = buildDistribution(filtered.map(toObservation), {
      level,
      lookbackDays: config.score.lookbackDays,
      computedAt: asOfIso,
      outlierTrim: config.score.outlierTrim,
    });
    if (distribution) {
      candidates.push({ level, nObservations: distribution.nObservations, distribution });
    }
  }

  const selection = selectBaselineLevel(
    candidates,
    config.baseline.minObsAbs,
    config.baseline.minObsTarget,
  );
  return selection.selected?.distribution ?? null;
}

async function replayComparables(
  target: ReplayTarget,
  asOfIso: string,
  config: ScoringConfig,
  client: Queryable,
): Promise<ComparableRate[]> {
  const { rows } = await client.query(
    `WITH comps AS (
       SELECT comparable_id AS hotel_id FROM hotel_comparable
        WHERE hotel_id = $1 ORDER BY rank LIMIT $8
     ),
     latest AS (
       SELECT DISTINCT ON (o.hotel_id, o.room_type_id)
              o.hotel_id, o.room_type_id, o.comparability_class,
              o.nightly_amount_minor, o.observed_at
         FROM rate_observation o
         JOIN comps ON comps.hotel_id = o.hotel_id
        WHERE o.check_in = $2 AND o.nights = $3 AND o.adults = $4
          AND o.children = $5 AND o.currency = $6 AND o.is_available
          -- Same-class only, matching the live path (docs/mvp/01 §4).
          AND o.comparability_class = $11
          AND o.observed_at <= $7
          AND o.observed_at > $7::timestamptz - ($9 || ' hours')::interval
        ORDER BY o.hotel_id, o.room_type_id, o.observed_at DESC
     ),
     cheapest AS (
       SELECT DISTINCT ON (hotel_id) * FROM latest ORDER BY hotel_id, nightly_amount_minor
     )
     SELECT h.wah_hotel_id, h.name, c.nightly_amount_minor, c.observed_at,
            -- The comparable's own typical rate AS OF the replay instant, so the
            -- discount index compares like with like in time as well as in kind.
            (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY b.nightly_amount_minor)
               FROM rate_observation b
              WHERE b.hotel_id = c.hotel_id AND b.room_type_id = c.room_type_id
                AND b.comparability_class = c.comparability_class
                AND b.currency = $6 AND b.is_available
                AND b.observed_at <= $7
                AND b.observed_at > $7::timestamptz - ($10 || ' days')::interval
            ) AS baseline_median
       FROM cheapest c JOIN hotel h ON h.id = c.hotel_id`,
    [
      target.hotelId,
      target.checkIn,
      target.nights,
      target.adults,
      target.children,
      target.currency,
      asOfIso,
      Math.max(config.confidence.coverageTargetComps, config.score.market.minComps) + 3,
      config.rec.maxCurrentAgeHours,
      config.score.lookbackDays,
      target.comparabilityClass,
    ],
  );

  return rows
    .filter((r) => r.baseline_median !== null)
    .map((r) => ({
      hotelId: r.wah_hotel_id as string,
      hotelName: r.name as string,
      currentNightlyMinor: r.nightly_amount_minor as number,
      baselineMedianMinor: Math.round(Number(r.baseline_median)),
      observedAt: (r.observed_at as Date).toISOString(),
    }));
}

export interface Outcome {
  readonly nObservations: number;
  readonly minNightlyMinor: number | null;
  readonly maxNightlyMinor: number | null;
  readonly lastNightlyMinor: number | null;
  readonly horizonEnd: string;
}

/**
 * What the price actually did after the replay instant.
 *
 * Bounded by the check-in date: a rate observed after the stay begins is not an
 * outcome the traveler could have acted on.
 */
export async function outcomeAfter(
  target: ReplayTarget,
  asOf: Date,
  horizonDays: number,
  q?: Queryable,
): Promise<Outcome> {
  const horizonEnd = new Date(
    Math.min(asOf.getTime() + horizonDays * 86_400_000, Date.parse(`${target.checkIn}T00:00:00Z`)),
  );

  const { rows } = await db(q).query(
    `SELECT count(*)::int AS n,
            min(nightly_amount_minor) AS min_nightly,
            max(nightly_amount_minor) AS max_nightly,
            (array_agg(nightly_amount_minor ORDER BY observed_at DESC))[1] AS last_nightly
       FROM rate_observation
      WHERE hotel_id = $1 AND room_type_id = $2 AND comparability_class = $3
        AND check_in = $4 AND nights = $5 AND adults = $6 AND children = $7
        AND currency = $8 AND is_available
        AND observed_at > $9 AND observed_at <= $10`,
    [
      target.hotelId,
      target.roomTypeId,
      target.comparabilityClass,
      target.checkIn,
      target.nights,
      target.adults,
      target.children,
      target.currency,
      asOf.toISOString(),
      horizonEnd.toISOString(),
    ],
  );

  const row = rows[0];
  return {
    nObservations: (row?.n as number) ?? 0,
    minNightlyMinor: (row?.min_nightly as number) ?? null,
    maxNightlyMinor: (row?.max_nightly as number) ?? null,
    lastNightlyMinor: (row?.last_nightly as number) ?? null,
    horizonEnd: horizonEnd.toISOString(),
  };
}
