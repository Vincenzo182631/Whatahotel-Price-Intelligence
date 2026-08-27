#!/usr/bin/env node
/**
 * Production collection runner — the WhataHotel API into the fact table.
 *
 *   node scripts/collect.mjs --catalog miami            # sync hotels for a city
 *   node scripts/collect.mjs --search "Troon North"     # sync hotels by name
 *   node scripts/collect.mjs --catalog-sweep            # sync the WHOLE catalogue
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
import {
  DEFAULT_GRID_SPEC,
  closePool,
  findMissingGridStays,
  recordCollectionAttempts,
} from '../packages/data/dist/index.js';
import {
  DEFAULT_COMPARABLE_OPTIONS,
  DEFAULT_INGEST_OPTIONS,
  DEFAULT_SCHEDULER_OPTIONS,
  WHATAHOTEL_INGEST_TUNING,
  WHATAHOTEL_SOURCE_CODE,
  createWhataHotelAdapter,
  ensureWhataHotelSource,
  ingestRecords,
  ingestStayKey,
  planCollection,
  rebuildComparables,
  refreshBaselines,
  sweepCatalog,
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
const CATALOG_SWEEP = arg('catalog-sweep', false) !== false;
const SWEEP_FROM = Number(arg('from', 1));
const SWEEP_TO = arg('to', null);
const BOOTSTRAP = arg('bootstrap', false) !== false;
// Rebuild the peer sets from what is already stored, and call nothing.
//
// hotel_comparable is computed from hotel and rate_baseline, so a rebuild
// costs database time and no WhataHotel API calls at all. It exists because
// the table can go stale against the CODE rather than against the data: every
// stored peer set was built before the builder took a distance bound, so all
// of them are destination-wide until something recomputes them. Waiting for
// the next collection would work, and it would also tie a pure recomputation
// to an API spend it does not need.
const REBUILD_ONLY = arg('rebuild-only', false) !== false;
const MAX_TASKS = Number(arg('limit', DEFAULT_SCHEDULER_OPTIONS.maxTasks));
// Share of each run reserved for refreshing stays we already track, when both
// kinds of work compete for the same limit. See mergeTasks.
//
// A half, because that is what HOT freshness costs at the current shape: ~20
// HOT slots per enrolled hotel across 245 hotels is ~4,900 stays wanting a
// fetch every 6-hour cycle, and half of a 10,000 limit covers it with room for
// the WARM tail behind it. It is a floor and not a quota — an unused half goes
// straight back to the grid.
const REFRESH_SHARE = Math.min(1, Math.max(0, Number(arg('refresh-share', 0.5))));
const CONCURRENCY = Number(arg('concurrency', 4));

function isoDate(offsetDays) {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Stays the grid is missing — see findMissingGridStays for why this runs on
 * every collection rather than only at cold start.
 */
async function missingGridTasks() {
  const stays = await findMissingGridStays(DEFAULT_GRID_SPEC);
  const hotLeadMs = DEFAULT_SCHEDULER_OPTIONS.hotLeadDaysMax * 86_400_000;
  const now = Date.now();

  return stays.map((stay) => ({
    ...stay,
    tier: Date.parse(`${stay.checkIn}T00:00:00Z`) - now <= hotLeadMs ? 'HOT' : 'WARM',
    lastObservedAt: null,
    reason: 'NEW_STAY',
  }));
}

/**
 * Merge new-grid stays with due refreshes, deduped, giving refreshes a
 * guaranteed share of the run.
 *
 * This used to be [...gridTasks, ...dueTasks].slice(0, limit), which serves
 * grid top-up FIRST and refreshes with whatever survives. That is fine while
 * the backlog is smaller than the limit and catastrophic the moment it is not:
 * measured 2026-08-27, a 9,533-stay backlog against a 10,000 limit left 467
 * slots for 8,486 due refreshes, and at the earlier 2,000 limit it left ZERO
 * for days. The tier scheduler stopped running and nothing said so.
 *
 * What that costs is not abstract. A tracked stay that is never refreshed goes
 * stale, assessLiveConfidence caps at LOW past maxRateAgeHours (12), and a
 * guest sees confidence collapse on a hotel whose comp set and score are
 * perfectly sound. Grid top-up buys future calendar neighbours; refreshes keep
 * the price we are showing true. When they compete, the price we are already
 * showing wins.
 *
 * The reservation wastes nothing. Each side is capped at what it can actually
 * use, and whatever the other side does not want is handed straight back — a
 * run with no backlog spends everything on refreshes, and a run with nothing
 * due spends everything on the grid.
 *
 * Dedup runs BEFORE allocation, and grid wins a tie: one fetch of a stay that
 * is both missing and due satisfies both, so counting it twice would reserve a
 * slot for work already being done.
 */
