/**
 * What guests asked about — the collector's demand signal.
 *
 * `planCollection` derives its work from `rate_observation`, and dates its
 * "viewed" signal from `analysis`. Both only know stays that already WORKED,
 * so the stays most worth collecting were invisible to it: a guest opens a
 * hotel page for dates nothing has collected, the live fetch fails, and the
 * request leaves no trace anywhere the collector reads. The next guest on
 * that page repeats the same failing fetch.
 *
 * These rows close that loop. The collector can then spend its PATIENT
 * settings (30s timeout, 3 retries, minutes to spend) on stays real people
 * are looking at — before the next one arrives, instead of inside their page
 * view where an 8-second budget is all a guest will wait for.
 *
 * Standing, stated once: this is scheduling input, exactly like
 * `collection_attempt` (rule 16). Nothing here reaches a baseline, a comp set
 * or a score, and it identifies no person — a hotel, dates, an occupancy.
 */

import { db, type Queryable } from '../client.js';

export interface RequestedStay {
  readonly hotelId: number;
  readonly wahHotelId: string;
  readonly checkIn: string;
  readonly nights: number;
  readonly adults: number;
  readonly requestCount: number;
  readonly lastRequestedAt: string;
  readonly lastObservedAt: string | null;
}

export interface WarmingOptions {
  /**
   * How long a request keeps counting as demand.
   *
   * Demand is evidence about a PAGE, not about a person: the stay a guest
   * looked at last Tuesday is one a search engine or a returning shopper can
   * land on again. Too short and warming only ever helps the second of two
   * guests arriving minutes apart, which is the rarest case; too long and the
   * collector works through a museum of dates nobody has wanted for a month.
   */
  readonly requestedWithinDays: number;
  /**
   * A warmed stay is refetched once its newest observation is older than this.
   *
   * Matched to `maxRateAgeHours` (12) — the age past which
   * `assessLiveConfidence` caps a guest's answer at LOW. Warming a stay that
   * is still fresh enough to answer at full confidence buys nothing; warming
   * one the hour after it goes stale is the whole point.
   */
  readonly staleAfterHours: number;
  /** Never warm a stay further out than this; the source is verified ~7 months. */
  readonly maxLeadDays: number;
  readonly limit: number;
}

export const DEFAULT_WARMING_OPTIONS: WarmingOptions = {
  requestedWithinDays: 14,
  staleAfterHours: 12,
  maxLeadDays: 300,
  limit: 500,
};

/**
 * Record that a guest asked about this stay. Idempotent per stay; counts up.
 *
 * Called on the read path, so it must be cheap and must never be the reason a
 * request fails — the caller swallows its errors. A primary-key upsert on a
 * small table is one index probe.
 */
export async function recordStayRequest(
  hotelId: number,
  checkIn: string,
  nights: number,
  adults: number,
  q?: Queryable,
): Promise<void> {
  await db(q).query(
    `INSERT INTO stay_request (hotel_id, check_in, nights, adults)
          VALUES ($1, $2::date, $3, $4)
     ON CONFLICT (hotel_id, check_in, nights, adults) DO UPDATE
            SET request_count = stay_request.request_count + 1,
                last_requested_at = now()`,
    [hotelId, checkIn, nights, adults],
  );
}

/**
 * Stays to warm, most-wanted first.
 *
 * "Most wanted" is request count, then recency — a stay ten people opened
 * outranks one that a single guest opened twice, and among equals the fresher
 * interest wins.
 *
 * What is deliberately NOT here:
 *
 *   - Stays whose check-in has passed. They cannot be booked, so a rate for
 *     them cannot answer anything.
 *   - Stays already fresh enough to answer at full confidence.
 *   - Hotels that are inactive. A hotel at collection tier `OFF` IS included:
 *     rule 17 keeps the whole catalogue scoreable on demand, and a guest
 *     asking about one is precisely the demand that justifies the call. This
 *     is the one place tier `OFF` should not exclude a stay, because the
 *     evidence for asking is a person having asked.
 *   - Any backoff logic. The caller runs these through the same
 *     `collection_attempt` ledger as every other task, so a stay that yields
 *     nothing backs off exactly as rule 16 requires — warming must not become
 *     a way to re-ask a dead stay every two hours.
 */
export async function planStayWarming(
  options: WarmingOptions = DEFAULT_WARMING_OPTIONS,
  q?: Queryable,
): Promise<RequestedStay[]> {
  const { rows } = await db(q).query(
    `WITH wanted AS (
       SELECT r.hotel_id, h.wah_hotel_id, r.check_in, r.nights, r.adults,
              r.request_count, r.last_requested_at
         FROM stay_request r
         JOIN hotel h ON h.id = r.hotel_id
        WHERE h.is_active
          AND r.check_in >= CURRENT_DATE
          AND r.check_in <= CURRENT_DATE + $3::int
          AND r.last_requested_at > now() - ($1 || ' days')::interval
     )
     SELECT w.*, o.last_observed_at
       FROM wanted w
       LEFT JOIN LATERAL (
         SELECT max(observed_at) AS last_observed_at
           FROM rate_observation o
          WHERE o.hotel_id = w.hotel_id AND o.check_in = w.check_in
            AND o.nights = w.nights AND o.adults = w.adults
       ) o ON true
      WHERE o.last_observed_at IS NULL
         OR o.last_observed_at < now() - ($2 || ' hours')::interval
      ORDER BY w.request_count DESC, w.last_requested_at DESC
      LIMIT $4`,
    [options.requestedWithinDays, options.staleAfterHours, options.maxLeadDays, options.limit],
  );

  return rows.map((row) => ({
    hotelId: row.hotel_id as number,
    wahHotelId: row.wah_hotel_id as string,
    checkIn: (row.check_in as Date).toISOString().slice(0, 10),
    nights: row.nights as number,
    adults: row.adults as number,
    requestCount: row.request_count as number,
    lastRequestedAt: (row.last_requested_at as Date).toISOString(),
    lastObservedAt: row.last_observed_at ? (row.last_observed_at as Date).toISOString() : null,
  }));
}

/**
 * Drop requests that can no longer inform a fetch.
 *
 * A stay whose check-in has passed is dead weight, and one nobody has asked
 * about in a long time is no longer demand. Kept generous against
 * `requestedWithinDays` so the table can still answer "was this ever popular"
 * for a while after it stops being warmed.
 */
export async function pruneStayRequests(staleDays = 60, q?: Queryable): Promise<number> {
  const { rowCount } = await db(q).query(
    `DELETE FROM stay_request
      WHERE check_in < CURRENT_DATE
         OR last_requested_at < now() - ($1 || ' days')::interval`,
    [staleDays],
  );
  return rowCount ?? 0;
}
