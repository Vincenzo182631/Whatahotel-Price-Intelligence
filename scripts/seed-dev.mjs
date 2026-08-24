#!/usr/bin/env node
/**
 * ⚠️  DEVELOPMENT SEED — GENERATES SYNTHETIC DATA, NOT REAL HOTEL RATES.
 *
 * Populates a local database with fabricated hotels and rate history so the
 * rollups, API and widget can be exercised end to end before a real source is
 * connected. Refuses to run unless ALLOW_SYNTHETIC_SEED=1, because synthetic
 * rates reaching a production database would be indistinguishable from real
 * ones once they are in the fact table.
 *
 * Usage:
 *   ALLOW_SYNTHETIC_SEED=1 npm run db:seed-dev
 */
import { getPool, closePool, withTransaction } from '../packages/data/dist/index.js';
import {
  SYNTHETIC_HOTELS,
  SYNTHETIC_RATE_PLANS,
  SYNTHETIC_SOURCE_CODE,
  DEFAULT_SYNTHETIC_OPTIONS,
  syntheticRate,
  ingestRecords,
  refreshBaselines,
  rebuildComparables,
} from '../packages/ingest/dist/index.js';
import { normalizeRoomName, extractAttributes } from '../packages/core/dist/index.js';

if (process.env.ALLOW_SYNTHETIC_SEED !== '1') {
  console.error(
    'Refusing to run.\n' +
      'This script writes SYNTHETIC rates that are indistinguishable from real ones\n' +
      'once stored. Set ALLOW_SYNTHETIC_SEED=1 if this is a development database.',
  );
  process.exit(1);
}

const OPTIONS = DEFAULT_SYNTHETIC_OPTIONS;
const STAY_DATES = 30; // distinct check-in dates
// Capture cadence mirrors the scheduler's tiers: roughly daily for the recent
// window, thinning further back. A uniformly sparse history would never
// exercise the trend factor, which needs several points inside seven days.
const RECENT_DAILY_DAYS = 14;
const OLDER_SAMPLES = 12;
const OLDER_SPAN_DAYS = 88;
const NIGHTS = 3;
const ADULTS = 2;

