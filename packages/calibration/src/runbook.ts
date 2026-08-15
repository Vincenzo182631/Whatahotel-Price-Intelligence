/**
 * The calibration runbook (docs/mvp/02-deal-score.md §4).
 *
 * Two phases, deliberately separated:
 *   1. collectSamples — expensive, database-bound, done ONCE.
 *   2. evaluate       — pure, cheap, can run thousands of times over the same
 *                       sample under different candidate configurations.
 *
 * That split is what makes a config sweep affordable, and it means every
 * candidate is judged on identical evidence rather than on a fresh sample that
 * might differ for unrelated reasons.
 */

import { analyze, type FactorCode, type ScoringConfig, type ScoringInput } from '@wahpi/core';
import { db, type Queryable } from '@wahpi/data';

import { allMetrics, type MetricResult, type MetricStatus, type Trial } from './metrics.js';
import {
  outcomeAfter,
  replayAt,
  replayPointsFor,
  sampleReplayTargets,
  type Outcome,
  type ReplayTarget,
} from './replay.js';

export interface ReplaySample {
  readonly target: ReplayTarget;
  readonly input: ScoringInput;
  readonly outcome: Outcome;
  readonly asOf: string;
}

export interface CollectOptions {
  /** How many distinct stays to sample. */
  readonly stays: number;
  /** How many replay instants per stay. */
  readonly pointsPerStay: number;
  /** Minimum captured observations for a stay to be worth replaying. */
  readonly minObservations: number;
  readonly onProgress?: (done: number, total: number) => void;
}

export const DEFAULT_COLLECT_OPTIONS: CollectOptions = {
  stays: 60,
  pointsPerStay: 6,
  minObservations: 15,
};

export interface DataProvenance {
  readonly totalObservations: number;
  readonly syntheticObservations: number;
  readonly syntheticShare: number;
  readonly sources: ReadonlyArray<{ code: string; authoritative: boolean; observations: number }>;
}

/**
 * How much of the underlying data is synthetic.
 *
 * The report refuses to present findings as real when this is non-zero. A
 * calibration run against fabricated rates measures the harness, not the model,
 * and a number that looks like a finding is worse than no number at all.
 */
export async function detectProvenance(q?: Queryable): Promise<DataProvenance> {
  const { rows } = await db(q).query(
    `SELECT s.code, s.is_authoritative, count(o.id)::int AS observations
       FROM source s LEFT JOIN rate_observation o ON o.source_id = s.id
      GROUP BY s.code, s.is_authoritative
      ORDER BY observations DESC`,
  );

  const sources = rows.map((r) => ({
    code: r.code as string,
    authoritative: r.is_authoritative === true,
    observations: r.observations as number,
  }));

  const total = sources.reduce((sum, s) => sum + s.observations, 0);
  const synthetic = sources
    .filter((s) => /SYNTHETIC|^IT_/i.test(s.code) || !s.authoritative)
    .reduce((sum, s) => sum + s.observations, 0);

  return {
    totalObservations: total,
    syntheticObservations: synthetic,
    syntheticShare: total === 0 ? 0 : synthetic / total,
    sources,
  };
}

export async function collectSamples(
  config: ScoringConfig,
  options: CollectOptions = DEFAULT_COLLECT_OPTIONS,
  q?: Queryable,
): Promise<ReplaySample[]> {
  const targets = await sampleReplayTargets(options.stays, options.minObservations, q);
  const samples: ReplaySample[] = [];

  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i] as ReplayTarget;
    const points = await replayPointsFor(target, q);

    // Drop the most recent points: a replay with no future observations has no
    // measurable outcome, so it would inflate the sample without informing it.
    const usable = points.slice(0, Math.max(0, points.length - 2));
    if (usable.length === 0) continue;

    const chosen = spread(usable, options.pointsPerStay);

    for (const asOf of chosen) {
      const replayed = await replayAt(target, asOf, config, q);
      if (!replayed) continue;
      const outcome = await outcomeAfter(target, asOf, config.calibration.outcomeHorizonDays, q);
      samples.push({ target, input: replayed.input, outcome, asOf: asOf.toISOString() });
    }

    options.onProgress?.(i + 1, targets.length);
  }

  return samples;
}

/** Evenly spaced selection, preserving the first and last. */
function spread<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  const out: T[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(items[Math.round((i / (count - 1)) * (items.length - 1))] as T);
  }
  return out;
}

/** Pure: re-score a collected sample under any configuration. */
export function evaluate(samples: readonly ReplaySample[], config: ScoringConfig): Trial[] {
  return samples.map((sample) => {
    const { analysis } = analyze(sample.input, config);

    const factorScores: Partial<Record<FactorCode, number>> = {};
    for (const factor of analysis.factors) {
      if (factor.available && factor.subScore !== null) {
        factorScores[factor.code] = factor.subScore;
      }
    }

    return {
      target: sample.target,
      asOf: sample.asOf,
      recommendation: analysis.recommendation,
      gateFired: analysis.gateFired,
      dealScore: analysis.dealScore,
      dealScoreBand: analysis.dealScoreBand,
      confidence: analysis.confidence,
      confidenceBand: analysis.confidenceBand,
      currentNightlyMinor: analysis.currentNightlyMinor,
      baselineLevel: analysis.baseline.level,
      nObservations: analysis.baseline.nObservations,
      factorScores,
      outcome: sample.outcome,
    };
  });
}

export interface RunbookResult {
  readonly configVersion: number;
  readonly sampleSize: number;
  readonly stays: number;
  readonly metrics: readonly MetricResult[];
  readonly overall: MetricStatus;
  readonly blocking: readonly string[];
}

export function runRunbook(samples: readonly ReplaySample[], config: ScoringConfig): RunbookResult {
  const trials = evaluate(samples, config);
  const metrics = allMetrics(trials, config);

  const failed = metrics.filter((m) => m.status === 'FAIL');
  const unknown = metrics.filter((m) => m.status === 'INSUFFICIENT_SAMPLE');

  const overall: MetricStatus =
    failed.length > 0
      ? 'FAIL'
      : unknown.length > metrics.length / 2
        ? 'INSUFFICIENT_SAMPLE'
        : metrics.some((m) => m.status === 'WARN' || m.status === 'INSUFFICIENT_SAMPLE')
          ? 'WARN'
          : 'PASS';

  const stays = new Set(
    samples.map((s) => `${s.target.hotelId}|${s.target.roomTypeId}|${s.target.checkIn}`),
  ).size;

  return {
    configVersion: config.version,
    sampleSize: samples.length,
    stays,
    metrics,
    overall,
    blocking: failed.map((m) => m.title),
  };
}
