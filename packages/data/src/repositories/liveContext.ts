/**
 * Inputs to the live-market model: the comp set, nearby dates, and how much of
 * the comparable market is still bookable.
 *
 * ── Why these read from stored observations ───────────────────────────────
 *
 * The source has no calendar or availability-range endpoint. Its methods are
 * `hotel`, `rates`, `search`, `info`, `namerates` and `cityrates`, and `rates`
 * prices one specific stay per call. There is no bulk "what does this month
 * cost" request to reuse, so nearby-date pricing can only come from stays the
 * collector has already captured — which is why the collection grid carries
 * same-weekday satellites around each anchor (see DEFAULT_GRID_SPEC).
 *
 * Everything here is live-validated at the point of use: a rate older than the
 * caller's freshness bound is excluded rather than aged into the answer.
 */

import type { CompetitorRate, CompressionInput, NearbyDateRate } from '@wahpi/core';

import { db, type Queryable } from '../client.js';

/**
 * Live competitor rates for the SAME stay.
 *
 * Distinct from `findComparableRates`, which returns each comp's rate beside
 * its own baseline median so factor F2 can compare discount depth. The live
 * model compares raw prices and needs no baseline, so this returns the cheapest
 * live rate per comp hotel and says whether it is bookable.
 */
export async function findCompetitorRates(
  hotelId: number,
  checkIn: string,
  nights: number,
  adults: number,
  children: number,
  currency: string,
  comparabilityClass: string,
  limit: number,
  maxAgeHours: number,
  q?: Queryable,
): Promise<CompetitorRate[]> {
  const { rows } = await db(q).query(
    `WITH comps AS (
       SELECT c.comparable_id AS hotel_id, c.rank
         FROM hotel_comparable c
        WHERE c.hotel_id = $1
        ORDER BY c.rank
        LIMIT $8
     ),
     latest AS (
       SELECT DISTINCT ON (o.hotel_id, o.room_type_id)
              o.hotel_id, o.nightly_amount_minor, o.observed_at, o.is_available
         FROM rate_observation o
         JOIN comps ON comps.hotel_id = o.hotel_id
        WHERE o.check_in = $2::date AND o.nights = $3 AND o.adults = $4
          AND o.children = $5 AND o.currency = $6
          AND o.comparability_class = $7
          AND o.observed_at >= now() - ($9 || ' hours')::interval
        ORDER BY o.hotel_id, o.room_type_id, o.observed_at DESC
     ),
     cheapest AS (
       SELECT DISTINCT ON (l.hotel_id) l.*
         FROM latest l
        WHERE l.is_available
        ORDER BY l.hotel_id, l.nightly_amount_minor
     )
     SELECT h.wah_hotel_id, h.name, ch.nightly_amount_minor, ch.observed_at
       FROM cheapest ch
       JOIN hotel h ON h.id = ch.hotel_id
      ORDER BY ch.nightly_amount_minor`,
    [hotelId, checkIn, nights, adults, children, currency, comparabilityClass, limit, maxAgeHours],
  );

  return rows.map((r) => ({
    hotelId: r.wah_hotel_id as string,
    name: r.name as string,
    nightlyMinor: Number(r.nightly_amount_minor),
    observedAt: (r.observed_at as Date).toISOString(),
    isAvailable: true,
  }));
}

/**
 * Rates for the same room on nearby check-in dates.
 *
 * Matched on hotel, room type, comparability class, length of stay, occupancy
 * and currency — everything except the date. Comparing a different room or a
 * different length of stay would measure the product, not the dates.
 *
 * `sameDow` marks neighbours whose check-in falls on the same weekday, which is
 * what lets the engine avoid measuring the weekend when the customer asked
 * about a Thursday. The subject's own date is excluded, and past dates are
 * excluded because they cannot be booked.
 */
