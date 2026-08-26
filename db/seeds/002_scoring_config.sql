-- Scoring configuration, version 8.
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
 WHERE is_active AND version <> 8;

INSERT INTO scoring_config (version, config, is_active, note, created_by)
VALUES (
    8,
    $config$
{
  "version": 8,
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
  "live": {
    "csi": {
      "strongValueMax": 85,
      "fairMax": 115,
      "minComps": 3,
      "priceOnlyFallback": true,
      "radiusMiles": [
        2,
        3,
        5
      ],
      "maxCompAgeHours": 24,
      "scoreAtCsi": {
        "zero": 130,
        "full": 70
      }
    },
    "premium": {
      "premiumThresholdPct": 5,
      "highCoverShare": 0.7,
      "moderateCoverShare": 0.35,
      "confidentCompsWithBenefits": 3,
      "confidentComps": 5
    },
    "calendar": {
      "dipMax": -15,
      "normalMax": 15,
      "windowDays": 21,
      "minNeighbours": 3,
      "preferSameDow": true,
      "delta": {
        "zero": 35,
        "full": -35
      }
    },
    "compression": {
      "tightMin": 0.4,
      "softMax": 0.15,
      "minChecked": 3
    },
    "weight": {
      "compSet": 0.45,
      "calendar": 0.35,
      "compression": 0.2
    },
    "minWeightCoverage": 0.6,
    "band": {
      "exceptionalMin": 85,
      "strongMin": 70,
      "marketMin": 50
    },
    "confidence": {
      "highMinComps": 4,
      "highMinNeighbours": 4,
      "maxRateAgeHours": 12,
      "mediumMinComps": 3
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
      "urgencyDemand": 0.6,
      "urgencyScarcityRooms": 3
    }
  },
  "calibration": {
    "outcomeHorizonDays": 14,
    "materialDropPct": 2,
    "bookNowRegretRateMax": 0.1,
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
    'Uncalibrated.',
    'mvp-spec'
)
ON CONFLICT (version) DO UPDATE
   SET config = EXCLUDED.config,
       is_active = true,
       note = EXCLUDED.note;
