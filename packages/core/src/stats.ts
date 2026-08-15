/**
 * Robust statistics for rate distributions.
 *
 * Hotel rates are right-skewed with fat tails — a single New Year's Eve
 * observation moves a mean materially and a median barely. Everything here
 * prefers medians and percentiles over means and standard deviations.
 * See docs/mvp/01-data-architecture.md §6.
 */

export function sortedAsc(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

/** Population standard deviation. */
export function stddev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let sum = 0;
  for (const v of values) sum += (v - m) ** 2;
  return Math.sqrt(sum / values.length);
}

/** Coefficient of variation — unit-free dispersion. */
export function coefficientOfVariation(values: readonly number[]): number {
  const m = mean(values);
  if (m === 0) return 0;
  return stddev(values) / Math.abs(m);
}

/**
 * Linear-interpolated percentile (the "R-7" / Excel convention, matching
 * Postgres `percentile_cont`). `p` is a fraction in [0, 1].
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = sortedAsc(values);
  const clamped = clamp(p, 0, 1);
  const idx = clamped * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loVal = sorted[lo] ?? 0;
  if (lo === hi) return loVal;
  const hiVal = sorted[hi] ?? loVal;
  return loVal + (hiVal - loVal) * (idx - lo);
}

export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

/**
 * Empirical CDF with mid-rank tie handling: the fraction of the distribution
 * strictly below `value`, plus half the mass equal to it.
 *
 * Mid-rank matters because fixed seasonal pricing produces many identical
 * observations; without it, a rate sitting exactly on the modal price would
 * score either 0 or 100 depending on comparison direction.
 */
export function percentileRank(values: readonly number[], value: number): number {
  if (values.length === 0) return 0.5;
  let below = 0;
  let equal = 0;
  for (const v of values) {
    if (v < value) below += 1;
    else if (v === value) equal += 1;
  }
  return (below + 0.5 * equal) / values.length;
}

export interface PercentileLadder {
  readonly min: number;
  readonly p10: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p90: number;
  readonly max: number;
}

/**
 * Percentile rank against a summary ladder rather than raw values.
 *
 * Production reads `rate_baseline` rollups, which store percentiles, not the
 * underlying observations. This interpolates between the known points so the
 * engine behaves identically whether it was handed raw values or a rollup.
 */
export function percentileRankFromLadder(ladder: PercentileLadder, value: number): number {
  const points: Array<[number, number]> = [
    [ladder.min, 0],
    [ladder.p10, 0.1],
    [ladder.p25, 0.25],
    [ladder.p50, 0.5],
    [ladder.p75, 0.75],
    [ladder.p90, 0.9],
    [ladder.max, 1],
  ];

  if (value <= ladder.min) return 0;
  if (value >= ladder.max) return 1;

  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    if (!prev || !curr) continue;
    const [prevVal, prevRank] = prev;
    const [currVal, currRank] = curr;
    if (value <= currVal) {
      if (currVal === prevVal) return currRank;
      const t = (value - prevVal) / (currVal - prevVal);
      return prevRank + t * (currRank - prevRank);
    }
  }
  return 1;
}

/**
 * Theil–Sen slope: the median of all pairwise slopes.
 *
 * Chosen over least squares because a trend window holds only 4–10 points, and
 * one spurious capture (a flash sale, a mis-parsed rate) would dominate an OLS
 * fit. The median of pairwise slopes shrugs it off.
 */
export function theilSenSlope(points: ReadonlyArray<{ x: number; y: number }>): number {
  if (points.length < 2) return 0;
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const a = points[i];
      const b = points[j];
      if (!a || !b) continue;
      const dx = b.x - a.x;
      if (dx === 0) continue;
      slopes.push((b.y - a.y) / dx);
    }
  }
  if (slopes.length === 0) return 0;
  return median(slopes);
}

/** Values outside [p_lo, p_hi] are dropped. Returns the kept values and the count removed. */
export function trimOutliers(
  values: readonly number[],
  lowerP: number,
  upperP: number,
): { kept: number[]; removed: number } {
  if (values.length === 0) return { kept: [], removed: 0 };
  const lo = percentile(values, lowerP);
  const hi = percentile(values, upperP);
  const kept = values.filter((v) => v >= lo && v <= hi);
  return { kept, removed: values.length - kept.length };
}

export function clamp(value: number, lo: number, hi: number): number {
  if (Number.isNaN(value)) return lo;
  return Math.min(hi, Math.max(lo, value));
}

/** Clamp to the 0–100 score range and round to an integer. */
export function toScore(value: number): number {
  return Math.round(clamp(value, 0, 100));
}

/** Weighted geometric mean. Weights need not be normalized. */
export function weightedGeometricMean(
  entries: ReadonlyArray<{ value: number; weight: number }>,
): number {
  const usable = entries.filter((e) => e.weight > 0);
  if (usable.length === 0) return 0;
  const totalWeight = usable.reduce((sum, e) => sum + e.weight, 0);
  if (totalWeight === 0) return 0;

  let logSum = 0;
  for (const { value, weight } of usable) {
    // A zero factor must annihilate the product — that is the entire point of
    // choosing a geometric mean (docs/mvp/03 §3).
    if (value <= 0) return 0;
    logSum += (weight / totalWeight) * Math.log(value);
  }
  return Math.exp(logSum);
}

export function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 3_600_000;
}

export function daysBetweenDates(fromIsoDate: string, toIsoDate: string): number {
  const a = Date.parse(`${fromIsoDate}T00:00:00Z`);
  const b = Date.parse(`${toIsoDate}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
