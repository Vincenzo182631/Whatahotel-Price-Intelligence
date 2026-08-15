#!/usr/bin/env node
/**
 * Production collection runner — the WhataHotel API into the fact table.
 *
 *   node scripts/collect.mjs --catalog miami            # sync hotels for a city
 *   node scripts/collect.mjs --search "Troon North"     # sync hotels by name
 *   node scripts/collect.mjs --bootstrap                # seed the stay grid
 *   node scripts/collect.mjs                            # collect what is due
 *   node scripts/collect.mjs --dry-run                  # show the plan only
 *
 * Requires WAH_API_KEY in the environment. The key is a credential and is never
 * read from a file in this repository.
 *
 * ── Why --bootstrap exists ──────────────────────────────────────────────────
 * planCollection() derives its work from rate_observation: it refreshes stays
 * already being tracked. On an empty database that returns nothing, and nothing
 * would ever be collected. --bootstrap generates the initial grid of stays for
 * hotels that have never been observed, which is the only way the first
 * observation for a hotel is ever taken.
 *
 * ── Why the first weeks produce no scores ───────────────────────────────────
 * The WhataHotel API answers "what is the rate now", never "what was it"
 * (U3 = NO, confirmed against the live API). There is no history to backfill,
 * so the 90-day baseline the Deal Score needs accumulates forward from the
 * first run. Expect INSUFFICIENT_DATA until roughly 14 days of capture exist —
 * that is the design working, not a fault.
 */
import { closePool, db } from '../packages/data/dist/index.js';
import {
  DEFAULT_COMPARABLE_OPTIONS,
  DEFAULT_INGEST_OPTIONS,
  DEFAULT_SCHEDULER_OPTIONS,
  WHATAHOTEL_INGEST_TUNING,
  WHATAHOTEL_SOURCE_CODE,
  createWhataHotelAdapter,
  ensureWhataHotelSource,
  ingestRecords,
  planCollection,
  rebuildComparables,
  refreshBaselines,
  syncHotelsFromCity,
  syncHotelsFromSearch,
} from '../packages/ingest/dist/index.js';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) return true;
  return value;
}

const DRY_RUN = arg('dry-run', false) !== false;
const CATALOG_CITY = arg('catalog', null);
const SEARCH_TERM = arg('search', null);
const BOOTSTRAP = arg('bootstrap', false) !== false;
const MAX_TASKS = Number(arg('limit', DEFAULT_SCHEDULER_OPTIONS.maxTasks));
const CONCURRENCY = Number(arg('concurrency', 4));

/** The stay grid a newly tracked hotel starts with. */
const BOOTSTRAP_LEAD_DAYS = [7, 14, 21, 30, 45, 60, 90];
const BOOTSTRAP_NIGHTS = [1, 3];
const BOOTSTRAP_ADULTS = 2;

