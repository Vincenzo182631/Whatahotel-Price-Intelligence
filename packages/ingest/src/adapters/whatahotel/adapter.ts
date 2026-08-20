/**
 * The WhataHotel rate source adapter.
 *
 * Built against captured responses from `/data/api.cfm`; the payloads it was
 * derived from are committed under tests/fixtures/whatahotel/ and the parsing
 * rules are verified against them.
 *
 * What this source does and does not provide (the U-register, answered):
 *
 *   U1  stable hotel id ............. YES — `hotel.id`, integer, e.g. "951"
 *   U2  arbitrary future dates ...... YES — verified 7 months out
 *   U3  HISTORICAL rates ............ **NO** — live quotes only, no history
 *   U4  per-room rates .............. YES — one record per bookCode
 *   U5  cancellation terms .......... **NO** — see comparabilityClassFor
 *   U6  occupancy ................... PARTIAL — total `guests`, not adults/children
 *   U7  total + nightly, tax basis .. YES — rateDaily NET/night, rateTotal GROSS/stay
 *                                     Both are kept: rateTotal is the stay
 *                                     total, rateDaily is the ADR the site
 *                                     quotes (reconstructed by migration 0011).
 *   U8  stable rate plan codes ...... YES — `rateCode`
 *   U9  structured room codes ....... YES — `bookCode`, the SOURCE_ID path
 *   U10 benefits .................... YES — hotel `perks`
 *   U11 availability / rooms left ... **NO** — absent from the payload
 *
 * **U3 is the consequential one.** This API answers "what is the rate now",
 * never "what was it". The 90-day baseline the Deal Score needs can only be
 * built by capturing forward from today — the cold-start problem from the
 * original assessment, now confirmed rather than assumed.
 */

import { normalizeRoomName } from '@wahpi/core';

import type { RateQuery, RateSourceAdapter, RawRateRecord } from '../RateSourceAdapter.js';
import { WahClient, type WahClientOptions } from './client.js';
import { parseRoom } from './parse.js';
import { WahApiError, type WahRatesResponse } from './types.js';

export const WHATAHOTEL_SOURCE_CODE = 'WAH_API';

/**
 * Ingest settings this source requires, established by running it.
 *
 * Not defaults anyone should have to rediscover: each value here fixes a
 * specific failure observed against the live API.
 */
export const WHATAHOTEL_INGEST_TUNING = {
  /** The API supplies a stable bookCode per room (U9); nothing pre-populates
   *  room types, so the first run has nothing to match against. */
  discoverRoomTypes: true,
  roomMatch: {
    /** Room names here are machine-generated and stable, so exact and
     *  source-code matching suffice. At the 0.45 default, fuzzy matching
     *  merged a Presidential Suite into a Corner Suite. */
    fuzzyMinSimilarity: 0.97,
    fuzzyMinMargin: 0.08,
    /** Same reason: the coarse class×bed×view vector merged distinct suites. */
    attributeInference: false,
  },
} as const;

export interface WhataHotelAdapterOptions extends Partial<WahClientOptions> {
  /** Continue the batch when one stay fails, instead of aborting all of it. */
  readonly continueOnError?: boolean;
  readonly onError?: (query: RateQuery, error: Error) => void;
  /**
   * A stay came back sold out. Not an error, but not nothing either: a run
   * where most stays are unavailable produced far less data than its task
   * count suggests, and that has to be visible rather than inferred.
   */
  readonly onNoAvailability?: (query: RateQuery) => void;
}

export function createWhataHotelAdapter(
  options: WhataHotelAdapterOptions = {},
): RateSourceAdapter & { readonly client: WahClient } {
  const client =
    options.apiKey !== undefined
      ? new WahClient({ ...options, apiKey: options.apiKey })
      : WahClient.fromEnv(options);

  const continueOnError = options.continueOnError ?? true;

  return {
    code: WHATAHOTEL_SOURCE_CODE,
    displayName: 'WhataHotel data API',
    isAuthoritative: true,
    client,

    async fetchRates(queries: readonly RateQuery[]): Promise<RawRateRecord[]> {
      const out: RawRateRecord[] = [];

      // Each query is one API call at ~2.4s; the client's concurrency limiter
      // is what makes a batch finish in reasonable time.
      const results = await Promise.all(
        queries.map(async (query) => {
          try {
            const data = await fetchOne(client, query);
            if (data === null) options.onNoAvailability?.(query);
            return { query, data };
          } catch (err) {
            options.onError?.(query, err as Error);
            if (!continueOnError) throw err;
            return { query, data: null };
          }
        }),
      );

      for (const { query, data } of results) {
        if (!data) continue;
        out.push(...toRecords(query, data));
      }
      return out;
    },
  };
}

