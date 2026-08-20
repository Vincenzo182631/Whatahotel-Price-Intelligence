/**
 * On-demand stay collection: fetch, ingest and store ONE guest's stay — plus
 * its comparables' rates for the same stay — synchronously, so the live model
 * can score dates nothing has collected yet.
 *
 * This deliberately relaxes an earlier design rule ("the API never calls a
 * rate source synchronously on a page view"). The collector's grid covers ~46
 * stay shapes per hotel; guests pick arbitrary dates, and without this path
 * every off-grid search rendered the honest empty state forever. The product
 * decision (2026-08-20) is: attempt a live fetch, and if the data cannot be
 * verified, STILL show no score rather than inventing one — the honesty rules
 * are unchanged, only the coverage is wider.
 *
 * What keeps it safe against an API whose rate limit is unknown (U15):
 *
 *   - Only catalogued, active hotels. Unknown hotels still 404 with no fetch.
 *   - A lead-time window (0..MAX_LEAD). The source is verified ~7 months out;
 *     beyond it a fetch is spend with no possible answer.
 *   - The fruitless-attempt guard: a stay that yielded nothing minutes ago is
 *     not retried per page view. Failures are recorded in collection_attempt
 *     exactly as the scheduled collector records them, so the two paths share
 *     one backoff ledger and the compression signal sees on-demand sold-outs.
 *   - A hard cap on comparables fetched per request.
 *
 * Everything fetched is ingested through the same pipeline as scheduled
 *  collection — same validation, same rejects, same dedup — so an on-demand
 * observation is indistinguishable from a scheduled one, and every guest
 * search permanently widens the dataset.
 */

import {
  findComparableIdentities,
  recordCollectionAttempts,
  wasStayRecentlyFruitless,
  type AttemptOutcome,
} from '@wahpi/data';

import type { RateQuery, RawRateRecord } from '../adapters/RateSourceAdapter.js';
import {
  WHATAHOTEL_INGEST_TUNING,
  WHATAHOTEL_SOURCE_CODE,
  createWhataHotelAdapter,
} from '../adapters/whatahotel/index.js';
import { DEFAULT_INGEST_OPTIONS, ingestRecords, ingestStayKey } from './pipeline.js';

export interface OnDemandStay {
  readonly hotelId: number;
  readonly wahHotelId: string;
  readonly checkIn: string;
  readonly nights: number;
  readonly adults: number;
  readonly children: number;
}

export interface OnDemandOptions {
  /** Beyond this lead the source has no verified answer; skip the spend. */
  readonly maxLeadDays: number;
  /** Comparables fetched alongside the subject, at most. */
  readonly maxComparables: number;
  /** A fruitless attempt younger than this blocks a refetch. */
  readonly retryHoldMinutes: number;
  readonly now?: Date;
}

export const DEFAULT_ON_DEMAND_OPTIONS: OnDemandOptions = {
  // The source is verified ~7 months out (U2). 300 keeps a safety margin, and
  // the smoke suite's deliberately-unfetchable stays sit far beyond it.
  maxLeadDays: 300,
  // Subject + 8 ≈ 9 calls ≈ 5–7s at the client's concurrency, inside the
  // function's budget. Eight rather than six because the comp set matches on
  // rate TERMS, and the source states them inconsistently: on a cold Honolulu
  // request only 2 of 6 fetched comps shared the subject's terms, which is
  // below the CSI minimum of 3. Widening the candidate pool is the fix that
  // costs latency; relaxing the terms match would cost honesty (rule 5).
  maxComparables: 8,
  retryHoldMinutes: 15,
};

export type OnDemandSkipReason =
  'NO_API_KEY' | 'DISABLED' | 'LEAD_OUT_OF_RANGE' | 'RECENTLY_FRUITLESS';

export interface OnDemandResult {
  readonly performed: boolean;
  readonly skipped?: OnDemandSkipReason;
  readonly staysQueried: number;
  readonly ratesFetched: number;
  readonly inserted: number;
  readonly rejected: number;
  /** True when the SUBJECT stay produced at least one stored observation. */
  readonly subjectTracked: boolean;
}

const NOT_PERFORMED = (skipped: OnDemandSkipReason): OnDemandResult => ({
  performed: false,
  skipped,
  staysQueried: 0,
  ratesFetched: 0,
  inserted: 0,
  rejected: 0,
  subjectTracked: false,
});

/** Days from today to the stay's check-in, in UTC. Pure, for the guard. */
export function leadDaysOf(checkIn: string, now: Date): number {
  const today = Date.parse(now.toISOString().slice(0, 10) + 'T00:00:00Z');
  return Math.round((Date.parse(checkIn + 'T00:00:00Z') - today) / 86_400_000);
}

/**
 * The queries one on-demand request makes: the subject stay first, then the
 * same stay at each comparable. Pure, so the fan-out rule is unit-testable.
 */
