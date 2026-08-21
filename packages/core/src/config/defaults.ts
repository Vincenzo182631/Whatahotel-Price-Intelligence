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

  /**
   * The LIVE intelligence model.
   *
   * This product does not predict prices. It answers "is this a good rate right
   * now, and are these good dates" from rates that exist today: the hotel
   * against its live comp set, the selected dates against nearby bookable
   * dates, and how much of the comparable market is still available.
   *
   * Every threshold the model uses is here. Nothing downstream may re-derive
   * one — a band that exists in two places will disagree in two places.
   */
  readonly live: {
    /**
     * Comp-Set Index = subject nightly ÷ median competitor nightly × 100.
     *
     * Deliberately the RAW ratio, not each hotel's discount against its own
     * norm (which is what the history-based market factor computes). The raw
     * form needs no history, which is the point — but it does mean a genuine
     * luxury flagship scores poorly against cheaper neighbours. That is the
     * intended reading of "is this a good rate right now".
     */
    readonly csi: {
      /** At or below this, the hotel is materially cheaper than its comp set. */
      readonly strongValueMax: number;
      /** Above this, the hotel is priced above its comp set. */
      readonly fairMax: number;
      /** Fewer valid competitors than this and the signal is not produced. */
      readonly minComps: number;
      /** Competitor rates older than this are not live-validated; excluded. */
      readonly maxCompAgeHours: number;
      /** CSI at which the sub-score hits 0 and 100 respectively. */
      readonly scoreAtCsi: { readonly zero: number; readonly full: number };
    };

    /**
     * Premium Justification — is a hotel dearer than its comp set because it
     * gives more for the money? Measured in money against money: the value a
     * rate INCLUDES versus the value the comparables include. See
     * computePremiumJustification for why that is the only honest measure
     * available today.
     */
    readonly premium: {
      /** Below this premium there is nothing to justify. */
      readonly premiumThresholdPct: number;
      /** Share of the premium covered by included value to call it HIGH. */
      readonly highCoverShare: number;
      readonly moderateCoverShare: number;
      /** Comparables stating their inclusions before the verdict is confident. */
      readonly confidentCompsWithBenefits: number;
      readonly confidentComps: number;
    };

    /**
     * Calendar Delta = (subject ADR − nearby ADR) ÷ nearby ADR × 100.
     *
     * Compares the chosen dates against other bookable dates for the SAME
     * hotel, room, occupancy and length of stay. Negative means the chosen
     * dates are cheaper than their neighbours.
     */
    readonly calendar: {
      /** At or below this, the dates are a genuine dip. */
      readonly dipMax: number;
      /** Above this, the dates are compressed/expensive. */
      readonly normalMax: number;
      /** Days either side of the stay to draw neighbours from. */
      readonly windowDays: number;
      /** Below this many neighbours the signal is not produced. */
      readonly minNeighbours: number;
      /**
       * Prefer neighbours on the same day-of-week pattern. A Thursday–Sunday
       * stay compared against a Monday–Thursday one measures the weekend, not
       * the dates. Same-DOW neighbours are used alone when there are enough.
       */
      readonly preferSameDow: boolean;
      readonly delta: { readonly zero: number; readonly full: number };
    };

    /**
     * Market compression: how much of the comparable set is still bookable.
     *
     * Real, not aspirational — the source answers status 204 for a sold-out
     * stay, and `collection_attempt.last_outcome` records it per hotel and
     * date. Absent that evidence the signal is omitted rather than guessed.
     */
    readonly compression: {
      /** Sold-out share at or above this is a tight market. */
      readonly tightMin: number;
      /** Sold-out share at or below this is a soft market. */
      readonly softMax: number;
      /** Fewer comp-set hotels checked than this and the signal is dropped. */
      readonly minChecked: number;
    };

    /**
     * Starting weights. They are renormalized across whichever signals are
     * actually available, so a missing signal redistributes rather than
     * dragging the score toward zero.
     */
    readonly weight: {
      readonly compSet: number;
      readonly calendar: number;
      readonly compression: number;
    };

    /** Below this share of total weight present, no score is produced at all. */
    readonly minWeightCoverage: number;

    /** Deal-score bands. Displayed to the customer as a 0–10 figure. */
    readonly band: {
      readonly exceptionalMin: number;
      readonly strongMin: number;
      readonly marketMin: number;
    };

    /** Confidence is reported HIGH / MEDIUM / LOW, not as a number. */
    readonly confidence: {
      readonly highMinComps: number;
      readonly highMinNeighbours: number;
      readonly maxRateAgeHours: number;
      readonly mediumMinComps: number;
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
      /** Rooms remaining at or below which gate G3 treats inventory as scarce. */
      readonly urgencyScarcityRooms: number;
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

export const DEFAULT_CONFIG: ScoringConfig = {
  // v4 — retires WAIT.
  //
  // v3 added the `live` block: the comp-set / calendar / compression model that
  // scores from rates existing today rather than from accrued history. v4
  // finishes the job by removing the one output that was a forecast. The
  // `rec.wait` block went with it; the two of its values that did non-predictive
  // work are now `rec.shortLeadDays` and `rec.book.urgencyScarcityRooms`.
  //
  // The v2 factor weights are retained unchanged, and every analysis records the
  // version that produced it, so older scores stay reproducible.
  version: 5,

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

  live: {
    csi: {
      strongValueMax: 85,
      fairMax: 115,
      // Below three, a median is one or two hotels wearing a statistic's
      // clothing. Confidence would also be LOW, but not producing the signal
      // is stronger than producing it apologetically.
      minComps: 3,
      maxCompAgeHours: 24,
      // CSI 130 → 0, CSI 70 → 100. Centred so parity (100) lands mid-scale.
      scoreAtCsi: { zero: 130, full: 70 },
    },

    premium: {
      // 5% is inside the noise of which room the comp set happened to match;
      // calling that a "premium" would invite a verdict about nothing.
      premiumThresholdPct: 5,
      // Included value covering 70% of the premium is a hotel that is barely
      // dearer once you count what you get. Half is a real but partial
      // offset. Below that the premium is mostly unexplained by the evidence
      // we hold — which is a statement about our evidence, not a claim that
      // the hotel is not worth it.
      highCoverShare: 0.7,
      moderateCoverShare: 0.35,
      // One comparable stating its inclusions is an anecdote about a market.
      confidentCompsWithBenefits: 3,
      confidentComps: 5,
    },
    calendar: {
      dipMax: -15,
      normalMax: 15,
      windowDays: 21,
      minNeighbours: 3,
      preferSameDow: true,
      // +35% → 0, −35% → 100.
      delta: { zero: 35, full: -35 },
    },
    compression: {
      tightMin: 0.4,
      softMax: 0.15,
      minChecked: 3,
    },
    weight: { compSet: 0.45, calendar: 0.35, compression: 0.2 },
    // Comp-set alone (0.45) is not enough to call something a deal; comp-set
    // plus either other signal is.
    minWeightCoverage: 0.6,
    band: { exceptionalMin: 85, strongMin: 70, marketMin: 50 },
    confidence: {
      highMinComps: 4,
      highMinNeighbours: 4,
      maxRateAgeHours: 12,
      mediumMinComps: 3,
    },
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
      urgencyScarcityRooms: 3,
    },
  },

  calibration: {
    outcomeHorizonDays: 14,
    materialDropPct: 2.0,
    bookNowRegretRateMax: 0.1,
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
