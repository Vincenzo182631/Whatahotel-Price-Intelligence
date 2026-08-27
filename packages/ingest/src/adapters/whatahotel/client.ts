/**
 * HTTP client for the WhataHotel data API.
 *
 * Three behaviours that come directly from observed responses:
 *
 *  1. **Every response is HTTP 200**, including auth failure and server error.
 *     The real outcome is `wahData.status.code`. A client that trusts the HTTP
 *     status would treat a 401 as a successful empty result and ingest nothing
 *     while reporting healthy — a silent outage.
 *  2. Latency is ~2.2–2.6s per rates call, so concurrency, not per-call speed,
 *     is what determines collection throughput.
 *  3. The API key is a query parameter, which means it lands in any URL that
 *     gets logged. Every log line here redacts it.
 *  4. **Success is not one code.** `hotel` answers `100`; `rates`, `search`
 *     and `cityrates` answer `200`. Both carry message "Success" and
 *     connection 1. Measured 2026-08-20 by calling all four — treating 200 as
 *     the only success made every `hotel` lookup throw, which is what stopped
 *     automatic catalogue enrollment from working at all.
 */

import { parseLenientJson } from './json.js';
import { WahApiError, type WahEnvelope, type WahMethod, type WahStatus } from './types.js';

/**
 * Status codes that mean the call worked. See note 4 above: the set is not a
 * single value, and a method added later may bring another — prefer widening
 * this deliberately over relaxing the check.
 */
const SUCCESS_CODES = new Set(['100', '200']);

export interface WahClientOptions {
  readonly baseUrl?: string;
  /** Never hardcode. Read from WAH_API_KEY. */
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly retryBaseMs?: number;
  /** Simultaneous in-flight requests. The API is slow; this sets throughput. */
  readonly concurrency?: number;
  readonly userAgent?: string;
  readonly onRequest?: (info: { method: WahMethod; url: string; ms: number; ok: boolean }) => void;
  /** Fired when a response only parsed after repair — worth reporting upstream. */
  readonly onMalformedJson?: (info: { method: WahMethod; url: string; bytes: number }) => void;
}

const DEFAULTS = {
  baseUrl: 'https://whatahotel.com/data/api.cfm',
  timeoutMs: 30_000,
  maxRetries: 3,
  retryBaseMs: 500,
  concurrency: 4,
  userAgent: 'WhataHotelPriceIntelligence/1.0 (+internal analytics)',
};

/** Redact the key from anything that might be logged or stored. */
export function redact(url: string): string {
  return url.replace(/(apiKey=)[^&]*/i, '$1<redacted>');
}

export class WahClient {
  private readonly options: Required<Omit<WahClientOptions, 'onRequest' | 'onMalformedJson'>> &
    Pick<WahClientOptions, 'onRequest' | 'onMalformedJson'>;
  private inFlight = 0;
  private readonly queue: Array<() => void> = [];

  constructor(options: WahClientOptions) {
    if (!options.apiKey) {
      throw new Error('WhataHotel API key is required (set WAH_API_KEY).');
    }
    this.options = { ...DEFAULTS, ...options };
  }

  static fromEnv(overrides: Partial<WahClientOptions> = {}): WahClient {
    const apiKey = process.env.WAH_API_KEY ?? '';
    if (!apiKey) {
      throw new Error(
        'WAH_API_KEY is not set. The WhataHotel API key must come from the ' +
          'environment — it is a credential and must never be committed.',
      );
    }
    return new WahClient({ apiKey, ...overrides });
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < this.options.concurrency) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.inFlight += 1;
  }

  private release(): void {
    this.inFlight -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  buildUrl(method: WahMethod, params: Record<string, string | number>): string {
    const url = new URL(this.options.baseUrl);
    url.searchParams.set('method', method);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    url.searchParams.set('apiKey', this.options.apiKey);
    return url.toString();
  }

  /**
   * Issue a call and return the unwrapped `wahData`, or throw WahApiError.
   *
   * Retries only what is retryable: transport failures and status 500. A 401 or
   * 400 is not going to succeed on a second attempt, and retrying it wastes the
   * call budget while delaying the error that a human needs to see.
   */
  async call<T>(method: WahMethod, params: Record<string, string | number>): Promise<T> {
    const url = this.buildUrl(method, params);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      if (attempt > 0) {
        const backoff = this.options.retryBaseMs * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, backoff));
      }

      await this.acquire();
      const started = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

        let body: WahEnvelope<T & { status: WahStatus }>;
        try {
          const response = await fetch(url, {
            signal: controller.signal,
            headers: { accept: 'application/json', 'user-agent': this.options.userAgent },
          });
          // Checked for completeness; the API does not use it to signal errors.
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} from ${redact(url)}`);
          }
          // Not response.json(): the API emits invalid JSON often enough that a
          // strict parse permanently loses some hotels. See json.ts.
          const text = await response.text();
          const parsed = parseLenientJson<WahEnvelope<T & { status: WahStatus }>>(text);
          if (parsed.repaired) {
            this.options.onMalformedJson?.({ method, url: redact(url), bytes: text.length });
          }
          body = parsed.value;
        } finally {
          clearTimeout(timer);
        }

        const wahData = body?.wahData;
        if (!wahData || !wahData.status) {
          throw new Error(`Malformed response (no wahData.status) from ${redact(url)}`);
        }

        // THE status check. HTTP 200 means nothing here.
        if (wahData.status.connection !== 1 || !SUCCESS_CODES.has(wahData.status.code)) {
          // wahData carries the amadeus block on a rates response; it is not
          // on the generic envelope type, hence the narrow read rather than a
          // widened generic. See WahApiError.brokenMapping for why it matters.
          const amadeus = (wahData as { readonly amadeus?: { readonly amaID?: string } }).amadeus;
          const apiError = new WahApiError(wahData.status, amadeus);
          if (apiError.retryable && attempt < this.options.maxRetries) {
            lastError = apiError;
            continue;
          }
          throw apiError;
        }

        this.options.onRequest?.({ method, url: redact(url), ms: Date.now() - started, ok: true });
        return wahData as unknown as T;
      } catch (err) {
        lastError = err as Error;
        this.options.onRequest?.({ method, url: redact(url), ms: Date.now() - started, ok: false });
        if (err instanceof WahApiError && !err.retryable) throw err;
        if (attempt === this.options.maxRetries) break;
      } finally {
        this.release();
      }
    }

    throw lastError ?? new Error(`WhataHotel request failed: ${redact(url)}`);
  }
}
