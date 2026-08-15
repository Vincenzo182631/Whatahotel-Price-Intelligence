/**
 * End-to-end integration: ingest → rollup → resolve → score.
 *
 * Runs against a real PostgreSQL when DATABASE_URL is set, and skips otherwise
 * so `npm test` stays runnable without a database. CI always sets it.
 *
 * Everything here uses an isolated set of hotels prefixed IT- and cleans up
 * after itself, so it can run against a seeded development database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { analyze, DEFAULT_CONFIG } from '../../packages/core/src/index.js';
import {
  closePool,
  db,
  getPool,
  isLoadFailure,
  loadScoringInput,
  resolveBaseline,
} from '../../packages/data/src/index.js';
import { ingestRecords } from '../../packages/ingest/src/pipeline/pipeline.js';
import { refreshBaselines } from '../../packages/ingest/src/rollup/baseline.js';
import type { RawRateRecord } from '../../packages/ingest/src/adapters/RateSourceAdapter.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;

const SOURCE_CODE = 'IT_SRC';
const HOTEL_ID = 'IT-9001';
const ROOM = 'Ocean View King';
const CURRENCY = 'USD';

function isoDate(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function record(
  overrides: Partial<RawRateRecord> & { observedAt: string; checkIn: string },
): RawRateRecord {
  return {
    wahHotelId: HOTEL_ID,
    rawRoomName: ROOM,
    sourceRoomCode: 'OVK',
    sourcePlanCode: 'BB-FLEX',
    rawPlanName: 'Bed and breakfast, flexible',
    nights: 3,
    adults: 2,
    children: 0,
    currency: CURRENCY,
    totalAmountMinor: 210000,
    taxBasis: 'GROSS',
    mealPlan: 'BREAKFAST',
    refundPolicy: 'REFUNDABLE',
    isPrepaid: false,
    audience: 'PUBLIC',
    roomsLeft: null,
    isAvailable: true,
    raw: { integrationTest: true },
    ...overrides,
  };
}

suite('integration · ingest → rollup → score', () => {
  let hotelId = 0;
  let roomTypeId = 0;

  beforeAll(async () => {
    const pool = getPool();
    await cleanup();

    await pool.query(
      `INSERT INTO source (code, display_name, is_authoritative)
       VALUES ($1, 'Integration test source', true) ON CONFLICT (code) DO NOTHING`,
      [SOURCE_CODE],
    );
    const { rows: dest } = await pool.query(
      `INSERT INTO destination (slug, name, country_code)
       VALUES ('it-testville','Testville','US')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    );
    const { rows: hotel } = await pool.query(
      `INSERT INTO hotel (wah_hotel_id, name, destination_id, luxury_tier, base_currency)
       VALUES ($1,'Integration Test Hotel',$2,5,'USD')
       ON CONFLICT (wah_hotel_id) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [HOTEL_ID, dest[0].id],
    );
    hotelId = hotel[0].id;

    const { rows: room } = await pool.query(
      `INSERT INTO room_type (hotel_id, canonical_name, normalized_name, room_class, bed_config, view_type)
       VALUES ($1,$2,'ocean view king','ROOM','KING','OCEAN')
       ON CONFLICT (hotel_id, normalized_name) DO UPDATE SET canonical_name = EXCLUDED.canonical_name
       RETURNING id`,
      [hotelId, ROOM],
    );
    roomTypeId = room[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await closePool();
  });

  async function cleanup(): Promise<void> {
    const pool = getPool();
    await pool.query(
      `DELETE FROM rate_observation WHERE hotel_id IN (SELECT id FROM hotel WHERE wah_hotel_id = $1)`,
      [HOTEL_ID],
    );
    await pool.query(
      `DELETE FROM rate_baseline WHERE hotel_id IN (SELECT id FROM hotel WHERE wah_hotel_id = $1)`,
      [HOTEL_ID],
    );
    await pool.query(
      `DELETE FROM analysis WHERE hotel_id IN (SELECT id FROM hotel WHERE wah_hotel_id = $1)`,
      [HOTEL_ID],
    );
    await pool.query(`DELETE FROM hotel WHERE wah_hotel_id = $1`, [HOTEL_ID]);
    await pool.query(`DELETE FROM destination WHERE slug = 'it-testville'`);
    await pool.query(
      `DELETE FROM ingest_batch WHERE source_id IN (SELECT id FROM source WHERE code = $1)`,
      [SOURCE_CODE],
    );
    await pool.query(`DELETE FROM source WHERE code = $1`, [SOURCE_CODE]);
  }

  it('ingests, deduplicates and rolls up into every ladder level', async () => {
    const records: RawRateRecord[] = [];
    // 40 stays × 5 capture days, spread across seasons and days of week so the
    // coarser ladder levels have something to aggregate.
    for (let s = 0; s < 40; s += 1) {
      const checkIn = isoDate(10 + s * 4);
      for (let o = 0; o < 5; o += 1) {
        records.push(
          record({
            checkIn,
            observedAt: new Date(Date.now() - o * 5 * 86_400_000).toISOString(),
            totalAmountMinor: 195000 + s * 900 + o * 1500,
          }),
        );
      }
    }

    const first = await ingestRecords(records, {
      sourceCode: SOURCE_CODE,
      captureSlotMinutes: 60,
      maxNights: 30,
      sanityBandMultiple: 8,
    });
    expect(first.inserted).toBe(records.length);
    expect(first.rejected).toBe(0);

    // Re-ingesting the identical batch must be a no-op: collection retries and
    // overlapping schedules are normal, and duplicates would inflate baselines.
    const second = await ingestRecords(records, {
      sourceCode: SOURCE_CODE,
      captureSlotMinutes: 60,
      maxNights: 30,
      sanityBandMultiple: 8,
    });
    expect(second.inserted).toBe(0);
    expect(second.duplicate).toBe(records.length);

    const rollup = await refreshBaselines({
      lookbackDays: 90,
      minMatchConfidence: 0.5,
      outlierTrim: [0.01, 0.99],
      hotelIds: [hotelId],
    });
    expect(rollup.rowsWritten).toBeGreaterThan(0);
    expect(rollup.levelCounts.L0).toBeGreaterThan(0);
    expect(rollup.levelCounts.L3).toBeGreaterThan(0);
  }, 120_000);

  it('rejects invalid records with a reason instead of coercing them', async () => {
    const result = await ingestRecords(
      [
        record({ checkIn: isoDate(30), observedAt: new Date().toISOString(), totalAmountMinor: 0 }),
        record({ checkIn: isoDate(30), observedAt: new Date().toISOString(), currency: '' }),
        record({ checkIn: isoDate(-30), observedAt: new Date().toISOString() }),
        record({ checkIn: isoDate(30), observedAt: new Date().toISOString(), nights: 99 }),
        record({
          checkIn: isoDate(30),
          observedAt: new Date().toISOString(),
          wahHotelId: 'IT-DOES-NOT-EXIST',
        }),
      ],
      { sourceCode: SOURCE_CODE, captureSlotMinutes: 60, maxNights: 30, sanityBandMultiple: 8 },
    );

    expect(result.inserted).toBe(0);
    expect(result.rejected).toBe(5);
    expect(Object.keys(result.rejectReasons).sort()).toEqual([
      'CHECK_IN_IN_PAST',
      'MISSING_CURRENCY',
      'NIGHTS_OUT_OF_RANGE',
      'NON_POSITIVE_AMOUNT',
      'UNKNOWN_HOTEL',
    ]);

    const { rows } = await db().query(
      `SELECT count(*)::int AS n FROM ingest_reject r
        JOIN ingest_batch b ON b.id = r.ingest_batch_id
       WHERE b.id = $1`,
      [result.batchId],
    );
    expect(rows[0]?.n).toBe(5);
  }, 60_000);

  it('rollup percentiles match a direct computation over the raw facts', async () => {
    const { rows } = await db().query(
      `SELECT b.p50_minor, b.n_observations,
              (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY o.nightly_amount_minor)
                 FROM rate_observation o
                WHERE o.hotel_id = b.hotel_id AND o.room_type_id = b.room_type_id
                  AND o.comparability_class = b.comparability_class
                  AND o.is_available AND o.match_confidence >= 0.5) AS direct_p50
         FROM rate_baseline b
        WHERE b.hotel_id = $1 AND b.baseline_level = 'L3'
        LIMIT 1`,
      [hotelId],
    );

    const row = rows[0];
    expect(row).toBeDefined();
    // Trimming excludes the extreme 1% at each end, so allow a small drift.
    const drift = Math.abs(row.p50_minor - Number(row.direct_p50)) / Number(row.direct_p50);
    expect(drift).toBeLessThan(0.05);
  });

  it('resolves a baseline through the ladder and scores it', async () => {
    const checkIn = isoDate(50);
    const loaded = await loadScoringInput(
      {
        wahHotelId: HOTEL_ID,
        checkIn,
        nights: 3,
        adults: 2,
        children: 0,
        currency: CURRENCY,
      },
      DEFAULT_CONFIG,
    );

    expect(isLoadFailure(loaded)).toBe(false);
    if (isLoadFailure(loaded)) return;

    expect(loaded.input.baseline).not.toBeNull();
    expect(loaded.input.current.nightlyMinor).toBeGreaterThan(0);
    expect(loaded.input.query.comparabilityClass).toBe('BREAKFAST_INCLUDED|FLEXIBLE|PUBLIC');

    const { analysis } = analyze(loaded.input, DEFAULT_CONFIG);
    expect(analysis.confidence).toBeGreaterThan(0);
    // The invariant, verified through the full stack rather than on fixtures.
    if (analysis.recommendation === 'WAIT') {
      expect(analysis.confidence).toBeGreaterThanOrEqual(DEFAULT_CONFIG.rec.wait.confidenceMin);
    }
    if (analysis.recommendation === 'INSUFFICIENT_DATA') {
      expect(analysis.dealScore).toBeNull();
    }
  }, 60_000);

  it('never mixes comparability classes in one baseline', async () => {
    // A non-refundable room-only rate at the same hotel and room must not enter
    // the flexible bed-and-breakfast baseline.
    const checkIn = isoDate(14);
    await ingestRecords(
      Array.from({ length: 20 }, (_, i) =>
        record({
          checkIn,
          observedAt: new Date(Date.now() - i * 86_400_000).toISOString(),
          sourcePlanCode: 'RO-NONREF',
          rawPlanName: 'Room only, non-refundable',
          mealPlan: 'ROOM_ONLY',
          refundPolicy: 'NON_REFUNDABLE',
          totalAmountMinor: 90000,
        }),
      ),
      { sourceCode: SOURCE_CODE, captureSlotMinutes: 60, maxNights: 30, sanityBandMultiple: 8 },
    );

    await refreshBaselines({
      lookbackDays: 90,
      minMatchConfidence: 0.5,
      outlierTrim: [0.01, 0.99],
      hotelIds: [hotelId],
    });

    const flexible = await resolveBaseline(
      {
        hotelId,
        roomTypeId,
        comparabilityClass: 'BREAKFAST_INCLUDED|FLEXIBLE|PUBLIC',
        currency: CURRENCY,
        seasonBand: 'PEAK',
        dowBucket: 'WEEKEND',
        leadBucket: '31-60',
        lookbackDays: 90,
      },
      12,
      30,
    );

    // The cheap non-refundable rates are ~30000/night; the flexible ones ~65000.
    // If the classes leaked, the flexible median would be dragged far below.
    expect(flexible.distribution).not.toBeNull();
    expect(flexible.distribution!.p50).toBeGreaterThan(50000);
  }, 120_000);
});