function mergeTasks(gridTasks, dueTasks, limit, refreshShare = REFRESH_SHARE) {
  const keyOf = (t) => `${t.hotelId}|${t.checkIn}|${t.nights}|${t.adults}`;

  const gridKeys = new Set(gridTasks.map(keyOf));
  const grid = [];
  const seen = new Set();
  for (const task of gridTasks) {
    const k = keyOf(task);
    if (seen.has(k)) continue;
    seen.add(k);
    grid.push(task);
  }
  // Disjoint by construction, so the two takes below cannot overlap.
  const due = [];
  for (const task of dueTasks) {
    const k = keyOf(task);
    if (gridKeys.has(k) || seen.has(k)) continue;
    seen.add(k);
    due.push(task);
  }

  // planCollection returns due stays sorted by tier then staleness, so slicing
  // takes HOT before WARM before COLD — the reservation inherits that order
  // rather than needing its own.
  const reserved = Math.min(due.length, Math.floor(limit * refreshShare));
  const gridTake = Math.min(grid.length, Math.max(0, limit - reserved));
  const dueTake = Math.min(due.length, Math.max(0, limit - gridTake));

  return {
    tasks: [...grid.slice(0, gridTake), ...due.slice(0, dueTake)],
    total: grid.length + due.length,
  };
}

