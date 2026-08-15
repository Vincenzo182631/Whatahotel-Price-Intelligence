/**
 * Default scoring configuration — version 1.
 *
 * Every value here is a STARTING PRIOR with a documented rationale, not a
 * finding. See docs/mvp/10-configuration-registry.md for the reasoning behind
 * each, and docs/mvp/02-deal-score.md §4 for the calibration runbook that must
 * replace them before launch.
 *
 * This module is the single source of truth. db/seeds/002_scoring_config_v1.sql
 * carries the same document, and a test asserts the two never drift apart.
 */

export interface ScoringConfig {
  readonly version: number;

  readonly score: {
    readonly weight: {
      readonly f1Historical: number;
      readonly f2Market: number;
      readonly f3Trend: number;
      readonly f4Seasonality: number;
      readonly f6Value: number;
    };
    readonly trend: {
      readonly windowDays: number;
      readonly gain: number;
      readonly minSeriesPoints: number;
    };
    readonly season: {
      readonly gain: number;
      readonly minHistoryDays: number;
      readonly correlationMax: number;
    };
    readonly value: {
      readonly gain: number;
      readonly benefitCapPct: number;
    };
    readonly market: {
      readonly minComps: number;
    };
    readonly minWeightCoverage: number;
    readonly lookbackDays: number;
    readonly outlierTrim: readonly [number, number];
    readonly band: {
      readonly excellentMin: number;
      readonly goodMin: number;
      readonly fairMin: number;
      readonly belowAverageMin: number;
    };
  };

  readonly baseline: {
    readonly minObsAbs: number;
    readonly minObsTarget: number;
    readonly levelMultiplier: {
      readonly L0: number;
      readonly L1: number;
      readonly L2: number;
      readonly L3: number;
      readonly L4: number;
    };
    readonly maxAgeHours: number;
    readonly captureSlotMinutes: number;
  };

  readonly confidence: {
    readonly weight: {
      readonly volume: number;
      readonly freshness: number;
      readonly match: number;
      readonly volatility: number;
      readonly consistency: number;
      readonly coverage: number;
    };
    readonly volumeTargetN: number;
    readonly freshFullHours: number;
    readonly freshZeroHours: number;
    readonly freshFloor: number;
    readonly staleBaselinePenalty: number;
    readonly consistencyCvMax: number;
    readonly singleSourceValue: number;
    readonly coverageTargetComps: number;
    readonly volatilityCvMax: number;
    readonly volatilityFloor: number;
    readonly unresolvedShareMax: number;
    readonly unresolvedCurrentPenalty: number;
    readonly unresolvedBaselinePenalty: number;
    readonly completenessFloor: number;
    readonly band: {
      readonly highMin: number;
      readonly moderateMin: number;
      readonly lowMin: number;
    };
  };

  readonly rec: {
    readonly confidenceFloor: number;
    readonly matchMin: number;
    readonly maxCurrentAgeHours: number;
    readonly minObsAbs: number;
    readonly l4ConfidenceMin: number;
    readonly book: {
      readonly scoreMin: number;
      readonly confidenceMin: number;
      readonly urgencyScoreMin: number;
      readonly urgencyRisePct: number;
      readonly urgencyDemand: number;
    };
    readonly wait: {
      readonly confidenceMin: number;
      readonly scoreMax: number;
      readonly minLeadDays: number;
      readonly riseBlockPct: number;
      readonly demandBlock: number;
      readonly scarcityBlock: number;
      readonly minVolatilityConfidence: number;
      readonly maxTrendPct: number;
    };
  };

  /**
   * Not engine inputs — the measurable goals the calibration runbook evaluates
   * against (docs/mvp/10 §10). They live in config so the targets are versioned
   * alongside the weights they judge.
   */
  readonly calibration: {
    /** How far forward outcomes are measured after an analysis. */
    readonly outcomeHorizonDays: number;
    /** A drop smaller than this is noise, not a missed opportunity. */
    readonly materialDropPct: number;
    readonly bookNowRegretRateMax: number;
    readonly waitSuccessRateMin: number;
    readonly scoreStabilityMaxDelta: number;
    /** Price moves under this count as "unchanged" for the stability check. */
    readonly stabilityPriceTolerancePct: number;
    readonly insufficientDataRateMax: number;
    /** Above this, two factors are measuring the same thing. */
    readonly factorCorrelationMax: number;
    readonly targetScoreMean: number;
    readonly targetScoreMeanTolerance: number;
    /** Below this many observations a metric is reported but not judged. */
    readonly minSampleSize: number;
  };