export async function findNearbyDateRates(
  hotelId: number,
  roomTypeId: number,
  comparabilityClass: string,
  checkIn: string,
  nights: number,
  adults: number,
  children: number,
  currency: string,
  windowDays: number,
  maxAgeHours: number,
  q?: Queryable,
): Promise<NearbyDateRate[]> {
  const { rows } = await db(q).query(
    `SELECT DISTINCT ON (o.check_in)
            to_char(o.check_in, 'YYYY-MM-DD') AS check_in,
            o.nightly_amount_minor,
            o.observed_at,
            EXTRACT(DOW FROM o.check_in) = EXTRACT(DOW FROM $4::date) AS same_dow
       FROM rate_observation o
      WHERE o.hotel_id = $1
        AND o.room_type_id = $2
        AND o.comparability_class = $3
        AND o.nights = $5 AND o.adults = $6 AND o.children = $7
        AND o.currency = $8
        AND o.is_available
        AND o.check_in <> $4::date
        AND o.check_in >= CURRENT_DATE
        AND o.check_in BETWEEN $4::date - $9::int AND $4::date + $9::int
        AND o.observed_at >= now() - ($10 || ' hours')::interval
      ORDER BY o.check_in, o.observed_at DESC`,
    [
      hotelId,
      roomTypeId,
      comparabilityClass,
      checkIn,
      nights,
      adults,
      children,
      currency,
      windowDays,
      maxAgeHours,
    ],
  );

  return rows.map((r) => ({
    checkIn: r.check_in as string,
    nightlyMinor: Number(r.nightly_amount_minor),
    sameDow: r.same_dow === true,
    observedAt: (r.observed_at as Date).toISOString(),
  }));
}

/**
 * How much of the comp set is still bookable for this stay.
 *
 * "Checked" means we actually asked: the hotel either returned a rate, or the
 * collector recorded an attempt for that exact stay. A comp we never asked
 * about is not counted either way — absence of a rate is not evidence of a
 * sold-out hotel, and treating it as one would manufacture scarcity.
 *
 * Sold-out is the source saying so: status 204, stored as
 * `collection_attempt.last_outcome = 'NO_AVAILABILITY'`.
 */
export async function findMarketCompression(
  hotelId: number,
  checkIn: string,
  nights: number,
  adults: number,
  limit: number,
  /**
   * Same freshness bound the comp-set query uses, and it must stay the same.
   * Without it a stale rate counts a hotel as bookable while a newer sold-out
   * record says otherwise, and the two signals end up describing different
   * markets — comp-set excluding a hotel as stale while compression counts it
   * as available.
   */
  maxAgeHours: number,
  q?: Queryable,
): Promise<CompressionInput | null> {
  const { rows } = await db(q).query(
    `WITH comps AS (
       SELECT c.comparable_id AS hotel_id
         FROM hotel_comparable c
        WHERE c.hotel_id = $1
        ORDER BY c.rank
        LIMIT $5
     ),
     priced AS (
       SELECT DISTINCT o.hotel_id
         FROM rate_observation o
         JOIN comps ON comps.hotel_id = o.hotel_id
        WHERE o.check_in = $2::date AND o.nights = $3 AND o.adults = $4
          AND o.is_available
          AND o.observed_at >= now() - ($6 || ' hours')::interval
     ),
     attempted AS (
       SELECT a.hotel_id, a.last_outcome
         FROM collection_attempt a
         JOIN comps ON comps.hotel_id = a.hotel_id
        WHERE a.check_in = $2::date AND a.nights = $3 AND a.adults = $4
     )
     SELECT
       (SELECT count(*) FROM comps)                                        AS comps,
       (SELECT count(*) FROM priced)                                       AS priced,
       (SELECT count(*) FROM attempted)                                    AS attempted,
       (SELECT count(*) FROM attempted WHERE last_outcome = 'NO_AVAILABILITY'
           AND hotel_id NOT IN (SELECT hotel_id FROM priced))              AS sold_out`,
    [hotelId, checkIn, nights, adults, limit, maxAgeHours],
  );

  const row = rows[0];
  if (!row) return null;

  const priced = Number(row.priced);
  const soldOut = Number(row.sold_out);
  const checked = priced + soldOut;

  // Nothing was actually asked, so there is nothing to report. The engine
  // omits the signal and redistributes its weight.
  if (checked === 0) return null;

  return { checked, soldOut };
}
