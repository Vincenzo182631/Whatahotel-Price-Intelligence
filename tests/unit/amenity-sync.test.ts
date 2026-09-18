/**
 * The identity guard on `method=info`.
 *
 * `info` is keyed by hotelName + hotelCity and its response carries no hotel
 * name, so nothing in an answer says which property it describes. Attaching
 * one hotel's amenities to another would be silent and permanent, and it is
 * rule 22's failure exactly: "Four Seasons Hotel Miami" and "Four Seasons
 * Resort Palm Beach" share most of their words.
 *
 * Every test here is about refusing to write. Only one is about writing.
 */
import { describe, expect, it, vi } from 'vitest';
import { syncHotelAmenities } from '../../packages/ingest/src/pipeline/amenities.js';
import type { ParsedInfo } from '../../packages/ingest/src/adapters/whatahotel/info.js';

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
  return {
    upsert,
    d: {
      client: {} as never,
      findAmadeusProperty: async () => storedCode,
      upsertHotelAmenities: upsert,
      fetchInfo: async () => {
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
  it('writes when both codes agree', () => {
    const { upsert, d } = deps('RZMIAKBZ', {});
    return syncHotelAmenities(HOTEL, d).then((r) => {
      expect(r.outcome).toBe('STORED');
      expect(r.written).toBe(2);
      expect(upsert).toHaveBeenCalledWith(18, AMENITIES);
    });
  });

  it('is case-insensitive about the codes, which are not a password', async () => {
    const { d } = deps('rzmiakbz', { amadeusCode: 'RZMIAKBZ' });
    expect((await syncHotelAmenities(HOTEL, d)).outcome).toBe('STORED');
  });

  it('REFUSES when the codes disagree, and says what disagreed', async () => {
    const { upsert, d } = deps('RZMIAKBZ', { amadeusCode: 'LCHNL376' });
    const r = await syncHotelAmenities(HOTEL, d);
    expect(r.outcome).toBe('CODE_MISMATCH');
    expect(r.written).toBe(0);
    expect(r.storedCode).toBe('RZMIAKBZ');
    expect(r.responseCode).toBe('LCHNL376');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('REFUSES when we hold no code to check against', async () => {
    // The tempting case: the answer is probably right, and skipping costs a
    // day. But "probably the right hotel" is a coin flip on what a guest
    // reads, and it never announces itself when it loses.
    const { upsert, d } = deps(null, {});
    const r = await syncHotelAmenities(HOTEL, d);
    expect(r.outcome).toBe('NO_STORED_CODE');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('REFUSES when the response carries no code', async () => {
    const { upsert, d } = deps('RZMIAKBZ', { amadeusCode: null });
    expect((await syncHotelAmenities(HOTEL, d)).outcome).toBe('NO_RESPONSE_CODE');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('REFUSES a degraded response rather than storing its empty list', async () => {
    // DESCSTATUS 0 inside a 200, measured on 1 of 18 hotels. The empty
    // amenity list that comes with it would render as a hotel that offers
    // nothing at all.
    const { upsert, d } = deps('RZMIAKBZ', { degraded: true, amenities: [] });
    expect((await syncHotelAmenities(HOTEL, d)).outcome).toBe('DEGRADED');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('REFUSES on an upstream failure', async () => {
    // A 400 on a non-ASCII name, a 204, a fault: none is a statement about
    // this hotel's amenities.
    const { upsert, d } = deps('RZMIAKBZ', new Error('WhataHotel API 400 on info'));
    expect((await syncHotelAmenities(HOTEL, d)).outcome).toBe('FAILED');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('separates a verified empty answer from every refusal', async () => {
    // Verified as the right hotel, and it genuinely stated no amenities.
    // Nothing to write either way, but a different FACT, and the outcome has
    // to say so or a later reader cannot tell coverage from silence.
    const { d } = deps('RZMIAKBZ', { amenities: [] });
    expect((await syncHotelAmenities(HOTEL, d)).outcome).toBe('EMPTY');
  });
});
