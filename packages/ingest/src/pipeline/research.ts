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
import { registrableDomain, resolveHotelWebsite } from '../adapters/brave/resolve.js';
import { extractClaims } from '../adapters/brave/evidence.js';
import type { BraveClient } from '../adapters/brave/client.js';

export type ResearchOutcome =
  | 'STORED'
  | 'NO_WEBSITE' // search returned nothing we could corroborate
  | 'SHARED_HOST' // the domain belongs to a brand, not to this property
  | 'REJECTED_HOST' // a human judged this domain not to be a property site
  | 'UNREADABLE' // the site would not give us a page
  | 'NOTHING_STATED' // we read it and it said nothing we recognise
  | 'FAILED';

export interface ResearchResult {
  readonly hotelId: number;
  readonly outcome: ResearchOutcome;
  readonly websiteUrl: string | null;
  readonly claims: readonly { motivator: string; claim: string; sourceUrl: string }[];
  /**
   * On SHARED_HOST, the registrable domain that collided.
   *
   * Published so a sweep can reconcile it afterwards. A collision clears
   * BOTH sides, and a later hotel resolving to the same domain then stands
   * alone — invisible to `purgeSharedWebsites`, which needs two holders to
   * see anything. Which of several equally-plausible pages survives is then
   * decided by run order, and that is the same arbitrariness the batch purge
   * was written to remove, one level down.
   */
  readonly sharedDomain?: string;
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
   * Other hotels already sitting under this registrable DOMAIN. A domain
   * claimed by more than one is a brand or directory domain by definition,
   * because no property's own site is shared.
   */
  readonly findOtherHotelsWithWebsite: (
    hotelId: number,
    domain: string,
  ) => Promise<readonly number[]>;
  /** Forget a resolved site and everything read from it. */
  readonly clearHotelResearch: (hotelId: number) => Promise<void>;
  /**
   * Hosts a human judged not to be any property's own site (migration 0023).
   * Optional, so a caller that has not loaded them still works — an empty set
   * means the automated checks alone, which is what ran before the review
   * loop existed.
   */
  readonly rejectedHosts?: ReadonlySet<string>;
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

/** The stored URL's host, or '' when it will not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export interface PurgedWebsite {
  /** The registrable domain the colliding hotels shared. */
  readonly domain: string;
  readonly hotelIds: readonly number[];
}

export interface PurgeDeps {
  readonly findAllHotelWebsites: () => Promise<readonly { hotelId: number; websiteUrl: string }[]>;
  readonly clearResearchForHotels: (hotelIds: readonly number[]) => Promise<void>;
}

/**
 * Reconcile the whole catalogue: drop every domain claimed by more than one
 * hotel, and everything read from it.
 *
 * The per-hotel check in `researchHotel` asks "does another hotel already
 * hold this domain", and that question depends on run ORDER. Measured
 * 2026-09-18, second run: hotel 3 resolved ritzcarlton.com with nothing to
 * collide against, hotel 7 collided and cleared both, and hotel 22 then
 * resolved the same domain into the empty slot and stood. Two Ritz-Carltons
 * survived on one brand domain, and which two was an accident of sequence.
 *
 * Asking the question of the FINISHED state has no such hole: a domain held
 * by two hotels is a shared domain whatever order they were researched in.
 * Run this after a sweep.
 *
 * The in-flight check stays, because on-demand research for a single hotel
 * has no batch to reconcile and still needs to catch a domain the catalogue
 * already holds.
 *
 * It groups here rather than in SQL because `registrableDomain` is the
 * resolver's rule about what counts as one site, and one rule with two
 * implementations is two rules.
 *
 * Returns what it purged so a run can report it rather than silently tidying.
 */
