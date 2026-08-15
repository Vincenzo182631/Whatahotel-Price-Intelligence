-- Scoring configuration, version 2.
--
-- GENERATED FILE — do not edit by hand.
-- Source of truth: packages/core/src/config/defaults.ts
-- Regenerate with: npm run config:seed
--
-- Every value is a STARTING PRIOR with a documented rationale, not a finding.
-- See docs/mvp/10-configuration-registry.md, and the calibration runbook in
-- docs/mvp/02-deal-score.md §4 that must replace these before launch.

-- Exactly one config may be active (partial unique index), so stand down any
-- earlier version before activating this one. Prior versions are KEPT: every
-- analysis row references the version that produced it, and deleting one would
-- make those scores irreproducible.
UPDATE scoring_config SET is_active = false
 WHERE is_active AND version <> 2;

INSERT INTO scoring_config (version, config, is_active, note, created_by)
VALUES (
    2,
    $config$
{
  "version": 2,
  "score": {
    "weight": {
      "f1Historical": 0.33,
      "f2Market": 0.28,
      "f3Trend": 0.17,
      "f4Seasonality": 0.11,
      "f6Value": 0.11
    },
    "trend": {
      "windowDays": 7,
      "gain": 250,
      "minSeriesPoints": 4
    },
    "season": {
      "gain": 150,
      "minHistoryDays": 365,
      "correlationMax": 0.6
    },
    "value": {
      "gain": 200,
      "benefitCapPct": 0.25
    },
    "market": {
      "minComps": 3
    },
    "minWeightCoverage": 0.55,
    "lookbackDays": 90,
    "outlierTrim": [
      0.01,
      0.99
    ],
    "band": {
      "excellentMin": 85,
      "goodMin": 70,
      "fairMin": 50,
      "belowAverageMin": 30
    }
  },
  "baseline": {
    "minObsAbs": 12,
    "minObsTarget": 30,
    "levelMultiplier": {
      "L0": 1,
      "L1": 0.95,
      "L2": 0.88,
      "L3": 0.8,
      "L4": 0.6
    },
    "maxAgeHours": 24,
    "captureSlotMinutes": 60
  },
  "confidence": {
    "weight": {
      "volume": 0.25,
      "freshness": 0.2,
      "match": 0.2,
      "volatility": 0.15,
      "consistency": 0.1,
      "coverage": 0.1
    },
    "volumeTargetN": 60,
    "freshFullHours": 6,
    "freshZeroHours": 72,
    "freshFloor": 0.05,
    "staleBaselinePenalty": 0.9,
    "consistencyCvMax": 0.15,
    "singleSourceValue": 0.85,
    "coverageTargetComps": 5,
    "volatilityCvMax": 0.35,
    "volatilityFloor": 0.25,
    "unresolvedShareMax": 0.2,
    "unresolvedCurrentPenalty": 0.9,
    "unresolvedBaselinePenalty": 0.85,
    "completenessFloor": 0.75,
    "band": {
      "highMin": 75,
      "moderateMin": 55,
      "lowMin": 40
    }
  },
  "rec": {
    "confidenceFloor": 40,
    "matchMin": 0.5,
    "maxCurrentAgeHours": 24,
    "minObsAbs": 12,
    "l4ConfidenceMin": 55,
    "book": {
      "scoreMin": 72,
      "confidenceMin": 60,
      "urgencyScoreMin": 60,
      "urgencyRisePct": 3,
      "urgencyDemand": 0.6
    },
    "wait": {
      "confidenceMin": 70,
      "scoreMax": 42,
      "minLeadDays": 10,
      "riseBlockPct": 2,
      "demandBlock": 0.6,
      "scarcityBlock": 3,
      "minVolatilityConfidence": 0.4,
      "maxTrendPct": 0
    }
  },
  "calibration": {
    "outcomeHorizonDays": 14,
    "materialDropPct": 2,
    "bookNowRegretRateMax": 0.1,
    "waitSuccessRateMin": 0.6,
    "scoreStabilityMaxDelta": 10,
    "stabilityPriceTolerancePct": 1,
    "insufficientDataRateMax": 0.25,
    "factorCorrelationMax": 0.6,
    "targetScoreMean": 50,
    "targetScoreMeanTolerance": 12,
    "minSampleSize": 30
  },
  "explanation": {
    "enabled": false,
    "temperature": 0.3,
    "timeoutMs": 2500,
    "maxSentences": 3,
    "numericTolerance": 0.5,
    "cacheTtlHours": 24,
    "maxTemplateFactors": 3,
    "promptVersion": 1
  }
}
$config$::jsonb,
    true,
    'F5 (Demand) removed from the Deal Score: it was an affine function of F1 (score_F5 = (50 - 50D) + D * score_F1) and carried no independent signal. Its 0.10 weight was redistributed proportionally across the remaining five factors. Demand still drives the never-WAIT guard W4 and urgency gate G3. Still not calibrated against real data.',
    'mvp-spec'
)
ON CONFLICT (version) DO UPDATE
   SET config = EXCLUDED.config,
       is_active = true,
       note = EXCLUDED.note;
