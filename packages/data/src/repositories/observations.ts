import type { SeriesPoint } from '@wahpi/core';

import { db, type Queryable } from '../client.js';

export interface StayKey {
  readonly hotelId: number;
  readonly roomTypeId: number;
  readonly comparabilityClass: string;
  readonly checkIn: string;
  readonly nights: number;
  readonly adults: number;
  readonly children: number;
  readonly currency: string;
}

export interface CurrentRateRow {
  readonly nightlyMinor: number;
  readonly totalMinor: number;
  readonly observedAt: string;
  readonly taxBasis: 'NET' | 'GROSS' | 'UNKNOWN';
  readonly matchMethod: string;
  readonly matchConfidence: number;
  readonly comparabilityClass: string;
  readonly roomsLeft: number | null;
  readonly refundPolicy: string;
  readonly mealPlan: string;
  readonly audience: string;
  readonly ratePlanId: number;
  readonly onlyNonRefundableAvailable: boolean;
}

/**
 * The newest observation for an exact stay tuple.
 *
 * Note this reads STORED data — the API never calls a rate source synchronously
 * on a page view (docs/mvp/06 §2). Staleness is handled by the engine's G0 gate,
 * not by blocking the request.
 */
export async function findCurrentRate(key: StayKey, q?: Queryable): Promise<CurrentRateRow | null> {
  const { rows } = await db(q).query(
    `WITH stay AS (
       SELECT o.*, rp.refund_policy, rp.meal_plan, rp.audience
         FROM rate_observation o
         JOIN rate_plan rp ON rp.id = o.rate_plan_id
        WHERE o.hotel_id = $1 AND o.room_type_id = $2
          AND o.check_in = $4 AND o.nights = $5
          AND o.adults = $6 AND o.children = $7
          AND o.currency = $8 AND o.is_available
     )
     SELECT s.*,
            NOT EXISTS (
              SELECT 1 FROM stay f WHERE f.refund_policy = 'REFUNDABLE'
            ) AS only_non_refundable
       FROM stay s
      WHERE s.comparability_class = $3
      ORDER BY s.observed_at DESC
      LIMIT 1`,
    [
      key.hotelId,
      key.roomTypeId,
      key.comparabilityClass,
      key.checkIn,
      key.nights,
      key.adults,
      key.children,
      key.currency,
    ],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    nightlyMinor: row.nightly_amount_minor as number,
    totalMinor: row.total_amount_minor as number,
    observedAt: (row.observed_at as Date).toISOString(),
    taxBasis: row.tax_basis as 'NET' | 'GROSS' | 'UNKNOWN',
    matchMethod: row.match_method as string,
    matchConfidence: row.match_confidence as number,
    comparabilityClass: row.comparability_class as string,
    roomsLeft: (row.rooms_left as number) ?? null,
    refundPolicy: row.refund_policy as string,
    mealPlan: row.meal_plan as string,
    audience: row.audience as string,
    ratePlanId: row.rate_plan_id as number,
    onlyNonRefundableAvailable: row.only_non_refundable === true,
  };
}

/**
 * The same-stay series S(Q) — how the price of this exact stay has moved.
 *
 * One point per capture day (the latest observation of that day), so a hotel
 * polled six-hourly does not out-weight one polled daily in the trend fit.
 */
export async function findSameStaySeries(
  key: StayKey,
  windowDays: number,
  q?: Queryable,
): Promise<SeriesPoint[]> {
  const { rows } = await db(q).query(
    `SELECT DISTINCT ON (observed_date)
            observed_date, observed_at, nightly_amount_minor
       FROM rate_observation
      WHERE hotel_id = $1 AND room_type_id = $2 AND comparability_class = $3
        AND check_in = $4 AND nights = $5 AND adults = $6 AND children = $7
        AND currency = $8 AND is_available
        AND observed_at >= now() - ($9 || ' days')::interval
      ORDER BY observed_date, observed_at DESC`,
    [
      key.hotelId,
      key.roomTypeId,
      key.comparabilityClass,
      key.checkIn,
      key.nights,
      key.adults,
      key.children,
      key.currency,
      windowDays,
    ],
  );

  return rows.map((row) => ({
    observedAt: (row.observed_at as Date).toISOString(),
    nightlyMinor: row.nightly_amount_minor as number,
  }));
}