function isoDate(offsetDays) {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** Stays for hotels that have never been observed. */
async function bootstrapTasks(limit) {
  const { rows } = await db().query(
    `SELECT h.id, h.wah_hotel_id
       FROM hotel h
       LEFT JOIN rate_observation o ON o.hotel_id = h.id
      WHERE h.is_active AND h.collection_tier <> 'OFF' AND o.id IS NULL
      ORDER BY h.id`,
  );

  const tasks = [];
  for (const hotel of rows) {
    for (const lead of BOOTSTRAP_LEAD_DAYS) {
      for (const nights of BOOTSTRAP_NIGHTS) {
        tasks.push({
          hotelId: hotel.id,
          wahHotelId: hotel.wah_hotel_id,
          checkIn: isoDate(lead),
          nights,
          adults: BOOTSTRAP_ADULTS,
          tier: lead <= DEFAULT_SCHEDULER_OPTIONS.hotLeadDaysMax ? 'HOT' : 'WARM',
          lastObservedAt: null,
          reason: 'BOOTSTRAP',
        });
      }
    }
  }
  return { tasks: tasks.slice(0, limit), hotels: rows.length, generated: tasks.length };
}

async function main() {
  const started = Date.now();

  // Catalog sync ------------------------------------------------------------
  if (CATALOG_CITY || SEARCH_TERM) {
    const adapter = createWhataHotelAdapter({ concurrency: CONCURRENCY });
    await ensureWhataHotelSource(WHATAHOTEL_SOURCE_CODE);

    const result =
      CATALOG_CITY !== null
        ? await syncHotelsFromCity(adapter.client, String(CATALOG_CITY), isoDate(30), isoDate(33))
        : await syncHotelsFromSearch(adapter.client, String(SEARCH_TERM));

    console.log(
      `• Catalog: ${result.hotelsWritten}/${result.hotelsSeen} hotels, ` +
        `${result.benefitsWritten} benefits, ${result.destinationsWritten} destinations`,
    );
    for (const skip of result.skipped) {
      console.warn(`  ! skipped hotel ${skip.hotelId}: ${skip.reason}`);
    }
    return;
  }

  // Plan --------------------------------------------------------------------
  let tasks;
  if (BOOTSTRAP) {
    const plan = await bootstrapTasks(MAX_TASKS);
    tasks = plan.tasks;
    console.log(
      `• Bootstrap: ${plan.hotels} unobserved hotel(s) → ${plan.generated} stays` +
        (plan.generated > tasks.length ? `, capped at ${tasks.length}` : ''),
    );
  } else {
    tasks = await planCollection({ ...DEFAULT_SCHEDULER_OPTIONS, maxTasks: MAX_TASKS });
    const byTier = tasks.reduce((acc, t) => ({ ...acc, [t.tier]: (acc[t.tier] ?? 0) + 1 }), {});
    console.log(
      `• Plan: ${tasks.length} stay(s) due ` +
        `(${Object.entries(byTier)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ') || 'none'})`,
    );
    if (tasks.length === MAX_TASKS) {
      console.warn(`  ! plan truncated at ${MAX_TASKS}; raise --limit or shorten the interval`);
    }
    if (tasks.length === 0) {
      console.log('  Nothing due. Run with --bootstrap if no hotel has been observed yet.');
      return;
    }
  }

  if (DRY_RUN) {
    for (const task of tasks.slice(0, 20)) {
      console.log(
        `  ${task.tier.padEnd(4)} hotel=${task.wahHotelId} ${task.checkIn} ` +
          `${task.nights}n ${task.adults}pax  ${task.reason}`,
      );
    }
    if (tasks.length > 20) console.log(`  … and ${tasks.length - 20} more`);
    console.log(`• Dry run — no API calls made, nothing written.`);
    return;
  }

  // Fetch -------------------------------------------------------------------
  await ensureWhataHotelSource(WHATAHOTEL_SOURCE_CODE);

  const failures = [];
  let soldOut = 0;
  let malformed = 0;
  const adapter = createWhataHotelAdapter({
    concurrency: CONCURRENCY,
    continueOnError: true,
    onError: (query, error) => failures.push({ query, message: error.message }),
    onNoAvailability: () => (soldOut += 1),
    onMalformedJson: () => (malformed += 1),
  });

  const queries = tasks.map((task) => ({
    wahHotelId: task.wahHotelId,
    checkIn: task.checkIn,
    nights: task.nights,
    adults: task.adults,
    children: 0,
    currency: 'USD',
  }));

  process.stdout.write(`• Fetching ${queries.length} stay(s) … `);
  const records = await adapter.fetchRates(queries);
  console.log(`${records.length} rate(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (soldOut > 0) console.log(`  ${soldOut} stay(s) sold out — no rates exist for those dates`);
  if (malformed > 0) {
    console.warn(`  ! ${malformed} response(s) were invalid JSON and had to be repaired`);
  }

  for (const failure of failures.slice(0, 10)) {
    console.warn(
      `  ! ${failure.query.wahHotelId} ${failure.query.checkIn}: ${failure.message}`,
    );
  }
  if (failures.length > 10) console.warn(`  ! … and ${failures.length - 10} more failures`);

  if (records.length === 0) {
    console.warn('  No rates returned. Nothing ingested.');
    return;
  }

  // Ingest ------------------------------------------------------------------
  const ingest = await ingestRecords(records, {
    ...DEFAULT_INGEST_OPTIONS,
    ...WHATAHOTEL_INGEST_TUNING,
    sourceCode: WHATAHOTEL_SOURCE_CODE,
  });
  console.log(
    `• Ingest: ${ingest.inserted} inserted, ${ingest.duplicate} duplicate, ` +
      `${ingest.rejected} rejected, ${ingest.discoveredRoomTypes} new room type(s) ` +
      `(batch ${ingest.batchId})`,
  );
  for (const [reason, count] of Object.entries(ingest.rejectReasons)) {
    console.warn(`  ! ${reason}: ${count}`);
  }

  if (ingest.inserted === 0) {
    console.log('• No new observations; skipping rollup.');
    return;
  }

  // Roll up -----------------------------------------------------------------
  const rollup = await refreshBaselines({
    lookbackDays: 90,
    minMatchConfidence: 0.6,
    outlierTrim: [0.05, 0.95],
  });
  console.log(
    `• Baselines: ${rollup.rowsWritten} row(s) ` +
      `(${Object.entries(rollup.levelCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')}) in ${rollup.durationMs}ms`,
  );

  const comparables = await rebuildComparables(DEFAULT_COMPARABLE_OPTIONS);
  console.log(
    `• Comparables: ${comparables.pairsWritten} pair(s) across ` +
      `${comparables.hotelsProcessed} hotel(s); ` +
      `${comparables.hotelsWithoutComparables} without a comp set`,
  );

  console.log(`✓ Done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
