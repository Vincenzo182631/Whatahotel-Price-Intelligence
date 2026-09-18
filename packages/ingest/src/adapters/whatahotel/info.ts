/**
 * Reading `method=info` — the amenity data this source spent a month denying.
 *
 * Rule 21 says amenities "live only behind method=info, which answers 500 for
 * our key". Matt fixed that on 2026-09-17. Probed over 20 hotels the same
 * day: 18 answered, and the response carries a CODED per-room amenity list,
 * restaurant names, and area, attraction and policy prose that genuinely
 * varies per property.
 *
 * ── The identity problem, which is the whole reason this file is careful ──
 *
 * `info` is keyed on hotelName + hotelCity, not on the id every other part of
 * this system uses, and the response contains NO hotel name. The only
 * name-shaped field is `session.sessionName`, the constant string "Guest" —
 * the first version of the probe matched exactly that and reported a mismatch
 * on all 18 answers, which was the probe's fault and not the source's.
 *
 * So a response cannot say which property it describes, and attaching one
 * hotel's amenities to another is silent and permanent. That is rule 22's
 * failure: "Four Seasons Hotel Miami" and "Four Seasons Resort Palm Beach"
 * share most of their words.
 *
 * `amadeus.codes` is the way out. One per hotel, distinct across all 18, and
 * the same identity the by-ID `hotel` lookup returns as `ama-property`. This
 * parser therefore RETURNS the code and never judges it; `syncHotelAmenities`
 * compares it against the stored one and writes nothing when they disagree.
 *
 * ── What this refuses to read ────────────────────────────────────────────
 *
 * The prose blocks (HOTELINFO, AREAINFO, ATTRACTIONINFO, POLICYINFO) are real
 * and do vary, but they are marketing copy: "Daily resort fee will be added to
 * all stays", "Upon early departure, an Early Departure Charge…". Nothing
 * downstream should reword a fee schedule into a reason to book, so they are
 * not returned. Rule 24's lesson — the hotel page's schema.org block looked
 * like a quality signal and was an SEO template — applies to anything that
 * merely reads like evidence.
 */
import type { WahClient } from './client.js';

/** One amenity as the source states it: its own code, and its own label. */
export interface InfoAmenity {
  /** RMACODE. The key — a label may be reworded upstream, a code may not. */
  readonly code: string;
  /** RMAVAL, e.g. "Bathrobe". Stored so a human can read a code. */
  readonly label: string;
}

export interface ParsedInfo {
  /**
   * `amadeus.codes`. The ONLY identity signal in the response; null when the
   * source gave none, which must be read as "cannot verify", never as "fine".
   */
  readonly amadeusCode: string | null;
  readonly amenities: readonly InfoAmenity[];
  /** Restaurant names, deduplicated. Real, per-hotel, and not yet used. */
  readonly restaurants: readonly string[];
  /**
   * The source reporting its own failure INSIDE a successful response:
   * `DESCSTATUS` 0 with a message like "Error: Element
   * XMLATTRIBUTES.ROOMAMENITY". Measured on 1 of 18 hotels. A caller must
   * treat a degraded response as unusable rather than as "no amenities",
   * because storing emptiness would look like a hotel that offers nothing.
   */
  readonly degraded: boolean;
}

function asArray(node: unknown): readonly unknown[] {
  if (Array.isArray(node)) return node;
  // The source collapses a single-element array to a bare object, which is
  // how a one-restaurant hotel silently reads as zero restaurants.
  if (node && typeof node === 'object') return [node];
  return [];
}

function str(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  if (typeof v === 'number') return String(v);
  return null;
}

/**
 * Parse one `info` payload. Pure: no I/O, no clock, no judgement about
 * identity — that belongs to the caller, which is the only place that knows
 * which hotel was asked for.
 */
export function parseInfo(payload: unknown): ParsedInfo {
  const root = (payload ?? {}) as Record<string, unknown>;
  const amadeus = (root.amadeus ?? {}) as Record<string, unknown>;
  const hotel = (root.hotel ?? {}) as Record<string, unknown>;

  const code = str(amadeus.codes);
  // "NULL" is the source's own way of saying it holds no mapping — the same
  // sentinel WahApiError.brokenMapping keys on. A literal four-character
  // string is not an identity, and treating it as one would let every
  // unmapped hotel verify against every other.
  const amadeusCode = code === null || code.toUpperCase() === 'NULL' ? null : code;

  const status = str(hotel.DESCSTATUS);
  const degraded = status !== null && status !== '1';

  // GUESTROOMS is an ARRAY of room blocks, each holding its own ROOMRMA list.
  // Measured on hotel 2008 (probe --dump hotel.GUESTROOMS, 2026-09-18):
  //
  //   hotel.GUESTROOMS: array[1]
  //   [ { "ROOMRMA": [ { "RMAVAL": "Non-smoking", "RMACODE": "74" }, … ] } ]
  //
  // The first version read GUESTROOMS as an object and took .ROOMRMA off it,
  // which on an array is undefined, so every hotel parsed to zero amenities:
  // a sweep of 150 stored nothing while 138 of them passed the identity
  // check. Codes are deduplicated ACROSS room blocks, because a hotel listing
  // several room types repeats the amenities they share.
  const amenities: InfoAmenity[] = [];
  const seenCodes = new Set<string>();
  for (const roomBlock of asArray(hotel.GUESTROOMS)) {
    const block = (roomBlock ?? {}) as Record<string, unknown>;
    for (const entry of asArray(block.ROOMRMA)) {
      const row = (entry ?? {}) as Record<string, unknown>;
      const amenityCode = str(row.RMACODE);
      const label = str(row.RMAVAL);
      if (amenityCode === null || label === null) continue;
      if (seenCodes.has(amenityCode)) continue;
      seenCodes.add(amenityCode);
      amenities.push({ code: amenityCode, label });
    }
  }

  const restaurants: string[] = [];
  const seenNames = new Set<string>();
  for (const entry of asArray(hotel.RESTAURANTS)) {
    const row = (entry ?? {}) as Record<string, unknown>;
    const name = str(row.RESTAURANTNAME);
    if (name === null || seenNames.has(name)) continue;
    seenNames.add(name);
    restaurants.push(name);
  }

  return { amadeusCode, amenities, restaurants, degraded };
}

/**
 * Ask the source about one hotel by name and city.
 *
 * Non-ASCII is rejected upstream with a 400 — measured, "Château
 * Saint-Martin", "Mont d'Arbois" (a typographic apostrophe) and "Saturnia
 * (Grosseto)" all fail. We do NOT transliterate around that: a name we
 * altered is a different name, and this method's whole risk is answering
 * about a different hotel. A caller sees the error and skips the hotel.
 */
export async function fetchHotelInfo(
  client: WahClient,
  hotelName: string,
  hotelCity: string,
): Promise<ParsedInfo> {
  const data = await client.call<unknown>('info', { hotelName, hotelCity });
  return parseInfo(data);
}
