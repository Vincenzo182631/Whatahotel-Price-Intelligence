/**
 * Filling `hotel_amenity` from `method=info`, safely.
 *
 * The whole difficulty is identity. `info` is keyed on hotelName + hotelCity
 * and its response contains no hotel name, so nothing in an answer says which
 * property it describes. Attaching one hotel's amenities to another would be
 * silent and permanent — rule 22's failure, where "Four Seasons Hotel Miami"
 * and "Four Seasons Resort Palm Beach" share most of their words.
 *
 * The check: the by-ID `hotel` lookup returns `ama-property`, and `info`
 * returns `amadeus.codes`. Two independent id spaces for the same property.
 * When both are present and equal, the answer is about the hotel we asked
 * about. Anything else writes NOTHING.
 *
 * "Anything else" deliberately includes the case where we hold no stored code
 * yet. An unverifiable answer is not a cheap answer, it is a coin flip on
 * which hotel's amenities a guest reads, and the cost of skipping is one
 * hotel's amenities arriving a day later.
 */
import { fetchHotelInfo, type ParsedInfo } from '../adapters/whatahotel/info.js';
import type { WahClient } from '../adapters/whatahotel/client.js';

export type AmenitySyncOutcome =
  | 'STORED'
  | 'NO_STORED_CODE'
  | 'NO_RESPONSE_CODE'
  | 'CODE_MISMATCH'
  | 'DEGRADED'
  | 'EMPTY'
  | 'FAILED';

export interface AmenitySyncResult {
  readonly hotelId: number;
  readonly outcome: AmenitySyncOutcome;
  readonly written: number;
  /** Present on CODE_MISMATCH so a human can see what disagreed. */
  readonly storedCode?: string | null;
  readonly responseCode?: string | null;
}

export interface AmenitySyncDeps {
  readonly client: WahClient;
  readonly findAmadeusProperty: (hotelId: number) => Promise<string | null>;
  readonly upsertHotelAmenities: (
    hotelId: number,
    amenities: readonly { code: string; label: string }[],
  ) => Promise<number>;
  /** Injected so the decision can be tested without a network or a clock. */
  readonly fetchInfo?: (name: string, city: string) => Promise<ParsedInfo>;
}

/**
 * Sync one hotel. Returns why, always — a silent skip is indistinguishable
 * from a hotel that genuinely offers nothing, and that distinction is the
 * point of this whole file.
 */
export async function syncHotelAmenities(
  hotel: { readonly hotelId: number; readonly name: string; readonly city: string },
  deps: AmenitySyncDeps,
): Promise<AmenitySyncResult> {
  const storedCode = await deps.findAmadeusProperty(hotel.hotelId);
  if (storedCode === null) {
    // No identity to check against. See the header: an unverifiable answer is
    // a coin flip, not a cheap win.
    return { hotelId: hotel.hotelId, outcome: 'NO_STORED_CODE', written: 0 };
  }

  let info: ParsedInfo;
  try {
    info = deps.fetchInfo
      ? await deps.fetchInfo(hotel.name, hotel.city)
      : await fetchHotelInfo(deps.client, hotel.name, hotel.city);
  } catch {
    // A 400 on a non-ASCII name, a 204 for a hotel info cannot find, an
    // upstream fault — none of them is a statement about this hotel's
    // amenities, so none of them writes.
    return { hotelId: hotel.hotelId, outcome: 'FAILED', written: 0 };
  }

  if (info.degraded) {
    // DESCSTATUS 0 inside a 200. Storing the empty list that comes with it
    // would render as a hotel that offers nothing.
    return { hotelId: hotel.hotelId, outcome: 'DEGRADED', written: 0 };
  }
  if (info.amadeusCode === null) {
    return { hotelId: hotel.hotelId, outcome: 'NO_RESPONSE_CODE', written: 0 };
  }
  if (info.amadeusCode.toUpperCase() !== storedCode.toUpperCase()) {
    return {
      hotelId: hotel.hotelId,
      outcome: 'CODE_MISMATCH',
      written: 0,
      storedCode,
      responseCode: info.amadeusCode,
    };
  }
  if (info.amenities.length === 0) {
    // Verified, and it really did state none. Still nothing to write, but a
    // different fact from every skip above, so it gets its own outcome.
    return { hotelId: hotel.hotelId, outcome: 'EMPTY', written: 0 };
  }

  const written = await deps.upsertHotelAmenities(hotel.hotelId, [...info.amenities]);
  return { hotelId: hotel.hotelId, outcome: 'STORED', written };
}
