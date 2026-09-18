/**
 * Identity on `method=infoid`.
 *
 * The old `info` was keyed by hotelName + hotelCity and its response carried
 * no hotel name, so nothing in an answer said which property it described.
 * Attaching one hotel's amenities to another would be silent and permanent,
 * and it is rule 22's failure exactly: "Four Seasons Hotel Miami" and "Four
 * Seasons Resort Palm Beach" share most of their words. This file used to be
 * almost entirely about refusing to write.
 *
 * `infoid` is keyed on the hotel id, so the REQUEST establishes identity and
 * there is nothing left to guess. What these tests pin now is that the
 * refusals which existed only for the guessing are gone, that the ones which
 * describe the DATA are not, and that a stale stored code is reported rather
 * than allowed to discard a good answer.
 */
import { describe, expect, it, vi } from 'vitest';
import { syncHotelAmenities } from '../../packages/ingest/src/pipeline/amenities.js';
import { parseInfo, type ParsedInfo } from '../../packages/ingest/src/adapters/whatahotel/info.js';

import { readFileSync } from 'node:fs';

const HOTEL = { hotelId: 18, name: 'Four Seasons Oahu at Ko Olina', city: 'Honolulu' };
const AMENITIES = [
  { code: '74', label: 'Non-smoking' },
  { code: '10', label: 'Bathrobe' },
];

function deps(
  storedCode: string | null,
  info: Partial<ParsedInfo> | Error,
  upsert = vi.fn(async () => AMENITIES.length),
) {
  const seen: number[] = [];
  return {
    upsert,
    seen,
    d: {
      client: {} as never,
      findAmadeusProperty: async () => storedCode,
      upsertHotelAmenities: upsert,
      fetchInfo: async (hotelId: number) => {
        seen.push(hotelId);
        if (info instanceof Error) throw info;
        return {
          amadeusCode: 'RZMIAKBZ',
          amenities: AMENITIES,
          restaurants: [],
          degraded: false,
          ...info,
        } as ParsedInfo;
      },
    },
  };
}