async function fetchOne(client: WahClient, query: RateQuery): Promise<WahRatesResponse | null> {
  try {
    return await client.call<WahRatesResponse>('rates', {
      hotel: query.wahHotelId,
      // The API takes a single `guests` total; it has no children parameter.
      guests: query.adults + query.children,
      checkIn: query.checkIn,
      checkOut: addDays(query.checkIn, query.nights),
    });
  } catch (err) {
    // Sold out is an answer, not a fault: no rates exist for these dates, and
    // the run is healthy. A 500 is NOT swallowed here — after the client has
    // exhausted its retries it is a real outage, and hiding it behind an empty
    // result would let collection quietly stop while reporting success.
    if (err instanceof WahApiError && err.noAvailability) return null;
    throw err;
  }
}

/**
 * Collapse rates that are identical in every dimension the payload exposes
 * but differ in price, keeping the cheapest.
 *
 * ~1.6% of live rates do this: same room text, same rate code, same offer,
 * different bookCode, different price — separate allotments the API gives us
 * no field to tell apart. They collide on the ingest dedup key regardless, so
 * the only question is which one survives. First-wins would store an arbitrary
 * price, up to 8% above the cheapest; the minimum is the rate a traveler can
 * actually book, and the bookCode kept is the one that gets it.
 *
 * This is NOT a substitute for modelling a real distinction. Where the payload
 * DOES distinguish two products — a different offer, a different room — they
 * stay separate; see sourcePlanCodeFor.
 */
function keepCheapestIndistinguishable(records: RawRateRecord[]): {
  records: RawRateRecord[];
  collapsed: number;
} {
  const best = new Map<string, RawRateRecord>();
  let collapsed = 0;

  for (const record of records) {
    const key = `${normalizeRoomName(record.rawRoomName)}|${record.sourcePlanCode ?? ''}`;
    const existing = best.get(key);
    if (!existing) {
      best.set(key, record);
      continue;
    }
    collapsed += 1;
    if (record.totalAmountMinor < existing.totalAmountMinor) best.set(key, record);
  }

  return { records: [...best.values()], collapsed };
}

/** Convert one rates response into RawRateRecords. */
export function toRecords(query: RateQuery, data: WahRatesResponse): RawRateRecord[] {
  const observedAt = new Date().toISOString();
  const nights = Number(data.stay?.nights ?? query.nights) || query.nights;
  const rooms = data.rooms ?? [];
  const out: RawRateRecord[] = [];

  for (const room of rooms) {
    const parsed = parseRoom(room, nights);
    if (!parsed) continue;

    out.push({
      wahHotelId: data.hotel?.id ?? query.wahHotelId,
      rawRoomName: parsed.rawRoomName,
      displayRoomName: parsed.displayRoomName,
      sourceRoomCode: parsed.sourceRoomCode,
      sourcePlanCode: parsed.sourcePlanCode,
      rawPlanName: parsed.planName,

      checkIn: data.stay?.['check-in'] ?? query.checkIn,
      nights,
      adults: query.adults,
      children: query.children,

      currency: parsed.currency,
      // The engine scores on what the traveler pays, so the stored total is the
      // GROSS whole-stay amount. rateDaily is NET and would understate the
      // price by the tax factor (~25% at the hotel this was verified against).
      totalAmountMinor: parsed.totalGrossMinor,
      totalGrossAmountMinor: parsed.totalGrossMinor,
      // Load-bearing, not diagnostic: ADR is derived as
      // (total - taxes) / nights (migration 0011), so this field is what keeps
      // the widget's nightly rate on the same basis as whatahotel.com's own
      // quote. Getting it wrong misprices every night by the tax factor.
      taxesFeesMinor: Math.max(0, parsed.totalGrossMinor - parsed.nightlyNetMinor * nights),
      taxBasis: 'GROSS',

      mealPlan: parsed.terms.mealPlan,
      refundPolicy: parsed.terms.refundPolicy,
      isPrepaid: parsed.terms.isPrepaid,
      audience: parsed.terms.audience,
      // The payload has no cancellation terms, so the semantic class would be
      // UNRESOLVED and every rate excluded from every baseline. Keyed on the
      // source's own rate-plan code instead. See parse.ts.
      comparabilityClassOverride: parsed.comparabilityClass,

      // Not exposed by this API (U11). Left null rather than defaulted, so the
      // scarcity guard stays inert rather than acting on an invented number.
      roomsLeft: null,
      isAvailable: true,
      observedAt,

      raw: {
        source: WHATAHOTEL_SOURCE_CODE,
        hotel: data.hotel,
        stay: data.stay,
        room: { ...room, images: undefined },
        amadeusProperty: data.amadeus?.codes ?? null,
      },
    });
  }

  return keepCheapestIndistinguishable(out).records;
}

function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
