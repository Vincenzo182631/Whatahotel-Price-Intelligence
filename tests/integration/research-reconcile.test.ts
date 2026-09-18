/**
 * Reconciling the finished state, which the per-hotel check cannot.
 *
 * `researchHotel` asks "does another hotel already hold this URL", and that
 * question depends on run ORDER. Measured 2026-09-18 on the second real run:
 * hotel 3 resolved ritzcarlton.com with nothing to collide against, hotel 7
 * collided and cleared both, and hotel 22 then resolved the same domain into
 * the now-empty slot and stood. Two Ritz-Carltons survived on one brand
 * domain, and which two was an accident of sequence.
 *
 * Asked of the FINISHED state the question has no such hole, which is what
 * this pins. SQL path, so it runs only when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closePool,
  findResearchClaims,
  getPool,
  purgeSharedWebsites,
  replaceResearchClaims,
} from '../../packages/data/src/index.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;

const IDS = ['RC-ONE', 'RC-TWO', 'SOLO'];
const BRAND = 'https://reconcile-brand.example/';
const OWN = 'https://reconcile-solo.example/';

suite('integration · purgeSharedWebsites', () => {
  let brandA = 0;
  let brandB = 0;
  let solo = 0;

  beforeAll(async () => {
    const pool = getPool();
    await cleanup();
    const mk = async (wah: string, url: string) => {
      const { rows } = await pool.query(
        `INSERT INTO hotel (wah_hotel_id,name,luxury_tier,base_currency,website_url)
         VALUES ($1,$1,3,'USD',$2) RETURNING id`,
        [wah, url],
      );
      return rows[0].id as number;
    };
    brandA = await mk('RC-ONE', BRAND);
    brandB = await mk('RC-TWO', BRAND);
    solo = await mk('SOLO', OWN);

    for (const id of [brandA, brandB, solo]) {
      await replaceResearchClaims(id, [
        {
          motivator: 'BEACH_RESORT',
          claim: 'The property\'s own site mentions "beachfront"',
          sourceUrl: id === solo ? OWN : BRAND,
        },
      ]);
    }
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await closePool();
  });

  async function cleanup(): Promise<void> {
    await getPool().query('DELETE FROM hotel WHERE wah_hotel_id = ANY($1)', [IDS]);
  }

  it('drops a domain two hotels claim, and every claim read from it', async () => {
    const purged = await purgeSharedWebsites();
    const brand = purged.find((p) => p.websiteUrl === BRAND);
    expect(brand).toBeDefined();
    expect(brand?.hotelIds).toEqual(expect.arrayContaining([brandA, brandB]));

    // BOTH sides go. Keeping either would just reward whichever hotel was
    // researched first, which is the ordering hole this exists to close.
    expect(await findResearchClaims(brandA)).toEqual([]);
    expect(await findResearchClaims(brandB)).toEqual([]);
  });

  it('leaves a hotel that genuinely owns its domain alone', async () => {
    await purgeSharedWebsites();
    const claims = await findResearchClaims(solo);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.sourceUrl).toBe(OWN);
  });

  it('is idempotent, so a sweep can end with it every time', async () => {
    expect(await purgeSharedWebsites()).toEqual([]);
  });
});
