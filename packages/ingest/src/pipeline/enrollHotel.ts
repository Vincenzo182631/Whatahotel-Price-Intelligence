/**
 * Automatic catalogue enrollment: teach the system about a hotel the moment
 * someone asks about it, instead of requiring a person to sync a city first.
 *
 * The catalogue used to be whatever a human had dispatched — 15 Miami hotels,
 * because `--catalog miami` was run once. Every other hotel on whatahotel.com
 * answered 404 and the widget hid, which is indistinguishable from broken. The
 * source is the authority on its own inventory, so the system asks it.
 *
 * Two steps, and the second is the one that matters:
 *
 *   1. `hotel` for the id itself — name, city, region, country, coordinates,
 *      perks. Verified to answer for arbitrary ids (2008 → The Royal Hawaiian,
 *      Honolulu), so nothing has to be pre-registered.
 *   2. `cityrates` for the city it turns out to be in. A hotel alone in a
 *      destination has no comp set and therefore no Comp-Set Index — 45% of
 *      the live score. Enrolling the city is what makes the FIRST request for
 *      a new destination scoreable rather than honestly empty.
 *
 * Guards, because this runs on a page view against an API whose rate limit is
 * unknown (U15):
 *
 *   - a negative cache, so a bogus id in someone's URL cannot cost one lookup
 *     per page view,
 *   - a positive cache, so a burst of traffic to a newly enrolled city does
 *     not re-sync it,
 *   - the city sync runs only when the destination is genuinely thin, so an
 *     established city costs one call, not two.
 *
 * Nothing here fabricates a hotel. If the source does not know the id, the
 * caller still renders no score.
 */

import { db, type Queryable } from '@wahpi/data';

import { WahClient } from '../adapters/whatahotel/client.js';
import { syncHotelById, syncHotelsFromCity } from '../adapters/whatahotel/catalog.js';

export interface EnrollOptions {
  /** A destination with fewer than this many hotels gets a city sync. */
  readonly thinDestinationBelow: number;
  /** How long a failed lookup suppresses another attempt. */
  readonly negativeTtlMs: number;
  /** How long a successful enrollment suppresses another city sync. */
  readonly positiveTtlMs: number;
}

export const DEFAULT_ENROLL_OPTIONS: EnrollOptions = {
  // The comp set needs a handful of same-destination hotels to mean anything;
  // below this the city sync is worth its one API call.
  thinDestinationBelow: 6,
  negativeTtlMs: 10 * 60_000,
  positiveTtlMs: 60 * 60_000,
};

export type EnrollOutcome =
  | 'ENROLLED' // the hotel is now in the catalogue
  | 'ALREADY_PRESENT'
  | 'UNKNOWN_TO_SOURCE' // the source has no such hotel
  | 'NO_API_KEY'
  | 'SUPPRESSED' // asked too recently
  | 'FAILED';

export interface EnrollResult {
  readonly outcome: EnrollOutcome;
  readonly hotelsWritten: number;
  readonly citySynced: string | null;
}

/**
 * Process-local, deliberately. A serverless instance is short-lived, so this
 * is a burst damper rather than durable state — it costs nothing and needs no
 * schema. The durable protection against re-fetching stays is the
 * `collection_attempt` ledger the on-demand path already writes to.
 */
const seen = new Map<string, { until: number; outcome: EnrollOutcome }>();

function remember(id: string, outcome: EnrollOutcome, ttl: number): void {
  seen.set(id, { until: Date.now() + ttl, outcome });
  // Unbounded growth would be a slow leak in a long-lived host.
  if (seen.size > 500) {
    const now = Date.now();
    for (const [k, v] of seen) if (v.until <= now) seen.delete(k);
  }
}

