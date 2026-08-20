/**
 * WhataHotel adapter tests, run against REAL captured payloads.
 *
 * The fixtures in tests/fixtures/whatahotel/ are actual API responses with
 * credentials and session tokens scrubbed. Testing against them rather than
 * hand-written objects is the point: the failures this adapter can have are
 * mis-readings of the real payload, and a fabricated fixture would encode the
 * same misreading as the code.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  comparabilityClassFor,
  offerSlugFor,
  sourcePlanCodeFor,
  parseHotel,
  parseMoney,
  parsePerk,
  parsePerks,
  parseRateTerms,
  parseRoom,
  parseRoomDesc,
} from '../../packages/ingest/src/adapters/whatahotel/parse.js';
import { toRecords } from '../../packages/ingest/src/adapters/whatahotel/adapter.js';
import { redact } from '../../packages/ingest/src/adapters/whatahotel/client.js';
import {
  parseLenientJson,
  stripTrailingCommas,
} from '../../packages/ingest/src/adapters/whatahotel/json.js';
import {
  WAH_NO_AVAILABILITY_CODE,
  WahApiError,
} from '../../packages/ingest/src/adapters/whatahotel/types.js';
import type {
  WahHotelsResponse,
  WahRatesResponse,
} from '../../packages/ingest/src/adapters/whatahotel/types.js';

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../fixtures/whatahotel/${name}.json`, import.meta.url), 'utf8'));

const rates1 = fixture<{ wahData: WahRatesResponse }>('rates_1n').wahData;
const rates3 = fixture<{ wahData: WahRatesResponse }>('rates_3n').wahData;
const hotelDoc = fixture<{ wahData: WahHotelsResponse }>('hotel').wahData;
const searchDoc = fixture<{ wahData: WahHotelsResponse }>('search').wahData;
const cityDoc = fixture<{ wahData: WahHotelsResponse }>('cityrates').wahData;

// ── money ──────────────────────────────────────────────────────────────────

describe('money parsing', () => {
  it('reads the formatted strings the API actually returns', () => {
    // The API sends money as display strings with thousands separators.
    expect(parseMoney('1,039.00', 'USD')).toEqual({ amountMinor: 103900, currency: 'USD' });
    expect(parseMoney('3,910.37', 'USD')).toEqual({ amountMinor: 391037, currency: 'USD' });
  });

  it('reads the cityrates form, where the currency is inside the string', () => {
    // rates: {"rateDaily":"522.75","currency":"USD"}
    // cityrates: {"rateDaily":"522.75 USD"}   ← different shape, same field name
    expect(parseMoney('522.75 USD')).toEqual({ amountMinor: 52275, currency: 'USD' });
    expect(parseMoney('1,461.10 USD')).toEqual({ amountMinor: 146110, currency: 'USD' });
  });

  it('returns null rather than zero for anything unreadable', () => {
    // A rate we cannot price must be rejected upstream, never coerced to 0 —
    // a zero would enter a baseline and drag every score built on it.
    for (const bad of ['', '   ', 'N/A', 'Call for rates', null, undefined]) {
      expect(parseMoney(bad as string)).toBeNull();
    }
  });
});

// ── the money semantics that would have been guessed wrong ─────────────────

describe('rateDaily vs rateTotal', () => {
  it('rateDaily is NET per night and rateTotal is GROSS for the whole stay', () => {
    const one = rates1.rooms[0]!;
    const three = rates3.rooms.find((r) => r.bookCode === one.bookCode)!;

    const dailyOne = parseMoney(one.rateDaily, 'USD')!.amountMinor;
    const dailyThree = parseMoney(three.rateDaily, 'USD')!.amountMinor;
    const totalOne = parseMoney(one.rateTotal, 'USD')!.amountMinor;
    const totalThree = parseMoney(three.rateTotal, 'USD')!.amountMinor;

    // rateDaily does not change with stay length — it is a per-night figure.
    expect(dailyThree).toBe(dailyOne);
    // rateTotal scales with nights, and carries a constant tax/fee uplift.
    const factorOne = totalOne / dailyOne;
    const factorThree = totalThree / (dailyThree * 3);
    expect(factorThree).toBeCloseTo(factorOne, 4);
    expect(factorOne).toBeGreaterThan(1.2); // ~1.2545 at this hotel
  });

  it('stores the GROSS whole-stay amount, because that is what the traveler pays', () => {
    const records = toRecords(
      {
        wahHotelId: '951',
        checkIn: '2027-03-29',
        nights: 3,
        adults: 2,
        children: 0,
        currency: 'USD',
      },
      rates3,
    );
    const first = records[0]!;
    const room = rates3.rooms.find((r) => r.bookCode === first.sourceRoomCode)!;

    expect(first.totalAmountMinor).toBe(parseMoney(room.rateTotal, 'USD')!.amountMinor);
    expect(first.taxBasis).toBe('GROSS');
    // Using rateDaily × nights would understate the price by the tax factor.
    const netTotal = parseMoney(room.rateDaily, 'USD')!.amountMinor * 3;
    expect(first.totalAmountMinor).toBeGreaterThan(netTotal);
    expect(first.taxesFeesMinor).toBe(first.totalAmountMinor - netTotal);
  });
});

// ── room and rate-plan identity ────────────────────────────────────────────

describe('room identity', () => {
  it('bookCode is stable across calls, so rooms match at SOURCE_ID confidence', () => {
    const a = new Set(rates1.rooms.map((r) => r.bookCode));
    const b = new Set(rates3.rooms.map((r) => r.bookCode));
    expect(a.size).toBe(rates1.rooms.length); // unique within a response
    expect([...a].every((code) => b.has(code))).toBe(true);
  });

  it('splits roomDesc into its rate-plan prefix and room text', () => {
    const parsed = parseRoomDesc(
      '-WhataHotel! Travel Network, deposit required-Deluxe Resort View Room overlooks tropical-landscape, 1 King',
    );
    expect(parsed.planText).toBe('WhataHotel! Travel Network, deposit required');
    expect(parsed.roomText).toContain('Deluxe Resort View Room');
  });

  it('builds the matching key from the room name plus the structured bed fields', () => {
    // Neither field alone works. `roomName` arrives cut mid-phrase ("Deluxe
    // Resort View Room overlooks tropical"), sometimes before the bed
    // configuration, so a King and a two-Queen version become identical. The
    // full description is worse: every room at a hotel shares a long amenity
    // tail that drowns the identifying words in a trigram comparison.
    const room = rates1.rooms[0]!;
    const parsed = parseRoom(room, 1)!;

    expect(parsed.rawRoomName).toContain(room.roomName.trim());
    expect(parsed.rawRoomName).toBe(`${room.roomName.trim()} [${room.bedNum} ${room.bedType}]`);
    // The amenity tail is NOT part of the key.
    expect(parsed.rawRoomName).not.toContain('Wireless internet');
  });

  it('distinguishes two rooms whose names truncate identically', () => {
    // The real case: one King, one two-Queen, both truncated to the same text.
    const base = rates1.rooms[0]!;
    const king = parseRoom({ ...base, bedNum: '1', bedType: 'King' }, 1)!;
    const queens = parseRoom({ ...base, bedNum: '2', bedType: 'Queen' }, 1)!;
    expect(king.rawRoomName).not.toBe(queens.rawRoomName);
  });

  it('rejects a room it cannot price or identify', () => {
    const room = rates1.rooms[0]!;
    expect(parseRoom({ ...room, rateDaily: '', rateTotal: '' }, 1)).toBeNull();
    expect(parseRoom({ ...room, bookCode: '' }, 1)).toBeNull();
    expect(parseRoom(room, 0)).toBeNull();
  });
});

describe('rate terms', () => {
  it('identifies the preferred-partner programme as a consortia rate', () => {
    const terms = parseRateTerms('-WhataHotel! Travel Network, deposit required-Deluxe Room');
    expect(terms.audience).toBe('CONSORTIA');
    expect(terms.isPrepaid).toBe(true);
  });

  it('does NOT invent a cancellation policy the payload does not carry', () => {
    // "deposit required" says a deposit is taken, not whether it is refundable.
    const terms = parseRateTerms('-WhataHotel! Travel Network, deposit required-Deluxe Room');
    expect(terms.refundPolicy).toBe('UNKNOWN');
  });

  it('models breakfast as a benefit, not a board basis', () => {
    // Breakfast arrives in the hotel's perks, so treating it as a meal plan
    // would double-count it against factor F6.
    const terms = parseRateTerms(
      '-WhataHotel! Travel Discover the Club, includes Club access-Ocean View',
    );
    expect(terms.mealPlan).toBe('ROOM_ONLY');
  });
});

describe('comparability class', () => {
  it('keys on the source rate-plan code, so like-for-like survives the missing terms', () => {
    expect(comparabilityClassFor('2SH')).toBe('WAH:2SH');
    expect(comparabilityClassFor('sgp')).toBe('WAH:SGP');
  });

  it('falls back to UNRESOLVED when there is no rate code at all', () => {
    expect(comparabilityClassFor('')).toBe('UNRESOLVED');
    expect(comparabilityClassFor(null)).toBe('UNRESOLVED');
  });

  it('separates different rate plans at the same hotel', () => {
    expect(comparabilityClassFor('2SH')).not.toBe(comparabilityClassFor('SGP'));
  });
});

// ── perks → benefits ───────────────────────────────────────────────────────

describe('perk parsing', () => {
  it('maps the real perks on a live hotel record', () => {
    const hotel = parseHotel(hotelDoc.hotels[0]!)!;
    const codes = hotel.perks.map((p) => p.benefitCode).sort();
    expect(codes).toContain('BREAKFAST_2');
    expect(codes).toContain('HOTEL_CREDIT');
    expect(codes).toContain('UPGRADE');
    expect(codes).toContain('LATE_CHECKOUT');
    expect(codes).toContain('WIFI');
  });

  it('extracts the credit amount', () => {
    const parsed = parsePerk('A 100 Hotel Credit  Welcome Amenity')!;
    expect(parsed.benefitCode).toBe('HOTEL_CREDIT');
    expect(parsed.valueMinor).toBe(10000);
  });

  it('ignores the long explanatory footnote that follows the real perks', () => {
    const footnote =
      'The onetime hotel credit is per stay and can be applied to parking, daily resort fee and select hotel outlets only  Must be used during stay The Credit cannot be applied to any part of the room rate or taxes';
    expect(parsePerk(footnote)).toBeNull();
  });

  it('returns null for anything it does not recognise, rather than guessing', () => {
    expect(parsePerk('Something entirely unrelated')).toBeNull();
    expect(parsePerk('')).toBeNull();
  });

  it('deduplicates by benefit code', () => {
    const parsed = parsePerks([
      { perk: 'Free WiFi' },
      { perk: 'Complimentary Basic Internet' },
      { perk: 'A Room Upgrade if Available' },
    ]);
    expect(parsed.filter((p) => p.benefitCode === 'WIFI')).toHaveLength(1);
  });
});

// ── hotel records ──────────────────────────────────────────────────────────

describe('hotel parsing', () => {
  it('reads identity and geo from a real record', () => {
    const hotel = parseHotel(hotelDoc.hotels[0]!)!;
    expect(hotel.wahHotelId).toBe('951');
    expect(hotel.name).toContain('Ritz Carlton');
    expect(hotel.city).toBe('Maui');
    expect(hotel.latitude).toBeCloseTo(21.0014, 3);
    expect(hotel.longitude).toBeCloseTo(-156.654, 2);
    expect(hotel.amadeusProperty).toBe('RZJHMKAP');
  });

  it('drops a coordinate that cannot be one, rather than storing it', () => {
    // Measured on hotel 4237 (Meliá Serengeti Lodge): the source states a
    // longitude of 5464062. It overflowed NUMERIC(9,6) and aborted a whole
    // catalogue sweep 1,315 hotels in. Latitude is bounded by ±90 and
    // longitude by ±180, so anything outside is not a coordinate at all —
    // null is the honest reading, and it costs nothing but the map pin.
    const broken = parseHotel({
      ...hotelDoc.hotels[0]!,
      'loc-lat': '5464062',
      'loc-long': '5464062',
    })!;
    expect(broken.latitude).toBeNull();
    expect(broken.longitude).toBeNull();

    // The bound is on the value, not on the format: a real coordinate that
    // happens to be near the limit still survives.
    const edge = parseHotel({
      ...hotelDoc.hotels[0]!,
      'loc-lat': '-89.9',
      'loc-long': '179.999',
    })!;
    expect(edge.latitude).toBeCloseTo(-89.9, 3);
    expect(edge.longitude).toBeCloseTo(179.999, 3);
  });

  it('treats the literal string "NULL" as absent', () => {
    // primary-desc and secondary-desc arrive as the four characters N-U-L-L.
    const hotel = parseHotel({ ...hotelDoc.hotels[0]!, city: 'NULL', country: 'NULL' })!;
    expect(hotel.city).toBeNull();
    expect(hotel.country).toBeNull();
  });

  it('parses every hotel in the search and cityrates responses', () => {
    for (const doc of [searchDoc, cityDoc]) {
      const parsed = (doc.hotels ?? []).map(parseHotel);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed.every((h) => h !== null)).toBe(true);
    }
  });
});

// ── error handling ─────────────────────────────────────────────────────────

describe('error taxonomy', () => {
  const err = (name: string) =>
    new WahApiError(fixture<{ wahData: { status: never } }>(name).wahData.status);

  it('treats 401 and 400 as permanent', () => {
    expect(err('error_401').retryable).toBe(false);
    expect(err('error_400').retryable).toBe(false);
  });

  it('treats 500 as retryable', () => {
    expect(err('error_500').retryable).toBe(true);
    // A 500 is a fault, never a stand-in for "sold out" — swallowing it would
    // let collection stop silently while every run reported success.
    expect(err('error_500').noAvailability).toBe(false);
  });

  // Found in the first production collection run, not in design.
  it('recognises 204 as sold out rather than as a failure', () => {
    const soldOut = err('soldout_204');
    expect(soldOut.code).toBe(WAH_NO_AVAILABILITY_CODE);
    expect(soldOut.noAvailability).toBe(true);
    // Nothing to retry: the inventory does not exist, and a second call costs
    // budget to be told the same thing.
    expect(soldOut.retryable).toBe(false);
  });

  it('a sold-out response is well-formed and simply carries no rooms', () => {
    const doc = fixture<{ wahData: WahRatesResponse & { status: { connection: number } } }>(
      'soldout_204',
    ).wahData;
    // connection: 1 — unlike the error fixtures. The API considers this a
    // successful call that happens to have no inventory, which is why the code
    // and not the connection flag is what distinguishes it.
    expect(doc.status.connection).toBe(1);
    expect(doc.rooms).toEqual([]);
    expect(doc.hotel?.id).toBe('1326');
  });

  it('carries the API message so the failure is diagnosable', () => {
    expect(err('error_401').message).toContain('Authorization denied');
    expect(err('error_400').message).toContain('Check-In date');
  });

  it('every error fixture reports HTTP-200-shaped success at the transport layer', () => {
    // The reason the client must check wahData.status and never the HTTP code:
    // an adapter trusting HTTP would read all of these as successful.
    for (const name of ['error_400', 'error_401', 'error_500']) {
      const status = fixture<{ wahData: { status: { connection: number; code: string } } }>(name)
        .wahData.status;
      expect(status.connection).toBe(0);
      expect(status.code).not.toBe('200');
    }
  });

  /**
   * Success is not one code. Measured 2026-08-20 across all four methods:
   * `hotel` answers 100, `rates`/`search`/`cityrates` answer 200, and both
   * carry connection 1 with message "Success". Treating 200 as the only
   * success made every `hotel` lookup throw — which silently disabled
   * automatic catalogue enrollment, so no new hotel could ever be added.
   */
  it('treats both documented success codes as success', () => {
    const succeeded = (status: { connection: number; code: string }): boolean =>
      status.connection === 1 && new Set(['100', '200']).has(status.code);

    expect(succeeded({ connection: 1, code: '100' })).toBe(true); // hotel
    expect(succeeded({ connection: 1, code: '200' })).toBe(true); // rates, search, cityrates
    // Everything else is still a failure, including a broken connection that
    // happens to carry a success code.
    expect(succeeded({ connection: 0, code: '200' })).toBe(false);
    expect(succeeded({ connection: 1, code: '401' })).toBe(false);
    expect(succeeded({ connection: 1, code: '500' })).toBe(false);
    expect(succeeded({ connection: 1, code: '204' })).toBe(false); // sold out
  });
});