export function planOnDemandQueries(
  stay: OnDemandStay,
  comparables: readonly { hotelId: number; wahHotelId: string }[],
  maxComparables: number,
): { queries: RateQuery[]; hotelIdByWahId: Map<string, number> } {
  const hotelIdByWahId = new Map<string, number>([[stay.wahHotelId, stay.hotelId]]);
  const subject: RateQuery = {
    wahHotelId: stay.wahHotelId,
    checkIn: stay.checkIn,
    nights: stay.nights,
    adults: stay.adults,
    children: stay.children,
    currency: 'USD',
  };
  const queries: RateQuery[] = [subject];
  for (const comp of comparables.slice(0, maxComparables)) {
    if (hotelIdByWahId.has(comp.wahHotelId)) continue;
    hotelIdByWahId.set(comp.wahHotelId, comp.hotelId);
    queries.push({ ...subject, wahHotelId: comp.wahHotelId });
  }
  return { queries, hotelIdByWahId };
}

/**
 * Fetch and ingest one stay (plus comparables) right now.
 *
 * Never throws for source-side trouble: a failed fetch degrades to
 * `performed: true, subjectTracked: false` and the caller renders the honest
 * no-score state. Only programming errors propagate.
 */
export async function collectStayOnDemand(
  stay: OnDemandStay,
  options: OnDemandOptions = DEFAULT_ON_DEMAND_OPTIONS,
): Promise<OnDemandResult> {
  if (!process.env.WAH_API_KEY) return NOT_PERFORMED('NO_API_KEY');
  if (process.env.ON_DEMAND_SCORING === '0') return NOT_PERFORMED('DISABLED');

  const now = options.now ?? new Date();
  const lead = leadDaysOf(stay.checkIn, now);
  if (lead < 0 || lead > options.maxLeadDays) return NOT_PERFORMED('LEAD_OUT_OF_RANGE');

  if (
    await wasStayRecentlyFruitless(
      stay.hotelId,
      stay.checkIn,
      stay.nights,
      stay.adults,
      options.retryHoldMinutes,
    )
  ) {
    return NOT_PERFORMED('RECENTLY_FRUITLESS');
  }

  const comparables = await findComparableIdentities(stay.hotelId, options.maxComparables);
  const { queries, hotelIdByWahId } = planOnDemandQueries(
    stay,
    comparables,
    options.maxComparables,
  );
  const subjectQuery = queries[0] as RateQuery;

  const failures = new Set<string>();
  const soldOut = new Set<string>();
  const queryKey = (q: RateQuery) => `${q.wahHotelId}|${q.checkIn}|${q.nights}|${q.adults}`;
  const adapter = createWhataHotelAdapter({
    concurrency: 6,
    continueOnError: true,
    onError: (query) => failures.add(queryKey(query)),
    onNoAvailability: (query) => soldOut.add(queryKey(query)),
  });

  let records: RawRateRecord[] = [];
  try {
    records = await adapter.fetchRates(queries);
  } catch (err) {
    // continueOnError already contains per-stay faults; this is a total one
    // (network down, key revoked). Degrade — the honest empty state is the
    // designed answer when nothing can be verified.
    console.error('on-demand fetch failed:', (err as Error).message);
    return {
      performed: true,
      staysQueried: queries.length,
      ratesFetched: 0,
      inserted: 0,
      rejected: 0,
      subjectTracked: false,
    };
  }

  const ingest =
    records.length > 0
      ? await ingestRecords(records, {
          ...DEFAULT_INGEST_OPTIONS,
          ...WHATAHOTEL_INGEST_TUNING,
          sourceCode: WHATAHOTEL_SOURCE_CODE,
        })
      : null;
  const tracked = ingest?.trackedStays ?? new Set<string>();
  const fetched = new Set(records.map((r) => ingestStayKey(r)));

  // Same ledger, same semantics as the scheduled collector: succeeded means
  // tracked, and a stay that yields nothing backs off (rule 16).
  const outcomes: AttemptOutcome[] = queries.map((q) => {
    const key = queryKey(q);
    return {
      hotelId: hotelIdByWahId.get(q.wahHotelId) as number,
      checkIn: q.checkIn,
      nights: q.nights,
      adults: q.adults,
      succeeded: tracked.has(key),
      outcome: failures.has(key)
        ? 'ERROR'
        : soldOut.has(key)
          ? 'NO_AVAILABILITY'
          : tracked.has(key)
            ? 'OK'
            : fetched.has(key)
              ? 'REJECTED'
              : 'EMPTY',
    };
  });
  await recordCollectionAttempts(outcomes);

  return {
    performed: true,
    staysQueried: queries.length,
    ratesFetched: records.length,
    inserted: ingest?.inserted ?? 0,
    rejected: ingest?.rejected ?? 0,
    subjectTracked: tracked.has(queryKey(subjectQuery)),
  };
}
