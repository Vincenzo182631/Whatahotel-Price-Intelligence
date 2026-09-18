/**
 * Resolving a hotel to its own website, and reading that page.
 *
 * Owner decision (2026-09-18): Brave FINDS the page, we FETCH it, and the
 * evidence a guest reads comes from what we fetched.
 *
 * ── Why it works this way ────────────────────────────────────────────────
 *
 * Terms: Brave restricts retaining API results. A stored row here is our own
 * reading of a page at a URL — the same thing rule 24 already does with
 * whatahotel.com's hotel pages.
 *
 * Evidence: the merchant's own site beats an aggregator's snippet. When the
 * widget tells a guest a property has a spa, the citation should be the
 * property saying so.
 *
 * Cost: ONE search per hotel to resolve the site, then every motivator is
 * read from that one document. Eight searches a hotel would have put 125
 * hotels inside Brave's free monthly credit; this puts 1,000 there.
 *
 * ── What this file refuses to do ─────────────────────────────────────────
 *
 * ── What the first real run taught this file ─────────────────────────────
 *
 * Measured over 25 hotels on 2026-09-18, seven of fifteen resolutions pointed
 * at the wrong entity: four separate Ritz-Carltons all resolved to
 * ritzcarlton.com, Four Seasons Ko Olina to press.fourseasons.com, EB Hotel
 * Miami to the Greater Miami tourism board, and Mr. C Coconut Grove to a
 * neighbourhood site. `nameEchoesHost` passed every one of them, because
 * "ritzcarlton" contains "carlton" and so does every Ritz-Carlton on earth.
 *
 * A claim carrying a citation that points at the wrong entity is worse than
 * no claim: the citation is what makes a reader trust it. The blocklists
 * below catch the brand newsrooms and the destination sites, and the caller
 * applies the check that actually generalises — a host claimed by MORE THAN
 * ONE hotel in our own catalogue is a brand domain by definition, because no
 * property's own site is shared. That test needs the database, so it lives in
 * the pipeline rather than here.
 *
 * It never treats a search result as evidence. The result supplies a URL and
 * nothing else; if the fetch of that URL fails, the hotel simply has no
 * researched claims. An unfetched page is not a hotel that lacks a spa —
 * that distinction is the whole of rule 28, and the reason
 * `assessMotivators` has no general negative verdict.
 */
import type { BraveClient } from './client.js';

/**
 * Subdomains that belong to a brand rather than to a property.
 *
 * Measured 2026-09-18: Four Seasons Oahu at Ko Olina resolved to
 * press.fourseasons.com, a corporate newsroom. Its pages are about the
 * chain, so every claim read there would be attributed to one hotel and
 * describe all of them.
 */
const BRAND_SUBDOMAINS = ['press.', 'media.', 'newsroom.', 'investor.', 'careers.', 'corporate.'];

/**
 * Destination marketing sites, which rank well for "<hotel> <city>" and are
 * about the city.
 *
 * Measured 2026-09-18: EB Hotel Miami resolved to miamiandbeaches.com, the
 * Greater Miami tourism board, and 11 claims about Miami were stored against
 * one hotel. A claim with a citation that points at the wrong entity is
 * worse than no claim, because the citation makes it look checked.
 */
const DESTINATION_SITES = [
  'andbeaches.com',
  'visit',
  'tourism',
  'gocity',
  'cvb.',
  'discover',
  'thingstodo',
];

/** Hosts that are never the hotel's own site, however well they rank. */
const AGGREGATORS = [
  'booking.com',
  'expedia.',
  'hotels.com',
  'tripadvisor.',
  'agoda.',
  'trivago.',
  'kayak.',
  'priceline.',
  'orbitz.',
  'travelocity.',
  'yelp.',
  'wikipedia.org',
  'facebook.com',
  'instagram.com',
  'x.com',
  'twitter.com',
  'youtube.com',
  'whatahotel.com',
];

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/** Shared words between the hotel's name and the domain, as weak corroboration. */
function nameEchoesHost(name: string, host: string): boolean {
  const flat = host.replace(/[^a-z0-9]/g, '');
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !['hotel', 'resort', 'suites', 'spa'].includes(w));
  return words.some((w) => flat.includes(w));
}

/**
 * The property's own website, or null.
 *
 * Null means "we could not establish it", never "it has none". The caller
 * stores that distinction: a hotel with no resolved site gets no researched
 * claims and keeps whatever verdicts its held evidence supports.
 *
 * The name check is corroboration rather than the decision. A first result
 * on a plausible host whose domain echoes the hotel's name is good enough for
 * a page we then read for ourselves; a result we cannot corroborate is
 * skipped, because attaching one property's website to another would be the
 * silent, permanent failure rule 22 and rule 29 both exist to prevent.
 */
export async function resolveHotelWebsite(
  client: BraveClient,
  name: string,
  city: string | null,
): Promise<string | null> {
  const query = `${name} ${city ?? ''} official site`.replace(/\s+/g, ' ').trim();
  const payload = (await client.search(query, 8)) as {
    web?: { results?: { url?: string }[] };
  };
  const results = payload?.web?.results ?? [];

  for (const r of results) {
    const url = r?.url;
    if (!url) continue;
    const host = hostOf(url);
    if (!host) continue;
    if (AGGREGATORS.some((a) => host.includes(a))) continue;
    if (BRAND_SUBDOMAINS.some((b) => host.startsWith(b))) continue;
    if (DESTINATION_SITES.some((d) => host.includes(d))) continue;
    if (!nameEchoesHost(name, host)) continue;
    return `https://${host}/`;
  }
  return null;
}
