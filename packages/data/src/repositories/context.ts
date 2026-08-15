/**
 * Comparables, benefits and demand context — the inputs to factors F2, F5 and F6.
 */

import type { BenefitValue, ComparableRate, DemandInput } from '@wahpi/core';

import { db, type Queryable } from '../client.js';

/**
 * Comparable hotels with a live rate for the same stay.
 *
 * Each carries its OWN baseline median, because F2 compares discount depth
 * rather than absolute price — comparing raw prices would merely report that
 * premium hotels cost more, permanently suppressing their scores.
 */
export async function findComparableRates(
  hotelId: number,
  checkIn: string,
  nights: number,
  adults: number,
  children: number,
  currency: string,
  /**
   * The SUBJECT's comparability class. Comparables are restricted to it: a comp
   * discounting its non-refundable room-only rate is not evidence about
   * flexible bed-and-breakfast pricing, and mixing them puts noise straight
   * into factor F2. Required by docs/mvp/01 §4.
   */
  comparabilityClass: string,
  limit: number,
  maxAgeHours: number,
  q?: Queryable,
): Promise<ComparableRate[]> {
  const { rows } = await db(q).query(
    `WITH comps AS (
       SELECT c.comparable_id AS hotel_id, c.rank
         FROM hotel_comparable c
        WHERE c.hotel_id = $1
        ORDER BY c.rank
        LIMIT $7
     ),
     latest AS (
       SELECT DISTINCT ON (o.hotel_id, o.room_type_id)
              o.hotel_id, o.room_type_id, o.comparability_class,
              o.nightly_amount_minor, o.observed_at
         FROM rate_observation o
         JOIN comps ON comps.hotel_id = o.hotel_id
        WHERE o.check_in = $2 AND o.nights = $3 AND o.adults = $4
          AND o.children = $5 AND o.currency = $6 AND o.is_available
          AND o.comparability_class = $9
          AND o.observed_at >= now() - ($8 || ' hours')::interval
        ORDER BY o.hotel_id, o.room_type_id, o.observed_at DESC
     ),
     cheapest AS (
       SELECT DISTINCT ON (l.hotel_id) l.*
         FROM latest l
        ORDER BY l.hotel_id, l.nightly_amount_minor
     )
     SELECT h.wah_hotel_id, h.name, ch.nightly_amount_minor, ch.observed_at,
            b.p50_minor AS baseline_median
       FROM cheapest ch
       JOIN hotel h ON h.id = ch.hotel_id
       JOIN rate_baseline b
         ON b.hotel_id = ch.hotel_id AND b.room_type_id = ch.room_type_id
        AND b.comparability_class = ch.comparability_class
        AND b.currency = $6 AND b.baseline_level = 'L3'
      ORDER BY h.name`,
    [hotelId, checkIn, nights, adults, children, currency, limit, maxAgeHours, comparabilityClass],
  );

  return rows.map((row) => ({
    hotelId: row.wah_hotel_id as string,
    hotelName: row.name as string,
    currentNightlyMinor: row.nightly_amount_minor as number,
    baselineMedianMinor: row.baseline_median as number,
    observedAt: (row.observed_at as Date).toISOString(),
  }));
}

/**
 * Benefits attached to the rate plan, falling back to hotel-level
 * (preferred-partner) benefits. Realization factors are applied by the scoring
 * engine, not here — this returns face values plus the factor.
 */
export async function findBenefits(
  hotelId: number,
  ratePlanId: number | null,
  checkIn: string,
  q?: Queryable,
): Promise<BenefitValue[]> {
  const { rows } = await db(q).query(
    `SELECT b.code, b.display_name, b.basis,
            COALESCE(rpb.value_minor, hb.value_minor, b.default_value_minor) AS value_minor,
            b.realization_factor
       FROM benefit b
       LEFT JOIN rate_plan_benefit rpb ON rpb.benefit_id = b.id AND rpb.rate_plan_id = $2
       LEFT JOIN hotel_benefit hb
              ON hb.benefit_id = b.id AND hb.hotel_id = $1
             AND (hb.valid_from IS NULL OR hb.valid_from <= $3::date)
             AND (hb.valid_to   IS NULL OR hb.valid_to   >= $3::date)
      WHERE (rpb.rate_plan_id IS NOT NULL OR hb.hotel_id IS NOT NULL)
        AND COALESCE(rpb.value_minor, hb.value_minor, b.default_value_minor) IS NOT NULL`,
    [hotelId, ratePlanId, checkIn],
  );

  return rows.map((row) => ({
    code: row.code as string,
    displayName: row.display_name as string,
    basis: row.basis as 'PER_NIGHT' | 'PER_STAY',
    valueMinor: row.value_minor as number,
    realizationFactor: row.realization_factor as number,
  }));
}

/**
 * Demand signals for the stay window.
 *
 * Returns `null` when nothing is known — distinct from a signal reporting no
 * demand. F5 treats those differently, and conflating them would turn "we have
 * no events feed" into "there are no events".
 */
export async function findDemand(
  destinationId: number | null,
  checkIn: string,
  nights: number,
  roomsLeft: number | null,
  q?: Queryable,
): Promise<DemandInput | null> {
  const events: Array<{ name: string; impactScore: number }> = [];

  if (destinationId !== null) {
    const { rows } = await db(q).query(
      `SELECT name, impact_score FROM destination_event
        WHERE destination_id = $1
          AND start_date <= ($2::date + $3::int)
          AND end_date   >= $2::date
        ORDER BY impact_score DESC
        LIMIT 5`,
      [destinationId, checkIn, nights],
    );
    for (const row of rows) {
      events.push({ name: row.name as string, impactScore: row.impact_score as number });
    }
  }

  if (events.length === 0 && roomsLeft === null) return null;
  return { events, roomsLeft };
}

export async function upsertComparables(
  hotelId: number,
  comparables: ReadonlyArray<{ comparableId: number; similarity: number; rank: number }>,
  basis: string,
  q?: Queryable,
): Promise<void> {
  const client = db(q);
  await client.query('DELETE FROM hotel_comparable WHERE hotel_id = $1', [hotelId]);
  for (const c of comparables) {
    await client.query(
      `INSERT INTO hotel_comparable (hotel_id, comparable_id, similarity, rank, basis)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (hotel_id, comparable_id) DO UPDATE
         SET similarity = EXCLUDED.similarity, rank = EXCLUDED.rank,
             basis = EXCLUDED.basis, computed_at = now()`,
      [hotelId, c.comparableId, c.similarity, c.rank, basis],
    );
  }
}
