/**
 * The five calibration metrics (docs/mvp/02-deal-score.md §4) plus coverage.
 *
 * Pure functions over evaluated trials, so a config sweep can re-score the same
 * replayed sample thousands of times without touching the database, and so the
 * metrics themselves are unit-testable.
 *
 * Every metric reports INSUFFICIENT_SAMPLE rather than a verdict when it does
 * not have the evidence to judge. A calibration report that cannot distinguish
 * "we passed" from "we could not tell" is worse than no report.
 */

import type { FactorCode, ScoringConfig } from '@wahpi/core';
import { mean, percentile, stddev } from '@wahpi/core';

import type { Outcome, ReplayTarget } from './replay.js';

export type MetricStatus = 'PASS' | 'FAIL' | 'WARN' | 'INSUFFICIENT_SAMPLE';

export interface MetricResult {
  readonly key: string;
  readonly title: string;
  readonly status: MetricStatus;
  readonly value: number | null;
  readonly target: string;
  readonly sampleSize: number;
  readonly detail: string;
  readonly rows?: ReadonlyArray<Readonly<Record<string, string | number>>>;
}

export interface Trial {
  readonly target: ReplayTarget;
  readonly asOf: string;
  readonly recommendation: string;
  readonly gateFired: string;
  readonly dealScore: number | null;
  readonly dealScoreBand: string | null;
  readonly confidence: number;
  readonly confidenceBand: string;
  readonly currentNightlyMinor: number;
  readonly baselineLevel: string;
  readonly nObservations: number;
  readonly factorScores: Readonly<Partial<Record<FactorCode, number>>>;
  readonly outcome: Outcome;
}

function stayKey(t: Trial): string {
  const q = t.target;
  return `${q.hotelId}|${q.roomTypeId}|${q.checkIn}|${q.nights}|${q.adults}|${q.children}`;
}

function scored(trials: readonly Trial[]): Trial[] {
  return trials.filter((t) => t.dealScore !== null);
}

/** Trials whose outcome we can actually observe. */
function measurable(trials: readonly Trial[]): Trial[] {
  return trials.filter((t) => t.outcome.nObservations > 0 && t.outcome.minNightlyMinor !== null);
}

// ── 1 · score distribution ─────────────────────────────────────────────────

export function scoreDistribution(trials: readonly Trial[], config: ScoringConfig): MetricResult {
  const values = scored(trials).map((t) => t.dealScore as number);
  const target = `mean within ±${config.calibration.targetScoreMeanTolerance} of ${config.calibration.targetScoreMean}`;

  if (values.length < config.calibration.minSampleSize) {
    return {
      key: 'score_distribution',
      title: 'Score distribution',
      status: 'INSUFFICIENT_SAMPLE',
      value: values.length === 0 ? null : Math.round(mean(values)),
      target,
      sampleSize: values.length,
      detail: `Need at least ${config.calibration.minSampleSize} scored trials to judge the distribution.`,
    };
  }

  const m = mean(values);
  const drift = Math.abs(m - config.calibration.targetScoreMean);
  const spread = stddev(values);

  const bands = countBy(scored(trials), (t) => t.dealScoreBand ?? 'NONE');
  const recommendations = countBy(trials, (t) => t.recommendation);

  // A distribution piled at one end means a gain constant is mis-set; a
  // distribution with no spread means the model is not discriminating at all.
  const status: MetricStatus =
    drift > config.calibration.targetScoreMeanTolerance ? 'FAIL' : spread < 8 ? 'WARN' : 'PASS';

  return {
    key: 'score_distribution',
    title: 'Score distribution',
    status,
    value: Math.round(m * 10) / 10,
    target,
    sampleSize: values.length,
    detail:
      `mean ${m.toFixed(1)} · median ${percentile(values, 0.5).toFixed(0)} · ` +
      `sd ${spread.toFixed(1)} · p10 ${percentile(values, 0.1).toFixed(0)} · ` +
      `p90 ${percentile(values, 0.9).toFixed(0)}` +
      (spread < 8 ? ' — spread is narrow; the model may not be discriminating.' : ''),
    rows: [
      ...Object.entries(bands).map(([band, n]) => ({
        group: `band:${band}`,
        count: n,
        share: `${((n / values.length) * 100).toFixed(1)}%`,
      })),
      ...Object.entries(recommendations).map(([rec, n]) => ({
        group: `rec:${rec}`,
        count: n,
        share: `${((n / trials.length) * 100).toFixed(1)}%`,
      })),
    ],
  };
}

// ── 2 · factor correlation ─────────────────────────────────────────────────

export function pearson(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length || xs.length < 3) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const a = (xs[i] as number) - mx;
    const b = (ys[i] as number) - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const denom = Math.sqrt(dx * dy);
  return denom === 0 ? 0 : num / denom;
}

const FACTOR_CODES: readonly FactorCode[] = ['F1', 'F2', 'F3', 'F4', 'F6'];

