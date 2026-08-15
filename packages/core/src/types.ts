/**
 * Domain types for the scoring engine.
 *
 * Everything the engine needs arrives as arguments. There is no database,
 * network, clock or filesystem access anywhere in `packages/core` — that is
 * what makes every scenario testable from fixtures and every stored score
 * reproducible. See docs/mvp/09-implementation-plan.md §2.
 */

import type { Currency, Minor } from './money.js';

export type { Currency, Minor, Money } from './money.js';

export type IsoDate = string; // YYYY-MM-DD
export type IsoDateTime = string; // RFC 3339, UTC

export type BaselineLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

export type MatchMethod =
  'SOURCE_ID' | 'ALIAS_EXACT' | 'ALIAS_FUZZY' | 'ATTRIBUTE_INFERRED' | 'UNMATCHED';

export type TaxBasis = 'NET' | 'GROSS' | 'UNKNOWN';

export type MealPlan =
  'ROOM_ONLY' | 'BREAKFAST' | 'HALF_BOARD' | 'FULL_BOARD' | 'ALL_INCLUSIVE' | 'UNKNOWN';

export type RefundPolicy = 'REFUNDABLE' | 'PARTIALLY_REFUNDABLE' | 'NON_REFUNDABLE' | 'UNKNOWN';

export type RateAudience = 'PUBLIC' | 'MEMBER' | 'CONSORTIA' | 'NEGOTIATED' | 'OPAQUE' | 'UNKNOWN';

export type RoomClass =
  'ROOM' | 'JUNIOR_SUITE' | 'SUITE' | 'VILLA' | 'RESIDENCE' | 'PENTHOUSE' | 'UNKNOWN';

export type BedConfig = 'KING' | 'QUEEN' | 'DOUBLE' | 'TWIN' | 'SINGLE' | 'MULTIPLE' | 'UNKNOWN';

export type ViewType =
  'OCEAN' | 'PARTIAL_OCEAN' | 'CITY' | 'GARDEN' | 'POOL' | 'MOUNTAIN' | 'INTERIOR' | 'UNKNOWN';

export type SeasonBand = 'LOW' | 'SHOULDER' | 'HIGH' | 'PEAK' | 'UNKNOWN';
export type DowBucket = 'WEEKDAY' | 'WEEKEND';

export const UNRESOLVED_CLASS = 'UNRESOLVED';
export type ComparabilityClass = string;

export type Recommendation = 'BOOK_NOW' | 'WAIT' | 'CONSIDER' | 'INSUFFICIENT_DATA';
export type ScoreBand = 'EXCELLENT' | 'GOOD' | 'FAIR' | 'BELOW_AVERAGE' | 'POOR';
export type ConfidenceBand = 'HIGH' | 'MODERATE' | 'LOW' | 'INSUFFICIENT';

/**
 * F5 (Demand) was removed from the Deal Score in config v2.
 *
 * It was an affine function of F1 — `score_F5 = (50 − 50D) + D · score_F1` —
 * so it contributed no independent information about price attractiveness and
 * its weight was effectively borrowed from F1. Demand still does real,
 * independent work in the never-WAIT guard W4 and the urgency gate G3; it just
 * no longer pretends to be a sixth scoring perspective.
 *
 * See docs/mvp/02-deal-score.md §3 and docs/mvp/11-calibration-tooling.md §5.
 */
export type FactorCode = 'F1' | 'F2' | 'F3' | 'F4' | 'F6';
export type GateCode = 'G0' | 'G2' | 'G3' | 'G4' | 'G5';
export type GuardCode = 'W1' | 'W2' | 'W3' | 'W4' | 'W5' | 'W6' | 'W7' | 'W8';

// ── Inputs ────────────────────────────────────────────────────────────────

export interface StayQuery {
  readonly hotelId: string;
  readonly hotelName: string;
  readonly roomTypeId: string;
  readonly roomTypeName: string;
  readonly comparabilityClass: ComparabilityClass;
  readonly checkIn: IsoDate;
  readonly nights: number;
  readonly adults: number;
  readonly children: number;
  readonly currency: Currency;
}

export interface CurrentRate {
  readonly nightlyMinor: Minor;
  readonly totalMinor: Minor;
  readonly observedAt: IsoDateTime;
  readonly taxBasis: TaxBasis;
  readonly refundable: boolean;
  readonly matchMethod: MatchMethod;
  readonly matchConfidence: number;
  readonly comparabilityClass: ComparabilityClass;
  readonly roomsLeft?: number | null;
  readonly onlyNonRefundableAvailable?: boolean;
}

/**
 * The historical distribution H(Q).
 *
 * `values` carries the trimmed observations when available (fixtures, and
 * queries served from raw facts). Production rollups supply only the summary
 * ladder; the engine interpolates in that case and behaves identically.
 */
export interface BaselineDistribution {
  readonly level: BaselineLevel;
  readonly nObservations: number;
  readonly nOutliersExcluded: number;
  readonly values?: readonly Minor[];
  readonly min: Minor;
  readonly p10: Minor;
  readonly p25: Minor;
  readonly p50: Minor;
  readonly p75: Minor;
  readonly p90: Minor;
  readonly max: Minor;
  readonly mean: Minor;
  readonly stddev: Minor;
  readonly cv: number;
  readonly meanMatchConfidence: number;
  readonly nSources: number;
  readonly crossSourceCv?: number | null;
  readonly unresolvedShare: number;
  readonly lookbackDays: number;
  readonly computedAt: IsoDateTime;
}

