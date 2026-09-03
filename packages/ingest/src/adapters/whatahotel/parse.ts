/**
 * Parsing the WhataHotel payload into domain values.
 *
 * Every rule here was verified against captured responses
 * (tests/fixtures/whatahotel/), not inferred from field names. The two that
 * would have been guessed wrong:
 *
 *   1. `rateDaily` is the per-night NET rate; `rateTotal` is the whole-stay
 *      GROSS amount. Verified across 1- and 3-night stays: rateTotal is
 *      exactly rateDaily × nights × 1.2545 for hotel 951. Treating rateTotal
 *      as a net total would understate taxes by ~25% on every observation.
 *
 *   2. Money arrives as a FORMATTED STRING with thousands separators
 *      ("1,039.00"), and on the cityrates method the currency is inside the
 *      string ("522.75 USD") rather than in a sibling field.
 */

import type { MealPlan, RateAudience, RefundPolicy } from '@wahpi/core';

import type { WahHotel, WahRoom } from './types.js';

export interface ParsedMoney {
  readonly amountMinor: number;
  readonly currency: string | null;
}

/**
 * Parse a formatted money string to integer minor units.
 *
 * Handles "1,039.00", "522.75 USD", "1039", "USD 1,039.00". Returns null on
 * anything it cannot read — a rate we cannot price is rejected upstream rather
 * than silently coerced to zero.
 */
export function parseMoney(
  raw: string | null | undefined,
  fallbackCurrency?: string,
): ParsedMoney | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === '') return null;

  const currencyMatch = text.match(/\b([A-Z]{3})\b/);
  const numeric = text.replace(/[A-Z]{3}/g, '').replace(/[^0-9.\-]/g, '');
  if (numeric === '' || numeric === '-' || numeric === '.') return null;

  const value = Number(numeric);
  if (!Number.isFinite(value)) return null;

  return {
    amountMinor: Math.round(value * 100),
    currency: currencyMatch?.[1] ?? fallbackCurrency ?? null,
  };
}

export interface ParsedRatePlan {
  /** Prose before the room description, e.g. "WhataHotel! Travel Network, deposit required". */
  readonly planText: string | null;
  readonly roomText: string;
  readonly mealPlan: MealPlan;
  readonly refundPolicy: RefundPolicy;
  readonly audience: RateAudience;
  readonly isPrepaid: boolean | null;
}

/**
 * Split `roomDesc` into its rate-plan prefix and room description.
 *
 * Observed form: `-<plan text>-<room text>`. The leading hyphen is always
 * present on the rates method.
 */
/**
 * Split `roomDesc` into its offer prefix and its room description.
 *
 * The format is `-<offer>-<room description>`, but hyphens occur INSIDE both
 * halves — "Prepay Non-refundable Non-changeable" in the offer, "Mini-fridge"
 * in the room text — so splitting on the first hyphen truncates the offer
 * mid-word. It produced offers named "Prepay Non", which then became a
 * different rate plan from "Prepay Non-refundable" at the next capture.
 *
 * When `roomName` is supplied the split is anchored on it instead: the room
 * half always begins with the room name, and that boundary is unambiguous.
 * The hyphen scan is only the fallback.
 */
export function parseRoomDesc(
  roomDesc: string,
  roomName?: string | null,
): { planText: string | null; roomText: string } {
  const text = (roomDesc ?? '').trim();
  if (!text.startsWith('-')) return { planText: null, roomText: text };
  const rest = text.slice(1);

  const anchor = (roomName ?? '').trim();
  if (anchor) {
    const at = rest.indexOf(anchor);
    if (at > 0) {
      return {
        planText:
          rest
            .slice(0, at)
            .replace(/[-\s]+$/, '')
            .trim() || null,
        roomText: rest.slice(at).trim(),
      };
    }
    if (at === 0) return { planText: null, roomText: rest.trim() };
  }

  const split = rest.indexOf('-');
  if (split === -1) return { planText: null, roomText: rest };
  return { planText: rest.slice(0, split).trim(), roomText: rest.slice(split + 1).trim() };
}

/**
 * A stable identifier for an offer, derived from its prose label.
 *
 * The API has no offer code — the only thing distinguishing "WhataHotel! &
 * Save" from "Hotel Credit Offer" on the same room and rateCode is this text.
 * Slugging it (upper-case, alphanumerics, single underscores) absorbs spacing
 * and punctuation drift while keeping genuinely different offers apart.
 */
