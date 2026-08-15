/**
 * Response shapes for the WhataHotel data API (`/data/api.cfm`).
 *
 * These are TRANSCRIBED FROM CAPTURED RESPONSES, not from a published schema —
 * see tests/fixtures/whatahotel/ for the payloads they were derived from. Every
 * field is typed as it actually arrives, which for money means a formatted
 * STRING, not a number.
 *
 * The API returns HTTP 200 for every outcome including auth failure; the real
 * status is `wahData.status.code`. See client.ts.
 */

export type WahMethod = 'rates' | 'hotel' | 'search' | 'info' | 'namerates' | 'cityrates';

export interface WahStatus {
  /** 1 on success, 0 on every failure. */
  readonly connection: number;
  /** "200" | "400" | "401" | "500" — as a STRING. */
  readonly code: string;
  readonly method: string;
  readonly message: string;
}

export interface WahEnvelope<T> {
  readonly wahData: T & { readonly status: WahStatus };
}

/** One bookable room+rate combination. */
export interface WahRoom {
  /** ISO currency, e.g. "USD". Present on the rates method only. */
  readonly currency?: string;
  /** Formatted whole-stay GROSS amount, e.g. "3,910.37". */
  readonly rateTotal: string;
  /** Formatted per-night NET amount, e.g. "1,039.00". */
  readonly rateDaily: string;
  /** Stable room identifier, e.g. "ZXXI00". The SOURCE_ID matching path. */
  readonly bookCode: string;
  /** Rate plan identifier, e.g. "2SH". Stable across captures. */
  readonly rateCode: string;
  readonly roomName: string;
  /** Rate-plan prose then room prose, hyphen-delimited. */
  readonly roomDesc: string;
  readonly roomType: string;
  readonly bedType: string;
  readonly bedNum: string;
  readonly bookingURL: string;
  readonly images?: ReadonlyArray<{ imgDesc: string; imgSource: string; imgFile: string }>;
}

export interface WahRatesResponse {
  readonly rooms: readonly WahRoom[];
  readonly hotel: {
    readonly id: string;
    readonly name: string;
    readonly city: string;
    readonly image?: string;
  };
  readonly stay: {
    readonly 'check-in': string;
    readonly 'check-out': string;
    readonly nights: string;
    readonly guests: string;
    readonly ratesURL?: string;
  };
  readonly result?: {
    readonly count: number;
    readonly filtered: number;
    readonly failed: number;
    readonly filters: string;
  };
  readonly amadeus?: {
    readonly codes?: string;
    readonly amaID?: string;
    readonly amaToken?: string;
  };
  readonly session?: Record<string, string>;
}

export interface WahPerk {
  readonly perk: string;
}

/** Hotel record as returned by `hotel`, `search` and `cityrates`. */
export interface WahHotel {
  readonly hotelID: string;
  readonly name: string;
  readonly city?: string;
  readonly region?: string;
  readonly country?: string;
  readonly address?: string;
  readonly 'loc-lat'?: string;
  readonly 'loc-long'?: string;
  readonly url?: string;
  readonly images?: string;
  readonly 'ama-property'?: string;
  readonly 'ama-location'?: string;
  /** Preferred-partner inclusions. The benefits behind factor F6. */
  readonly perks?: readonly WahPerk[];
  /** Present on cityrates only — note the currency is INSIDE the string. */
  readonly rateTotal?: string;
  readonly rateDaily?: string;
  readonly rank?: string;
}

export interface WahHotelsResponse {
  readonly hotels: readonly WahHotel[];
  readonly images?: readonly unknown[];
  readonly city?: { readonly id: string; readonly name: string; readonly image?: string };
}

/**
 * The status code a sold-out stay returns.
 *
 * Observed in production collection: a hotel with no inventory over the exact
 * requested dates answers `204` with a prose message telling the traveler to
 * try other dates. It is a legitimate empty result, not a fault — counting it
 * as an error would make a healthy run look broken, and every collection run
 * over a busy weekend would be full of red.
 */
export const WAH_NO_AVAILABILITY_CODE = '204';

export class WahApiError extends Error {
  readonly code: string;
  readonly method: string;
  readonly retryable: boolean;
  /** The stay is simply sold out. Distinct from a fault; see the constant above. */
  readonly noAvailability: boolean;

  constructor(status: WahStatus) {
    super(`WhataHotel API ${status.code} on ${status.method}: ${status.message}`);
    this.name = 'WahApiError';
    this.code = status.code;
    this.method = status.method;
    this.noAvailability = status.code === WAH_NO_AVAILABILITY_CODE;
    // 500/503 are transient. 400/401 are permanent: bad input or bad
    // credentials, and a retry only wastes the call budget. 204 is not a
    // failure at all, so there is nothing to retry.
    this.retryable = status.code === '500' || status.code === '503';
  }
}