export interface SeriesPoint {
  readonly observedAt: IsoDateTime;
  readonly nightlyMinor: Minor;
}

export interface ComparableRate {
  readonly hotelId: string;
  readonly hotelName: string;
  readonly currentNightlyMinor: Minor;
  readonly baselineMedianMinor: Minor;
  readonly observedAt: IsoDateTime;
}

export interface SeasonalityInput {
  /** Median for this season band ÷ median across all bands. */
  readonly seasonalIndex: number;
  readonly historyDays: number;
  readonly seasonBand: SeasonBand;
}

export interface DemandEvent {
  readonly name: string;
  readonly impactScore: number;
}

export interface DemandInput {
  readonly events?: readonly DemandEvent[];
  readonly roomsLeft?: number | null;
  readonly compSoldOutShare?: number | null;
  readonly bookingVelocityPercentile?: number | null;
}

export interface BenefitValue {
  readonly code: string;
  readonly displayName: string;
  readonly basis: 'PER_NIGHT' | 'PER_STAY';
  readonly valueMinor: Minor;
  readonly realizationFactor: number;
}

export interface ScoringInput {
  readonly query: StayQuery;
  readonly current: CurrentRate;
  readonly baseline: BaselineDistribution | null;
  readonly series: readonly SeriesPoint[];
  readonly comparables: readonly ComparableRate[];
  readonly seasonality?: SeasonalityInput | null;
  readonly demand?: DemandInput | null;
  readonly benefits: readonly BenefitValue[];
  /** Injected rather than read from a clock, so the engine stays deterministic (P9). */
  readonly now: Date;
}

// ── Outputs ───────────────────────────────────────────────────────────────

export type FactorUnavailableReason =
  | 'NO_BASELINE'
  | 'INSUFFICIENT_OBSERVATIONS'
  | 'INSUFFICIENT_COMPARABLES'
  | 'INSUFFICIENT_SERIES_POINTS'
  | 'INSUFFICIENT_HISTORY'
  | 'NO_DEMAND_SIGNAL'
  | 'NO_BENEFITS';

export interface FactorResult {
  readonly code: FactorCode;
  readonly name: string;
  readonly available: boolean;
  readonly subScore: number | null;
  readonly rawValue: number | null;
  readonly unit: 'PERCENTILE' | 'PERCENT' | 'RATIO' | 'CURRENCY_MINOR' | 'SCORE' | null;
  readonly weight: number;
  readonly weightApplied: number;
  readonly unavailableReason: FactorUnavailableReason | null;
}

export interface ConfidenceFactorResult {
  readonly code: string;
  readonly name: string;
  readonly included: boolean;
  readonly value: number;
  readonly weight: number;
}

export interface ConfidenceResult {
  readonly confidence: number;
  readonly band: ConfidenceBand;
  readonly factors: readonly ConfidenceFactorResult[];
  readonly baselineLevelMultiplier: number;
  readonly completeness: number;
}

export interface DealScoreResult {
  readonly score: number | null;
  readonly band: ScoreBand | null;
  readonly factors: readonly FactorResult[];
  readonly weightCoverage: number;
}

export interface GuardResult {
  readonly code: GuardCode;
  readonly tripped: boolean;
  readonly detail: string;
}

export interface RecommendationResult {
  readonly recommendation: Recommendation;
  readonly gateFired: GateCode;
  readonly waitBlockedBy: readonly GuardCode[];
  readonly guards: readonly GuardResult[];
  readonly insufficientReasons: readonly string[];
}

export interface BaselineSummary {
  readonly level: BaselineLevel;
  readonly nObservations: number;
  readonly lookbackDays: number;
  readonly typicalNightlyMinor: Minor | null;
  readonly p10Minor: Minor | null;
  readonly p90Minor: Minor | null;
  readonly lowestMinor: Minor | null;
  readonly highestMinor: Minor | null;
  readonly percentileRank: number | null;
  readonly pctBelowTypical: number | null;
}

export interface AnalysisResult {
  readonly query: StayQuery;
  readonly dealScore: number | null;
  readonly dealScoreBand: ScoreBand | null;
  readonly confidence: number;
  readonly confidenceBand: ConfidenceBand;
  readonly recommendation: Recommendation;
  readonly gateFired: GateCode;
  readonly waitBlockedBy: readonly GuardCode[];
  readonly reasonCodes: readonly string[];
  readonly caveatCodes: readonly string[];
  readonly factors: readonly FactorResult[];
  readonly confidenceFactors: readonly ConfidenceFactorResult[];
  readonly baseline: BaselineSummary;
  readonly currentNightlyMinor: Minor;
  readonly currentTotalMinor: Minor;
  readonly effectiveNightlyMinor: Minor | null;
  readonly benefitValuePerNightMinor: Minor;
  readonly dataAsOf: IsoDateTime;
  readonly configVersion: number;
  readonly engineVersion: string;
  readonly decisionTrace: Readonly<Record<string, unknown>>;
}