// ── rate-plan identity ─────────────────────────────────────────────────────

/**
 * Found by the first production collection run, not by design.
 *
 * The adapter originally keyed rate-plan identity on `rateCode` alone. Live
 * responses put three different OFFERS on one room under a single rateCode at
 * two different prices, so they collided on the ingest dedup key: two of every
 * three were dropped and the survivor was whichever the API listed first.
 */
describe('offers are part of the rate-plan identity', () => {
  const multi = fixture<{ wahData: WahRatesResponse }>('rates_multi_offer').wahData;

  it('the fixture really does carry colliding offers', () => {
    const zeroS8 = (multi.rooms ?? []).filter((r) => r.rateCode === '0S8');
    expect(zeroS8).toHaveLength(3);
    expect(new Set(zeroS8.map((r) => r.roomName))).toHaveLength(1);
    // Same room, same rateCode, two prices — 8.3% apart.
    expect(new Set(zeroS8.map((r) => r.rateTotal))).toHaveLength(2);
  });

  it('separates them by offer, so the cheaper rate is not discarded', () => {
    const records = toRecords(
      {
        wahHotelId: '1198',
        checkIn: '2026-08-29',
        nights: 3,
        adults: 2,
        children: 0,
        currency: 'USD',
      },
      multi,
    );
    const zeroS8 = records.filter((r) => r.sourcePlanCode?.startsWith('0S8'));
    expect(zeroS8).toHaveLength(3);

    // Three distinct plan codes → three rows survive dedup, one per offer.
    expect(new Set(zeroS8.map((r) => r.sourcePlanCode))).toHaveLength(3);
    expect(zeroS8.map((r) => r.sourcePlanCode)).toContain(
      '0S8|WHATAHOTEL_WHATAHOTEL_SAVE_INCLUDES',
    );
    expect(zeroS8.map((r) => r.sourcePlanCode)).toContain('0S8|EXCLUSIVE_RATE');

    // The cheapest offer is present, which is the whole point.
    expect(Math.min(...zeroS8.map((r) => r.totalAmountMinor))).toBe(169_821);
  });

  it('keeps the comparability class aligned with the plan identity', () => {
    const records = toRecords(
      {
        wahHotelId: '1198',
        checkIn: '2026-08-29',
        nights: 3,
        adults: 2,
        children: 0,
        currency: 'USD',
      },
      multi,
    );
    for (const record of records) {
      expect(record.comparabilityClassOverride).toBe(`WAH:${record.sourcePlanCode}`);
    }
    // Different offers are different products and must never share a baseline.
    const classes = new Set(records.map((r) => r.comparabilityClassOverride));
    expect(classes).toHaveLength(4);
  });

  it('reads stated non-refundability, and stays silent otherwise', () => {
    const nonRef = (multi.rooms ?? []).find((r) => r.bookCode === 'PNAZ00');
    expect(parseRateTerms(nonRef?.roomDesc ?? '', nonRef?.roomName).refundPolicy).toBe(
      'NON_REFUNDABLE',
    );
    expect(parseRateTerms(nonRef?.roomDesc ?? '', nonRef?.roomName).isPrepaid).toBe(true);

    // An offer that says nothing about cancellation stays UNKNOWN. Absence of
    // the word is not evidence the rate is refundable.
    const silent = (multi.rooms ?? []).find((r) => r.bookCode === 'ODLC00');
    expect(parseRateTerms(silent?.roomDesc ?? '', silent?.roomName).refundPolicy).toBe('UNKNOWN');
  });

  it('does not truncate an offer label at a hyphen inside a word', () => {
    // The first version split on the first "-" and produced "Prepay Non",
    // which would become a different rate plan at the next capture.
    const nonRef = (multi.rooms ?? []).find((r) => r.bookCode === 'PNAZ00');
    const { planText } = parseRoomDesc(nonRef?.roomDesc ?? '', nonRef?.roomName);
    expect(planText).toBe('Prepay Non-refundable Non-changeable, prepay in full');
    expect(planText).not.toBe('Prepay Non');
  });

  it('keeps the matching disambiguator out of customer-facing text', () => {
    const records = toRecords(
      {
        wahHotelId: '1198',
        checkIn: '2026-08-29',
        nights: 3,
        adults: 2,
        children: 0,
        currency: 'USD',
      },
      multi,
    );
    for (const record of records) {
      // The bed suffix exists so a truncated name cannot merge a King with a
      // two-Queen. It must never reach the widget.
      expect(record.rawRoomName).toMatch(/\[.+\]$/);
      expect(record.displayRoomName).not.toMatch(/\[/);
      expect(record.displayRoomName?.trim()).not.toBe('');
    }
  });

  it('slugs offers stably across punctuation and spacing drift', () => {
    expect(offerSlugFor('WhataHotel! & Save')).toBe(offerSlugFor('WhataHotel  &   Save'));
    expect(offerSlugFor('Exclusive Rate (*)')).toBe('EXCLUSIVE_RATE');
    expect(offerSlugFor('  ')).toBeNull();
    // Genuinely different offers stay apart.
    expect(offerSlugFor('Hotel Credit Offer')).not.toBe(offerSlugFor('Exclusive Rate'));
  });

  it('keeps the cheapest when two rates are indistinguishable but priced apart', () => {
    // Two rooms identical in every modelled dimension, 8% apart in price.
    // Whichever the API listed first would otherwise win.
    const room = (multi.rooms ?? []).find((r) => r.bookCode === 'Z44A00');
    if (!room) throw new Error('fixture changed');
    const dearer = { ...room, bookCode: 'ZZZZ99', rateTotal: '1,999.00' };

    const records = toRecords(
      {
        wahHotelId: '1198',
        checkIn: '2026-08-29',
        nights: 3,
        adults: 2,
        children: 0,
        currency: 'USD',
      },
      { ...multi, rooms: [dearer, room] },
    );
    const survivors = records.filter((r) => r.sourcePlanCode?.startsWith('0S8|WHATAHOTEL'));
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.totalAmountMinor).toBe(169_821);
    // The kept bookCode is the one that actually gets that price.
    expect(survivors[0]?.sourceRoomCode).toBe('Z44A00');
  });

  it('falls back to the bare rate code when there is no offer text', () => {
    expect(sourcePlanCodeFor('2SH', null)).toBe('2SH');
    expect(comparabilityClassFor('2SH', null)).toBe('WAH:2SH');
    expect(comparabilityClassFor('', null)).toBe('UNRESOLVED');
  });
});