export function factorCorrelation(trials: readonly Trial[], config: ScoringConfig): MetricResult {
  const pairs: Array<{ a: FactorCode; b: FactorCode; r: number; n: number }> = [];

  for (let i = 0; i < FACTOR_CODES.length; i += 1) {
    for (let j = i + 1; j < FACTOR_CODES.length; j += 1) {
      const a = FACTOR_CODES[i] as FactorCode;
      const b = FACTOR_CODES[j] as FactorCode;
      const xs: number[] = [];
      const ys: number[] = [];
      for (const t of trials) {
        const va = t.factorScores[a];
        const vb = t.factorScores[b];
        if (va !== undefined && vb !== undefined) {
          xs.push(va);
          ys.push(vb);
        }
      }
      if (xs.length >= config.calibration.minSampleSize) {
        pairs.push({ a, b, r: pearson(xs, ys), n: xs.length });
      }
    }
  }

  const target = `no pair above |r| ${config.calibration.factorCorrelationMax}`;

  if (pairs.length === 0) {
    return {
      key: 'factor_correlation',
      title: 'Factor correlation',
      status: 'INSUFFICIENT_SAMPLE',
      value: null,
      target,
      sampleSize: 0,
      detail: 'No factor pair had enough co-occurring observations to correlate.',
    };
  }

  const worst = pairs.reduce((acc, p) => (Math.abs(p.r) > Math.abs(acc.r) ? p : acc));
  const offenders = pairs.filter((p) => Math.abs(p.r) > config.calibration.factorCorrelationMax);

  return {
    key: 'factor_correlation',
    title: 'Factor correlation',
    status: offenders.length > 0 ? 'FAIL' : 'PASS',
    value: Math.round(worst.r * 1000) / 1000,
    target,
    sampleSize: pairs.reduce((s, p) => Math.max(s, p.n), 0),
    detail:
      offenders.length > 0
        ? `${offenders.length} pair(s) are measuring the same thing: ` +
          offenders.map((p) => `${p.a}/${p.b} r=${p.r.toFixed(2)}`).join(', ') +
          '. Fold one into the other rather than paying for it twice.'
        : `Strongest pair ${worst.a}/${worst.b} at r=${worst.r.toFixed(2)} — within tolerance.`,
    rows: pairs
      .slice()
      .sort((x, y) => Math.abs(y.r) - Math.abs(x.r))
      .map((p) => ({ pair: `${p.a}/${p.b}`, r: Math.round(p.r * 1000) / 1000, n: p.n })),
  };
}

// ── 3 · BOOK_NOW regret ────────────────────────────────────────────────────

export function bookNowRegret(trials: readonly Trial[], config: ScoringConfig): MetricResult {
  const drop = config.calibration.materialDropPct / 100;
  const candidates = measurable(trials).filter((t) => t.recommendation === 'BOOK_NOW');
  const target = `≤ ${(config.calibration.bookNowRegretRateMax * 100).toFixed(0)}%`;

  if (candidates.length < config.calibration.minSampleSize) {
    return {
      key: 'book_now_regret',
      title: 'BOOK_NOW regret rate',
      status: 'INSUFFICIENT_SAMPLE',
      value: candidates.length === 0 ? null : rate(candidates, (t) => beaten(t, drop)),
      target,
      sampleSize: candidates.length,
      detail: `Only ${candidates.length} measurable BOOK_NOW trials; need ${config.calibration.minSampleSize}.`,
    };
  }

  const regretted = candidates.filter((t) => beaten(t, drop));
  const value = regretted.length / candidates.length;

  const misses = regretted.map((t) => ({
    hotel: t.target.hotelName,
    checkIn: t.target.checkIn,
    recommended: Math.round(t.currentNightlyMinor / 100),
    laterLow: Math.round((t.outcome.minNightlyMinor as number) / 100),
    lostPct: `${(((t.currentNightlyMinor - (t.outcome.minNightlyMinor as number)) / t.currentNightlyMinor) * 100).toFixed(1)}%`,
  }));

  return {
    key: 'book_now_regret',
    title: 'BOOK_NOW regret rate',
    status: value > config.calibration.bookNowRegretRateMax ? 'FAIL' : 'PASS',
    value: Math.round(value * 1000) / 1000,
    target,
    sampleSize: candidates.length,
    detail:
      `${regretted.length} of ${candidates.length} BOOK_NOW rates were beaten by more than ` +
      `${config.calibration.materialDropPct}% within ${config.calibration.outcomeHorizonDays} days.`,
    rows: misses.slice(0, 10),
  };
}

function beaten(t: Trial, dropFraction: number): boolean {
  const low = t.outcome.minNightlyMinor as number;
  return low < t.currentNightlyMinor * (1 - dropFraction);
}

// ── 4 · (retired) ──────────────────────────────────────────────────────────
//
// This slot held the WAIT success rate: of the trials where the engine said
// WAIT, how many were followed by a material price drop. WAIT was retired in
// config v4 — the engine no longer makes a claim about future price — so the
// metric has nothing to measure. The numbering is left with a hole rather than
// closed up, because past calibration reports cite metrics by number.

// ── 5 · score stability ────────────────────────────────────────────────────

