/**
 * `method=info` parsing, against the shapes the real API returned on
 * 2026-09-17 (probe run 35281232720, 20 hotels, 18 answers).
 *
 * Every fixture here is derived from a real response with the session tokens
 * removed — `cfID` and `cfToken` are credentials and rule 10 keeps them out
 * of the repository.
 */
import { describe, expect, it } from 'vitest';
import { parseInfo } from '../../packages/ingest/src/adapters/whatahotel/info.js';

/** The Ritz-Carlton, Key Biscayne, trimmed. Codes and labels are verbatim. */
const REAL = {
  amadeus: { codes: 'RZMIAKBZ', count: '1' },
  hotel: {
    DESCSTATUS: '1',
    DESCMSG: 'Success',
    GUESTROOMS: {
      ROOMRMA: [
        { RMAVAL: 'Non-smoking', RMACODE: '74' },
        { RMAVAL: 'Free local calls', RMACODE: '45' },
        { RMAVAL: 'Bathrobe', RMACODE: '10' },
        { RMAVAL: 'Sofa bed', RMACODE: '102' },
      ],
    },
    RESTAURANTS: [{ RESTAURANTNAME: 'Dune Beach Bar' }, { RESTAURANTNAME: 'Lightkeepers' }],
    HOTELINFO: { HOTELDESC: 'Daily resort fee will be added to all stays.' },
  },
  session: { sessionName: 'Guest', sessionID: '0' },
  status: { code: '200', connection: 1 },
};

describe('parseInfo', () => {
  it('reads the coded amenity list the source states', () => {
    const parsed = parseInfo(REAL);
    expect(parsed.amenities).toEqual([
      { code: '74', label: 'Non-smoking' },
      { code: '45', label: 'Free local calls' },
      { code: '10', label: 'Bathrobe' },
      { code: '102', label: 'Sofa bed' },
    ]);
    expect(parsed.restaurants).toEqual(['Dune Beach Bar', 'Lightkeepers']);
    expect(parsed.degraded).toBe(false);
  });

  it('returns the Amadeus code, the only identity the response carries', () => {
    // There is no hotel name anywhere in the payload. The first version of
    // the probe matched /name/ and found session.sessionName — the constant
    // "Guest" — and reported a mismatch on all 18 hotels that answered.
    expect(parseInfo(REAL).amadeusCode).toBe('RZMIAKBZ');
  });

  it('treats the literal "NULL" as no identity, not as an identity', () => {
    // Measured on Ritz Carlton Yacht Collection: info answered and gave
    // amadeus.codes = "NULL", the same sentinel a broken mapping uses. If
    // that counted as a code, every unmapped hotel would verify against
    // every other unmapped hotel.
    expect(parseInfo({ ...REAL, amadeus: { codes: 'NULL' } }).amadeusCode).toBeNull();
    expect(parseInfo({ ...REAL, amadeus: {} }).amadeusCode).toBeNull();
  });

  it('flags the source reporting its own failure inside a 200', () => {
    // Measured on 1 of 18: DESCSTATUS 0 with "Error: Element
    // XMLATTRIBUTES.ROOMAMENITY", everything else looking normal. Storing
    // the empty amenity list would render as a hotel that offers nothing.
    const degraded = parseInfo({
      ...REAL,
      hotel: {
        ...REAL.hotel,
        DESCSTATUS: '0',
        DESCMSG: 'Error: Element XMLATTRIBUTES.ROOMAMENITY',
      },
    });
    expect(degraded.degraded).toBe(true);
  });

  it('survives a single element the source did not wrap in an array', () => {
    // A one-restaurant hotel arrives as a bare object, which would otherwise
    // read as zero restaurants.
    const one = parseInfo({
      ...REAL,
      hotel: {
        ...REAL.hotel,
        RESTAURANTS: { RESTAURANTNAME: 'Solo' },
        GUESTROOMS: { ROOMRMA: { RMAVAL: 'Bathrobe', RMACODE: '10' } },
      },
    });
    expect(one.restaurants).toEqual(['Solo']);
    expect(one.amenities).toEqual([{ code: '10', label: 'Bathrobe' }]);
  });

  it('drops duplicates and anything missing a code or a label', () => {
    const messy = parseInfo({
      ...REAL,
      hotel: {
        ...REAL.hotel,
        GUESTROOMS: {
          ROOMRMA: [
            { RMAVAL: 'Bathrobe', RMACODE: '10' },
            { RMAVAL: 'Bathrobe', RMACODE: '10' },
            { RMAVAL: 'No code', RMACODE: '' },
            { RMACODE: '99' },
          ],
        },
      },
    });
    expect(messy.amenities).toEqual([{ code: '10', label: 'Bathrobe' }]);
  });

  it('never returns the prose blocks', () => {
    // HOTELINFO and friends are real and vary, but they are marketing and fee
    // copy. Rule 24's lesson: something that merely reads like evidence is
    // worse than nothing, because it looks like evidence.
    const parsed = parseInfo(REAL) as unknown as Record<string, unknown>;
    for (const key of ['HOTELINFO', 'AREAINFO', 'ATTRACTIONINFO', 'POLICYINFO']) {
      expect(JSON.stringify(parsed)).not.toContain(key);
    }
    expect(JSON.stringify(parsed)).not.toContain('resort fee');
  });

  it('does not fall over on an empty or malformed payload', () => {
    for (const bad of [null, undefined, {}, { hotel: null }, { hotel: { GUESTROOMS: 'x' } }]) {
      const parsed = parseInfo(bad);
      expect(parsed.amenities).toEqual([]);
      expect(parsed.amadeusCode).toBeNull();
    }
  });
});
