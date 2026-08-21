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
 * The comp set, as SQL: the curated set when one exists, otherwise the
 * subject's own destination, nearest first.
 *
 * `rebuildComparables` ranks on accrued baselines, so a hotel catalogued this
 * week has no curated set — and a destination the collector has never visited
 * would therefore have no Comp-Set Index at all, which is 45% of the live
 * score. That is not an acceptable answer for a widget that has to work on
 * every hotel page on the site, and the honest stand-in is the same filter the
 * curated set itself starts from: the same destination, minus the price and
 * tier ranking it cannot compute yet.
 *
 * Ordered by the SOURCE's own ranking first (`hotel.city_rank`, from
 * `cityrates` — the only cross-hotel prominence signal the API offers), then by
 * straight-line distance for everything the source has not ranked. Rank orders
 * the comparison; it is never scored with, and it is never shown to a customer
 * as a rating. See migration 0012 and docs/runbooks/source-api-inventory.md.
 *
 * The fallback is weaker evidence and is reported as such — see `compBasis` on
 * the loaded result, which the API publishes so nothing downstream can present
 * a city-wide comparison as a curated peer set.
 *
 * ── Why "curated exists" is not the right trigger ──────────────────────────
 *
 * The fallback used to fire only when `hotel_comparable` was EMPTY. A curated
 * set that exists but yields nothing usable is the worse case and it was the
 * one left unhandled: measured on hotel 1198 (Ritz-Carlton Key Biscayne), the
 * curated comps returned 0 usable rates on three separate stays while the
 * top-up fetched 128 competitor rates and inserted none — every one already
 * stored, none matching the subject's terms. Fetching more of the same could
 * never fix it, because the pool was wrong rather than stale.
 *
 * So the caller re-asks with `widen` once it can see the count. That decision
 * needs the usable comps, which only the full query produces, so it lives in
 * loadLiveIntelligence rather than here — see `widenedCompetitors`.
 *
 * $1 is the subject hotel id; `limitParam` is the caller's own placeholder;
 * `widenParam` is a boolean that suppresses the curated branch entirely.
 */
function compSetCte(limitParam: string, widenParam: string): string {
  return `curated AS (
       SELECT c.comparable_id AS hotel_id, c.rank
         FROM hotel_comparable c
        WHERE c.hotel_id = $1 AND NOT ${widenParam}
        ORDER BY c.rank
        LIMIT ${limitParam}
     ),
     comps AS (
       SELECT hotel_id, rank FROM curated
       UNION ALL
       (SELECT h.id, 9999
          FROM hotel h,
               (SELECT destination_id, latitude, longitude FROM hotel WHERE id = $1) s
         WHERE NOT EXISTS (SELECT 1 FROM curated)
           AND h.is_active
           AND h.id <> $1
           AND s.destination_id IS NOT NULL
           AND h.destination_id = s.destination_id
         ORDER BY (h.city_rank IS NULL),
                  h.city_rank DESC,
                  (h.latitude IS NULL OR s.latitude IS NULL),
                  (h.latitude - s.latitude) ^ 2 + (h.longitude - s.longitude) ^ 2,
                  h.id
         LIMIT ${limitParam})
     )`;
}

/**
 * Live competitor rates for the SAME stay.
 *
 * Distinct from `findComparableRates`, which returns each comp's rate beside
 * its own baseline median so factor F2 can compare discount depth. The live
 * model compares raw prices and needs no baseline, so this returns the cheapest
 * live rate per comp hotel and says whether it is bookable.
 */
/**
 * Competitor rates for the same stay, matched on RATE TERMS rather than on the
 * comparability class.
 *
 * The class cannot do this job. In production it is `WAH:<rateCode>|<offer>` —
 * the source's own plan identity, which is hotel-specific by construction, so
 * a competitor can never share it. Measured over 40 real stays, every
 * competitor survived every other filter and none survived this one: 0/40.
 *
 * Matching on meal plan, refundability and audience instead is tolerant by
 * nature, because SQL equality already treats UNKNOWN = UNKNOWN as a match
 * while never matching UNKNOWN to a stated value. That is exactly the rule
 * normalize/compMatch.ts argues for, and the reason this function does not
 * reuse `classifyComparability`: that classifier poisons an unresolved
 * dimension to UNRESOLVED, which is correct for baselines and fatal here.
 *
 * Baselines still key on the class. Only the comp set uses these terms.
 */
