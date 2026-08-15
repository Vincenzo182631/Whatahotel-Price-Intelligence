/**
 * Fixture builders for the scenario suite.
 *
 * Distributions are generated from an explicit quantile ladder rather than a
 * parametric family, so each scenario can state exactly the shape it needs —
 * where the current rate should land, how fat the tails are — and the intent
 * stays readable in the scenario file.
 */

import { coefficientOfVariation, mean, percentile, stddev } from '../../packages/core/src/stats.js';
import type {
  BaselineDistribution,
  BaselineLevel,
  ComparableRate,
  CurrentRate,
  MatchMethod,
  SeriesPoint,
  StayQuery,
} from '../../packages/core/src/types.js';

export const NOW = new Date('2026-08-14T12:00:00Z');

/** Quantile ladder: [fraction 0–1, value]. Interpolated linearly between points. */
export type QuantileLadder = ReadonlyArray<readonly [number, number]>;

export function valuesFromLadder(n: number, ladder: QuantileLadder): number[] {
  const points = [...ladder].sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const u = n === 1 ? 0.5 : i / (n - 1);
    out.push(Math.round(interpolate(points, u)));
  }
  return out;
}

function interpolate(points: QuantileLadder, u: number): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return 0;
  if (u <= first[0]) return first[1];
  if (u >= last[0]) return last[1];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    if (!prev || !curr) continue;
    if (u <= curr[0]) {
      const span = curr[0] - prev[0];
      if (span === 0) return curr[1];
      const t = (u - prev[0]) / span;
      return prev[1] + t * (curr[1] - prev[1]);
    }
  }
  return last[1];
}

export interface BaselineSpec {
  readonly n: number;
  readonly ladder: QuantileLadder;
  readonly level?: BaselineLevel;
  readonly meanMatchConfidence?: number;
  readonly nSources?: number;
  readonly crossSourceCv?: number | null;
  readonly unresolvedShare?: number;
  readonly lookbackDays?: number;
  readonly computedAt?: string;
}

export function makeBaseline(spec: BaselineSpec): BaselineDistribution {
  const values = valuesFromLadder(spec.n, spec.ladder);
  return {
    level: spec.level ?? 'L0',
    nObservations: spec.n,
    nOutliersExcluded: 0,
    values,
    min: Math.min(...values),
    p10: Math.round(percentile(values, 0.1)),
    p25: Math.round(percentile(values, 0.25)),
    p50: Math.round(percentile(values, 0.5)),
    p75: Math.round(percentile(values, 0.75)),
    p90: Math.round(percentile(values, 0.9)),
    max: Math.max(...values),
    mean: Math.round(mean(values)),
    stddev: Math.round(stddev(values)),
    cv: coefficientOfVariation(values),
    meanMatchConfidence: spec.meanMatchConfidence ?? 0.98,
    nSources: spec.nSources ?? 1,
    crossSourceCv: spec.crossSourceCv ?? null,
    unresolvedShare: spec.unresolvedShare ?? 0,
    lookbackDays: spec.lookbackDays ?? 90,
    computedAt: spec.computedAt ?? '2026-08-14T09:00:00Z',
  };
}

export interface SeriesSpec {
  readonly points: number;
  readonly spanDays: number;
  readonly endMinor: number;
  /** Fractional change across the span. 0.09 = +9%. */
  readonly deltaFraction: number;
  readonly endAt?: Date;
}

export function makeSeries(spec: SeriesSpec): SeriesPoint[] {
  const end = spec.endAt ?? NOW;
  const start = spec.endMinor / (1 + spec.deltaFraction);
  const out: SeriesPoint[] = [];
  for (let i = 0; i < spec.points; i += 1) {
    const t = spec.points === 1 ? 1 : i / (spec.points - 1);
    const ms = end.getTime() - (1 - t) * spec.spanDays * 86_400_000;
    out.push({
      observedAt: new Date(ms).toISOString(),
      nightlyMinor: Math.round(start + t * (spec.endMinor - start)),
    });
  }
  return out;
}

export interface CompSpec {
  readonly count: number;
  /** Median discount index across the comp set (current ÷ own baseline median). */
  readonly index: number;
  /** Half-width of the index spread across the set. Real comp sets are not uniform. */
  readonly indexSpread?: number;
  readonly baselineMedianMinor: number;
  readonly observedAt?: string;
}

export function makeComparables(spec: CompSpec): ComparableRate[] {
  const spread = spec.indexSpread ?? 0.04;
  const out: ComparableRate[] = [];
  for (let i = 0; i < spec.count; i += 1) {
    const offset = spec.count === 1 ? 0 : ((i / (spec.count - 1)) * 2 - 1) * spread;
    const index = spec.index + offset;
    const median = Math.round(spec.baselineMedianMinor * (1 + (i - (spec.count - 1) / 2) * 0.004));
    out.push({
      hotelId: `comp-${i + 1}`,
      hotelName: `Comparable Hotel ${i + 1}`,
      baselineMedianMinor: median,
      currentNightlyMinor: Math.round(median * index),
      observedAt: spec.observedAt ?? '2026-08-14T09:00:00Z',
    });
  }
  return out;
}

export function makeQuery(overrides: Partial<StayQuery> = {}): StayQuery {
  return {
    hotelId: '2962',
    hotelName: 'The Ritz-Carlton Miami Beach',
    roomTypeId: 'rt_8814',
    roomTypeName: 'Ocean View King',
    comparabilityClass: 'BREAKFAST_INCLUDED|FLEXIBLE|PUBLIC',
    checkIn: '2026-09-18',
    nights: 3,
    adults: 2,
    children: 0,
    currency: 'USD',
    ...overrides,
  };
}

export function makeCurrent(
  nightlyMinor: number,
  overrides: Partial<CurrentRate> = {},
): CurrentRate {
  const nights = 3;
  return {
    nightlyMinor,
    totalMinor: nightlyMinor * nights,
    observedAt: '2026-08-14T11:46:00Z',
    taxBasis: 'GROSS',
    refundable: true,
    matchMethod: 'SOURCE_ID' as MatchMethod,
    matchConfidence: 1,
    comparabilityClass: 'BREAKFAST_INCLUDED|FLEXIBLE|PUBLIC',
    roomsLeft: null,
    onlyNonRefundableAvailable: false,
    ...overrides,
  };
}

/** Check-in date that yields the given lead time from NOW. */
export function checkInWithLeadDays(days: number, from: Date = NOW): string {
  const base = Date.parse(`${from.toISOString().slice(0, 10)}T00:00:00Z`);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}
