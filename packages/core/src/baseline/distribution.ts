/**
 * Building a BaselineDistribution from raw observations.
 *
 * Used by the calibration replay harness, which reconstructs baselines at past
 * points in time rather than reading today's rollup. Sharing this code with the
 * engine is the point: a replayed score must be computed the same way a live one
 * was, or the calibration measures the harness rather than the model.
 */

import { coefficientOfVariation, mean, percentile, stddev, trimOutliers } from '../stats.js';
import type { BaselineDistribution, BaselineLevel, Minor } from '../types.js';

export interface DistributionObservation {
  readonly nightlyMinor: Minor;
  readonly matchConfidence: number;
  readonly sourceId: number;
  readonly comparabilityClass: string;
}

export interface BuildDistributionOptions {
  readonly level: BaselineLevel;
  readonly lookbackDays: number;
  readonly computedAt: string;
  readonly outlierTrim: readonly [number, number];
}

/**
 * Returns `null` when there is nothing to describe. An empty distribution is
 * not a distribution of zeros — the caller must be able to tell the difference.
 */
export function buildDistribution(
  observations: readonly DistributionObservation[],
  options: BuildDistributionOptions,
): BaselineDistribution | null {
  if (observations.length === 0) return null;

  const rawValues = observations.map((o) => o.nightlyMinor);
  const { kept, removed } = trimOutliers(rawValues, options.outlierTrim[0], options.outlierTrim[1]);
  if (kept.length === 0) return null;

  // Keep the observation records aligned with the trimmed values so match
  // confidence and source counts describe the same rows the statistics do.
  const lo = Math.min(...kept);
  const hi = Math.max(...kept);
  const keptObservations = observations.filter((o) => o.nightlyMinor >= lo && o.nightlyMinor <= hi);

  const meanValue = mean(kept);
  const stddevValue = stddev(kept);
  const sources = new Set(keptObservations.map((o) => o.sourceId));

  const unresolved = keptObservations.filter((o) => o.comparabilityClass === 'UNRESOLVED').length;

  return {
    level: options.level,
    nObservations: kept.length,
    nOutliersExcluded: removed,
    values: kept,
    min: lo,
    p10: Math.round(percentile(kept, 0.1)),
    p25: Math.round(percentile(kept, 0.25)),
    p50: Math.round(percentile(kept, 0.5)),
    p75: Math.round(percentile(kept, 0.75)),
    p90: Math.round(percentile(kept, 0.9)),
    max: hi,
    mean: Math.round(meanValue),
    stddev: Math.round(stddevValue),
    cv: coefficientOfVariation(kept),
    meanMatchConfidence:
      keptObservations.length === 0
        ? 0
        : keptObservations.reduce((sum, o) => sum + o.matchConfidence, 0) / keptObservations.length,
    nSources: sources.size,
    // Cross-source agreement needs at least two sources to mean anything.
    crossSourceCv: sources.size > 1 ? crossSourceDispersion(keptObservations) : null,
    unresolvedShare: keptObservations.length === 0 ? 0 : unresolved / keptObservations.length,
    lookbackDays: options.lookbackDays,
    computedAt: options.computedAt,
  };
}

/** Dispersion of per-source medians — how much the sources disagree. */
function crossSourceDispersion(observations: readonly DistributionObservation[]): number {
  const bySource = new Map<number, number[]>();
  for (const o of observations) {
    const list = bySource.get(o.sourceId);
    if (list) list.push(o.nightlyMinor);
    else bySource.set(o.sourceId, [o.nightlyMinor]);
  }
  const medians = [...bySource.values()].map((values) => percentile(values, 0.5));
  const m = mean(medians);
  return m === 0 ? 0 : stddev(medians) / m;
}
