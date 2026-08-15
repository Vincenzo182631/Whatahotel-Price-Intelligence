/**
 * The scoring pipeline: inputs in, verdict out.
 *
 * Pure and deterministic — `input.now` is injected rather than read from a
 * clock, so the same inputs and config version always produce the same output
 * (invariant P9). No I/O anywhere in this module or anything it calls.
 */

import { ENGINE_VERSION, type ScoringConfig } from './config/defaults.js';
import { computeConfidence, fMatch, fVolatility } from './confidence/confidence.js';
import { buildExplanationBundle, type ExplanationBundle } from './explanation/bundle.js';
import {
  deriveCaveats,
  deriveReasons,
  type CaveatFact,
  type ReasonFact,
} from './explanation/reasonCodes.js';
import { renderTemplate, type RenderedExplanation } from './explanation/template.js';
import { assertWaitInvariant, recommend } from './recommendation/engine.js';
import { composeDealScore } from './scoring/dealScore.js';
import {
  computeF1,
  computeF2,
  computeF3,
  computeF4,
  computeF5,
  computeF6,
} from './scoring/factors.js';
import { daysBetweenDates, hoursBetween } from './stats.js';
import type { AnalysisResult, BaselineSummary, FactorResult, ScoringInput } from './types.js';

export interface AnalyzeOutput {
  readonly analysis: AnalysisResult;
  readonly reasons: readonly ReasonFact[];
  readonly caveats: readonly CaveatFact[];
  readonly bundle: ExplanationBundle;
  readonly explanation: RenderedExplanation;
}