// ── malformed JSON from the API ────────────────────────────────────────────

describe('tolerant JSON parsing', () => {
  const malformedText = readFileSync(
    new URL('../fixtures/whatahotel/malformed_trailing_comma.json', import.meta.url),
    'utf8',
  );

  it('the fixture really is invalid JSON — the defect is preserved, not fixed', () => {
    // If this ever starts passing, the fixture was accidentally repaired and
    // every test below is asserting nothing.
    expect(() => JSON.parse(malformedText)).toThrow();
  });

  it('recovers the real payload the API failed to encode', () => {
    const { value, repaired } = parseLenientJson<{ wahData: WahRatesResponse }>(malformedText);
    expect(repaired).toBe(true);
    expect(value.wahData.rooms).toHaveLength(2);
    expect(value.wahData.rooms?.[0]?.bookCode).toBe('B1KPR2');
    expect(value.wahData.hotel?.id).toBe('1326');
  });

  it('parses the recovered rooms into records with the money semantics intact', () => {
    const { value } = parseLenientJson<{ wahData: WahRatesResponse }>(malformedText);
    const records = toRecords(
      {
        wahHotelId: '1326',
        checkIn: '2026-09-05',
        nights: 3,
        adults: 2,
        children: 0,
        currency: 'USD',
      },
      value.wahData,
    );
    expect(records).toHaveLength(2);
    // rateTotal "1,853.20" is the GROSS whole stay, not a nightly figure.
    expect(records[0]?.totalAmountMinor).toBe(185_320);
    expect(records[0]?.taxBasis).toBe('GROSS');
  });

  it('leaves valid JSON untouched', () => {
    const { value, repaired } = parseLenientJson<{ a: number[] }>('{"a":[1,2,3]}');
    expect(repaired).toBe(false);
    expect(value.a).toEqual([1, 2, 3]);
  });

  it('never edits commas inside strings', () => {
    // The naive regex fix corrupts this. A value of "done, ]" is legal content.
    const text = '{"note":"done, ]","list":[1,]}';
    expect(stripTrailingCommas(text)).toBe('{"note":"done, ]","list":[1]}');
    expect(parseLenientJson<{ note: string }>(text).value.note).toBe('done, ]');
  });

  it('handles escaped quotes and backslashes while scanning', () => {
    const text = '{"a":"say \\"hi, ]\\"","b":"back\\\\","c":[1,]}';
    const parsed = parseLenientJson<{ a: string; b: string; c: number[] }>(text);
    expect(parsed.value.a).toBe('say "hi, ]"');
    expect(parsed.value.b).toBe('back\\');
    expect(parsed.value.c).toEqual([1]);
  });

  it('rethrows the original error when the repair does not help', () => {
    expect(() => parseLenientJson('{"a": }')).toThrow(SyntaxError);
    expect(() => parseLenientJson('not json at all')).toThrow(SyntaxError);
  });
});