export async function findCompetitorRates(
  hotelId: number,
  checkIn: string,
  nights: number,
  adults: number,
  children: number,
  currency: string,
  terms: { mealPlan: string; refundPolicy: string; audience: string },
  limit: number,
  maxAgeHours: number,
  /**
   * Skip the curated set and take the destination instead. The caller sets it
   * after seeing that the curated set produced fewer usable comps than the
   * index needs — see the note on compSetCte.
   */
  widen = false,
  /**
   * Restrict competitors to an equivalent ROOM, not merely an equivalent rate.
   *
   * Terms alone answer "is this the same product commercially"; they say
   * nothing about whether it is the same kind of room. Without this, a guest
   * asking about an Ocean View suite was measured against whatever each
   * competitor's cheapest terms-matching room happened to be — usually an
   * entry-level room — so a dearer category looked overpriced by construction
   * rather than by evidence. Null means "any room", which is the honest
   * fallback when nothing equivalent is bookable; the caller reports which
   * rung it landed on.
   */
  roomClass: string | null = null,
  viewType: string | null = null,
  q?: Queryable,
): Promise<CompetitorRate[]> {
  const { rows } = await db(q).query(
    `WITH ${compSetCte('$8', '$12')},
     latest AS (
       SELECT DISTINCT ON (o.hotel_id, o.room_type_id)
              o.hotel_id, o.nightly_amount_minor, o.observed_at, o.is_available
         FROM rate_observation o
         JOIN comps ON comps.hotel_id = o.hotel_id
         JOIN rate_plan rp ON rp.id = o.rate_plan_id
         -- LEFT JOIN: fixtures carry observations with no room type, and a
         -- missing type is not a deactivated one. Only a type known to be
         -- inactive is excluded — a retired (poisoned) room must not price a
         -- competitor comparison any more than it may be offered to a guest.
         LEFT JOIN room_type rt ON rt.id = o.room_type_id
        WHERE (rt.id IS NULL OR rt.is_active)
          AND o.check_in = $2::date AND o.nights = $3 AND o.adults = $4
          AND o.children = $5 AND o.currency = $6
          AND rp.meal_plan = $7 AND rp.refund_policy = $10 AND rp.audience = $11
          -- A room whose class we do not know never matches a class we DO
          -- know: rt.room_class is NULL on the LEFT JOIN, so the comparison
          -- yields NULL and the row drops. Same rule as the terms match —
          -- symmetric ignorance is fair, ignorance against knowledge is not.
          -- ::text on the COLUMN, not the parameter: room_class and view_type
          -- are enums, and an enum does not compare to a bound text parameter.
          AND ($13::text IS NULL OR rt.room_class::text = $13)
          AND ($14::text IS NULL OR rt.view_type::text = $14)
          AND o.observed_at >= now() - ($9 || ' hours')::interval
        -- Cheapest within the freshest capture, not merely the newest row:
        -- a competitor room with two rate plans otherwise priced itself at
        -- whichever was captured last, inflating the comp set and making
        -- the subject look cheaper than it is. See findAvailableRoomTypes.
        ORDER BY o.hotel_id, o.room_type_id, o.observation_slot DESC,
                 o.nightly_amount_minor
     ),
     cheapest AS (
       SELECT DISTINCT ON (l.hotel_id) l.*
         FROM latest l
        WHERE l.is_available
        ORDER BY l.hotel_id, l.nightly_amount_minor
     )
     SELECT h.wah_hotel_id, h.name, ch.nightly_amount_minor, ch.observed_at,
            -- What this hotel's rate INCLUDES, per night, discounted by each
            -- benefit's realization factor. NULL when we hold no benefit rows
            -- for the hotel: "we do not know what it includes" is not the same
            -- as "it includes nothing", and Premium Justification must be able
            -- to tell those apart.
            (SELECT sum(
                      CASE WHEN b.basis = 'PER_NIGHT'
                           THEN COALESCE(hb.value_minor, b.default_value_minor) * b.realization_factor
                           ELSE COALESCE(hb.value_minor, b.default_value_minor) * b.realization_factor / $3
                      END)
               FROM hotel_benefit hb
               JOIN benefit b ON b.id = hb.benefit_id
              WHERE hb.hotel_id = ch.hotel_id) AS benefit_per_night
       FROM cheapest ch
       JOIN hotel h ON h.id = ch.hotel_id
      ORDER BY ch.nightly_amount_minor`,
    [
      hotelId,
      checkIn,
      nights,
      adults,
      children,
      currency,
      terms.mealPlan,
      limit,
      maxAgeHours,
      terms.refundPolicy,
      terms.audience,
      widen,
      roomClass,
      viewType,
    ],
  );

  return rows.map((r) => ({
    hotelId: r.wah_hotel_id as string,
    name: r.name as string,
    nightlyMinor: Number(r.nightly_amount_minor),
    observedAt: (r.observed_at as Date).toISOString(),
    isAvailable: true,
    ...(r.benefit_per_night === null || r.benefit_per_night === undefined
      ? {}
      : { benefitValuePerNightMinor: Math.round(Number(r.benefit_per_night)) }),
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
      -- Same rule as the subject and the comp set: freshest capture, then
      -- cheapest within it. A neighbour date priced by an arbitrary rate
      -- plan would move the calendar delta for no market reason.
      ORDER BY o.check_in, o.observation_slot DESC, o.nightly_amount_minor`,
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
  /** Must match the comp set's own choice, or the two describe different markets. */
  widen = false,
  q?: Queryable,
): Promise<CompressionInput | null> {
  const { rows } = await db(q).query(
    `WITH ${compSetCte('$5', '$7')},
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
    [hotelId, checkIn, nights, adults, limit, maxAgeHours, widen],
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