/**
 * Make sure the hotel's destination has enough siblings to compare it against.
 *
 * Separate from `enrollHotel` because it answers a different question. Enrollment
 * asks "does this hotel exist"; this asks "do we know its neighbourhood", which
 * matters even for a hotel we already have — the full-inventory sweep catalogues
 * hotels one id at a time and has no notion of a city, so a destination can be
 * populated unevenly. A comp set is 45% of the live score, and a hotel alone in
 * its destination has none.
 *
 * Costs NOTHING in the common case: the sibling count is one indexed query, and
 * the API is called only when the destination is genuinely thin.
 */
export async function ensureDestinationDepth(
  wahHotelId: string,
  options: EnrollOptions = DEFAULT_ENROLL_OPTIONS,
  q?: Queryable,
): Promise<EnrollResult> {
  const none = (outcome: EnrollOutcome): EnrollResult => ({
    outcome,
    hotelsWritten: 0,
    citySynced: null,
  });

  if (!process.env.WAH_API_KEY) return none('NO_API_KEY');
  if (process.env.AUTO_ENROLL_HOTELS === '0') return none('SUPPRESSED');

  const cacheKey = `city:${wahHotelId}`;
  const cached = seen.get(cacheKey);
  if (cached && cached.until > Date.now()) return none('SUPPRESSED');

  const { city, siblings } = await destinationDepth(wahHotelId, q);
  if (!city || siblings >= options.thinDestinationBelow) return none('ALREADY_PRESENT');

  try {
    const result = await syncCity(WahClient.fromEnv({ concurrency: 2 }), city, q);
    remember(cacheKey, 'ENROLLED', options.positiveTtlMs);
    return { outcome: 'ENROLLED', hotelsWritten: result.hotelsWritten, citySynced: city };
  } catch (err) {
    console.error('destination depth sync failed:', (err as Error).message);
    remember(cacheKey, 'FAILED', options.negativeTtlMs);
    return none('FAILED');
  }
}

/**
 * Pull the source's ranked hotels for this city, for the guest's EXACT dates.
 *
 * `cityrates` is the API's "best hotels in this city" answer: up to 15 hotels,
 * returned in descending `rank` order, each with a dated `rateTotal` and its
 * perks. It is the only cross-hotel prominence signal the API offers, and it is
 * a better comp-set shortlist than "whichever ids the sweep reached first"
 * — the source's own opinion of which hotels in a destination matter.
 *
 * Called with the guest's dates rather than arbitrary ones, so the rank and the
 * rates describe the stay being scored. What comes back is persisted through
 * the ordinary catalogue path: unknown hotels are added at tier OFF, and
 * `city_rank` lands on every one of them (see migration 0012).
 *
 * This only DISCOVERS and RANKS. It fetches no rates itself — the comparables'
 * rates come from the ordinary on-demand fetch, through the ordinary pipeline,
 * with the ordinary validation. One method's cheap list is not a substitute for
 * a priced, term-classified observation.
 */
export async function discoverCityComparables(
  wahHotelId: string,
  checkIn: string,
  checkOut: string,
  guests = 2,
  options: EnrollOptions = DEFAULT_ENROLL_OPTIONS,
  q?: Queryable,
): Promise<EnrollResult> {
  const none = (outcome: EnrollOutcome): EnrollResult => ({
    outcome,
    hotelsWritten: 0,
    citySynced: null,
  });

  if (!process.env.WAH_API_KEY) return none('NO_API_KEY');
  if (process.env.AUTO_ENROLL_HOTELS === '0') return none('SUPPRESSED');

  // Keyed on the STAY as well as the hotel: the ranking and the rates are
  // date-specific, so a different stay is a different question. Without the
  // dates in the key one guest's search would suppress every other guest's.
  const cacheKey = `city:${wahHotelId}|${checkIn}|${checkOut}|${guests}`;
  const cached = seen.get(cacheKey);
  if (cached && cached.until > Date.now()) return none('SUPPRESSED');

  const { city } = await destinationDepth(wahHotelId, q);
  if (!city) return none('UNKNOWN_TO_SOURCE');

  try {
    const result = await syncHotelsFromCity(
      WahClient.fromEnv({ concurrency: 2 }),
      city,
      checkIn,
      checkOut,
      guests,
      q,
      // Catalogued, not scheduled — see syncHotelsFromCity. These are
      // comparables; their rates are fetched live for the stay being scored.
      'OFF',
    );
    remember(cacheKey, 'ENROLLED', options.positiveTtlMs);
    return { outcome: 'ENROLLED', hotelsWritten: result.hotelsWritten, citySynced: city };
  } catch (err) {
    console.error('city comparable discovery failed:', (err as Error).message);
    remember(cacheKey, 'FAILED', options.negativeTtlMs);
    return none('FAILED');
  }
}

