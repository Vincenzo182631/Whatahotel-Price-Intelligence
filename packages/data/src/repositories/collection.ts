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
  /**
   * Anchor lead times, in days from today.
   *
   * Anchors come in pairs three days apart (14/17, 35/38, …) so the grid
   * samples two different weekdays rather than one. A single track would make
   * every collected stay share a weekday, and a customer asking about a
   * midweek stay would find nothing comparable.
   */
  readonly anchorLeadDays: readonly number[];
  /**
   * Offsets around each anchor, in days. Multiples of seven on purpose: an
   * offset stay lands on the SAME weekday as its anchor, which is what makes
   * it a valid neighbour for the calendar-delta signal.
   *
   * The previous grid was a flat list of lead times — 7, 14, 21, 30, 45, 60,
   * 90 — under which only 7/14/21 shared a weekday. A stay at lead 30 had no
   * same-weekday neighbour anywhere in the grid, so the calendar signal could
   * not be computed for most of what was collected.
   */
  readonly satelliteOffsetDays: readonly number[];
  /** Never request a stay closer in than this. */
  readonly minLeadDays: number;
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
  // Three horizons × two weekday tracks. With the offsets below this yields
  // ~19 distinct check-in dates per hotel per stay length, each with two to
  // four same-weekday neighbours inside a ±14 day window — which is what the
  // calendar signal needs.
  //
  // Cost: roughly 2.7× the previous grid on a cold fill. There is no cheaper
  // route: the source has no calendar endpoint, so a nearby-date price only
  // exists if it was collected as its own stay.
  anchorLeadDays: [14, 17, 35, 38, 63, 66],
  satelliteOffsetDays: [-14, -7, 0, 7, 14],
  minLeadDays: 3,
  // 1, 2 AND 3 nights.
  //
  // 2 was missing, and its absence was invisible because nothing reports it:
  // findNearbyDateRates matches `nights` EXACTLY — comparing a two-night price
  // against a three-night one would measure the product, not the dates — so a
  // two-night stay could never find a neighbour, the Calendar signal was never
  // available, and 35% of the live model was silently redistributed on every
  // such request. Confidence could not reach HIGH either, since that needs
  // nearby-date evidence.
  //
  // Measured 2026-08-26 on hotel 1198: at 3 nights, 14 neighbours and HIGH
  // confidence; at 2 nights, zero neighbours and the calendar unavailable.
  // Two nights is a weekend break — plausibly the commonest leisure stay
  // there is, and the one length the system was blind on.
  //
  // Cost: the grid grows by half again, because stay length multiplies the
  // whole date set. There is no cheaper route — the source has no calendar
  // endpoint, so a nearby-date price exists only if it was collected as its
  // own stay.
  nights: [1, 2, 3],
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
 * How far (in days) a tracked stay may sit from a wanted grid date and still
 * count as covering it.
 *
 * The grid's lead times are relative to today, and no two of them differ by
 * one day — so at every UTC-day rollover the wanted dates are DISJOINT from
 * yesterday's, and an exact-date match declared the entire grid untracked.
 * Measured on 2026-08-19, the first rollover after go-live: the run planned
 * "690 new, 231 due" and truncated 421 stays at the --limit, starving the
 * HOT-tier refreshes it exists to protect.
 *
 * ±1 is the smallest tolerance under which yesterday's grid covers today's
 * (the grid moves one day per day), and it is safe because adjacent grid
 * leads are at least 3 days apart: a single tracked stay can never satisfy
 * two distinct wanted dates at once.
 */
