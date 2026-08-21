/**
 * Google Places API (New) client — the reputation half of the intelligence
 * pipeline.
 *
 * Four decisions worth stating, because each one is load-bearing:
 *
 *  1. **Field masks are mandatory.** Places (New) bills by the fields you ask
 *     for, and an omitted `X-Goog-FieldMask` is a 400, not a default. The two
 *     masks below are the complete list of what we store; adding a field here
 *     changes the bill, so it is a deliberate edit.
 *  2. **The key is a header, never a query parameter.** `X-Goog-Api-Key` keeps
 *     it out of URLs, which keeps it out of anything that logs a URL. Nothing
 *     in this file logs the key, the header block, or a request body.
 *  3. **Not configured is not an error.** With no `GOOGLE_PLACES_API_KEY` the
 *     factory returns null and every caller falls back to its existing
 *     behaviour. Reputation is an enhancement layered onto a system that was
 *     already correct without it.
 *  4. **Failure returns nothing, never a guess.** A timeout, a quota refusal
 *     or an empty result all land as "no candidates". They must not become a
 *     zero rating: an absent reputation is absent (rule 3), and a hotel shown
 *     as 0.0 stars because Google was slow would be a fabrication.
 */

import type { PlaceCandidate } from './match.js';

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const DETAILS_BASE = 'https://places.googleapis.com/v1/places/';

/**
 * Exactly the fields we persist (migration 0013). `location` is here because
 * coordinates are what separate two same-brand properties — see match.ts.
 */
const SEARCH_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
].join(',');

const DETAILS_MASK = [
  'id',
  'displayName',
  'formattedAddress',
  'location',
  'rating',
  'userRatingCount',
  'googleMapsUri',
].join(',');

export interface PlaceReputation extends PlaceCandidate {
  /** 1–5, or null when Google holds no rating for this place. */
  readonly rating: number | null;
  /** How many reviews the rating rests on. Null when unknown. */
  readonly userRatingCount: number | null;
  readonly mapsUri: string | null;
}

export interface PlacesClientOptions {
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly baseSearchUrl?: string;
  readonly baseDetailsUrl?: string;
  /**
   * Called once per request with the outcome. Never receives the key: the key
   * travels only in a request header, and `detail` is Google's own
   * error.status/error.message pair, which describes the refusal ("API key
   * not valid", "Places API (New) has not been enabled…") and is what turns
   * "45 failed" into a diagnosis instead of a shrug.
   */
  readonly onRequest?: (info: {
    kind: 'search' | 'details';
    ms: number;
    ok: boolean;
    /** HTTP status, when a response arrived at all. */
    status?: number;
    /** Google's error status + message, bounded. Never the key, never the URL. */
    detail?: string;
  }) => void;
}

interface RawPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string;
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function toCandidate(raw: RawPlace): PlaceCandidate | null {
  const placeId = raw.id?.trim();
  const displayName = raw.displayName?.text?.trim();
  if (!placeId || !displayName) return null;
  return {
    placeId,
    displayName,
    formattedAddress: raw.formattedAddress?.trim() || null,
    latitude: num(raw.location?.latitude),
    longitude: num(raw.location?.longitude),
  };
}

function toReputation(raw: RawPlace): PlaceReputation | null {
  const base = toCandidate(raw);
  if (!base) return null;
  const rating = num(raw.rating);
  return {
    ...base,
    // Out-of-range means we misread the payload, and a misread rating is
    // worse than none: drop it rather than store something the CHECK
    // constraint would reject anyway.
    rating: rating !== null && rating >= 0 && rating <= 5 ? rating : null,
    userRatingCount: num(raw.userRatingCount),
    mapsUri: raw.googleMapsUri?.trim() || null,
  };
}

export class PlacesClient {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly searchUrl: string;
  private readonly detailsBase: string;
  private readonly onRequest: PlacesClientOptions['onRequest'];

  constructor(options: PlacesClientOptions) {
    if (!options.apiKey) throw new Error('Google Places API key is required.');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 4_000;
    this.searchUrl = options.baseSearchUrl ?? SEARCH_URL;
    this.detailsBase = options.baseDetailsUrl ?? DETAILS_BASE;
    this.onRequest = options.onRequest;
  }

  /**
   * Null when no key is configured, so a caller writes
   * `const places = PlacesClient.fromEnv(); if (!places) ...` and the disabled
   * path is impossible to forget.
   */
  static fromEnv(overrides: Partial<PlacesClientOptions> = {}): PlacesClient | null {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY?.trim();
    if (!apiKey) return null;
    return new PlacesClient({ apiKey, ...overrides });
  }

  private async request<T>(
    kind: 'search' | 'details',
    url: string,
    mask: string,
    body: unknown | null,
  ): Promise<T | null> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: body === null ? 'GET' : 'POST',
        headers: {
          'X-Goog-Api-Key': this.apiKey,
          'X-Goog-FieldMask': mask,
          ...(body === null ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const ok = response.ok;
      // Unlike the WhataHotel API, Google's HTTP status IS the outcome. A 4xx
      // here is a real refusal — bad key, quota, malformed mask — and is not
      // worth retrying inside a page-view budget. It IS worth naming: the
      // first live sweep failed all 45 lookups in 5 seconds and the log could
      // not say why, because this branch discarded the body unread.
      if (!ok) {
        let detail: string | undefined;
        try {
          const payload = (await response.json()) as {
            error?: { status?: string; message?: string };
          };
          if (payload.error) {
            detail = `${payload.error.status ?? ''} ${payload.error.message ?? ''}`
              .trim()
              .slice(0, 300);
          }
        } catch {
          // Body was not JSON; the status code alone will have to do.
        }
        this.onRequest?.({ kind, ms: Date.now() - started, ok, status: response.status, detail });
        return null;
      }
      this.onRequest?.({ kind, ms: Date.now() - started, ok, status: response.status });
      return (await response.json()) as T;
    } catch {
      // Timeout or transport failure. Deliberately swallowed: reputation is
      // optional, and the deterministic answer is already correct without it.
      this.onRequest?.({ kind, ms: Date.now() - started, ok: false });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Candidates for a free-text hotel query.
   *
   * `null` means the CALL failed; `[]` means Google answered and knows of no
   * such place. The caller must keep them apart — an empty answer is worth
   * recording as NO_MATCH, while a timeout recorded as NO_MATCH would retire
   * the hotel from ever being looked up again over a four-second blip.
   */
  async searchText(query: string, maxResults = 5): Promise<PlaceCandidate[] | null> {
    if (!query.trim()) return [];
    const payload = await this.request<{ places?: RawPlace[] }>(
      'search',
      this.searchUrl,
      SEARCH_MASK,
      {
        textQuery: query,
        maxResultCount: Math.max(1, Math.min(20, maxResults)),
        // Lodging only. Without it a text search for a hotel name cheerfully
        // returns the restaurant inside it, which then matches on name.
        includedType: 'lodging',
      },
    );
    if (payload === null) return null;
    return (payload.places ?? []).map(toCandidate).filter((c): c is PlaceCandidate => c !== null);
  }

  /** Full record for a known place id. Null when unavailable. */
  async details(placeId: string): Promise<PlaceReputation | null> {
    if (!placeId.trim()) return null;
    const url = `${this.detailsBase}${encodeURIComponent(placeId)}`;
    const payload = await this.request<RawPlace>('details', url, DETAILS_MASK, null);
    return payload ? toReputation(payload) : null;
  }
}