export async function purgeSharedWebsites(
  deps: PurgeDeps,
  /**
   * Domains that COLLIDED during the run that is now ending
   * (`ResearchResult.sharedDomain`).
   *
   * A domain in this set has already proved it is held by more than one
   * hotel, so a single hotel left on it is a survivor of run order rather
   * than a property that owns its domain. Measured 2026-09-18 over 300
   * hotels: the Doha InterContinental was cleared from
   * `doha.intercontinental.com` and the Madrid one stood on
   * `madrid.intercontinental.com`, and nothing about the two pages decided
   * which — only the order they were researched in.
   *
   * Both may well be legitimate per-property pages on a brand domain. That
   * is exactly why the survivor is not simply kept: we cannot tell a brand's
   * property page from a directory's per-hotel page by its shape, the
   * consequence of being wrong is a citation pointing at another business,
   * and rule 34 spends a correct claim to avoid a wrong one. What this
   * removes is the coin flip, not the caution.
   *
   * It is bounded to the run and never stored: a domain is not banned, it is
   * reconciled. The next sweep re-resolves from scratch.
   */
  collidedDomains: readonly string[] = [],
): Promise<readonly PurgedWebsite[]> {
  const collided = new Set(collidedDomains.map((d) => d.toLowerCase()));
  const byDomain = new Map<string, number[]>();
  for (const row of await deps.findAllHotelWebsites()) {
    const host = hostOf(row.websiteUrl);
    if (!host) continue;
    const domain = registrableDomain(host);
    const held = byDomain.get(domain);
    if (held) held.push(row.hotelId);
    else byDomain.set(domain, [row.hotelId]);
  }

  const purged: PurgedWebsite[] = [];
  for (const [domain, hotelIds] of byDomain) {
    if (hotelIds.length < 2 && !collided.has(domain)) continue;
    purged.push({ domain, hotelIds: [...hotelIds].sort((a, b) => a - b) });
  }
  purged.sort((a, b) => a.domain.localeCompare(b.domain));

  const ids = purged.flatMap((p) => p.hotelIds);
  // researched_at is deliberately left set by the caller's clear, so a hotel
  // whose answer was wrong backs off instead of spending a search to reach
  // the same shared domain on the next run (rule 16's principle).
  await deps.clearResearchForHotels(ids);
  return purged;
}

/**
 * Research one hotel. Every outcome is named, because a silent skip is
 * indistinguishable from a property that genuinely offers nothing — the same
 * reason `syncHotelAmenities` names each of its own (rule 29).
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

    // A human looked at this domain and said no. Their judgement outranks
    // every check below it, which is the point of having the review loop:
    // the automated rules cover what generalises, and a person covers the
    // rest without anybody having to invent a pattern for it.
    const rejected = deps.rejectedHosts;
    const host = hostOf(website);
    if (rejected && rejected.size > 0 && host) {
      // The domain as well as the host: a human rejecting `com-miami.com`
      // rejects the directory, and `w.com-miami.com` is the same directory
      // wearing one hotel's subdomain.
      if (rejected.has(host) || rejected.has(registrableDomain(host))) {
        await deps.saveHotelResearchTarget(hotel.hotelId, null);
        return {
          hotelId: hotel.hotelId,
          outcome: 'REJECTED_HOST',
          websiteUrl: null,
          claims: [],
        };
      }
    }

    // A host claimed by another hotel is a BRAND domain, not this property's
    // site. Measured 2026-09-18: four separate Ritz-Carltons resolved to
    // ritzcarlton.com and would have shown a guest identical "evidence" for
    // Key Biscayne, Coconut Grove, Turtle Bay and Waikiki.
    //
    // BOTH sides are cleared, not just this one. If two hotels claim one
    // domain neither claim is right, and keeping the first would simply
    // reward whichever hotel was researched earliest.
    //
    // The DOMAIN collides, not the URL. Measured 2026-09-18, third run:
    // `com-miami.com` served `w.com-miami.com`, `east.com-miami.com` and
    // `ebhotelairport.com-miami.com` to three different hotels, and three
    // distinct URL strings never collided with each other.
    const collisions = host
      ? await deps.findOtherHotelsWithWebsite(hotel.hotelId, registrableDomain(host))
      : [];
    if (collisions.length > 0) {
      await deps.clearHotelResearch(hotel.hotelId);
      for (const other of collisions) await deps.clearHotelResearch(other);
      await deps.saveHotelResearchTarget(hotel.hotelId, null);
      return {
        hotelId: hotel.hotelId,
        outcome: 'SHARED_HOST',
        websiteUrl: null,
        claims: [],
        sharedDomain: registrableDomain(host),
      };
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
