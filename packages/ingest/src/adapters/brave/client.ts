/**
 * Brave Search, for researching what a property actually offers.
 *
 * Owner decision (2026-09-18): the motivator assessment should use live web
 * research, and Brave is the provider.
 *
 * ── The rule this adapter exists to enforce ──────────────────────────────
 *
 * A model's recollection of a hotel is not evidence about that hotel. It is
 * fluent, it is often right, and nothing downstream can tell the right ones
 * from the wrong ones. So this layer RETRIEVES: every claim that reaches a
 * guest must trace to a page we fetched, with its URL and the time we read
 * it, exactly as rule 22 makes a rating traceable to Google and rule 32
 * makes an editorial summary traceable to Google's own words.
 *
 * That is the difference between "Halekulani has a spa" (unfalsifiable, from
 * training data) and "halekulani.com lists a spa, read 2026-09-18"
 * (checkable, and wrong in a way somebody can notice).
 *
 * ── What this file does NOT do ───────────────────────────────────────────
 *
 * It does not parse. Nothing here decides what a result means, because the
 * response shape has not been measured yet and writing a parser against a
 * guessed shape is what cost this project a silent sweep over 150 hotels
 * this morning (rule 29's closing paragraph). `scripts/probe-brave.mjs`
 * measures first; the parser lands after.
 */

export interface BraveClientOptions {
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly endpoint: string;
}

const DEFAULTS: Omit<BraveClientOptions, 'apiKey'> = {
  // Research runs in a sweep, never on a page view, so this can be patient
  // without any guest waiting on it.
  timeoutMs: 8_000,
  endpoint: 'https://api.search.brave.com/res/v1/web/search',
};

/** The key is a credential (rule 10): environment only, never logged. */
export function redactBrave(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join('[REDACTED]');
}

export class BraveError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BraveError';
  }
}

export class BraveClient {
  private readonly options: BraveClientOptions;

  constructor(options: Partial<BraveClientOptions> & { apiKey: string }) {
    if (!options.apiKey) throw new Error('A Brave Search API key is required.');
    this.options = { ...DEFAULTS, ...options };
  }

  /**
   * Null when no key is configured, so a caller writes
   * `const brave = BraveClient.fromEnv(); if (!brave) ...` and the disabled
   * path is impossible to forget — the same shape PlacesClient uses.
   */
  static fromEnv(overrides: Partial<BraveClientOptions> = {}): BraveClient | null {
    const apiKey = process.env.BRAVE_API_KEY?.trim();
    if (!apiKey) return null;
    return new BraveClient({ apiKey, ...overrides });
  }

  /**
   * One search. Returns the parsed JSON body untouched.
   *
   * Unlike the WhataHotel API, whose every response is HTTP 200 with the real
   * outcome buried in `wahData.status.code`, Brave's HTTP status IS the
   * outcome. A 429 is the rate limit and is worth naming rather than
   * swallowing, because the free tier allows roughly one request a second
   * and a sweep that ignores it will look like a broken key.
   */
  async search(query: string, count = 5): Promise<unknown> {
    const url = new URL(this.options.endpoint);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(Math.max(1, Math.min(20, count))));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': this.options.apiKey,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        let detail = '';
        try {
          detail = (await response.text()).slice(0, 300);
        } catch {
          /* body unavailable; the status alone will have to do */
        }
        throw new BraveError(
          response.status,
          redactBrave(`Brave search failed: ${response.status} ${detail}`, this.options.apiKey),
        );
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
