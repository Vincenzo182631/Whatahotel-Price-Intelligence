/**
 * Reconciling the finished state, which the per-hotel check cannot.
 *
 * `researchHotel` asks "does another hotel already hold this domain", and
 * that question depends on run ORDER. Measured 2026-09-18 on the second real
 * run: hotel 3 resolved ritzcarlton.com with nothing to collide against,
 * hotel 7 collided and cleared both, and hotel 22 then resolved the same
 * domain into the now-empty slot and stood. Two Ritz-Carltons survived on one
 * brand domain, and which two was an accident of sequence.
 *
 * Asked of the FINISHED state the question has no such hole, which is what
 * this pins. SQL path, so it runs only when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearResearchForHotels,
  closePool,
  findAllHotelWebsites,
  findOtherHotelsWithWebsite,
  findResearchClaims,
  getPool,
  replaceResearchClaims,
} from '../../packages/data/src/index.js';
import { purgeSharedWebsites } from '../../packages/ingest/src/pipeline/research.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;

const IDS = ['RC-ONE', 'RC-TWO', 'SOLO', 'DIR-ONE', 'DIR-TWO', 'SOLE-SURVIVOR'];
const BRAND = 'https://reconcile-brand.example/';
const OWN = 'https://reconcile-solo.example/';
// One directory, two subdomains, two hotels. Measured 2026-09-18 as
// w.com-miami.com, east.com-miami.com and ebhotelairport.com-miami.com:
// three distinct URL strings that never collided with each other.
const DIR_A = 'https://w.reconcile-directory.example/';
const DIR_B = 'https://east.reconcile-directory.example/';

const deps = { findAllHotelWebsites, clearResearchForHotels };

suite('integration · purgeSharedWebsites', () => {
  let brandA = 0;
  let brandB = 0;
  let solo = 0;
  let dirA = 0;
  let dirB = 0;

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
    dirA = await mk('DIR-ONE', DIR_A);
    dirB = await mk('DIR-TWO', DIR_B);

    for (const id of [brandA, brandB, solo, dirA, dirB]) {
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

  it('finds a hotel sitting under the same domain on another subdomain', async () => {
    // The in-flight check, which the batch reconcile cannot replace: a single
    // on-demand research run has no batch to reconcile afterwards.
    expect(await findOtherHotelsWithWebsite(dirA, 'reconcile-directory.example')).toEqual([dirB]);
    // An exact host match still collides, and a hotel never collides with
    // itself.
    expect(await findOtherHotelsWithWebsite(brandA, 'reconcile-brand.example')).toEqual([brandB]);
    expect(await findOtherHotelsWithWebsite(solo, 'reconcile-solo.example')).toEqual([]);
    // Not a substring match: a domain ENDING in another one is a different
    // site, and clearing it would punish a hotel nobody looked at.
    expect(await findOtherHotelsWithWebsite(0, 'brand.example')).toEqual([]);
  });

  it('drops a domain two hotels claim, and every claim read from it', async () => {
    const purged = await purgeSharedWebsites(deps);
    const brand = purged.find((p) => p.domain === 'reconcile-brand.example');
    expect(brand).toBeDefined();
    expect(brand?.hotelIds).toEqual(expect.arrayContaining([brandA, brandB]));

    // The directory goes too, and it is the case a URL comparison could not
    // see: two hotels, two different URLs, one site.
    const directory = purged.find((p) => p.domain === 'reconcile-directory.example');
    expect(directory?.hotelIds).toEqual(expect.arrayContaining([dirA, dirB]));

    // BOTH sides go. Keeping either would just reward whichever hotel was
    // researched first, which is the ordering hole this exists to close.
    for (const id of [brandA, brandB, dirA, dirB]) {
      expect(await findResearchClaims(id)).toEqual([]);
    }
  });

  it('leaves a hotel that genuinely owns its domain alone', async () => {
    await purgeSharedWebsites(deps);
    const claims = await findResearchClaims(solo);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.sourceUrl).toBe(OWN);
  });

  it('is idempotent, so a sweep can end with it every time', async () => {
    expect(await purgeSharedWebsites(deps)).toEqual([]);
  });

  it('clears the lone survivor of a domain that collided during the run', async () => {
    // The hole the batch purge cannot see. A collision clears BOTH sides, so
    // a later hotel resolving to the same domain stands alone and the "held
    // by two or more" test finds nothing. Which page survives is then decided
    // by the order the hotels were researched in.
    //
    // Measured 2026-09-18 over 300 hotels: the Doha InterContinental was
    // cleared from doha.intercontinental.com and the Madrid one stood on
    // madrid.intercontinental.com. Both may be legitimate per-property pages;
    // nothing about them chose, only sequence.
    const pool = getPool();
    const { rows } = await pool.query(
      `INSERT INTO hotel (wah_hotel_id,name,luxury_tier,base_currency,website_url)
       VALUES ('SOLE-SURVIVOR','SOLE-SURVIVOR',3,'USD','https://madrid.reconcile-brandco.example/')
       RETURNING id`,
    );
    const survivor = rows[0].id as number;
    try {
      // Only one hotel holds it, so the ordinary rule is silent...
      expect(await purgeSharedWebsites(deps)).toEqual([]);

      // ...until the run reports that this domain collided earlier.
      const purged = await purgeSharedWebsites(deps, ['reconcile-brandco.example']);
      expect(purged).toHaveLength(1);
      expect(purged[0]?.hotelIds).toEqual([survivor]);
      expect(await findResearchClaims(survivor)).toEqual([]);
    } finally {
      await pool.query(`DELETE FROM hotel WHERE wah_hotel_id = 'SOLE-SURVIVOR'`);
    }
  });

  it('leaves an unrelated domain alone however many collided', async () => {
    // The reconcile is scoped to what actually collided, not to everything
    // resolved in the same run.
    await purgeSharedWebsites(deps, ['somewhere-else.example']);
    expect(await findResearchClaims(solo)).toHaveLength(1);
  });
});