export const GRID_COVERAGE_TOLERANCE_DAYS = 1;

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
  const seen = new Set<string>(
    tracked.map((r) => `${r.hotel_id}|${r.check_in}|${r.nights}|${r.adults}`),
  );

  const { rows: attempts } = await client.query(
    `SELECT hotel_id, lead_days, nights, adults,
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
      backedOff.add(`${row.hotel_id}|${row.lead_days}|${row.nights}|${row.adults}`);
    }
  }

  return planGridTopUp(
    hotels.map((h) => ({ id: h.id as number, wahHotelId: h.wah_hotel_id as string })),
    seen,
    backedOff,
    spec,
    now,
  );
}

/**
 * The pure planning core of `findMissingGridStays`, split out so the coverage
 * rule is testable without a database.
 *
 * Coverage is tolerant (`GRID_COVERAGE_TOLERANCE_DAYS`): a wanted date counts
 * as covered when a tracked stay of the same hotel/nights/adults sits within
 * the tolerance. Backoff is keyed by GRID SLOT — `hotel|lead|nights|adults` —
 * because the slot is what gets re-requested daily; the date is just the
 * slot's current position. Keyed by date, a never-pricing stay re-entered as
 * a fresh key each day, its failure count restarted, and the backoff could
 * never outlast the 6-hour cron (migration 0010 has the measured incident).
 */
export function planGridTopUp(
  hotels: readonly { readonly id: number; readonly wahHotelId: string }[],
  seen: ReadonlySet<string>,
  backedOff: ReadonlySet<string>,
  spec: GridSpec = DEFAULT_GRID_SPEC,
  now: Date = new Date(),
): GridStay[] {
  const dayMs = 86_400_000;
  const out: GridStay[] = [];
  for (const hotel of hotels) {
    for (const lead of gridLeadDays(spec)) {
      const checkInMs = now.getTime() + lead * dayMs;
      const checkIn = new Date(checkInMs).toISOString().slice(0, 10);
      for (const nights of spec.nights) {
        if (backedOff.has(`${hotel.id}|${lead}|${nights}|${spec.adults}`)) continue;
        let covered = false;
        for (let d = -GRID_COVERAGE_TOLERANCE_DAYS; d <= GRID_COVERAGE_TOLERANCE_DAYS; d++) {
          const near = new Date(checkInMs + d * dayMs).toISOString().slice(0, 10);
          if (seen.has(`${hotel.id}|${near}|${nights}|${spec.adults}`)) {
            covered = true;
            break;
          }
        }
        if (covered) continue;
        out.push({
          hotelId: hotel.id,
          wahHotelId: hotel.wahHotelId,
          checkIn,
          nights,
          adults: spec.adults,
        });
      }
    }
  }
  return out;
}

/**
 * The lead times the grid covers: every anchor expanded by its offsets,
 * deduplicated and sorted.
 *
 * Anchors overlap deliberately — 35+14 and 63−14 both land on 49 — so the
 * horizon is continuous rather than three islands. Deduplication is what stops
 * that costing a second API call for the same stay.
 */
export function gridLeadDays(spec: GridSpec = DEFAULT_GRID_SPEC): number[] {
  const leads = new Set<number>();
  for (const anchor of spec.anchorLeadDays) {
    for (const offset of spec.satelliteOffsetDays) {
      const lead = anchor + offset;
      if (lead >= spec.minLeadDays) leads.add(lead);
    }
  }
  return [...leads].sort((a, b) => a - b);
}

/**
 * Whether this exact stay was attempted recently and yielded nothing.
 *
 * The on-demand scoring path consults this before fetching live: a stay that
 * failed minutes ago (sold out, API 500, every rate rejected) will fail again,
 * and widget traffic must not turn one dead stay into a request per page view.
 * Success rows do not block — a fresh success means observations exist and the
 * caller would not be here.
 */
export async function wasStayRecentlyFruitless(
  hotelId: number,
  checkIn: string,
  nights: number,
  adults: number,
  withinMinutes: number,
  q?: Queryable,
): Promise<boolean> {
  const { rows } = await db(q).query(
    `SELECT 1 FROM collection_attempt
      WHERE hotel_id = $1 AND check_in = $2::date AND nights = $3 AND adults = $4
        AND consecutive_failures > 0
        AND last_attempt_at > now() - ($5 || ' minutes')::interval
      LIMIT 1`,
    [hotelId, checkIn, nights, adults, withinMinutes],
  );
  return rows.length > 0;
}

/**
 * How many of these hotels were asked about THIS stay recently.
 *
 * The comp-set top-up needs its own hold, and it cannot borrow the subject's.
 * `wasStayRecentlyFruitless` keys on the stay that succeeded — and in the case
 * the top-up exists for, the subject DID succeed, so its guard returns false
 * forever and every page view would re-fetch the whole comp set. This asks the
 * question that actually bounds the spend: have we already asked these hotels
 * about this stay, whatever the answer was?
 *
 * Deliberately not filtered on `consecutive_failures`. A comp that answered a
 * rate we could not use, and a comp that answered nothing, both mean the same
 * thing here — we asked, and the comp set is still thin. Asking again minutes
 * later is spend with no new information either way.
 */
export async function countRecentAttempts(
  hotelIds: readonly number[],
  checkIn: string,
  nights: number,
  adults: number,
  withinMinutes: number,
  q?: Queryable,
): Promise<number> {
  if (hotelIds.length === 0) return 0;
  const { rows } = await db(q).query(
    `SELECT count(*)::int AS n FROM collection_attempt
      WHERE hotel_id = ANY($1::bigint[])
        AND check_in = $2::date AND nights = $3 AND adults = $4
        AND last_attempt_at > now() - ($5 || ' minutes')::interval`,
    [[...hotelIds], checkIn, nights, adults, withinMinutes],
  );
  return (rows[0]?.n as number) ?? 0;
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
 * Keyed by grid slot (`lead_days` computed at write time), so a stay that
 * never prices keeps ONE row whose failure count accumulates as the grid
 * rolls, instead of a fresh row per date whose count restarts daily.
 * `check_in` is carried as data — "the date last attempted" — for the
 * runbook's diagnostics and for `findMarketCompression`, which reads
 * sold-out evidence by exact stay date.
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
         (hotel_id, lead_days, check_in, nights, adults, attempts,
          consecutive_failures, last_attempt_at, last_outcome)
       VALUES ($1,($2::date - CURRENT_DATE)::smallint,$2::date,$3,$4,1,$5,now(),$6)
       ON CONFLICT (hotel_id, lead_days, nights, adults) DO UPDATE
         SET attempts = collection_attempt.attempts + 1,
             consecutive_failures =
               CASE WHEN $5 = 0 THEN 0 ELSE collection_attempt.consecutive_failures + 1 END,
             check_in = EXCLUDED.check_in,
             last_attempt_at = now(),
             last_outcome = EXCLUDED.last_outcome`,
      [o.hotelId, o.checkIn, o.nights, o.adults, o.succeeded ? 0 : 1, o.outcome],
    );
    written += rowCount ?? 0;
  }
  return written;
}