function isoDate(base, offsetDays) {
  return new Date(base.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

async function ensureReferenceData(client) {
  // This seed writes ~90 days of history, but the partition maintainer's
  // default back window is only a couple of days (migration 0015 — production
  // has no reason to hold empty backward partitions). Widen it here, where
  // the history is actually about to be written.
  await client.query('SELECT ensure_rate_observation_partitions(14, 100)');

  await client.query(
    // is_synthetic is what the API reports provenance from, so it must be set
    // here and re-asserted on conflict — a pre-existing row from before the
    // column was added would otherwise stay silently marked as real.
    `INSERT INTO source (code, display_name, is_authoritative, trust_weight, is_synthetic)
     VALUES ($1, 'Synthetic development data (NOT REAL RATES)', false, 0.50, true)
     ON CONFLICT (code) DO UPDATE SET is_synthetic = true`,
    [SYNTHETIC_SOURCE_CODE],
  );

  const destinations = new Map();
  for (const hotel of SYNTHETIC_HOTELS) {
    if (destinations.has(hotel.destinationSlug)) continue;
    const { rows } = await client.query(
      `INSERT INTO destination (slug, name, country_code, timezone)
       VALUES ($1,$2,$3,'UTC')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [hotel.destinationSlug, hotel.destinationName, hotel.countryCode],
    );
    destinations.set(hotel.destinationSlug, rows[0].id);
  }

  const { rows: sourceRows } = await client.query('SELECT id FROM source WHERE code = $1', [
    SYNTHETIC_SOURCE_CODE,
  ]);
  const sourceId = sourceRows[0].id;

  for (const hotel of SYNTHETIC_HOTELS) {
    const { rows } = await client.query(
      `INSERT INTO hotel (wah_hotel_id, name, brand, destination_id, luxury_tier,
                          star_rating, base_currency, collection_tier)
       VALUES ($1,$2,$3,$4,$5,$6,'USD','WARM')
       ON CONFLICT (wah_hotel_id) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [
        hotel.wahHotelId,
        hotel.name,
        hotel.brand,
        destinations.get(hotel.destinationSlug),
        hotel.luxuryTier,
        hotel.starRating,
      ],
    );
    const hotelId = rows[0].id;

    for (const room of hotel.rooms) {
      const normalized = normalizeRoomName(room.name);
      const attrs = extractAttributes(normalized);
      const { rows: roomRows } = await client.query(
        `INSERT INTO room_type (hotel_id, canonical_name, normalized_name, room_class,
                                bed_config, view_type, max_occupancy, tier_ordinal)
         VALUES ($1,$2,$3,$4::room_class_t,$5::bed_config_t,$6::view_t,4,$7)
         ON CONFLICT (hotel_id, normalized_name)
           DO UPDATE SET canonical_name = EXCLUDED.canonical_name
         RETURNING id`,
        [
          hotelId,
          room.name,
          normalized,
          attrs.roomClass,
          attrs.bedConfig,
          attrs.view,
          room.tierOrdinal,
        ],
      );

      // Register the source room code so ingest matches at SOURCE_ID confidence
      // rather than falling back to string matching.
      await client.query(
        `INSERT INTO room_type_alias (hotel_id, room_type_id, source_id, raw_value,
                                      normalized_value, source_room_code, match_method,
                                      match_confidence, is_confirmed)
         VALUES ($1,$2,$3,$4,$5,$6,'SOURCE_ID',1.00,true)
         ON CONFLICT (hotel_id, source_id, normalized_value) DO NOTHING`,
        [hotelId, roomRows[0].id, sourceId, room.name, normalized, room.sourceCode],
      );
    }

    // Preferred-partner benefits on the luxury tier, so factor F6 has something
    // to work with on some hotels and not others.
    if (hotel.luxuryTier >= 5) {
      await client.query(
        `INSERT INTO hotel_benefit (hotel_id, benefit_id, value_minor, currency)
         SELECT $1, b.id, b.default_value_minor, 'USD'
           FROM benefit b WHERE b.code IN ('BREAKFAST_2','HOTEL_CREDIT')
         ON CONFLICT (hotel_id, benefit_id) DO NOTHING`,
        [hotelId],
      );
    }
  }

  // One demand event, so factor F5 is exercised on some dates.
  await client.query(
    `INSERT INTO destination_event (destination_id, name, start_date, end_date, impact_score, source_note)
     SELECT id, 'Miami Design Week', CURRENT_DATE + 45, CURRENT_DATE + 52, 0.70, 'synthetic'
       FROM destination WHERE slug = 'miami-beach'
     ON CONFLICT DO NOTHING`,
  );

  return { sourceId };
}

function captureDaysAgo() {
  const days = new Set();
  for (let d = 0; d <= RECENT_DAILY_DAYS; d += 1) days.add(d);
  for (let i = 1; i <= OLDER_SAMPLES; i += 1) {
    days.add(
      RECENT_DAILY_DAYS + Math.round((i / OLDER_SAMPLES) * (OLDER_SPAN_DAYS - RECENT_DAILY_DAYS)),
    );
  }
  return [...days].sort((a, b) => a - b);
}

function generateRecords() {
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
  const captures = captureDaysAgo();
  const records = [];

  for (const hotel of SYNTHETIC_HOTELS) {
    for (const room of hotel.rooms) {
      for (const plan of SYNTHETIC_RATE_PLANS) {
        for (let s = 0; s < STAY_DATES; s += 1) {
          // Spread check-ins from 5 to ~115 days out.
          const checkIn = isoDate(today, 5 + Math.round(s * 3.7));
          for (const daysAgo of captures) {
            const observedAt = new Date(today.getTime() - daysAgo * 86_400_000);
            if (Date.parse(`${checkIn}T00:00:00Z`) < observedAt.getTime()) continue;
            records.push(
              syntheticRate(hotel, room, plan, checkIn, NIGHTS, ADULTS, observedAt, OPTIONS),
            );
          }
        }
      }
    }
  }
  return records;
}

async function main() {
  const started = Date.now();
  const pool = getPool();

  console.log('⚠️  Generating SYNTHETIC data — these are not real hotel rates.\n');

  await withTransaction(async (client) => {
    process.stdout.write('• Reference data (hotels, rooms, plans, benefits) … ');
    await ensureReferenceData(client);
    console.log('ok');
  });

  process.stdout.write('• Generating observations … ');
  const records = generateRecords();
  console.log(`${records.length.toLocaleString()} records`);

  process.stdout.write('• Ingesting … ');
  const result = await withTransaction((client) =>
    ingestRecords(
      records,
      {
        sourceCode: SYNTHETIC_SOURCE_CODE,
        captureSlotMinutes: 60,
        maxNights: 30,
        sanityBandMultiple: 8,
      },
      client,
    ),
  );
  console.log(
    `inserted ${result.inserted.toLocaleString()}, duplicate ${result.duplicate}, rejected ${result.rejected}` +
      (result.rejected > 0 ? ` ${JSON.stringify(result.rejectReasons)}` : ''),
  );

  process.stdout.write('• Refreshing baselines … ');
  const rollup = await refreshBaselines({
    lookbackDays: 90,
    minMatchConfidence: 0.5,
    outlierTrim: [0.01, 0.99],
  });
  console.log(
    `${rollup.rowsWritten.toLocaleString()} rows ` +
      `(${Object.entries(rollup.levelCounts)
        .map(([k, v]) => `${k}:${v}`)
        .join(' ')}) ` +
      `in ${(rollup.durationMs / 1000).toFixed(1)}s`,
  );

  process.stdout.write('• Building comparable sets … ');
  const comps = await rebuildComparables();
  console.log(
    `${comps.pairsWritten} pairs across ${comps.hotelsProcessed} hotels` +
      (comps.hotelsWithoutComparables > 0
        ? ` (${comps.hotelsWithoutComparables} without comparables)`
        : ''),
  );

  const { rows } = await pool.query(`
    SELECT (SELECT count(*) FROM rate_observation)                      AS observations,
           (SELECT count(*) FROM rate_baseline)                         AS baselines,
           (SELECT count(*) FROM rate_baseline WHERE n_observations>=30) AS rich_baselines,
           (SELECT count(*) FROM hotel)                                 AS hotels
  `);
  const summary = rows[0];
  console.log(
    `\n✓ ${summary.observations.toLocaleString()} observations · ` +
      `${summary.baselines.toLocaleString()} baselines ` +
      `(${summary.rich_baselines.toLocaleString()} at target depth) · ` +
      `${summary.hotels} hotels · ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );

  await closePool();
}

main().catch(async (err) => {
  console.error('\nSeed failed:', err.message);
  await closePool();
  process.exit(1);
});