  readonly explanation: {
    readonly enabled: boolean;
    readonly temperature: number;
    readonly timeoutMs: number;
    readonly maxSentences: number;
    readonly numericTolerance: number;
    readonly cacheTtlHours: number;
    readonly maxTemplateFactors: number;
    readonly promptVersion: number;
  };
}

/**
 * Hard floor on the never-WAIT confidence threshold.
 *
 * Configuration must not be able to disable the safety rule it exists to
 * enforce. `validateConfig` rejects any document setting it lower.
 */
export const WAIT_CONFIDENCE_HARD_FLOOR = 60;

export const DEFAULT_CONFIG: ScoringConfig = {
  // v2 — F5 (Demand) removed from the Deal Score. Its 0.10 was redistributed
  // proportionally across the remaining five, preserving their intended
  // relative importance rather than folding it all into F1.
  version: 2,

  score: {
    weight: {
      f1Historical: 0.33,
      f2Market: 0.28,
      f3Trend: 0.17,
      f4Seasonality: 0.11,
      f6Value: 0.11,
    },
    trend: { windowDays: 7, gain: 250, minSeriesPoints: 4 },
    season: { gain: 150, minHistoryDays: 365, correlationMax: 0.6 },
    value: { gain: 200, benefitCapPct: 0.25 },
    market: { minComps: 3 },
    minWeightCoverage: 0.55,
    lookbackDays: 90,
    outlierTrim: [0.01, 0.99],
    band: { excellentMin: 85, goodMin: 70, fairMin: 50, belowAverageMin: 30 },
  },

  baseline: {
    minObsAbs: 12,
    minObsTarget: 30,
    levelMultiplier: { L0: 1.0, L1: 0.95, L2: 0.88, L3: 0.8, L4: 0.6 },
    maxAgeHours: 24,
    captureSlotMinutes: 60,
  },

  confidence: {
    weight: {
      volume: 0.25,
      freshness: 0.2,
      match: 0.2,
      volatility: 0.15,
      consistency: 0.1,
      coverage: 0.1,
    },
    volumeTargetN: 60,
    freshFullHours: 6,
    freshZeroHours: 72,
    freshFloor: 0.05,
    staleBaselinePenalty: 0.9,
    consistencyCvMax: 0.15,
    singleSourceValue: 0.85,
    coverageTargetComps: 5,
    volatilityCvMax: 0.35,
    volatilityFloor: 0.25,
    unresolvedShareMax: 0.2,
    unresolvedCurrentPenalty: 0.9,
    unresolvedBaselinePenalty: 0.85,
    // Factor completeness scales confidence between this floor and 1.0 rather
    // than multiplying it raw. F4 (seasonality) and F5 (demand) are expected to
    // be UNAVAILABLE at MVP launch by design, which would otherwise cap every
    // confidence score at 80% permanently — penalising the product for a known,
    // planned data gap rather than for a data quality problem.
    completenessFloor: 0.75,
    band: { highMin: 75, moderateMin: 55, lowMin: 40 },
  },

  rec: {
    confidenceFloor: 40,
    matchMin: 0.5,
    maxCurrentAgeHours: 24,
    minObsAbs: 12,
    l4ConfidenceMin: 55,
    book: {
      scoreMin: 72,
      confidenceMin: 60,
      urgencyScoreMin: 60,
      urgencyRisePct: 3.0,
      urgencyDemand: 0.6,
    },
    wait: {
      confidenceMin: 70,
      scoreMax: 42,
      minLeadDays: 10,
      riseBlockPct: 2.0,
      demandBlock: 0.6,
      scarcityBlock: 3,
      minVolatilityConfidence: 0.4,
      maxTrendPct: 0.0,
    },
  },

  calibration: {
    outcomeHorizonDays: 14,
    materialDropPct: 2.0,
    bookNowRegretRateMax: 0.1,
    waitSuccessRateMin: 0.6,
    scoreStabilityMaxDelta: 10,
    stabilityPriceTolerancePct: 1.0,
    insufficientDataRateMax: 0.25,
    factorCorrelationMax: 0.6,
    targetScoreMean: 50,
    targetScoreMeanTolerance: 12,
    minSampleSize: 30,
  },

  explanation: {
    enabled: false,
    temperature: 0.3,
    timeoutMs: 2500,
    maxSentences: 3,
    numericTolerance: 0.5,
    cacheTtlHours: 24,
    maxTemplateFactors: 3,
    promptVersion: 1,
  },
};

export const ENGINE_VERSION = '1.0.0';
