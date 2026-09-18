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
 * It never treats a search result as evidence. The result supplies a URL and
 * nothing else; if the fetch of that URL fails, the hotel simply has no
 * researched claims. An unfetched page is not a hotel that lacks a spa —
 * that distinction is the whole of rule 28, and the reason
 * `assessMotivators` has no general negative verdict.
 */
import type { BraveClient } from './client.js';

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
    if (!nameEchoesHost(name, host)) continue;
    return `https://${host}/`;
  }
  return null;
}
