/**
 * Amenity storage and the identity it depends on (migration 0021).
 *
 * `method=info` is keyed on name + city and its answer names no hotel, so the
 * only thing that says which property it described is `amadeus.codes` against
 * the `ama-property` the by-id lookup stored. These are SQL paths — the
 * additive upsert, and the COALESCE that stops a cityrates row erasing a code
 * it never carried — so only an integration test executes them. Runs only when
 * DATABASE_URL is set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closePool,
  findAmadeusProperty,
  findHotelAmenities,
  findHotelsNeedingAmenities,
  getPool,
  setAmadeusProperty,
  upsertHotelAmenities,
} from '../../packages/data/src/index.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;

const HOTEL = 'AM-HOTEL';
const NON_ASCII = 'AM-ACCENTED';
const DESTINATION = 'am-amenityville';

suite('integration · hotel amenities', () => {
  let hotelId = 0;
  let accentedId = 0;
  let destinationId = 0;

  beforeAll(async () => {
    const pool = getPool();
    await cleanup();
    // Both hotels sit in the SAME destination, so the only thing separating
    // them in the queue is the name. Without that the non-ASCII assertion
    // would pass for the wrong reason: an unplaced hotel is excluded anyway.
    const dest = await pool.query(
      `INSERT INTO destination (slug,name,country_code) VALUES ($1,'Amenityville','US')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [DESTINATION],
    );
    destinationId = dest.rows[0].id as number;
    const { rows } = await pool.query(
      `INSERT INTO hotel (wah_hotel_id,name,destination_id,luxury_tier,base_currency)
       VALUES ($1,'AM Hotel',$2,3,'USD') RETURNING id`,
      [HOTEL, destinationId],
    );
    hotelId = rows[0].id as number;
    const accented = await pool.query(
      `INSERT INTO hotel (wah_hotel_id,name,destination_id,luxury_tier,base_currency)
       VALUES ($1,'Château AM',$2,3,'USD') RETURNING id`,
      [NON_ASCII, destinationId],
    );
    accentedId = accented.rows[0].id as number;
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await closePool();
  });

  async function cleanup(): Promise<void> {
    const pool = getPool();
    await pool.query('DELETE FROM hotel WHERE wah_hotel_id = ANY($1)', [[HOTEL, NON_ASCII]]);
    await pool.query('DELETE FROM destination WHERE slug = $1', [DESTINATION]);
  }

  it('starts with no Amadeus code, which reads as cannot-verify', async () => {
    expect(await findAmadeusProperty(hotelId)).toBeNull();
  });

  it('stores the code from the by-id lookup', async () => {
    await setAmadeusProperty(hotelId, 'YXMIAAM1');
    expect(await findAmadeusProperty(hotelId)).toBe('YXMIAAM1');
  });

  it('never forgets a known code when a later record omits it', async () => {
    // A cityrates row carries no ama-property. Clearing the code here would
    // silently disarm the identity check for this hotel, so the amenity sync
    // would skip it forever without saying why.
    await setAmadeusProperty(hotelId, null);
    expect(await findAmadeusProperty(hotelId)).toBe('YXMIAAM1');
  });

  it('writes amenities and reads them back alphabetically', async () => {
    const written = await upsertHotelAmenities(hotelId, [
      { code: 'ROBE', label: 'Bathrobe' },
      { code: 'AIRC', label: 'Air conditioning' },
    ]);
    expect(written).toBe(2);
    expect((await findHotelAmenities(hotelId)).map((a) => a.label)).toEqual([
      'Air conditioning',
      'Bathrobe',
    ]);
  });

  it('is additive: a thinner answer never deletes what we already hold', async () => {
    await upsertHotelAmenities(hotelId, [{ code: 'AIRC', label: 'Air conditioning' }]);
    const labels = (await findHotelAmenities(hotelId)).map((a) => a.label);
    expect(labels).toContain('Bathrobe');
    expect(labels).toContain('Air conditioning');
  });

  it('refreshes a label in place rather than adding a second row', async () => {
    await upsertHotelAmenities(hotelId, [{ code: 'ROBE', label: 'Bath robe' }]);
    const robes = (await findHotelAmenities(hotelId)).filter((a) => a.code === 'ROBE');
    expect(robes).toHaveLength(1);
    expect(robes[0]?.label).toBe('Bath robe');
  });

  it('leaves a non-ASCII name out of the queue rather than transliterating it', async () => {
    // The lookup is rejected with a 400 upstream. Sending an altered name
    // would be asking about a different hotel, which is this method's whole
    // risk, so the hotel is skipped instead.
    const queued = await findHotelsNeedingAmenities(5_000);
    expect(queued.some((h) => h.hotelId === accentedId)).toBe(false);
    expect(queued.some((h) => h.hotelId === hotelId)).toBe(true);
  });
});
