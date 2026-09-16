/**
 * Warming the stays guests actually asked about (migration 0020).
 *
 * The scheduler could not see demand: planCollection derives its work from
 * rate_observation and dates "viewed" from analysis, so a guest asking about
 * dates we failed to price left no trace anywhere it reads — and the next
 * guest on that page repeated the same failing fetch. These are pure SQL
 * paths, so only an integration test executes them. Runs only when
 * DATABASE_URL is set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closePool,
  getPool,
  planStayWarming,
  pruneStayRequests,
  recordStayRequest,
  DEFAULT_WARMING_OPTIONS,
} from '../../packages/data/src/index.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;

const HOTEL = 'SW-HOTEL';
const OFF_HOTEL = 'SW-OFF-HOTEL';

const isoAtLead = (leadDays: number): string =>
  new Date(Date.now() + leadDays * 86_400_000).toISOString().slice(0, 10);

suite('integration · warming guest-requested stays', () => {
  let hotelId = 0;
  let offHotelId = 0;

  const plan = async (over: Partial<typeof DEFAULT_WARMING_OPTIONS> = {}) =>
    (await planStayWarming({ ...DEFAULT_WARMING_OPTIONS, ...over })).filter(
      (s) => s.hotelId === hotelId || s.hotelId === offHotelId,
    );

  beforeAll(async () => {
    const pool = getPool();
    await cleanup();
    const { rows } = await pool.query(
      `INSERT INTO hotel (wah_hotel_id,name,luxury_tier,base_currency)
       VALUES ($1,'SW Hotel',3,'USD') RETURNING id`,
      [HOTEL],
    );
    hotelId = rows[0].id as number;
    const off = await pool.query(
      `INSERT INTO hotel (wah_hotel_id,name,luxury_tier,base_currency,collection_tier)
       VALUES ($1,'SW Off Hotel',3,'USD','OFF') RETURNING id`,
      [OFF_HOTEL],
    );
    offHotelId = off.rows[0].id as number;
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await closePool();
  });

  async function cleanup(): Promise<void> {
    const pool = getPool();
    await pool.query(
      `DELETE FROM stay_request
        WHERE hotel_id IN (SELECT id FROM hotel WHERE wah_hotel_id = ANY($1::text[]))`,
      [[HOTEL, OFF_HOTEL]],
    );
    await pool.query(`DELETE FROM hotel WHERE wah_hotel_id = ANY($1::text[])`, [
      [HOTEL, OFF_HOTEL],
    ]);
  }

  it('counts repeat interest in the same stay instead of duplicating it', async () => {
    const checkIn = isoAtLead(40);
    await recordStayRequest(hotelId, checkIn, 3, 2);
    await recordStayRequest(hotelId, checkIn, 3, 2);
    await recordStayRequest(hotelId, checkIn, 3, 2);

    const wanted = await plan();
    const row = wanted.find((s) => s.checkIn === checkIn);
    expect(row?.requestCount).toBe(3);
    expect(wanted.filter((s) => s.checkIn === checkIn)).toHaveLength(1);
  });

  it('ranks the most-wanted stay first', async () => {
    const popular = isoAtLead(41);
    const seenOnce = isoAtLead(42);
    await recordStayRequest(hotelId, seenOnce, 3, 2);
    for (let i = 0; i < 5; i += 1) await recordStayRequest(hotelId, popular, 3, 2);

    const wanted = await plan();
    const popularIndex = wanted.findIndex((s) => s.checkIn === popular);
    const onceIndex = wanted.findIndex((s) => s.checkIn === seenOnce);
    expect(popularIndex).toBeGreaterThanOrEqual(0);
    expect(popularIndex).toBeLessThan(onceIndex);
  });

  it('includes a hotel at collection tier OFF', async () => {
    // Rule 17 keeps the whole catalogue scoreable on demand, and a guest
    // asking about an OFF hotel is exactly the demand that justifies the
    // call. This is the one place tier OFF must not exclude a stay: the
    // evidence for asking is a person having asked.
    const checkIn = isoAtLead(43);
    await recordStayRequest(offHotelId, checkIn, 3, 2);
    const wanted = await plan();
    expect(wanted.some((s) => s.hotelId === offHotelId && s.checkIn === checkIn)).toBe(true);
  });

  it('never warms a stay whose check-in has passed', async () => {
    // It cannot be booked, so a rate for it answers nothing.
    const past = isoAtLead(-3);
    await recordStayRequest(hotelId, past, 3, 2);
    const wanted = await plan();
    expect(wanted.some((s) => s.checkIn === past)).toBe(false);
  });

  it('never warms beyond the lead window the source is verified for', async () => {
    const tooFar = isoAtLead(DEFAULT_WARMING_OPTIONS.maxLeadDays + 30);
    await recordStayRequest(hotelId, tooFar, 3, 2);
    const wanted = await plan();
    expect(wanted.some((s) => s.checkIn === tooFar)).toBe(false);
  });

  it('drops out of the queue once demand goes quiet', async () => {
    const checkIn = isoAtLead(44);
    await recordStayRequest(hotelId, checkIn, 3, 2);
    await getPool().query(
      `UPDATE stay_request SET last_requested_at = now() - interval '60 days'
        WHERE hotel_id = $1 AND check_in = $2::date`,
      [hotelId, checkIn],
    );
    const wanted = await plan();
    expect(wanted.some((s) => s.checkIn === checkIn)).toBe(false);
  });

  it('prunes what can no longer inform a fetch, and keeps live demand', async () => {
    const live = isoAtLead(45);
    await recordStayRequest(hotelId, live, 3, 2);
    await recordStayRequest(hotelId, isoAtLead(-5), 3, 2);

    const removed = await pruneStayRequests();
    expect(removed).toBeGreaterThan(0);

    const { rows } = await getPool().query(
      `SELECT to_char(check_in,'YYYY-MM-DD') AS check_in FROM stay_request WHERE hotel_id = $1`,
      [hotelId],
    );
    const remaining = rows.map((r) => r.check_in as string);
    expect(remaining).toContain(live);
    expect(remaining.every((d) => d >= new Date().toISOString().slice(0, 10))).toBe(true);
  });
});