export function scoreStability(trials: readonly Trial[], config: ScoringConfig): MetricResult {
  const byStay = new Map<string, Trial[]>();
  for (const t of scored(trials)) {
    const key = stayKey(t);
    const list = byStay.get(key);
    if (list) list.push(t);
    else byStay.set(key, [t]);
  }

  const deltas: Array<{ delta: number; hotel: string; checkIn: string; from: string; to: string }> =
    [];
  const tolerance = config.calibration.stabilityPriceTolerancePct / 100;

  for (const group of byStay.values()) {
    const ordered = [...group].sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
    for (let i = 1; i < ordered.length; i += 1) {
      const prev = ordered[i - 1] as Trial;
      const curr = ordered[i] as Trial;

      // Only compare consecutive replays where the PRICE barely moved: a score
      // that changes because the rate changed is the model working, not drift.
      //
      // A tolerance rather than exact equality, because requiring an identical
      // price makes the metric unmeasurable on any hotel that reprices daily —
      // which is most of them. A 1% move cannot justify a 10-point swing.
      const priceMove =
        Math.abs(curr.currentNightlyMinor - prev.currentNightlyMinor) /
        Math.max(1, prev.currentNightlyMinor);
      if (priceMove > tolerance) continue;

      deltas.push({
        delta: Math.abs((curr.dealScore as number) - (prev.dealScore as number)),
        hotel: curr.target.hotelName,
        checkIn: curr.target.checkIn,
        from: prev.asOf.slice(0, 10),
        to: curr.asOf.slice(0, 10),
      });
    }
  }

  const target = `max Δ ≤ ${config.calibration.scoreStabilityMaxDelta} points`;

  if (deltas.length < config.calibration.minSampleSize) {
    return {
      key: 'score_stability',
      title: 'Score stability',
      status: 'INSUFFICIENT_SAMPLE',
      value: deltas.length === 0 ? null : Math.max(...deltas.map((d) => d.delta)),
      target,
      sampleSize: deltas.length,
      detail: `Only ${deltas.length} consecutive replays with an unchanged price; need ${config.calibration.minSampleSize}.`,
    };
  }

  const values = deltas.map((d) => d.delta);
  const worst = Math.max(...values);
  const p95 = percentile(values, 0.95);

  return {
    key: 'score_stability',
    title: 'Score stability',
    status:
      p95 > config.calibration.scoreStabilityMaxDelta
        ? 'FAIL'
        : worst > config.calibration.scoreStabilityMaxDelta
          ? 'WARN'
          : 'PASS',
    value: Math.round(p95 * 10) / 10,
    target,
    sampleSize: deltas.length,
    detail:
      `p95 Δ ${p95.toFixed(1)} · worst Δ ${worst.toFixed(0)} · mean Δ ${mean(values).toFixed(1)} ` +
      `across ${deltas.length} price-unchanged re-runs. Instability here usually means a starved baseline.`,
    rows: deltas
      .slice()
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 10)
      .map((d) => ({
        hotel: d.hotel,
        checkIn: d.checkIn,
        window: `${d.from}→${d.to}`,
        delta: d.delta,
      })),
  };
}

// ── 6 · coverage ───────────────────────────────────────────────────────────

export function coverage(trials: readonly Trial[], config: ScoringConfig): MetricResult {
  const target = `≤ ${(config.calibration.insufficientDataRateMax * 100).toFixed(0)}%`;
  if (trials.length === 0) {
    return {
      key: 'coverage',
      title: 'INSUFFICIENT_DATA rate',
      status: 'INSUFFICIENT_SAMPLE',
      value: null,
      target,
      sampleSize: 0,
      detail: 'No trials.',
    };
  }

  const insufficient = trials.filter((t) => t.recommendation === 'INSUFFICIENT_DATA');
  const value = insufficient.length / trials.length;
  const levels = countBy(trials, (t) => t.baselineLevel);

  return {
    key: 'coverage',
    title: 'INSUFFICIENT_DATA rate',
    status:
      trials.length < config.calibration.minSampleSize
        ? 'INSUFFICIENT_SAMPLE'
        : value > config.calibration.insufficientDataRateMax
          ? 'FAIL'
          : 'PASS',
    value: Math.round(value * 1000) / 1000,
    target,
    sampleSize: trials.length,
    detail:
      `${insufficient.length} of ${trials.length} queries could not be scored. ` +
      `Above target means coverage is too thin to launch on this hotel set.`,
    rows: Object.entries(levels).map(([level, n]) => ({
      group: `baseline:${level}`,
      count: n,
      share: `${((n / trials.length) * 100).toFixed(1)}%`,
    })),
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function rate(items: readonly Trial[], predicate: (t: Trial) => boolean): number {
  if (items.length === 0) return 0;
  return Math.round((items.filter(predicate).length / items.length) * 1000) / 1000;
}

export function allMetrics(trials: readonly Trial[], config: ScoringConfig): MetricResult[] {
  return [
    scoreDistribution(trials, config),
    factorCorrelation(trials, config),
    bookNowRegret(trials, config),
    scoreStability(trials, config),
    coverage(trials, config),
  ];
}
