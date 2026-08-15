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
import {
  DEFAULT_SCHEDULER_OPTIONS,
  planCollection,
} from '../../packages/ingest/src/scheduler/tiers.js';
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
      discoverRoomTypes: false,
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
      discoverRoomTypes: false,
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

  /**
   * The cold-start gap found by the first production collection run: the
   * matching ladder resolves against room types a hotel already has, and on a
   * brand-new hotel there are none, so every rate was rejected as UNMATCHED.
   */
  it('discovers room types on first sight, and only when asked to', async () => {
    const options = {
      sourceCode: SOURCE_CODE,
      captureSlotMinutes: 60,
      maxNights: 30,
      sanityBandMultiple: 8,
      discoverRoomTypes: false,
    };
    const newRoom = {
      rawRoomName: 'Panoramic Bay View Queen',
      sourceRoomCode: 'IT-NEWCODE-1',
      checkIn: isoDate(45),
      observedAt: new Date().toISOString(),
    };

    // Discovery off — the pre-existing behaviour, unchanged.
    const off = await ingestRecords([record(newRoom)], options);
    expect(off.inserted).toBe(0);
    expect(off.discoveredRoomTypes).toBe(0);
    expect(off.rejectReasons.UNMATCHED_ROOM_TYPE).toBe(1);

    // Discovery on — three rates for the same new room in one batch. Exactly
    // one room type must be created, not three: the in-batch cache is what
    // stops a single collection run from fragmenting a hotel's catalog.
    const on = await ingestRecords(
      [
        record({ ...newRoom, observedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }),
        record({ ...newRoom, observedAt: new Date(Date.now() - 1 * 3_600_000).toISOString() }),
        record({ ...newRoom, observedAt: new Date().toISOString() }),
      ],
      { ...options, discoverRoomTypes: true },
    );
    expect(on.discoveredRoomTypes).toBe(1);
    expect(on.inserted).toBe(3);

    const { rows: created } = await db().query(
      `SELECT id, normalized_name, room_class, bed_config, view_type
         FROM room_type WHERE hotel_id = $1 AND normalized_name = 'panoramic bay view queen'`,
      [hotelId],
    );
    expect(created).toHaveLength(1);
    // Attributes are extracted, not defaulted — room_class in particular, since
    // it is the hard rule that stops a ROOM merging with a SUITE.
    expect(created[0]?.room_class).toBe('ROOM');
    expect(created[0]?.bed_config).toBe('QUEEN');

    // The source code is registered, so the next capture takes the SOURCE_ID
    // path at confidence 1.00 rather than being rediscovered.
    const { rows: aliases } = await db().query(
      `SELECT source_room_code, match_method, match_confidence, is_confirmed
         FROM room_type_alias WHERE room_type_id = $1`,
      [created[0]?.id],
    );
    expect(aliases).toHaveLength(1);
    expect(aliases[0]?.source_room_code).toBe('IT-NEWCODE-1');
    expect(aliases[0]?.match_method).toBe('SOURCE_ID');
    expect(Number(aliases[0]?.match_confidence)).toBe(1);

    const again = await ingestRecords(
      [record({ ...newRoom, checkIn: isoDate(46), observedAt: new Date().toISOString() })],
      { ...options, discoverRoomTypes: true },
    );
    expect(again.discoveredRoomTypes).toBe(0);
    expect(again.inserted).toBe(1);

    const { rows: obs } = await db().query(
      `SELECT DISTINCT match_method, match_confidence FROM rate_observation
        WHERE hotel_id = $1 AND room_type_id = $2`,
      [hotelId, created[0]?.id],
    );
    expect(obs).toHaveLength(1);
    expect(obs[0]?.match_method).toBe('SOURCE_ID');

    // A rate with no source room code is NOT discovered: there would be no
    // stable identity to key on, and a room type per marketing string is the
    // fragmentation the matching ladder exists to prevent.
    const noCode = await ingestRecords(
      [
        record({
          rawRoomName: 'Some Entirely Unseen Marketing Name',
          sourceRoomCode: null,
          checkIn: isoDate(47),
          observedAt: new Date().toISOString(),
        }),
      ],
      { ...options, discoverRoomTypes: true },
    );
    expect(noCode.discoveredRoomTypes).toBe(0);
    expect(noCode.rejectReasons.UNMATCHED_ROOM_TYPE).toBe(1);
  }, 60_000);

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
      {
        sourceCode: SOURCE_CODE,
        captureSlotMinutes: 60,
        maxNights: 30,
        sanityBandMultiple: 8,
        discoverRoomTypes: false,
      },
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
    if (!row) throw new Error('no L3 baseline was written — the rollup produced nothing to check');
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
      {
        sourceCode: SOURCE_CODE,
        captureSlotMinutes: 60,
        maxNights: 30,
        sanityBandMultiple: 8,
        discoverRoomTypes: false,
      },
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

  /**
   * The scheduler is pure SQL, so nothing but an integration test can execute
   * it. Without this, `CURRENT_DATE + $1` (untyped, and therefore ambiguous
   * between date+integer and date+interval) shipped: the cold-start path never
   * calls planCollection, so the failure would only have appeared on the
   * SECOND day of scheduled collection.
   */
  it('plans a refresh for stays already being tracked', async () => {
    await ingestRecords(
      [
        record({
          checkIn: isoDate(20),
          observedAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
        }),
      ],
      {
        sourceCode: SOURCE_CODE,
        captureSlotMinutes: 60,
        maxNights: 30,
        sanityBandMultiple: 8,
        discoverRoomTypes: false,
      },
    );

    const tasks = await planCollection(DEFAULT_SCHEDULER_OPTIONS);
    const mine = tasks.filter((t) => t.wahHotelId === HOTEL_ID);

    // Observed 48h ago at 20 days' lead — HOT tier, 6h interval, so due.
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0]?.checkIn).toBe(isoDate(20));
    expect(mine[0]?.lastObservedAt).not.toBeNull();
  }, 60_000);

  it('excludes stays beyond the horizon and in the past', async () => {
    const options = {
      sourceCode: SOURCE_CODE,
      captureSlotMinutes: 60,
      maxNights: 30,
      sanityBandMultiple: 8,
      discoverRoomTypes: false,
    };
    // Well outside the 120-day default horizon, and stale enough to be due on
    // its own tier (300 days' lead is COLD, 72h interval) — so if it is absent
    // from the plan that is the horizon filter, not the staleness check.
    await ingestRecords(
      [
        record({
          checkIn: isoDate(300),
          observedAt: new Date(Date.now() - 100 * 3_600_000).toISOString(),
        }),
      ],
      options,
    );

    const tasks = await planCollection(DEFAULT_SCHEDULER_OPTIONS);
    const beyond = tasks.filter((t) => t.wahHotelId === HOTEL_ID && t.checkIn === isoDate(300));
    expect(beyond).toHaveLength(0);

    // The horizon is a real filter, not an accident of the date arithmetic:
    // widening it past the stay brings it back.
    const wide = await planCollection({ ...DEFAULT_SCHEDULER_OPTIONS, horizonDays: 365 });
    expect(
      wide.filter((t) => t.wahHotelId === HOTEL_ID && t.checkIn === isoDate(300)),
    ).toHaveLength(1);
  }, 60_000);
});