async function main() {
  const started = Date.now();

  // Before anything that needs a key or a network. Nothing below this branch
  // is reached, so a rebuild cannot accidentally spend an API call.
  if (REBUILD_ONLY) {
    console.log('• Rebuilding comparables from stored data — no API calls\n');

    // Comparables only, deliberately. Baselines are refreshed by every
    // collection six hours apart, so they are already current; recomputing
    // them here would move Deal Scores as a side effect of a request to fix
    // peer sets, and a rebuild should change exactly the thing it names.
    const comparables = await rebuildComparables(DEFAULT_COMPARABLE_OPTIONS);
    console.log(
      `• Comparables: ${comparables.pairsWritten} pair(s) across ` +
        `${comparables.hotelsProcessed} hotel(s); ` +
        `${comparables.hotelsWithoutComparables} without a comp set ` +
        `(bound: ${DEFAULT_COMPARABLE_OPTIONS.maxDistanceKm.toFixed(2)} km)`,
    );

    console.log(`\n✓ Done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return;
  }

  // Full-inventory sweep ----------------------------------------------------
  //
  // The source has no method that lists its catalogue: `search` caps at 12
  // results and `cityrates` at 15, for every term and every city. Walking the
  // hotel-id space is the only complete view, and at ~150ms a call it is a few
  // minutes for the whole inventory. See sweepCatalog for why a probe that
  // fails is skipped rather than deactivated, and why what it finds starts at
  // tier OFF.
  if (CATALOG_SWEEP) {
    // maxRetries 0 deliberately: most ids are not hotels, the source answers
    // 500 for those, and 500 is retryable — retrying every gap would turn a
    // 4-minute sweep into an hour of backoff.
    const adapter = createWhataHotelAdapter({ concurrency: 8, maxRetries: 0 });
    await ensureWhataHotelSource(WHATAHOTEL_SOURCE_CODE);

    if (DRY_RUN) {
      console.log('• Dry run — sweep would walk the hotel-id space; nothing called.');
      return;
    }

    const result = await sweepCatalog(adapter.client, {
      fromId: SWEEP_FROM,
      ...(SWEEP_TO === null ? {} : { toId: Number(SWEEP_TO) }),
      onProgress: ({ scanned, found, lastId }) => {
        if (lastId % 1200 === 0 || scanned % 1200 === 0) {
          console.log(`  … ${scanned} id(s) probed, ${found} hotel(s) written (at id ${lastId})`);
        }
      },
    });

    console.log(
      `• Sweep: ${result.hotelsWritten} hotel(s) from ${result.scanned} id(s) probed, ` +
        `${result.notFound} not found, ${result.destinationsWritten} destination(s), ` +
        `${result.batchesFailed} batch(es) unwritten, ` +
        `${result.benefitsWritten} benefits, highest id ${result.highestFoundId ?? 'none'} ` +
        `in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
    for (const skip of result.skipped) {
      console.warn(`  ! skipped hotel ${skip.hotelId}: ${skip.reason}`);
    }
    return;
  }

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
  //
  // Two sources of work, and an unattended run needs BOTH: stays nothing is
  // tracking yet (the grid rolls forward daily), and tracked stays whose last
  // capture is older than their tier's interval.
  const gridTasks = await missingGridTasks();
  const dueTasks = BOOTSTRAP
    ? []
    : await planCollection({ ...DEFAULT_SCHEDULER_OPTIONS, maxTasks: MAX_TASKS });

  const { tasks, total } = mergeTasks(gridTasks, dueTasks, MAX_TASKS);

  const byTier = tasks.reduce((acc, t) => ({ ...acc, [t.tier]: (acc[t.tier] ?? 0) + 1 }), {});
  console.log(
    `• Plan: ${tasks.length} stay(s) — ${gridTasks.length} new, ${dueTasks.length} due ` +
      `(${
        Object.entries(byTier)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ') || 'none'
      })`,
  );
  // Capacity: which kind of work the limit is actually being spent on.
  //
  // mergeTasks concatenates [...gridTasks, ...dueTasks] and slices to the
  // limit, so GRID TOP-UP IS SERVED FIRST and refreshes get whatever is left.
  // When the backlog exceeds the limit, that is nothing: every planned stay is
  // a grid top-up and the tier scheduler — HOT every 6h, WARM every 24h —
  // does not run at all.
  //
  // The first version of this line had the causality backwards, reporting that
  // refreshes consumed the limit. They cannot: they are last in the queue.
  // Counting the planned tasks by reason says which is true instead of
  // assuming, and the two failures want opposite fixes.
  //
  // Why starved refreshes matter beyond the missed fetch: assessLiveConfidence
  // caps at LOW when the subject rate is older than maxRateAgeHours (12), so
  // stalled refreshes surface to guests as falling confidence on hotels whose
  // comp sets are perfectly good.
  const topUps = tasks.filter((t) => t.reason === 'NEW_STAY').length;
  const refreshes = tasks.length - topUps;
  const dueSaturated = dueTasks.length >= MAX_TASKS;
  console.log(
    `• Capacity: limit ${MAX_TASKS}/run — planning ${topUps} grid top-up(s) and ` +
      `${refreshes} refresh(es); backlog ${gridTasks.length}, ` +
      `due ${dueTasks.length}${dueSaturated ? ' (at the cap, true demand is higher)' : ''}`,
  );

  if (total > tasks.length) {
    // Never silent: a truncated plan means stays went uncollected today, and
    // with no rate history in this source that data cannot be recovered later.
    console.warn(
      `  ! plan truncated: ${total - tasks.length} stay(s) NOT collected. ` +
        `Raise --limit (currently ${MAX_TASKS}) or run more often.`,
    );
  }

  // Two distinct conditions, and grid-first ordering means the first causes
  // the second. Spilling a little is routine and self-correcting; a backlog
  // wider than the limit is not, and it silently switches the tier scheduler
  // off while every run still exits 0.
  if (gridTasks.length >= MAX_TASKS && refreshes === 0 && dueTasks.length > 0) {
    console.warn(
      `  !! REFRESHES STARVED: the grid backlog (${gridTasks.length}) fills the whole ` +
        `${MAX_TASKS}-stay limit, so NO tracked stay was refreshed this run and at least ` +
        `${dueTasks.length} were due. Tracked prices age out; confidence falls to LOW past ` +
        `${12}h. Raise --limit, shorten the schedule, or reduce the grid or enrolled set.`,
    );
  } else if (gridTasks.length > tasks.length - refreshes) {
    console.warn(
      `  !! BACKLOG CANNOT DRAIN: ${gridTasks.length} stay(s) are missing from the grid and ` +
        `only ${topUps} could be planned this run. ` +
        'Raise --limit, shorten the schedule, or reduce the grid or the enrolled set.',
    );
  }

  if (tasks.length === 0) {
    console.log('  Nothing due and no gaps in the grid — up to date.');
    return;
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
  const soldOutKeys = new Set();
  let soldOut = 0;
  let malformed = 0;
  const stayKey = (q) => `${q.wahHotelId}|${q.checkIn}|${q.nights}|${q.adults}`;
  const adapter = createWhataHotelAdapter({
    concurrency: CONCURRENCY,
    continueOnError: true,
    onError: (query, error) => failures.push({ query, message: error.message }),
    onNoAvailability: (query) => {
      soldOut += 1;
      soldOutKeys.add(stayKey(query));
    },
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

  // Record what each stay did — AFTER ingest, because "succeeded" means the
  // stay is TRACKED: at least one observation survived validation. That is
  // the only thing the grid can see. A stay whose every rate is rejected
  // (hotel 3561: offer-prose room names on all of them) fetched
  // "successfully" and so never backed off — re-proposed and re-fetched four
  // times a day forever. It fails like a sold-out stay now, with its own
  // outcome (`REJECTED`) so the two are never confused in diagnosis. Any
  // later success resets the counter, so a stay that starts yielding usable
  // rates is picked straight back up.
  const producedData = new Set(records.map((r) => ingestStayKey(r)));
  const failedKeys = new Set(failures.map((f) => stayKey(f.query)));
  const recordAttempts = async (trackedStays) => {
    const attempts = tasks.map((task) => {
      const key = ingestStayKey(task);
      const tracked = trackedStays.has(key);
      return {
        hotelId: task.hotelId,
        checkIn: task.checkIn,
        nights: task.nights,
        adults: task.adults,
        succeeded: tracked,
        outcome: failedKeys.has(key)
          ? 'ERROR'
          : soldOutKeys.has(key)
            ? 'NO_AVAILABILITY'
            : tracked
              ? 'OK'
              : producedData.has(key)
                ? 'REJECTED'
                : 'EMPTY',
      };
    });
    const backingOff = attempts.filter((a) => !a.succeeded).length;
    await recordCollectionAttempts(attempts);
    if (backingOff > 0) {
      console.log(
        `  ${backingOff} stay(s) yielded no usable rates and will be retried less often`,
      );
    }
  };

  if (records.length === 0) {
    await recordAttempts(new Set());
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

  await recordAttempts(ingest.trackedStays);

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