/** The hotel's city and how many active hotels share its destination. */
async function destinationDepth(
  wahHotelId: string,
  q?: Queryable,
): Promise<{ city: string | null; siblings: number }> {
  const { rows } = await db(q).query(
    `SELECT d.name AS city,
            (SELECT count(*) FROM hotel s
              WHERE s.destination_id = h.destination_id AND s.is_active) AS siblings
       FROM hotel h LEFT JOIN destination d ON d.id = h.destination_id
      WHERE h.wah_hotel_id = $1`,
    [wahHotelId],
  );
  return {
    city: (rows[0]?.city as string | null) ?? null,
    siblings: Number(rows[0]?.siblings ?? 0),
  };
}

/**
 * `cityrates` needs dates it does not use for the catalogue it returns, so ask
 * for the cheapest thing there is: a near-term stay.
 */
function syncCity(client: WahClient, city: string, q?: Queryable) {
  const from = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 33 * 86_400_000).toISOString().slice(0, 10);
  return syncHotelsFromCity(client, city, from, to, 2, q, 'OFF');
}

export async function enrollHotel(
  wahHotelId: string,
  options: EnrollOptions = DEFAULT_ENROLL_OPTIONS,
  q?: Queryable,
): Promise<EnrollResult> {
  const none = (outcome: EnrollOutcome): EnrollResult => ({
    outcome,
    hotelsWritten: 0,
    citySynced: null,
  });

  if (!process.env.WAH_API_KEY) return none('NO_API_KEY');
  if (process.env.AUTO_ENROLL_HOTELS === '0') return none('SUPPRESSED');

  const cached = seen.get(wahHotelId);
  if (cached && cached.until > Date.now()) return none('SUPPRESSED');

  const client = WahClient.fromEnv({ concurrency: 2 });

  try {
    const added = await syncHotelById(client, wahHotelId, q);
    if (added.hotelsWritten === 0) {
      // The source does not recognise it. Remember, so a mistyped id in a URL
      // does not cost a lookup per page view.
      remember(wahHotelId, 'UNKNOWN_TO_SOURCE', options.negativeTtlMs);
      return { outcome: 'UNKNOWN_TO_SOURCE', hotelsWritten: 0, citySynced: null };
    }

    // How thin is the destination this hotel landed in? A lone hotel cannot be
    // compared to anything, so its city is worth pulling in the same request.
    const { city, siblings } = await destinationDepth(wahHotelId, q);

    let citySynced: string | null = null;
    let written = added.hotelsWritten;

    if (city && siblings < options.thinDestinationBelow) {
      try {
        const cityResult = await syncCity(client, city, q);
        written += cityResult.hotelsWritten;
        citySynced = city;
      } catch (err) {
        // The hotel itself is enrolled; a failed city sync only means a thin
        // comp set this time. Never fail the request for it.
        console.error('city sync during enrollment failed:', (err as Error).message);
      }
    }

    remember(wahHotelId, 'ENROLLED', options.positiveTtlMs);
    return { outcome: 'ENROLLED', hotelsWritten: written, citySynced };
  } catch (err) {
    console.error('hotel enrollment failed:', (err as Error).message);
    remember(wahHotelId, 'FAILED', options.negativeTtlMs);
    return none('FAILED');
  }
}
