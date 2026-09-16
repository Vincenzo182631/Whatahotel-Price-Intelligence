/**
 * Which hotels get their rates fetched as comparables (2026-09-16).
 *
 * Two faults, both of which hid a subject's closest price peers and so made
 * an expensive hotel read as over-priced against whatever cheaper hotels
 * happened to have been collected:
 *
 *   1. The curated branch excluded tier OFF. Every sweep-discovered hotel
 *      starts at OFF and only leaves it when a guest opens ITS OWN page, so a
 *      hotel that exists purely as somebody else's comparable was invisible
 *      forever — never fetched, never priced, never compared. It also made
 *      `discoverCityComparables` self-defeating: it asks the source for the
 *      city's best hotels, stores them at OFF exactly as it should, and the
 *      re-read then dropped everything it had just found.
 *
 *   2. A curated set of ANY size short-circuited the destination fallback, so
 *      a hotel with three ranked peers compared against three — and the peers
 *      missing from that list were, by construction, the unbrowsed ones,
 *      because an unbrowsed hotel accrues no baselines and is never ranked
 *      into anyone's curated set.
 *
 * Measured on Four Seasons Paris George V, 6-8 Oct 2026: with Bvlgari and
 * Shangri-La invisible, the comparison read "45% above comparable luxury
 * hotels" at LOW confidence. These are pure SQL paths, so only an integration
 * test executes them. Runs only when DATABASE_URL is set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePool, findComparableIdentities, getPool } from '../../packages/data/src/index.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;

const PREFIX = 'CI-PEER-';
const SLUG = 'ci-peer-destination';

suite('integration · which comparables get fetched', () => {
  let destinationId = 0;
  let subjectId = 0;
  const ids: Record<string, number> = {};

  const add = async (key: string, tier: string): Promise<number> => {
    const { rows } = await getPool().query(
      `INSERT INTO hotel (wah_hotel_id, name, luxury_tier, base_currency, collection_tier,
                          destination_id)
            VALUES ($1, $2, 5, 'EUR', $3, $4) RETURNING id`,
      [PREFIX + key, `Peer ${key}`, tier, destinationId],
    );
    ids[key] = rows[0].id as number;
    return ids[key] as number;
  };

  beforeAll(async () => {
    await cleanup();
    const dest = await getPool().query(
      `INSERT INTO destination (slug, name) VALUES ($1, 'CI Peer Destination') RETURNING id`,
      [SLUG],
    );
    destinationId = dest.rows[0].id as number;

    subjectId = await add('SUBJECT', 'WARM');
    // One ranked peer, on the schedule — the only kind the old code could see.
    await add('CURATED', 'WARM');
    // The hotels this test exists for: catalogued, ranked by nobody, OFF.
    await add('OFF-A', 'OFF');
    await add('OFF-B', 'OFF');

    await getPool().query(
      `INSERT INTO hotel_comparable (hotel_id, comparable_id, similarity, rank, basis)
            VALUES ($1, $2, 0.9, 1, 'TEST')`,
      [subjectId, ids['CURATED']],
    );
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await closePool();
  });

  async function cleanup(): Promise<void> {
    const pool = getPool();
    await pool.query(
      `DELETE FROM hotel_comparable
        WHERE hotel_id IN (SELECT id FROM hotel WHERE wah_hotel_id LIKE $1)
           OR comparable_id IN (SELECT id FROM hotel WHERE wah_hotel_id LIKE $1)`,
      [PREFIX + '%'],
    );
    await pool.query(`DELETE FROM hotel WHERE wah_hotel_id LIKE $1`, [PREFIX + '%']);
    await pool.query(`DELETE FROM destination WHERE slug = $1`, [SLUG]);
  }

  /** Destination-keyed, so the radius branch is not in play for these rows. */
  const fetched = async (limit: number): Promise<string[]> =>
    (await findComparableIdentities(subjectId, limit, 0)).map((c) => c.wahHotelId);

  it('tops a short curated set up instead of answering from it alone', async () => {
    const got = await fetched(4);
    expect(got).toContain(PREFIX + 'CURATED');
    expect(got.length).toBeGreaterThan(1);
  });

  it('includes hotels that are off the collection schedule', async () => {
    // The heart of it: OFF says "not on the grid", never "the source will not
    // answer". Rule 17 is explicit that comparables are fetched live for the
    // stay being scored and never need scheduling.
    const got = await fetched(4);
    expect(got).toContain(PREFIX + 'OFF-A');
    expect(got).toContain(PREFIX + 'OFF-B');
  });

  it('ranks the curated peer ahead of the supplement', async () => {
    // The fetch cap is spent on the best-evidenced peers first: the curated
    // set is ranked on accrued baselines, which is measured price-tier
    // similarity rather than a guess.
    const got = await fetched(4);
    expect(got[0]).toBe(PREFIX + 'CURATED');
  });

  it('never exceeds the caller’s fetch budget', async () => {
    // The budget is real API spend on a guest's page view.
    expect((await fetched(2)).length).toBeLessThanOrEqual(2);
    expect((await fetched(1)).length).toBeLessThanOrEqual(1);
  });

  it('never returns the subject as its own comparable', async () => {
    expect(await fetched(4)).not.toContain(PREFIX + 'SUBJECT');
  });
});
