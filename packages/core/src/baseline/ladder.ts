/**
 * The widening ladder (docs/mvp/01-data-architecture.md §6).
 *
 * Rather than silently loosening filters until enough observations appear, the
 * engine walks a FIXED ladder and records which level it reached. Each level
 * carries a confidence multiplier, and levels L3+ raise a caveat the customer
 * sees. Loosening is allowed; hiding that we loosened is not.
 */

import type { BaselineLevel, DowBucket, IsoDate, SeasonBand } from '../types.js';

export const BASELINE_LEVELS: readonly BaselineLevel[] = ['L0', 'L1', 'L2', 'L3', 'L4'];

export interface LeadBucket {
  readonly key: string;
  readonly minDays: number;
  readonly maxDays: number;
}

/**
 * Buckets rather than a continuous lead-time adjustment: the relationship
 * between lead time and price is non-monotonic and hotel-specific, and bucketing
 * is honest about what we can support at MVP.
 */
export const LEAD_BUCKETS: readonly LeadBucket[] = [
  { key: '0-3', minDays: 0, maxDays: 3 },
  { key: '4-7', minDays: 4, maxDays: 7 },
  { key: '8-14', minDays: 8, maxDays: 14 },
  { key: '15-30', minDays: 15, maxDays: 30 },
  { key: '31-60', minDays: 31, maxDays: 60 },
  { key: '61-120', minDays: 61, maxDays: 120 },
  { key: '121+', minDays: 121, maxDays: Number.MAX_SAFE_INTEGER },
];

export function leadBucketFor(leadTimeDays: number): string {
  const days = Math.max(0, leadTimeDays);
  for (const bucket of LEAD_BUCKETS) {
    if (days >= bucket.minDays && days <= bucket.maxDays) return bucket.key;
  }
  return '121+';
}

export function dowBucketFor(isoDate: IsoDate): DowBucket {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  // Friday and Saturday nights are the weekend rate in hotel pricing — the
  // stay date is the night, not the checkout morning.
  return day === 5 || day === 6 ? 'WEEKEND' : 'WEEKDAY';
}

/**
 * Northern-hemisphere leisure default. Per-destination calendars should replace
 * this once they exist (it is wrong for the southern hemisphere and for
 * business-led city markets), which is why it is isolated in one function.
 */
export function seasonBandFor(isoDate: IsoDate): SeasonBand {
  const month = Number(isoDate.slice(5, 7));
  if (month === 12 || month === 1 || month === 7 || month === 8) return 'PEAK';
  if (month === 6 || month === 9 || month === 2 || month === 3) return 'HIGH';
  if (month === 4 || month === 5 || month === 10) return 'SHOULDER';
  return 'LOW';
}

/** Which stratum columns each level constrains. */
export interface LevelStrata {
  readonly level: BaselineLevel;
  readonly useSeason: boolean;
  readonly useDow: boolean;
  readonly useLead: boolean;
  readonly useSiblingRooms: boolean;
}

export const LEVEL_STRATA: readonly LevelStrata[] = [
  { level: 'L0', useSeason: true, useDow: true, useLead: true, useSiblingRooms: false },
  { level: 'L1', useSeason: true, useDow: true, useLead: false, useSiblingRooms: false },
  { level: 'L2', useSeason: true, useDow: false, useLead: false, useSiblingRooms: false },
  { level: 'L3', useSeason: false, useDow: false, useLead: false, useSiblingRooms: false },
  { level: 'L4', useSeason: false, useDow: false, useLead: false, useSiblingRooms: true },
];

export interface LadderCandidate {
  readonly level: BaselineLevel;
  readonly nObservations: number;
}

export interface LadderSelection<T extends LadderCandidate> {
  readonly selected: T | null;
  readonly level: BaselineLevel | null;
  /** Levels examined and rejected, with the count that fell short. */
  readonly rejected: ReadonlyArray<{ level: BaselineLevel; nObservations: number }>;
  readonly reachedTarget: boolean;
}

/**
 * Choose the most specific baseline that carries enough observations.
 *
 * Climbs only as far as needed to reach `minObsTarget`, and never past L4. If
 * no level reaches `minObsAbs`, returns the richest candidate anyway so the
 * caller can report *how* short it fell — the recommendation engine's G0 gate
 * turns that into INSUFFICIENT_DATA with a specific reason.
 */
export function selectBaselineLevel<T extends LadderCandidate>(
  candidates: readonly T[],
  minObsAbs: number,
  minObsTarget: number,
): LadderSelection<T> {
  const byLevel = new Map<BaselineLevel, T>();
  for (const c of candidates) {
    const existing = byLevel.get(c.level);
    if (!existing || c.nObservations > existing.nObservations) byLevel.set(c.level, c);
  }

  const rejected: Array<{ level: BaselineLevel; nObservations: number }> = [];
  let bestBelowTarget: T | null = null;

  for (const level of BASELINE_LEVELS) {
    const candidate = byLevel.get(level);
    if (!candidate) continue;

    if (candidate.nObservations >= minObsTarget) {
      return { selected: candidate, level, rejected, reachedTarget: true };
    }

    rejected.push({ level, nObservations: candidate.nObservations });
    // Remember the MOST SPECIFIC usable level (`??=` keeps the first seen, and
    // levels are walked specific-first). This is the fallback for when no level
    // reaches the target at all — a like-for-like comparison on 15 observations
    // is better than a loose one on 20.
    if (candidate.nObservations >= minObsAbs) bestBelowTarget ??= candidate;
  }

  if (bestBelowTarget) {
    return {
      selected: bestBelowTarget,
      level: bestBelowTarget.level,
      rejected: rejected.filter((r) => r.level !== bestBelowTarget?.level),
      reachedTarget: false,
    };
  }

  const richest =
    [...byLevel.values()].sort((a, b) => b.nObservations - a.nObservations)[0] ?? null;
  return {
    selected: richest,
    level: richest?.level ?? null,
    rejected,
    reachedTarget: false,
  };
}
