export * from './types.js';
export * from './money.js';
export * from './stats.js';

export { DEFAULT_CONFIG, ENGINE_VERSION } from './config/defaults.js';
export type { ScoringConfig } from './config/defaults.js';
export {
  ConfigValidationError,
  assertValidConfig,
  validateConfig,
  withConfig,
} from './config/schema.js';
export type { DeepPartial } from './config/schema.js';

export {
  ABBREVIATIONS,
  FILLER_WORDS,
  looksLikeOfferProse,
  normalizeRoomName,
  trigramSimilarity,
  trigrams,
} from './normalize/text.js';
export {
  extractAttributes,
  roomClassesCompatible,
  viewsCompatible,
} from './normalize/attributes.js';
export type { RoomAttributes } from './normalize/attributes.js';
export { compMatchKey, compMatchStrength, unknownDimensions } from './normalize/compMatch.js';
export type { CompMatchStrength, CompMatchTerms } from './normalize/compMatch.js';
export { matchRoomType } from './normalize/roomType.js';
export type { MatchOptions, RoomTypeCandidate, RoomTypeMatch } from './normalize/roomType.js';
export {
  ALL_COMPARABILITY_CLASSES,
  audienceGroup,
  classifyComparability,
  describeRateTerms,
  mealPlanGroup,
  refundGroup,
} from './normalize/ratePlan.js';
export type {
  AudienceGroup,
  ComparabilityResult,
  MealPlanGroup,
  RatePlanTerms,
  RefundGroup,
} from './normalize/ratePlan.js';

export { buildDistribution } from './baseline/distribution.js';
export type { BuildDistributionOptions, DistributionObservation } from './baseline/distribution.js';
export {
  BASELINE_LEVELS,
  LEAD_BUCKETS,
  LEVEL_STRATA,
  dowBucketFor,
  leadBucketFor,
  seasonBandFor,
  selectBaselineLevel,
} from './baseline/ladder.js';
export type {
  LadderCandidate,
  LadderSelection,
  LeadBucket,
  LevelStrata,
} from './baseline/ladder.js';

export { bandForScore, composeDealScore } from './scoring/dealScore.js';

// ── the live-market model (no history, no prediction) ──────────────────────
export {
  computeCalendarDelta,
  computeCompSetIndex,
  computePremiumJustification,
  computeCompression,
} from './scoring/liveSignals.js';
export type {
  CalendarBand,
  CalendarResult,
  CompSetResult,
  CompTermsBasis,
  CompetitorRate,
  PremiumConfidence,
  PremiumJustificationResult,
  PremiumLevel,
  CompressionBand,
  CompressionInput,
  CompressionResult,
  CsiBand,
  LiveSignal,
  LiveSignalCode,
  LiveSignalUnavailableReason,
  NearbyDateRate,
} from './scoring/liveSignals.js';
export {
  SCORE_DISPLAY_FLOOR,
  applyScoreDisplayFloor,
  assessLiveConfidence,
  composeLiveScore,
  liveBandLabel,
  liveVerdictLabel,
} from './scoring/liveScore.js';
export type {
  LiveBand,
  LiveConfidence,
  LiveScoreResult,
  LiveVerdict,
} from './scoring/liveScore.js';
export {
  computeDemandPressure,
  computeF1,
  computeF2,
  computeF3,
  computeF4,
  computeF6,
} from './scoring/factors.js';
export type { DemandSignal, F1Result, F2Result, F3Result, F6Result } from './scoring/factors.js';

export {
  bandForConfidence,
  computeConfidence,
  fConsistency,
  fCoverage,
  fFreshness,
  fMatch,
  fVolatility,
  fVolume,
} from './confidence/confidence.js';
export type { ConfidenceInput } from './confidence/confidence.js';

export { recommend } from './recommendation/engine.js';
export type { RecommendationInput } from './recommendation/engine.js';

export { deriveCaveats, deriveReasons } from './explanation/reasonCodes.js';
export type {
  CaveatFact,
  CaveatInputs,
  ReasonDirection,
  ReasonFact,
  ReasonInputs,
  ReasonUnit,
} from './explanation/reasonCodes.js';
export { BUNDLE_VERSION, buildExplanationBundle } from './explanation/bundle.js';
export type { ExplanationBundle } from './explanation/bundle.js';
export {
  PREDICTIVE_VOCABULARY,
  containsPredictiveLanguage,
  findPredictiveLanguage,
} from './explanation/predictive.js';
export { renderTemplate } from './explanation/template.js';
export type { RenderedExplanation } from './explanation/template.js';
export { LIVE_BUNDLE_VERSION, buildLiveExplanationBundle } from './explanation/liveBundle.js';
export type {
  LiveBundleInput,
  LiveExplanationBundle,
  ReputationFact,
} from './explanation/liveBundle.js';
export { renderLiveExplanation } from './explanation/liveTemplate.js';
export type { RenderedLiveExplanation } from './explanation/liveTemplate.js';
export { validateNarrative } from './explanation/validate.js';
export {
  ASSESSMENT_EVIDENCE,
  availabilityContextSentence,
  deterministicAssessment,
  evidenceConfidence,
  evidencePresent,
  premiumJustificationSummary,
  premiumPosition,
  validateAssessment,
} from './explanation/assessment.js';
export type {
  AssessmentConfidence,
  AssessmentEvidence,
  AssessmentLevel,
  AssessmentValidation,
  PremiumAssessment,
  PremiumPosition,
} from './explanation/assessment.js';
export {
  HOTEL_VALUE_EVIDENCE,
  THEME_PROSE,
  deterministicHotelValue,
  hotelValueConfidence,
  hotelValueEvidencePresent,
  supportingSignals,
  validateHotelValue,
} from './explanation/hotelValue.js';
export type {
  HotelValue,
  HotelValueEvidence,
  HotelValueValidation,
} from './explanation/hotelValue.js';
export { PREFERENCES, PREFERENCE_LABEL, parsePreference } from './explanation/preference.js';
export type { Preference } from './explanation/preference.js';
export {
  deterministicPersonalization,
  validatePersonalization,
} from './explanation/personalization.js';
export type { Personalization, PersonalizationValidation } from './explanation/personalization.js';
export {
  assessAvailabilityPosition,
  chooseAlternative,
  chooseRoomUpgrade,
  chooseSuperiorAlternative,
  isProtectedBrand,
} from './scoring/valueAlternative.js';
export type {
  AlternativeCandidate,
  AvailabilityPosition,
  AvailableCategory,
  RoomUpgrade,
  SuperiorAlternative,
  SuperiorCandidate,
  ValueAlternative,
} from './scoring/valueAlternative.js';
export type { NarrativeConstraints, ValidationResult } from './explanation/validate.js';

export { analyze } from './analyze.js';
export type { AnalyzeOutput } from './analyze.js';
