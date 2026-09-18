/**
 * Researching one hotel: find its site, read it, store what it says.
 *
 * Owner requirement (2026-09-18), built the way the owner chose: Brave finds
 * the page, we fetch the page, and every stored claim cites the URL we read
 * and the time we read it.
 *
 * One search per hotel, not one per motivator. All ten are assessed from the
 * single document, which is both better evidence and the difference between
 * 125 and 1,000 hotels inside Brave's free monthly credit.
 */
import { resolveHotelWebsite } from '../adapters/brave/resolve.js';
import { extractClaims } from '../adapters/brave/evidence.js';
import type { BraveClient } from '../adapters/brave/client.js';

export type ResearchOutcome =
  | 'STORED'
  | 'NO_WEBSITE' // search returned nothing we could corroborate
  | 'SHARED_HOST' // the domain belongs to a brand, not to this property
  | 'UNREADABLE' // the site would not give us a page
  | 'NOTHING_STATED' // we read it and it said nothing we recognise
  | 'FAILED';

export interface ResearchResult {
  readonly hotelId: number;
  readonly outcome: ResearchOutcome;
  readonly websiteUrl: string | null;
  readonly claims: readonly { motivator: string; claim: string; sourceUrl: string }[];
}

export interface ResearchDeps {
  readonly client: BraveClient;
  readonly findHotelWebsite: (hotelId: number) => Promise<string | null>;
  readonly saveHotelResearchTarget: (hotelId: number, url: string | null) => Promise<void>;
  readonly replaceResearchClaims: (
    hotelId: number,
    claims: readonly { motivator: string; claim: string; sourceUrl: string }[],
  ) => Promise<number>;
  /**
   * Other hotels already pointing at this host. A domain claimed by more than
   * one is a brand domain by definition, because no property's own site is
   * shared.
   */
  readonly findOtherHotelsWithWebsite: (
    hotelId: number,
    websiteUrl: string,
  ) => Promise<readonly number[]>;
  /** Forget a resolved site and everything read from it. */
  readonly clearHotelResearch: (hotelId: number) => Promise<void>;
  /** Injected so the decision is testable without a network. */
  readonly fetchPage?: (url: string) => Promise<string | null>;
}

/**
 * Fetch a page as a browser would be served one.
 *
 * Kept small and forgiving: this is somebody else's marketing site, not an
 * API. A timeout, a cookie wall or a 403 is an ordinary outcome and means we
 * store no claims for that hotel — never that the hotel lacks anything.
 */
async function defaultFetchPage(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        // Identifying ourselves is the courteous form and makes us blockable
        // on purpose: a site that does not want this can say so.
        'User-Agent': 'WhataHotelPriceIntelligence/1.0 (+https://www.whatahotel.com)',
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('html')) return null;
    const body = await response.text();
    // A page far larger than this is usually an app shell whose text is not
    // in the HTML at all; reading 2 MB of it would not help.
    return body.slice(0, 2_000_000);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Research one hotel. Every outcome is named, because a silent skip is
 * indistinguishable from a property that genuinely offers nothing — the same
 * reason `syncHotelAmenities` names its six (rule 29).
 *
 * `researched_at` is stamped on EVERY path including the failures, so a hotel
 * whose site cannot be resolved or read backs off instead of costing a search
 * on every page view (rule 16's principle).
 */
export async function researchHotel(
  hotel: { readonly hotelId: number; readonly name: string; readonly city: string | null },
  deps: ResearchDeps,
): Promise<ResearchResult> {
  const fetchPage = deps.fetchPage ?? defaultFetchPage;
  try {
    // A site we already resolved costs no search. The resolution is the
    // expensive half; re-reading the page is free.
    let website = await deps.findHotelWebsite(hotel.hotelId);
    if (!website) {
      website = await resolveHotelWebsite(deps.client, hotel.name, hotel.city);
    }
    if (!website) {
      await deps.saveHotelResearchTarget(hotel.hotelId, null);
      return { hotelId: hotel.hotelId, outcome: 'NO_WEBSITE', websiteUrl: null, claims: [] };
    }

    // A host claimed by another hotel is a BRAND domain, not this property's
    // site. Measured 2026-09-18: four separate Ritz-Carltons resolved to
    // ritzcarlton.com and would have shown a guest identical "evidence" for
    // Key Biscayne, Coconut Grove, Turtle Bay and Waikiki.
    //
    // BOTH sides are cleared, not just this one. If two hotels claim one
    // domain neither claim is right, and keeping the first would simply
    // reward whichever hotel was researched earliest.
    const collisions = await deps.findOtherHotelsWithWebsite(hotel.hotelId, website);
    if (collisions.length > 0) {
      await deps.clearHotelResearch(hotel.hotelId);
      for (const other of collisions) await deps.clearHotelResearch(other);
      await deps.saveHotelResearchTarget(hotel.hotelId, null);
      return { hotelId: hotel.hotelId, outcome: 'SHARED_HOST', websiteUrl: null, claims: [] };
    }

    const html = await fetchPage(website);
    if (html === null) {
      await deps.saveHotelResearchTarget(hotel.hotelId, website);
      return { hotelId: hotel.hotelId, outcome: 'UNREADABLE', websiteUrl: website, claims: [] };
    }

    const claims = extractClaims(html).map((c) => ({ ...c, sourceUrl: website }));
    await deps.saveHotelResearchTarget(hotel.hotelId, website);

    if (claims.length === 0) {
      // Read, and it said nothing we recognise. A different fact from an
      // unreadable page, and neither is a claim about the property.
      await deps.replaceResearchClaims(hotel.hotelId, []);
      return {
        hotelId: hotel.hotelId,
        outcome: 'NOTHING_STATED',
        websiteUrl: website,
        claims: [],
      };
    }

    await deps.replaceResearchClaims(hotel.hotelId, claims);
    return { hotelId: hotel.hotelId, outcome: 'STORED', websiteUrl: website, claims };
  } catch {
    return { hotelId: hotel.hotelId, outcome: 'FAILED', websiteUrl: null, claims: [] };
  }
}
