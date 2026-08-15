/**
 * Configuration validation.
 *
 * Runs on every config activation. Two rules here are not stylistic:
 *  - Deal Score weights must sum to 1.0, or redistribution silently misweights.
 *  - The WAIT confidence threshold cannot be set below its hard floor, because
 *    configuration must not be able to disable a safety rule.
 */

import { DEFAULT_CONFIG, WAIT_CONFIDENCE_HARD_FLOOR, type ScoringConfig } from './defaults.js';

export class ConfigValidationError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid scoring configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

const WEIGHT_SUM_TOLERANCE = 1e-9;

export function validateConfig(config: ScoringConfig): readonly string[] {
  const issues: string[] = [];

  const w = config.score.weight;
  const weightSum =
    w.f1Historical + w.f2Market + w.f3Trend + w.f4Seasonality + w.f5Demand + w.f6Value;
  if (Math.abs(weightSum - 1) > WEIGHT_SUM_TOLERANCE) {
    issues.push(`score.weight.* must sum to 1.0 (got ${weightSum})`);
  }
  for (const [key, value] of Object.entries(w)) {
    if (value < 0 || value > 1) issues.push(`score.weight.${key} must be in [0,1] (got ${value})`);
  }

  if (config.rec.wait.confidenceMin < WAIT_CONFIDENCE_HARD_FLOOR) {
    issues.push(
      `rec.wait.confidenceMin must be at least ${WAIT_CONFIDENCE_HARD_FLOOR} — ` +
        `configuration cannot disable the never-WAIT safety rule (got ${config.rec.wait.confidenceMin})`,
    );
  }

  if (config.rec.book.confidenceMin > config.rec.wait.confidenceMin) {
    issues.push(
      'rec.book.confidenceMin should not exceed rec.wait.confidenceMin — ' +
        'the asymmetry is deliberate and this inverts it',
    );
  }

  if (config.baseline.minObsAbs < 1) issues.push('baseline.minObsAbs must be at least 1');
  if (config.baseline.minObsTarget < config.baseline.minObsAbs) {
    issues.push('baseline.minObsTarget must be >= baseline.minObsAbs');
  }

  const bands = config.score.band;
  if (!(
    bands.excellentMin > bands.goodMin &&
    bands.goodMin > bands.fairMin &&
    bands.fairMin > bands.belowAverageMin
  )) {
    issues.push('score.band.* thresholds must be strictly descending');
  }

  const cb = config.confidence.band;
  if (!(cb.highMin > cb.moderateMin && cb.moderateMin > cb.lowMin)) {
    issues.push('confidence.band.* thresholds must be strictly descending');
  }

  const [trimLo, trimHi] = config.score.outlierTrim;
  if (!(trimLo >= 0 && trimLo < trimHi && trimHi <= 1)) {
    issues.push('score.outlierTrim must satisfy 0 <= lo < hi <= 1');
  }

  if (config.confidence.freshZeroHours <= config.confidence.freshFullHours) {
    issues.push('confidence.freshZeroHours must exceed confidence.freshFullHours');
  }

  return issues;
}

export function assertValidConfig(config: ScoringConfig): ScoringConfig {
  const issues = validateConfig(config);
  if (issues.length > 0) throw new ConfigValidationError(issues);
  return config;
}

/** Deep-merge a partial override onto the defaults. Used by tests and calibration. */
export function withConfig(overrides: DeepPartial<ScoringConfig> = {}): ScoringConfig {
  return deepMerge(DEFAULT_CONFIG, overrides) as ScoringConfig;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (
    typeof base !== 'object' ||
    base === null ||
    Array.isArray(base) ||
    typeof override !== 'object' ||
    override === null ||
    Array.isArray(override)
  ) {
    return override;
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    result[key] = deepMerge((base as Record<string, unknown>)[key], value);
  }
  return result;
}
