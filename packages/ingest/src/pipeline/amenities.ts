/**
 * Filling `hotel_amenity` from `method=infoid`.
 *
 * The whole difficulty used to be identity. `info` is keyed on hotelName +
 * hotelCity and its response contains no hotel name, so nothing in an answer
 * said which property it described. Attaching one hotel's amenities to
 * another would be silent and permanent — rule 22's failure, where "Four
 * Seasons Hotel Miami" and "Four Seasons Resort Palm Beach" share most of
 * their words. So this file compared the by-ID `hotel` lookup's
 * `ama-property` against the response's `amadeus.codes` and wrote NOTHING
 * unless both were present and equal.
 *
 * `infoid` (shipped by the source 2026-09-18, at our request) removes the
 * problem instead of checking around it: the REQUEST names the id, so the
 * answer is about that hotel by construction. There is no coin flip left to
 * protect against, and the two refusals that existed only to protect against
 * it are gone with it.
 *
 * That matters for coverage, which is why it was worth asking for. We only
 * began writing `hotel.amadeus_property` on 2026-09-18, and the catalogue was
 * built over the preceding month, so most rows still hold NULL. Under the old
 * gate every one of those hotels reported NO_STORED_CODE and stored nothing —
 * a skip caused entirely by a column of ours, not by anything the source did
 * or did not say.
 *
 * What survives is the CORROBORATION. Where we do hold a stored code and it
 * disagrees, the amenities are still written — the request is what
 * establishes identity, and discarding a good answer over a stale bookkeeping
 * value would be the same mistake in the other direction — but the
 * disagreement is reported on the result so a human sees it. Measured before
 * this change: 28 of 30 hotels agreed, 0 disagreed, 2 answered on neither
 * side. A disagreement is therefore an anomaly worth a look rather than a
 * routine event, and it should stay visible.
 */
import { fetchHotelInfoById, type ParsedInfo } from '../adapters/whatahotel/info.js';
import type { WahClient } from '../adapters/whatahotel/client.js';

export type AmenitySyncOutcome = 'STORED' | 'DEGRADED' | 'EMPTY' | 'FAILED';

export interface AmenitySyncResult {
  readonly hotelId: number;
  readonly outcome: AmenitySyncOutcome;
  readonly written: number;
  /**
   * True when we held a stored `ama-property` and the response's
   * `amadeus.codes` disagreed with it. NOT a refusal any more: `infoid` is
   * keyed on the id, so the answer is about this hotel whatever our own
   * column says. Reported because it is rare (0 of 28 measured) and a run
   * full of them would mean something changed upstream.
   */
  readonly codeDisagreement?: boolean;
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
  readonly fetchInfo?: (hotelId: number) => Promise<ParsedInfo>;
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
  let info: ParsedInfo;
  try {
    info = deps.fetchInfo
      ? await deps.fetchInfo(hotel.hotelId)
      : await fetchHotelInfoById(deps.client, hotel.hotelId);
  } catch {
    // A 204 for a hotel the source holds no information about, an upstream
    // fault — neither is a statement about this hotel's amenities, so
    // neither writes. (The old non-ASCII 400 cannot happen here: an id goes
    // over the wire, not a name.)
    return { hotelId: hotel.hotelId, outcome: 'FAILED', written: 0 };
  }

  if (info.degraded) {
    // DESCSTATUS 0 inside a 200. Storing the empty list that comes with it
    // would render as a hotel that offers nothing.
    return { hotelId: hotel.hotelId, outcome: 'DEGRADED', written: 0 };
  }

  // Corroboration, not a gate. Both sides have to be present for a
  // disagreement to mean anything: a missing stored code is our gap (the
  // column is new) and a missing response code is the source holding no
  // Amadeus mapping, and neither says the amenities belong to another hotel.
  const storedCode = await deps.findAmadeusProperty(hotel.hotelId);
  const codeDisagreement =
    storedCode !== null &&
    info.amadeusCode !== null &&
    storedCode.toUpperCase() !== info.amadeusCode.toUpperCase();

  if (info.amenities.length === 0) {
    // It really did state none. Still nothing to write, but a different fact
    // from every skip above, so it gets its own outcome.
    return {
      hotelId: hotel.hotelId,
      outcome: 'EMPTY',
      written: 0,
      ...(codeDisagreement ? { codeDisagreement, storedCode, responseCode: info.amadeusCode } : {}),
    };
  }

  const written = await deps.upsertHotelAmenities(hotel.hotelId, [...info.amenities]);
  return {
    hotelId: hotel.hotelId,
    outcome: 'STORED',
    written,
    ...(codeDisagreement ? { codeDisagreement, storedCode, responseCode: info.amadeusCode } : {}),
  };
}
