/**
 * The collector's own bookkeeping: which stays to ask for, and which to stop
 * asking about for a while.
 *
 * Separate from `observations` because these are attempts, not facts. Nothing
 * here ever reaches a baseline or a score.
 */

import { db, type Queryable } from '../client.js';

export interface GridStay {
  readonly hotelId: number;
  readonly wahHotelId: string;
  readonly checkIn: string;
  readonly nights: number;
  readonly adults: number;
}

export interface GridSpec {
  /** Lead times, in days from today, the grid should always cover. */
  readonly leadDays: readonly number[];
  readonly nights: readonly number[];
  readonly adults: number;
  /**
   * Consecutive failures after which a stay is backed off rather than retried
   * every run. The delay doubles per failure from this point, capped below.
   */
  readonly backoffAfterFailures: number;
  readonly backoffMaxHours: number;
}

export const DEFAULT_GRID_SPEC: GridSpec = {
  leadDays: [7, 14, 21, 30, 45, 60, 90],
  nights: [1, 3],
  adults: 2,
  backoffAfterFailures: 3,
  backoffMaxHours: 168, // one week
};

/** Hours to wait before retrying a stay that has failed this many times. */
export function backoffHours(consecutiveFailures: number, spec: GridSpec): number {
  if (consecutiveFailures < spec.backoffAfterFailures) return 0;
  const over = consecutiveFailures - spec.backoffAfterFailures;
  return Math.min(2 ** over, spec.backoffMaxHours);
}

/**
 * Stays in the target grid that nothing is tracking yet, minus those currently
 * backed off.
 *
 * The lead times are relative to TODAY, so the grid rolls forward daily. This
 * must run on every collection, not only at cold start: `planCollection` only
 * refreshes stays it can already see, so without a top-up the tracked set is
 * frozen at whatever the first run captured and ages out one day at a time.
 */
export async function findMissingGridStays(
  spec: GridSpec = DEFAULT_GRID_SPEC,
  now: Date = new Date(),
  q?: Queryable,
): Promise<GridStay[]> {
  const client = db(q);

  const { rows: hotels } = await client.query(
    `SELECT id, wah_hotel_id FROM hotel
      WHERE is_active AND collection_tier <> 'OFF' ORDER BY id`,
  );
  if (hotels.length === 0) return [];

  const { rows: tracked } = await client.query(
    `SELECT DISTINCT hotel_id, to_char(check_in,'YYYY-MM-DD') AS check_in, nights, adults
       FROM rate_observation
      WHERE check_in >= CURRENT_DATE`,
  );
  const seen = new Set(tracked.map((r) => `${r.hotel_id}|${r.check_in}|${r.nights}|${r.adults}`));

  const { rows: attempts } = await client.query(
    `SELECT hotel_id, to_char(check_in,'YYYY-MM-DD') AS check_in, nights, adults,
            consecutive_failures,
            EXTRACT(EPOCH FROM (now() - last_attempt_at)) / 3600 AS hours_since
       FROM collection_attempt
      WHERE consecutive_failures > 0`,
  );
  const backedOff = new Set<string>();
  for (const row of attempts) {
    const failures = Number(row.consecutive_failures);
    const hoursSince = Number(row.hours_since);
    if (hoursSince < backoffHours(failures, spec)) {
      backedOff.add(`${row.hotel_id}|${row.check_in}|${row.nights}|${row.adults}`);
    }
  }

  const out: GridStay[] = [];
  for (const hotel of hotels) {
    for (const lead of spec.leadDays) {
      const checkIn = new Date(now.getTime() + lead * 86_400_000).toISOString().slice(0, 10);
      for (const nights of spec.nights) {
        const key = `${hotel.id}|${checkIn}|${nights}|${spec.adults}`;
        if (seen.has(key) || backedOff.has(key)) continue;
        out.push({
          hotelId: hotel.id as number,
          wahHotelId: hotel.wah_hotel_id as string,
          checkIn,
          nights,
          adults: spec.adults,
        });
      }
    }
  }
  return out;
}

export interface AttemptOutcome {
  readonly hotelId: number;
  readonly checkIn: string;
  readonly nights: number;
  readonly adults: number;
  readonly succeeded: boolean;
  readonly outcome: string;
}

/**
 * Record what each attempted stay did.
 *
 * A success resets `consecutive_failures`, so a stay that starts pricing again
 * leaves backoff on its next run rather than serving out a stale penalty.
 */
export async function recordCollectionAttempts(
  outcomes: readonly AttemptOutcome[],
  q?: Queryable,
): Promise<number> {
  if (outcomes.length === 0) return 0;
  const client = db(q);
  let written = 0;

  for (const o of outcomes) {
    const { rowCount } = await client.query(
      `INSERT INTO collection_attempt
         (hotel_id, check_in, nights, adults, attempts, consecutive_failures,
          last_attempt_at, last_outcome)
       VALUES ($1,$2::date,$3,$4,1,$5,now(),$6)
       ON CONFLICT (hotel_id, check_in, nights, adults) DO UPDATE
         SET attempts = collection_attempt.attempts + 1,
             consecutive_failures =
               CASE WHEN $5 = 0 THEN 0 ELSE collection_attempt.consecutive_failures + 1 END,
             last_attempt_at = now(),
             last_outcome = EXCLUDED.last_outcome`,
      [o.hotelId, o.checkIn, o.nights, o.adults, o.succeeded ? 0 : 1, o.outcome],
    );
    written += rowCount ?? 0;
  }
  return written;
}
