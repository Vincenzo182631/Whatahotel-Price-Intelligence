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
  DEFAULT_WARMING_OPTIONS,
  closePool,
  findMissingGridStays,
  planStayWarming,
  pruneStayRequests,
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
  mergeTasks,
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
// Share of each run reserved for WARMING — stays a guest actually asked about
// (stay_request), fetched ahead of the next guest rather than inside their
// page view.
//
// Warming is served FIRST, because it is the only work in the run backed by
// evidence that a person wants the answer: the grid is a guess about which
// dates might be asked for, and a refresh keeps an answer we already have
// true. A guest's own dates outrank both. It is capped rather than unbounded
// so it can never starve rule 14's grid top-up, and like the refresh share it
// is a floor, not a quota — unused slots go straight back.
//
// A fifth, because measured demand is small next to the grid (a few hundred
// distinct stays against 3,500 slots) and this is meant to cover it entirely
// while leaving the schedule intact. Raise it only with the log line below as
// evidence: "warming N of M wanted" saturating is what says the share is too
// small.
const WARM_SHARE = Math.min(1, Math.max(0, Number(arg('warm-share', 0.2))));
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
 * Stays a guest asked about that are missing or stale — the warming queue.
 *
 * Tiered HOT on the same rule as the grid: a warmed stay is by definition one
 * someone is looking at, and the near-term ones are the decisions being made
 * now. The tier only orders work inside the run; the reservation in
 * mergeTasks is what actually bounds the spend.
 */
async function warmingTasks() {
  const wanted = await planStayWarming({
    ...DEFAULT_WARMING_OPTIONS,
    // No point planning more than the run could ever take.
    limit: MAX_TASKS,
  });
  const hotLeadMs = DEFAULT_SCHEDULER_OPTIONS.hotLeadDaysMax * 86_400_000;
  const now = Date.now();

  return wanted.map((stay) => ({
    hotelId: stay.hotelId,
    wahHotelId: stay.wahHotelId,
    checkIn: stay.checkIn,
    nights: stay.nights,
    adults: stay.adults,
    tier: Date.parse(`${stay.checkIn}T00:00:00Z`) - now <= hotLeadMs ? 'HOT' : 'WARM',
    lastObservedAt: stay.lastObservedAt,
    reason: 'GUEST_REQUESTED',
  }));
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

  // Third source, and the only one with a person behind it: stays a guest
  // actually opened. The collector has minutes and patient retry settings;
  // a page view has eight seconds. Doing this work here is what turns the
  // second visit to a page into a scored answer instead of a repeat of the
  // first visit's failure.
  //
  // Skipped under --bootstrap, which exists to lay down the grid and nothing
  // else.
  const warmTasks = BOOTSTRAP ? [] : await warmingTasks();

  const { tasks, total, warmPlanned, warmTaken } = mergeTasks(gridTasks, dueTasks, MAX_TASKS, {
    refreshShare: REFRESH_SHARE,
    warmTasks,
    warmShare: WARM_SHARE,
  });

  const byTier = tasks.reduce((acc, t) => ({ ...acc, [t.tier]: (acc[t.tier] ?? 0) + 1 }), {});
  if (warmPlanned > 0 || warmTaken > 0) {
    // Saturation here is the signal to raise --warm-share: it means guests
    // asked about more stays than the reserved slice can carry.
    console.log(
      `• Warming: ${warmTaken} of ${warmPlanned} guest-requested stay(s)` +
        `${warmTaken < warmPlanned ? ` — reserved share is full (--warm-share ${WARM_SHARE})` : ''}`,
    );
  }
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
  // Read this line rather than inferring the split from the shares: each
  // share is a FLOOR that hands back what it does not use (see mergeTasks),
  // so the actual division changes with what each queue holds that run.
  //
  // An early version of this line had the causality backwards, reporting that
  // refreshes consumed the limit when they were in fact last in the queue and
  // getting nothing. Counting the planned tasks BY REASON says which is true
  // instead of assuming, and the failures want opposite fixes: a starved grid
  // wants a bigger limit, starved refreshes want a bigger refresh share, and
  // starved warming wants a bigger warm share.
  //
  // Why starved refreshes matter beyond the missed fetch: assessLiveConfidence
  // caps at LOW when the subject rate is older than maxRateAgeHours (12), so
  // stalled refreshes surface to guests as falling confidence on hotels whose
  // comp sets are perfectly good.
  const topUps = tasks.filter((t) => t.reason === 'NEW_STAY').length;
  const warmed = tasks.filter((t) => t.reason === 'GUEST_REQUESTED').length;
  const refreshes = tasks.length - topUps - warmed;
  const dueSaturated = dueTasks.length >= MAX_TASKS;
  console.log(
    `• Capacity: limit ${MAX_TASKS}/run — planning ${warmed} warm, ${topUps} grid top-up(s) and ` +
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
    onError: (query, error) =>
      failures.push({
        query,
        message: error.message,
        // A dead Amadeus mapping, told apart from a transient fault by the
        // adapter (WahApiError.brokenMapping). Recorded distinctly so the
        // ledger can show the difference; without it every 500 reads the same
        // and a permanently broken hotel is indistinguishable from a bad
        // minute upstream.
        brokenMapping: error?.brokenMapping === true,
      }),
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
  const brokenKeys = new Set(
    failures.filter((f) => f.brokenMapping).map((f) => stayKey(f.query)),
  );
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
        outcome: brokenKeys.has(key)
          ? 'BROKEN_MAPPING'
          : failedKeys.has(key)
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

  // Demand that can no longer inform a fetch: a check-in that has passed, or
  // a stay nobody has opened in two months. Cheap, and it keeps the warming
  // queue about what people want NOW rather than growing forever.
  try {
    const pruned = await pruneStayRequests();
    if (pruned > 0) console.log(`• Pruned ${pruned} expired stay request(s)`);
  } catch (err) {
    // Housekeeping never fails a collection that already did its work.
    console.error('stay-request prune failed:', err instanceof Error ? err.message : err);
  }

  console.log(`✓ Done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