export function offerSlugFor(planText: string | null | undefined): string | null {
  const slug = (planText ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
  return slug === '' ? null : slug;
}

/**
 * Derive rate terms.
 *
 * What the payload supports and what it does not:
 *  - **audience** is confidently CONSORTIA. Every rate observed carries the
 *    "WhataHotel! Travel Network" / preferred-partner marker; that is the
 *    programme these rates come from.
 *  - **mealPlan** is ROOM_ONLY. Breakfast appears in the hotel's `perks`, i.e.
 *    as a partner BENEFIT attached to the stay, not as a board basis on the
 *    rate. Modelling it as a meal plan would double-count it against factor F6.
 *  - **refundPolicy is PARTIALLY determinable.** Some offers state it outright
 *    ("Prepay Non-refundable Non-changeable"); most say nothing. Stated
 *    non-refundability is recorded; silence stays UNKNOWN. Silence is NOT read
 *    as refundable — the absence of the word is not evidence of the terms, and
 *    a wrongly-refundable rate would be compared against genuinely flexible
 *    ones and look like a bargain because it is a worse product.
 *
 *    Since 2026-09-02 the source also sends `cancelDate` — a dated
 *    free-cancellation deadline. A well-formed date is the source STATING the
 *    rate is refundable, which is the positive signal the prose never gave
 *    us. An empty or absent value stays UNKNOWN: the source has not defined
 *    what empty means, and reading it as non-refundable would be the same
 *    silence-as-evidence mistake in the other direction. If the prose says
 *    non-refundable AND a cancelDate is present, the contradiction resolves
 *    to NON_REFUNDABLE — the conservative bucket: wrongly flattering a rate
 *    misprices it, wrongly stricter bucketing only narrows its comparisons.
 */
export function parseRateTerms(
  roomDesc: string,
  roomName?: string | null,
  cancelDate?: string | null,
): ParsedRatePlan {
  const { planText, roomText } = parseRoomDesc(roomDesc, roomName);
  const plan = (planText ?? '').toLowerCase();

  const isPartnerRate = /whatahotel|travel network|travel discover/.test(plan);
  const nonRefundable = /non-?\s*refundable/.test(plan);
  const prepayInFull = /prepay(?:\s+in\s+full)?/.test(plan);
  const depositRequired = /deposit required/.test(plan);
  const hasCancelDeadline = /^\d{4}-\d{2}-\d{2}$/.test((cancelDate ?? '').trim());

  return {
    planText,
    roomText,
    mealPlan: 'ROOM_ONLY',
    refundPolicy: nonRefundable ? 'NON_REFUNDABLE' : hasCancelDeadline ? 'REFUNDABLE' : 'UNKNOWN',
    audience: isPartnerRate ? 'CONSORTIA' : 'UNKNOWN',
    isPrepaid: prepayInFull || depositRequired ? true : null,
  };
}

/**
 * The source's own rate-plan identity: rate code AND offer.
 *
 * `rateCode` alone is NOT the plan. Verified against live responses: one hotel
 * returned the same room under rateCode `0S8` three times at two different
 * prices — "WhataHotel! & Save" at 1,698.21 and "Hotel Credit Offer" at
 * 1,838.51. They are different offers on the same inventory.
 *
 * Keying identity on the rate code alone made those collide on the ingest
 * dedup key, so two of every three were dropped and the survivor was whichever
 * the API happened to list first — an arbitrary price, sometimes 8% above the
 * cheapest available. The offer is therefore part of the identity.
 */
export function sourcePlanCodeFor(
  rateCode: string | null | undefined,
  planText: string | null | undefined,
): string {
  const code = (rateCode ?? '').trim().toUpperCase() || 'DEFAULT';
  const offer = offerSlugFor(planText);
  return offer ? `${code}|${offer}` : code;
}

/**
 * Comparability class for a WhataHotel rate.
 *
 * The semantic class (meal × refundability × audience) cannot be built, because
 * the payload states cancellation terms for only some offers — it would resolve
 * to UNRESOLVED for the rest, and doc 01 §4 excludes unresolved rates from every
 * baseline. That would leave the product with nothing to score.
 *
 * The source's own plan identity is used instead. Two rates sharing a rate code
 * AND an offer ARE the same product, even where we cannot state that product's
 * cancellation terms. Keying the class on it preserves the compare-like-with-
 * like guarantee without inventing facts we do not have.
 *
 * Upgrade path: once terms are exposed for every offer (U5), switch to the
 * semantic class and these opaque classes disappear.
 */
export function comparabilityClassFor(
  rateCode: string | null | undefined,
  planText?: string | null,
): string {
  const code = (rateCode ?? '').trim().toUpperCase();
  if (code === '') return 'UNRESOLVED';
  return `WAH:${sourcePlanCodeFor(code, planText)}`;
}

/**
 * The string the room-type matcher should see.
 *
 * NOT the full description. Every room at a hotel shares a long amenity tail —
 * "Mini-fridge, 420sqft/38sqm, Wireless internet, for" — and feeding that to a
 * trigram matcher drowns the two or three words that actually identify the
 * room. Measured against live data, it merged Bay View, Oceanfront, Resort
 * View and Standard Limited View into a single room type spanning a 37% price
 * range, which is exactly the baseline-mixing failure docs/mvp/01 §3 exists to
 * prevent.
 *
 * NOT the bare `roomName` either: it arrives truncated at ~45 characters, and
 * the truncation sometimes falls before the bed configuration, so a King and a
 * two-Queen version of one room become indistinguishable.
 *
 * So: the truncated name, which is where the view and class words are, plus the
 * structured `bedNum`/`bedType` fields the payload supplies separately. The
 * amenity tail is dropped.
 */
export function roomIdentityFor(room: WahRoom, roomText: string): string {
  const name = (room.roomName ?? '').trim();
  const base = name !== '' ? name : roomText;

  const bedNum = (room.bedNum ?? '').toString().trim();
  const bedType = (room.bedType ?? '').trim();
  const bed = [bedNum, bedType].filter((part) => part !== '').join(' ');

  // Appended unconditionally when present: it must be there for every capture
  // of this room or the identity is not stable across captures.
  return bed === '' ? base : `${base} [${bed}]`;
}

export interface ParsedRoom {
  readonly sourceRoomCode: string;
  readonly sourcePlanCode: string;
  /** The matching key — carries the bed disambiguator. Not for display. */
  readonly rawRoomName: string;
  /** What a customer should see. */
  readonly displayRoomName: string;
  readonly planName: string | null;
  readonly nightlyNetMinor: number;
  readonly totalGrossMinor: number;
  readonly currency: string;
  readonly comparabilityClass: string;
  readonly terms: ParsedRatePlan;
}

/**
 * Parse one room record. Returns null when the record cannot be priced or
 * identified — rejected upstream with a reason rather than coerced.
 */
export function parseRoom(room: WahRoom, nights: number): ParsedRoom | null {
  if (!room.bookCode || !room.roomName) return null;

  const daily = parseMoney(room.rateDaily, room.currency);
  const total = parseMoney(room.rateTotal, room.currency);
  if (!daily || !total || daily.amountMinor <= 0 || total.amountMinor <= 0) return null;
  if (nights <= 0) return null;

  const currency = daily.currency ?? total.currency ?? room.currency ?? 'USD';
  const terms = parseRateTerms(room.roomDesc ?? '', room.roomName, room.cancelDate);

  return {
    sourceRoomCode: room.bookCode,
    sourcePlanCode: sourcePlanCodeFor(room.rateCode, terms.planText),
    rawRoomName: roomIdentityFor(room, terms.roomText),
    displayRoomName: (room.roomName ?? '').trim() || terms.roomText,
    planName: terms.planText,
    nightlyNetMinor: daily.amountMinor,
    totalGrossMinor: total.amountMinor,
    currency,
    comparabilityClass: comparabilityClassFor(room.rateCode, terms.planText),
    terms,
  };
}

// ── perks → benefits ──────────────────────────────────────────────────────

export interface ParsedPerk {
  readonly benefitCode: string;
  readonly displayName: string;
  readonly valueMinor: number | null;
}

/**
 * Map a preferred-partner perk to a benefit in the catalog.
 *
 * Ordered: the credit rule must run before the generic ones, since several
 * perks mention more than one thing. Anything unrecognised returns null and is
 * left out rather than bucketed into a wrong category — a mis-valued benefit
 * moves the Effective Value factor directly.
 */
export function parsePerk(perkText: string): ParsedPerk | null {
  const text = (perkText ?? '').trim();
  if (text === '') return null;
  const lower = text.toLowerCase();

  // Long explanatory footnotes rather than actual perks.
  if (lower.length > 120) return null;

  if (/credit/.test(lower)) {
    // "A 100 Hotel Credit", "A 100 Credit" — the currency symbol is stripped
    // in the source data, so match a bare number.
    const amount = lower.match(/(\d{2,5})\s*(?:usd)?\s*(?:hotel\s*)?credit/);
    const value = amount?.[1] ? Number(amount[1]) * 100 : null;
    return { benefitCode: 'HOTEL_CREDIT', displayName: text, valueMinor: value };
  }
  if (/breakfast/.test(lower)) {
    return { benefitCode: 'BREAKFAST_2', displayName: text, valueMinor: null };
  }
  if (/upgrade/.test(lower)) {
    return { benefitCode: 'UPGRADE', displayName: text, valueMinor: null };
  }
  if (/late\s*check\s*out/.test(lower)) {
    return { benefitCode: 'LATE_CHECKOUT', displayName: text, valueMinor: null };
  }
  if (/early\s*check\s*in/.test(lower)) {
    return { benefitCode: 'EARLY_CHECKIN', displayName: text, valueMinor: null };
  }
  if (/wi-?fi|internet/.test(lower)) {
    return { benefitCode: 'WIFI', displayName: text, valueMinor: null };
  }
  if (/welcome amenity|amenity/.test(lower)) {
    return { benefitCode: 'WELCOME_AMENITY', displayName: text, valueMinor: null };
  }
  return null;
}

export function parsePerks(perks: readonly { perk: string }[] | undefined): ParsedPerk[] {
  if (!perks) return [];
  const seen = new Set<string>();
  const out: ParsedPerk[] = [];
  for (const p of perks) {
    const parsed = parsePerk(p.perk);
    if (!parsed || seen.has(parsed.benefitCode)) continue;
    seen.add(parsed.benefitCode);
    out.push(parsed);
  }
  return out;
}

export interface ParsedHotel {
  readonly wahHotelId: string;
  readonly name: string;
  readonly city: string | null;
  readonly region: string | null;
  readonly country: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  /**
   * The source's rank for this hotel within its city, when the record came
   * from `cityrates` — the only method that carries one. Null everywhere else,
   * which means "not ranked", never "ranked last".
   */
  readonly cityRank: number | null;
  readonly amadeusProperty: string | null;
  readonly perks: readonly ParsedPerk[];
  readonly url: string | null;
}

export function parseHotel(hotel: WahHotel): ParsedHotel | null {
  if (!hotel.hotelID || !hotel.name) return null;
  const num = (v: string | undefined): number | null => {
    if (v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  /**
   * A coordinate, or null — never a number that cannot be one.
   *
   * Latitude is bounded by ±90 and longitude by ±180 by definition, so a value
   * outside them is not an imprecise coordinate, it is not a coordinate.
   * Measured 2026-08-20: hotel 4237 (Meliá Serengeti Lodge) states a longitude
   * of 5464062, which overflowed the NUMERIC(9,6) column and aborted a whole
   * catalogue sweep. Storing null is the honest reading — we do not know where
   * this hotel is — and it keeps one bad record from costing the run.
   */
  const coord = (v: string | undefined, limit: number): number | null => {
    const n = num(v);
    return n === null || Math.abs(n) > limit ? null : n;
  };
  // The API writes the string "NULL" for absent text fields.
  const str = (v: string | undefined): string | null =>
    v === undefined || v === '' || v === 'NULL' ? null : v;

  // The `hotel` method can jam BOTH coordinates into loc-lat
  // ("12.519021737497715, -70.03774231571535") and leave loc-long empty —
  // measured 2026-08-26 on hotel 4734 (Renaissance Windcreek Aruba), whose
  // coordinates the catalogue therefore stored as null, which removed it
  // from every comp radius. The `search` method sends the same hotel's
  // coordinates as two proper fields. Split the combined form; each half
  // still passes the bounded coord() validation like any other value.
  //
  // The literal string "NULL" counts as empty here for the same reason str()
  // treats it that way: it is how this API spells an absent field. Testing
  // only for undefined and '' left a combined loc-lat unsplit whenever
  // loc-long came back as "NULL".
  let rawLat = hotel['loc-lat'];
  let rawLng = hotel['loc-long'];
  const absent = (v: string | undefined): boolean => v === undefined || v === '' || v === 'NULL';
  if (rawLat && absent(rawLng) && String(rawLat).includes(',')) {
    const [half1, half2] = String(rawLat).split(',');
    rawLat = half1?.trim();
    rawLng = half2?.trim();
  }

  // A position is a PAIR. One coordinate without the other is not a partial
  // position, it is no position: every distance predicate in the system needs
  // both, so a lone latitude is invisible to the competitive ladder while
  // still making the hotel look placed. Four hotels reached production in
  // exactly that state — The Westin Siray Bay, Hotel Villa Carlotta, The Slaak
  // Rotterdam and The Danna Langkawi — each with a latitude and a longitude
  // the source did not supply.
  //
  // Rejecting the pair here rather than storing half of it is also what keeps
  // the catalogue sync working: migration 0018 requires a position and its
  // provenance to move together, so re-writing a lone latitude on the next
  // sync would be refused by the CHECK and take the whole sync down with it.
  //
  // Same principle as rule 9: a thing that cannot be measured is excluded, not
  // recorded at half strength.
  const latitude = coord(rawLat, 90);
  const longitude = coord(rawLng, 180);
  const placed = latitude !== null && longitude !== null;

  return {
    wahHotelId: hotel.hotelID,
    name: hotel.name,
    city: str(hotel.city),
    region: str(hotel.region),
    country: str(hotel.country),
    latitude: placed ? latitude : null,
    longitude: placed ? longitude : null,
    cityRank: num(hotel.rank),
    amadeusProperty: str(hotel['ama-property']),
    perks: parsePerks(hotel.perks),
    url: str(hotel.url),
  };
}
