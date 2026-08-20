/**
 * Slot-keyed backoff against a real PostgreSQL (migration 0010).
 *
 * The failure counter must ACCUMULATE when the same grid slot is attempted at
 * a new date — that is the whole fix. Keyed by date, a never-pricing stay got
 * a fresh row every UTC day, its counter restarted at 1, and the backoff
 * could never outlast the 6-hour cron. These are pure SQL paths, so only an
 * integration test executes them. Runs only when DATABASE_URL is set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePool, getPool, recordCollectionAttempts } from '../../packages/data/src/index.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;

const HOTEL = 'CB-HOTEL';

function isoAtLead(leadDays: number): string {
  return new Date(Date.now() + leadDays * 86_400_000).toISOString().slice(0, 10);
}

suite('integration · slot-keyed collection backoff', () => {
  let hotelId = 0;

  beforeAll(async () => {
    const pool = getPool();
    await cleanup();
    const { rows } = await pool.query(
      `INSERT INTO hotel (wah_hotel_id,name,luxury_tier,base_currency)
       VALUES ($1,'CB Hotel',3,'USD') RETURNING id`,
      [HOTEL],
    );
    hotelId = rows[0].id as number;
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await closePool();
  });

  async function cleanup(): Promise<void> {
    const pool = getPool();
    await pool.query(
      `DELETE FROM collection_attempt
        WHERE hotel_id IN (SELECT id FROM hotel WHERE wah_hotel_id = $1)`,
      [HOTEL],
    );
    await pool.query(`DELETE FROM hotel WHERE wah_hotel_id = $1`, [HOTEL]);
  }

  async function slotRow(): Promise<{
    leadDays: number;
    checkIn: string;
    attempts: number;
    failures: number;
  } | null> {
    const { rows } = await getPool().query(
      `SELECT lead_days, to_char(check_in,'YYYY-MM-DD') AS check_in,
              attempts, consecutive_failures
         FROM collection_attempt WHERE hotel_id = $1`,
      [hotelId],
    );
    if (rows.length === 0) return null;
    expect(rows.length).toBe(1); // one row per slot, always
    return {
      leadDays: Number(rows[0].lead_days),
      checkIn: rows[0].check_in as string,
      attempts: Number(rows[0].attempts),
      failures: Number(rows[0].consecutive_failures),
    };
  }

  const attempt = (checkIn: string, succeeded: boolean) =>
    recordCollectionAttempts([
      { hotelId, checkIn, nights: 1, adults: 2, succeeded, outcome: succeeded ? 'OK' : 'ERROR' },
    ]);

  it('accumulates failures across the daily date shift — one row per slot', async () => {
    // Seed the row exactly as YESTERDAY's run would have left it: slot lead 10,
    // but check_in one day behind today's lead-10 date. CURRENT_DATE cannot be
    // moved inside a test, so the day-one write is raw; the day-two write goes
    // through recordCollectionAttempts and must COLLIDE on the slot despite
    // the different date — the collision that never happened under date keys.
    await getPool().query(
      `INSERT INTO collection_attempt
         (hotel_id,lead_days,check_in,nights,adults,attempts,consecutive_failures,last_outcome)
       VALUES ($1,10,$2::date,1,2,1,1,'ERROR')`,
      [hotelId, isoAtLead(9)],
    );

    const dayTwoDate = isoAtLead(10);
    await attempt(dayTwoDate, false);
    const row = await slotRow();
    expect(row).toMatchObject({ leadDays: 10, failures: 2, attempts: 2 });
    expect(row?.checkIn).toBe(dayTwoDate); // check_in advances with the attempt
  });

  it('keeps distinct slots distinct', async () => {
    await attempt(isoAtLead(13), false);
    const { rows } = await getPool().query(
      `SELECT lead_days, consecutive_failures FROM collection_attempt
        WHERE hotel_id = $1 ORDER BY lead_days`,
      [hotelId],
    );
    expect(rows.map((r) => [Number(r.lead_days), Number(r.consecutive_failures)])).toEqual([
      [10, 2],
      [13, 1],
    ]);
  });

  it('resets the counter on any success, per rule 16', async () => {
    await attempt(isoAtLead(10), true);
    const { rows } = await getPool().query(
      `SELECT consecutive_failures, attempts, last_outcome FROM collection_attempt
        WHERE hotel_id = $1 AND lead_days = 10`,
      [hotelId],
    );
    expect(Number(rows[0].consecutive_failures)).toBe(0);
    expect(Number(rows[0].attempts)).toBe(3); // attempts is a lifetime count
    expect(rows[0].last_outcome).toBe('OK');
  });
});