export function analyze(input: ScoringInput, config: ScoringConfig): AnalyzeOutput {
  const { query, current, baseline, series, comparables, benefits, now } = input;

  // ── Factors ────────────────────────────────────────────────────────────
  const f1 = computeF1(current, baseline, config);
  const f2 = computeF2(current, baseline, comparables, config);
  const f3 = computeF3(series, now, config);
  const f4 = computeF4(input.seasonality, config);
  const f5 = computeF5(input.demand, f1.percentileRank, config);
  const f6 = computeF6(current, query, benefits, config);

  const rawFactors: FactorResult[] = [f1.factor, f2.factor, f3.factor, f4, f5.factor, f6.factor];

  // ── Deal Score ─────────────────────────────────────────────────────────
  const dealScore = composeDealScore(rawFactors, config);

  // ── Confidence ─────────────────────────────────────────────────────────
  const confidenceResult = computeConfidence(
    {
      current,
      baseline,
      nFreshComps: f2.compCount,
      marketFactorUsed: f2.factor.available,
      weightCoverage: dealScore.weightCoverage,
      now,
    },
    config,
  );

  // ── Recommendation ─────────────────────────────────────────────────────
  const nowDate = now.toISOString().slice(0, 10);
  const leadTimeDays = daysBetweenDates(nowDate, query.checkIn);
  const matchQuality = fMatch(current, baseline, config);
  const volatilityFactor = fVolatility(baseline?.cv ?? 0, config);
  const rateAgeHours = hoursBetween(new Date(current.observedAt), now);

  const recommendation = recommend(
    {
      dealScore: dealScore.score,
      confidence: confidenceResult.confidence,
      current,
      baseline,
      weightCoverage: dealScore.weightCoverage,
      matchQuality,
      leadTimeDays,
      trendPct: f3.deltaPct,
      demandPressure: f5.demandPressure,
      volatilityFactor,
      now,
    },
    config,
  );

  assertWaitInvariant(recommendation, confidenceResult.confidence, config);

  // A score is published only when the engine is willing to stand behind it.
  // `null`, never `0` — a zero renders to the customer as "terrible deal".
  const insufficient = recommendation.recommendation === 'INSUFFICIENT_DATA';
  const publishedScore = insufficient ? null : dealScore.score;
  const publishedBand = insufficient ? null : dealScore.band;

  // ── Reasons and caveats ────────────────────────────────────────────────
  const reasons = insufficient
    ? []
    : deriveReasons({
        currency: query.currency,
        currentNightlyMinor: current.nightlyMinor,
        typicalNightlyMinor: baseline?.p50 ?? null,
        pctBelowTypical: f1.pctBelowTypical,
        percentileRank: f1.percentileRank,
        lookbackDays: baseline?.lookbackDays ?? config.score.lookbackDays,
        nObservations: baseline?.nObservations ?? 0,
        lowestMinor: baseline?.min ?? null,
        pctVsCompMedian: f2.pctVsCompMedian,
        compCount: f2.compCount,
        compMedianMinor: f2.compMedianNightlyMinor,
        trendPct: f3.deltaPct,
        trendWindowDays: config.score.trend.windowDays,
        trendStartMinor: f3.windowStartNightlyMinor,
        seasonalIndex: f4.available ? f4.rawValue : null,
        demandPressure: f5.demandPressure,
        demandEvents: f5.events,
        benefitValuePerNightMinor: f6.benefitValuePerNightMinor,
        effectiveNightlyMinor: f6.effectiveNightlyMinor,
        benefitNames: f6.benefitNames,
      });

  const caveats = deriveCaveats({
    baselineLevel: baseline?.level ?? 'L4',
    nObservations: baseline?.nObservations ?? 0,
    minObsTarget: config.baseline.minObsTarget,
    volatilityCv: baseline?.cv ?? 0,
    volatilityCvMax: config.confidence.volatilityCvMax,
    rateAgeHours,
    maxCurrentAgeHours: config.rec.maxCurrentAgeHours,
    matchQuality,
    nSources: baseline?.nSources ?? 1,
    compCount: f2.compCount,
    minComps: config.score.market.minComps,
    leadTimeDays,
    minLeadDays: config.rec.wait.minLeadDays,
    insufficientReasons: recommendation.insufficientReasons,
  });

  // ── Assemble ───────────────────────────────────────────────────────────
  const baselineSummary: BaselineSummary = {
    level: baseline?.level ?? 'L4',
    nObservations: baseline?.nObservations ?? 0,
    lookbackDays: baseline?.lookbackDays ?? config.score.lookbackDays,
    typicalNightlyMinor: baseline?.p50 ?? null,
    p10Minor: baseline?.p10 ?? null,
    p90Minor: baseline?.p90 ?? null,
    lowestMinor: baseline?.min ?? null,
    highestMinor: baseline?.max ?? null,
    percentileRank: f1.percentileRank,
    pctBelowTypical: f1.pctBelowTypical,
  };

  const analysis: AnalysisResult = {
    query,
    dealScore: publishedScore,
    dealScoreBand: publishedBand,
    confidence: confidenceResult.confidence,
    confidenceBand: confidenceResult.band,
    recommendation: recommendation.recommendation,
    gateFired: recommendation.gateFired,
    waitBlockedBy: recommendation.waitBlockedBy,
    reasonCodes: reasons.map((r) => r.code),
    caveatCodes: caveats.map((c) => c.code),
    factors: dealScore.factors,
    confidenceFactors: confidenceResult.factors,
    baseline: baselineSummary,
    currentNightlyMinor: current.nightlyMinor,
    currentTotalMinor: current.totalMinor,
    effectiveNightlyMinor: f6.effectiveNightlyMinor,
    benefitValuePerNightMinor: f6.benefitValuePerNightMinor,
    dataAsOf: current.observedAt,
    configVersion: config.version,
    engineVersion: ENGINE_VERSION,
    decisionTrace: {
      gate: recommendation.gateFired,
      guards: recommendation.guards,
      insufficientReasons: recommendation.insufficientReasons,
      weightCoverage: dealScore.weightCoverage,
      rawDealScore: dealScore.score,
      leadTimeDays,
      matchQuality,
      volatilityFactor,
      rateAgeHours,
      trendPct: f3.deltaPct,
      demandPressure: f5.demandPressure,
      baselineLevelMultiplier: confidenceResult.baselineLevelMultiplier,
      completeness: confidenceResult.completeness,
      subjectIndex: f2.subjectIndex,
      marketIndex: f2.marketIndex,
      benefitCapped: f6.wasCapped,
    },
  };

  const bundle = buildExplanationBundle(
    analysis,
    reasons,
    caveats,
    config.explanation.maxSentences,
  );
  const explanation = renderTemplate(bundle, config.explanation.maxTemplateFactors);

  return { analysis, reasons, caveats, bundle, explanation };
}
