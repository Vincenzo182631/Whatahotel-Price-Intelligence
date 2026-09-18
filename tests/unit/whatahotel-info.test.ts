/**
 * `method=info` parsing, against the shape the real API returned for hotel
 * 2008 on 2026-09-18 (`npm run probe-info -- --ids 2008 --dump
 * hotel.GUESTROOMS`, run 35295960983), with the session tokens removed:
 * `cfID` and `cfToken` are credentials and rule 10 keeps them out of the
 * repository.
 *
 * The earlier version of this file said the same thing and it was NOT TRUE.
 * The first probe reported field NAMES and distinct-value counts, never a
 * nested shape, so the fixture below was written from what those names
 * suggested: `GUESTROOMS` as an object holding `ROOMRMA`. It is an ARRAY of
 * room blocks, each holding its own `ROOMRMA`. Eight tests passed against
 * the invention, the sweep then ran over 150 real hotels and stored nothing,
 * and 138 of those had already passed the identity check.
 *
 * So: a fixture is evidence only if it was MEASURED. When a shape is not in
 * hand, dump the branch (`--dump`) before writing the parser, and say in the
 * fixture where the bytes came from.
 */
import { describe, expect, it } from 'vitest';
import { parseInfo } from '../../packages/ingest/src/adapters/whatahotel/info.js';

/**
 * The Royal Hawaiian (hotel 2008), trimmed to the first four amenities.
 * Structure, codes and labels are verbatim from the dump named above.
 */
const REAL = {
  amadeus: { codes: 'LCHNL376', count: '1' },
  hotel: {
    DESCSTATUS: '1',
    DESCMSG: 'Success',
    // An ARRAY of room blocks. This is the part that was guessed wrong.
    GUESTROOMS: [
      {
        ROOMRMA: [
          { RMAVAL: 'Non-smoking', RMACODE: '74' },
          { RMAVAL: 'Free local calls', RMACODE: '45' },
          { RMAVAL: 'Bathrobe', RMACODE: '10' },
          { RMAVAL: 'Sofa bed', RMACODE: '102' },
        ],
      },
    ],
    // A FLAT array of name objects, measured the same way (--dump
    // hotel.RESTAURANTS, run 35296084128). The parser already read it this
    // way, which was luck rather than evidence until it was dumped.
    RESTAURANTS: [
      { RESTAURANTNAME: 'Ahaaina, A Royal Hawaiian Luau' },
      { RESTAURANTNAME: 'Surf Lanai To Go' },
    ],
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
    expect(parsed.restaurants).toEqual(['Ahaaina, A Royal Hawaiian Luau', 'Surf Lanai To Go']);
    expect(parsed.degraded).toBe(false);
  });

  it('returns the Amadeus code, the only identity the response carries', () => {
    // There is no hotel name anywhere in the payload. The first version of
    // the probe matched /name/ and found session.sessionName — the constant
    // "Guest" — and reported a mismatch on all 18 hotels that answered.
    expect(parseInfo(REAL).amadeusCode).toBe('LCHNL376');
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
        // Collapsed at BOTH levels: the room-block array and the amenity
        // array. asArray handles either, so the parser reads the measured
        // array shape and this one without a special case.
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
        GUESTROOMS: [
          {
            ROOMRMA: [
              { RMAVAL: 'Bathrobe', RMACODE: '10' },
              { RMAVAL: 'Bathrobe', RMACODE: '10' },
              { RMAVAL: 'No code', RMACODE: '' },
              { RMACODE: '99' },
            ],
          },
        ],
      },
    });
    expect(messy.amenities).toEqual([{ code: '10', label: 'Bathrobe' }]);
  });

  it('gathers amenities across every room block, deduplicated', () => {
    // Hotel 2008 answered with a single room block, so the array wrapper was
    // invisible in one sample and is exactly what the first parser got wrong.
    // A hotel listing several room types repeats the amenities they share,
    // and a guest reading "Bathrobe, Bathrobe" would be reading our bug.
    const multi = parseInfo({
      ...REAL,
      hotel: {
        ...REAL.hotel,
        GUESTROOMS: [
          { ROOMRMA: [{ RMAVAL: 'Bathrobe', RMACODE: '10' }] },
          {
            ROOMRMA: [
              { RMAVAL: 'Bathrobe', RMACODE: '10' },
              { RMAVAL: 'Wet bar', RMACODE: '122' },
            ],
          },
        ],
      },
    });
    expect(multi.amenities).toEqual([
      { code: '10', label: 'Bathrobe' },
      { code: '122', label: 'Wet bar' },
    ]);
  });

  it('reads nothing from a room block that is not one', () => {
    for (const bad of [{ GUESTROOMS: ['x'] }, { GUESTROOMS: [{ ROOMRMA: 'x' }] }]) {
      expect(parseInfo({ ...REAL, hotel: { ...REAL.hotel, ...bad } }).amenities).toEqual([]);
    }
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
