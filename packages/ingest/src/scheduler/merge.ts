/**
 * How one collection run's limit is divided between the three kinds of work.
 *
 * Lived in scripts/collect.mjs until the third kind arrived. It is scheduling
 * policy with a starvation failure mode on every side, so it belongs where it
 * can be typechecked and tested rather than in a script that runs a
 * collection the moment it is imported.
 */

import type { CollectionTask } from './tiers.js';

export interface MergeOptions {
  /**
   * Floor for refreshing stays we already track, when grid and refresh
   * compete.
   *
   * This used to be [...gridTasks, ...dueTasks].slice(0, limit), which serves
   * grid top-up FIRST and refreshes with whatever survives. Fine while the
   * backlog is smaller than the limit, and catastrophic the moment it is not:
   * measured 2026-08-27, a 9,533-stay backlog against a 10,000 limit left 467
   * slots for 8,486 due refreshes, and at the earlier 2,000 limit it left
   * ZERO for days. The tier scheduler stopped running and nothing said so.
   *
   * What that costs is not abstract. A tracked stay that is never refreshed
   * goes stale, `assessLiveConfidence` caps at LOW past `maxRateAgeHours`
   * (12), and a guest sees confidence collapse on a hotel whose comp set and
   * score are perfectly sound. Grid top-up buys future calendar neighbours;
   * refreshes keep the price we are showing true. When they compete, the
   * price we are already showing wins.
   */
  readonly refreshShare: number;
  /**
   * Stays a guest actually asked about (`stay_request`), fetched ahead of the
   * next guest rather than inside their page view.
   */
  readonly warmTasks: readonly CollectionTask[];
  /**
   * Floor for warming. Served FIRST, because it is the only work in the run
   * backed by evidence that a person wants the answer: the grid is a guess
   * about which dates might be asked for, and a refresh keeps an answer we
   * already have true. A guest's own dates outrank both.
   *
   * Capped rather than unbounded so warming can never starve rule 14's grid
   * top-up — without the grid the tracked set freezes and empties after ~90
   * days, which is a slower but total failure.
   */
  readonly warmShare: number;
}

export interface MergedPlan {
  readonly tasks: CollectionTask[];
  /** Everything that WANTED a slot, before the limit was applied. */
  readonly total: number;
  readonly warmPlanned: number;
  readonly warmTaken: number;
}

const keyOf = (t: CollectionTask): string => `${t.hotelId}|${t.checkIn}|${t.nights}|${t.adults}`;

/**
 * Merge the three queues, deduped, each with a guaranteed share.
 *
 * Every reservation is a FLOOR, not a quota: each side is capped at what it
 * can actually use and whatever it does not want is handed straight back — a
 * run with no backlog spends everything on refreshes, a run with nothing due
 * spends everything on the grid, and a run nobody has browsed spends nothing
 * on warming.
 *
 * Dedup runs BEFORE allocation, in priority order, because one fetch of a
 * stay that is both wanted and missing and due satisfies all three. Counting
 * it twice would reserve a slot for work already being done, and attributing
 * it to the weaker reason would hide the demand that warming follows.
 */
export function mergeTasks(
  gridTasks: readonly CollectionTask[],
  dueTasks: readonly CollectionTask[],
  limit: number,
  options: MergeOptions,
): MergedPlan {
  const seen = new Set<string>();
  const take = (source: readonly CollectionTask[]): CollectionTask[] => {
    const out: CollectionTask[] = [];
    for (const task of source) {
      const k = keyOf(task);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(task);
    }
    return out;
  };

  const warm = take(options.warmTasks);
  const grid = take(gridTasks);
  const due = take(dueTasks);

  // Warming takes its reserved share off the top; what it does not use is
  // handed back, and the other two then split what is left exactly as before.
  const warmTake = Math.min(warm.length, Math.floor(limit * options.warmShare));
  const rest = Math.max(0, limit - warmTake);

  // planCollection returns due stays sorted by tier then staleness, so slicing
  // takes HOT before WARM before COLD — the reservation inherits that order
  // rather than needing its own.
  const reserved = Math.min(due.length, Math.floor(rest * options.refreshShare));
  const gridTake = Math.min(grid.length, Math.max(0, rest - reserved));
  const dueTake = Math.min(due.length, Math.max(0, rest - gridTake));

  return {
    tasks: [...warm.slice(0, warmTake), ...grid.slice(0, gridTake), ...due.slice(0, dueTake)],
    total: warm.length + grid.length + due.length,
    warmPlanned: warm.length,
    warmTaken: warmTake,
  };
}