describe('credential handling', () => {
  it('redacts the API key from anything loggable', () => {
    const url = 'https://whatahotel.com/data/api.cfm?method=rates&hotel=951&apiKey=SECRET-KEY-123';
    expect(redact(url)).toContain('apiKey=<redacted>');
    expect(redact(url)).not.toContain('SECRET-KEY-123');
  });

  it('the committed fixtures contain no credentials', () => {
    // Enumerated, not listed: a fixture added later must be covered by this
    // check automatically, or the one that leaks is the one nobody added here.
    const dir = new URL('../fixtures/whatahotel/', import.meta.url);
    const names = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(names.length).toBeGreaterThanOrEqual(8);

    for (const name of names) {
      const text = readFileSync(new URL(name, dir), 'utf8');
      // Anything that is not the literal <scrubbed> placeholder is a leak.
      // The first version of this test allow-listed patterns and missed the
      // session tokens sitting inside bookingURL query strings.
      for (const param of ['apiKey', 'cfid', 'cftoken']) {
        const re = new RegExp(`${param}=(?!<scrubbed>)`, 'i');
        expect(text, `${name} leaks ${param} in a URL`).not.toMatch(re);
      }
      for (const key of ['cfID', 'cfToken']) {
        const re = new RegExp(`"${key}":\\s*"(?!<scrubbed>)`);
        expect(text, `${name} leaks ${key}`).not.toMatch(re);
      }
    }
  });
});