export interface SeriesGap {
  readonly from: string;
  readonly to: string;
}

/**
 * Days inside the window with no observation.
 *
 * Returned explicitly so the chart can break the line rather than interpolate.
 * Drawing a continuous line across days we never observed would be fabricated
 * history (docs/mvp/08 §3F).
 */
export function findSeriesGaps(series: readonly SeriesPoint[], windowDays: number): SeriesGap[] {
  if (series.length < 3) return [];

  const times = series.map((p) => Date.parse(p.observedAt)).sort((a, b) => a - b);
  const spacings: number[] = [];
  for (let i = 1; i < times.length; i += 1) {
    spacings.push((times[i] as number) - (times[i - 1] as number));
  }

  // A gap is an interval much longer than THIS series' own cadence, not longer
  // than an assumed daily one. A hotel polled every three days is not full of
  // holes, but a three-week silence in that same series is a real gap.
  const sorted = [...spacings].sort((a, b) => a - b);
  const medianSpacing = sorted[Math.floor(sorted.length / 2)] ?? 86_400_000;
  const threshold = Math.max(2.5 * 86_400_000, 2.5 * medianSpacing);

  const gaps: SeriesGap[] = [];
  for (let i = 1; i < times.length; i += 1) {
    const prevMs = times[i - 1] as number;
    const currMs = times[i] as number;
    if (currMs - prevMs > threshold) {
      gaps.push({
        from: new Date(prevMs).toISOString().slice(0, 10),
        to: new Date(currMs).toISOString().slice(0, 10),
      });
    }
  }
  void windowDays;
  return gaps;
}

/** Room types with a live rate for these dates, cheapest first. */
export async function findAvailableRoomTypes(
  hotelId: number,
  checkIn: string,
  nights: number,
  adults: number,
  children: number,
  currency: string,
  q?: Queryable,
): Promise<
  Array<{
    roomTypeId: number;
    canonicalName: string;
    roomClass: string;
    nightlyMinor: number;
    comparabilityClass: string;
    /** Rate terms as ingested — the comp set matches on these, not the class. */
    mealPlan: string;
    refundPolicy: string;
    audience: string;
    observedAt: string;
    nObservations: number;
  }>
> {
  const { rows } = await db(q).query(
    `SELECT DISTINCT ON (o.room_type_id)
            o.room_type_id, rt.canonical_name, rt.room_class,
            o.nightly_amount_minor, o.comparability_class, o.observed_at,
            rp.meal_plan, rp.refund_policy, rp.audience,
            COALESCE((
              SELECT max(b.n_observations) FROM rate_baseline b
               WHERE b.hotel_id = o.hotel_id AND b.room_type_id = o.room_type_id
                 AND b.comparability_class = o.comparability_class
            ), 0) AS n_observations
       FROM rate_observation o
       JOIN room_type rt ON rt.id = o.room_type_id
       JOIN rate_plan rp ON rp.id = o.rate_plan_id
      WHERE o.hotel_id = $1 AND o.check_in = $2 AND o.nights = $3
        AND o.adults = $4 AND o.children = $5 AND o.currency = $6
        AND o.is_available AND o.room_type_id IS NOT NULL
      ORDER BY o.room_type_id, o.observed_at DESC`,
    [hotelId, checkIn, nights, adults, children, currency],
  );

  return rows
    .map((row) => ({
      roomTypeId: row.room_type_id as number,
      canonicalName: row.canonical_name as string,
      roomClass: row.room_class as string,
      nightlyMinor: row.nightly_amount_minor as number,
      comparabilityClass: row.comparability_class as string,
      mealPlan: row.meal_plan as string,
      refundPolicy: row.refund_policy as string,
      audience: row.audience as string,
      observedAt: (row.observed_at as Date).toISOString(),
      nObservations: row.n_observations as number,
    }))
    .sort((a, b) => a.nightlyMinor - b.nightlyMinor);
}
