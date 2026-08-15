export * from './types.js';
export * from './money.js';
export * from './stats.js';

export { DEFAULT_CONFIG, ENGINE_VERSION, WAIT_CONFIDENCE_HARD_FLOOR } from './config/defaults.js';
export type { ScoringConfig } from './config/defaults.js';
export {
  ConfigValidationError,
  assertValidConfig,
  validateConfig,
  withConfig,
} from './config/schema.js';
export type { DeepPartial } from './config/schema.js';

export { bandForScore, composeDealScore } from './scoring/dealScore.js';
export {
  computeF1,
  computeF2,
  computeF3,
  computeF4,
  computeF5,
  computeF6,
} from './scoring/factors.js';
export type { F1Result, F2Result, F3Result, F5Result, F6Result } from './scoring/factors.js';

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

export {
  WaitConfidenceViolation,
  assertWaitInvariant,
  evaluateGuards,
  recommend,
} from './recommendation/engine.js';
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
export { renderTemplate } from './explanation/template.js';
export type { RenderedExplanation } from './explanation/template.js';

export { analyze } from './analyze.js';
export type { AnalyzeOutput } from './analyze.js';
