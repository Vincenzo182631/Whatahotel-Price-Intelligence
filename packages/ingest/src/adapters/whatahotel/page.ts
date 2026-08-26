/**
 * Reading the facts published on whatahotel.com's own hotel page.
 *
 * This is NOT the rates API. It is the public marketing page, parsed for the
 * two things it states that `/data/api.cfm` does not: the property's street
 * address, and whether the property can be booked online at all.
 *
 * Measured 2026-08-26 over 15 sampled ids:
 *
 *   - `https://www.whatahotel.com/hotels/<id>/` resolves without the URL
 *     slug, so the same id space the catalogue sweep already walks addresses
 *     every page. No slug discovery, no search step.
 *   - 12 of the 15 were real hotels. The other three returned a generic page
 *     with no schema.org Hotel node, which is how a non-existent id presents.
 *   - The address arrives in a schema.org `PostalAddress`, which is why this
 *     parses JSON-LD rather than scraping markup. The visible layout is free
 *     to change; the structured data is what the page is published FOR.
 *
 * ── What this deliberately refuses to read ────────────────────────────────
 *
 * The same JSON-LD carries `starRating`, `priceRange` and `amenityFeature`,
 * and all three were byte-identical across all 12 real hotels: 5 stars,
 * "$$$$", and the same five WhataHotel perks on a yacht collection and on an
 * airport hotel alike. They are an SEO template, not a measurement. Reading
 * them would hand the scoring layer a "quality signal" with zero variance
 * across the catalogue — a number that looks like evidence and contains none.
 * `parseHotelPage` does not return them, so nothing downstream can.
 */

export interface ParsedHotelPage {
  readonly streetAddress: string | null;
  readonly locality: string | null;
  readonly country: string | null;
  readonly postalCode: string | null;
  /**
   * The page states the property cannot be booked online.
   *
   * `null` means it said nothing either way, which is the common case and is
   * NOT the same as "bookable". Only an explicit notice sets this false.
   */
  readonly bookableOnline: boolean | null;
  /** Present only so a caller can tell a real hotel page from a stub. */
  readonly name: string | null;
}

/** The notice the page renders in place of the booking widget. */
const NOT_BOOKABLE = /not\s+available\s+for\s+online\s+booking/i;

const LD_BLOCK = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Flatten `@graph` / array / bare-object JSON-LD into one node list. */
function ldNodes(html: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  for (const match of html.matchAll(LD_BLOCK)) {
    const body = match[1]?.trim();
    if (!body) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // A malformed block is not a malformed page. The address may still be
      // in the next one, so skip this and keep going.
      continue;
    }
    const push = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(push);
      else if (value && typeof value === 'object') {
        const node = value as Record<string, unknown>;
        if (Array.isArray(node['@graph'])) (node['@graph'] as unknown[]).forEach(push);
        else nodes.push(node);
      }
    };
    push(parsed);
  }
  return nodes;
}

const str = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * Parse one hotel page.
 *
 * Pure — takes HTML, returns values, touches nothing. Everything about this
 * source that could be wrong is therefore testable from a captured page.
 */
export function parseHotelPage(html: string): ParsedHotelPage {
  const hotel = ldNodes(html).find((node) => node['@type'] === 'Hotel') ?? null;
  const address = (hotel?.['address'] ?? null) as Record<string, unknown> | null;

  return {
    streetAddress: str(address?.['streetAddress']),
    locality: str(address?.['addressLocality']),
    country: str(address?.['addressCountry']),
    postalCode: str(address?.['postalCode']),
    // Absence of the notice is not evidence of bookability — an id that is not
    // a hotel at all has no notice either. Only a real page may answer false.
    bookableOnline: hotel === null ? null : NOT_BOOKABLE.test(html) ? false : null,
    name: str(hotel?.['name']),
  };
}

export interface HotelPageFetchOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const PAGE_DEFAULTS = {
  baseUrl: 'https://www.whatahotel.com',
  timeoutMs: 15_000,
};

/**
 * Fetch and parse one hotel page.
 *
 * Returns null when the page cannot be read or is not a hotel — never a
 * half-filled record. The caller writes nothing on null, which keeps the
 * hotel in the refresh queue rather than recording an absence we did not
 * measure. Same reasoning as FAILED in the Places resolver.
 */
export async function fetchHotelPage(
  wahHotelId: string,
  options: HotelPageFetchOptions = {},
): Promise<ParsedHotelPage | null> {
  const { baseUrl, timeoutMs } = { ...PAGE_DEFAULTS, ...options };
  const call = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await call(`${baseUrl}/hotels/${encodeURIComponent(wahHotelId)}/`, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'text/html' },
    });
    if (!response.ok) return null;
    const parsed = parseHotelPage(await response.text());
    // No Hotel node: the id is not a hotel, or the template changed. Either
    // way there is nothing here worth storing.
    return parsed.name === null ? null : parsed;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