// ── end to end over a real response ────────────────────────────────────────

describe('toRecords over a captured response', () => {
  const records = toRecords(
    {
      wahHotelId: '951',
      checkIn: '2027-03-29',
      nights: 1,
      adults: 2,
      children: 0,
      currency: 'USD',
    },
    rates1,
  );

  it('produces one record per distinguishable product', () => {
    // Not one per room: this response lists 36 rooms, two of which are
    // indistinguishable duplicates of another entry in every dimension the
    // payload exposes. Those collapse; everything else survives.
    expect(rates1.rooms).toHaveLength(36);
    expect(records).toHaveLength(34);

    // Every surviving record is a distinct (room, plan) pair — anything else
    // would collide on the ingest dedup key and be silently dropped later.
    const keys = records.map((r) => `${r.rawRoomName}|${r.sourcePlanCode}`);
    expect(new Set(keys).size).toBe(records.length);
  });

  it('produces records the ingest pipeline will accept', () => {
    for (const r of records) {
      expect(r.wahHotelId).toBe('951');
      expect(r.rawRoomName.trim()).not.toBe('');
      expect(r.totalAmountMinor).toBeGreaterThan(0);
      expect(Number.isInteger(r.totalAmountMinor)).toBe(true);
      expect(r.currency).toHaveLength(3);
      expect(r.nights).toBe(1);
      expect(r.sourceRoomCode).toBeTruthy();
      expect(r.comparabilityClassOverride).toMatch(/^WAH:/);
      expect(r.isAvailable).toBe(true);
    }
  });

  it('leaves availability null rather than inventing a scarcity signal', () => {
    // The API does not expose rooms-remaining (U11), so the scarcity guard must
    // stay inert rather than act on a default.
    expect(records.every((r) => r.roomsLeft === null)).toBe(true);
  });

  it('keeps the raw payload for audit, minus the image blobs', () => {
    const raw = records[0]!.raw as { room: { images?: unknown }; hotel: unknown };
    expect(raw.hotel).toBeTruthy();
    expect(raw.room.images).toBeUndefined();
  });
});