describe('syncHotelAmenities', () => {
  it('asks by hotel id, never by name', async () => {
    // The whole point of the change. A name over the wire is what could
    // answer about a different property, and it is also what a non-ASCII
    // name got rejected for.
    const { seen, d } = deps('RZMIAKBZ', {});
    await syncHotelAmenities(HOTEL, d);
    expect(seen).toEqual([18]);
  });

  it('writes when both codes agree', async () => {
    const { upsert, d } = deps('RZMIAKBZ', {});
    const r = await syncHotelAmenities(HOTEL, d);
    expect(r.outcome).toBe('STORED');
    expect(r.written).toBe(2);
    expect(r.codeDisagreement).toBeUndefined();
    expect(upsert).toHaveBeenCalledWith(18, AMENITIES);
  });

  it('writes when we hold no code to check against', async () => {
    // This was NO_STORED_CODE, and it was most of the catalogue: the column
    // only started being written on 2026-09-18, so rows older than that hold
    // NULL. The skip was caused by a gap of ours, not by anything the source
    // did or did not say, and with an id-keyed request there is nothing it
    // protects against.
    const { upsert, d } = deps(null, {});
    const r = await syncHotelAmenities(HOTEL, d);
    expect(r.outcome).toBe('STORED');
    expect(upsert).toHaveBeenCalledWith(18, AMENITIES);
  });

  it('writes when the response carries no code', async () => {
    // The source holding no Amadeus mapping is not a statement that these
    // amenities belong to another hotel.
    const { upsert, d } = deps('RZMIAKBZ', { amadeusCode: null });
    expect((await syncHotelAmenities(HOTEL, d)).outcome).toBe('STORED');
    expect(upsert).toHaveBeenCalled();
  });

  it('still writes when the codes disagree, and reports the disagreement', async () => {
    // Deliberately not a refusal any more. The request named the id, so the
    // answer is this hotel's whatever our column says, and discarding it
    // over a stale bookkeeping value is the same mistake facing the other
    // way. It is rare — 0 of 28 measured — so it stays visible.
    const { upsert, d } = deps('RZMIAKBZ', { amadeusCode: 'LCHNL376' });
    const r = await syncHotelAmenities(HOTEL, d);
    expect(r.outcome).toBe('STORED');
    expect(r.codeDisagreement).toBe(true);
    expect(r.storedCode).toBe('RZMIAKBZ');
    expect(r.responseCode).toBe('LCHNL376');
    expect(upsert).toHaveBeenCalled();
  });

  it('is case-insensitive about the codes, which are not a password', async () => {
    const { d } = deps('rzmiakbz', { amadeusCode: 'RZMIAKBZ' });
    const r = await syncHotelAmenities(HOTEL, d);
    expect(r.outcome).toBe('STORED');
    expect(r.codeDisagreement).toBeUndefined();
  });

  it('refuses a degraded answer, which is about the DATA', async () => {
    // DESCSTATUS 0 inside a 200. The empty list that comes with it would
    // render as a hotel that offers nothing.
    const { upsert, d } = deps('RZMIAKBZ', { degraded: true, amenities: [] });
    expect((await syncHotelAmenities(HOTEL, d)).outcome).toBe('DEGRADED');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses a failed call', async () => {
    const { upsert, d } = deps('RZMIAKBZ', new Error('204'));
    expect((await syncHotelAmenities(HOTEL, d)).outcome).toBe('FAILED');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('names a genuinely empty answer separately from every skip', async () => {
    const { upsert, d } = deps('RZMIAKBZ', { amenities: [] });
    const r = await syncHotelAmenities(HOTEL, d);
    expect(r.outcome).toBe('EMPTY');
    expect(r.written).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('reports a disagreement even on an empty answer', async () => {
    const { d } = deps('RZMIAKBZ', { amenities: [], amadeusCode: 'LCHNL376' });
    const r = await syncHotelAmenities(HOTEL, d);
    expect(r.outcome).toBe('EMPTY');
    expect(r.codeDisagreement).toBe(true);
  });
});

/**
 * The parser, against bytes that were actually measured.
 *
 * Rule 29 records why this test exists: the first `info` parser read
 * GUESTROOMS as an object holding ROOMRMA, every hotel parsed to zero
 * amenities, a sweep of 150 stored nothing, and eight unit tests passed
 * throughout because the fixture had been written from a list of field NAMES
 * rather than from a response. A test against a guessed fixture measures the
 * guess. These bytes came off `method=infoid&hotel=1421` on 2026-09-18.
 */
describe('parseInfo against a measured infoid response', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('../fixtures/whatahotel/infoid.json', import.meta.url), 'utf8'),
  ) as { wahData: unknown; _measured: { method: string; hotel: number } };

  it('is what it says it is', () => {
    expect(fixture._measured.method).toBe('infoid');
    expect(fixture._measured.hotel).toBe(1421);
  });

  it('reads the identity the request already established', () => {
    expect(parseInfo(fixture.wahData).amadeusCode).toBe('FSOGG516');
  });

  it('reads amenities out of the room-block ARRAY', () => {
    // The shape, pinned. GUESTROOMS is a list of room blocks and each holds
    // its own ROOMRMA; reading `.ROOMRMA` off the array yields undefined and
    // that is precisely how this failed silently the first time.
    const parsed = parseInfo(fixture.wahData);
    expect(parsed.amenities.length).toBeGreaterThan(0);
    for (const a of parsed.amenities) {
      expect(a.code).toBeTruthy();
      expect(a.label).toBeTruthy();
    }
  });

  it('carries no session token, ever', () => {
    // rule 10, enforced on the committed bytes rather than trusted.
    const raw = readFileSync(
      new URL('../fixtures/whatahotel/infoid.json', import.meta.url),
      'utf8',
    );
    expect(raw).not.toMatch(/cfToken"\s*:\s*"[0-9a-f]{8,}/i);
    expect(raw.toLowerCase()).not.toContain('apikey');
  });
});
