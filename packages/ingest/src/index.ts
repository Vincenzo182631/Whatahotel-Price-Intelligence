export type { RateQuery, RateSourceAdapter, RawRateRecord } from './adapters/RateSourceAdapter.js';

export * from './adapters/whatahotel/index.js';
export * from './adapters/brave/index.js';

export {
  DEFAULT_SYNTHETIC_OPTIONS,
  SYNTHETIC_HOTELS,
  SYNTHETIC_RATE_PLANS,
  SYNTHETIC_SOURCE_CODE,
  createSyntheticAdapter,
  hashString,
  seededRandom,
  syntheticRate,
} from './adapters/synthetic/syntheticSource.js';
export type {
  RatePlanSpec,
  SyntheticHotel,
  SyntheticOptions,
  SyntheticRoom,
} from './adapters/synthetic/syntheticSource.js';

export {
  DEFAULT_INGEST_OPTIONS,
  ingestRecords,
  ingestStayKey,
  observationSlot,
  validateRecord,
} from './pipeline/pipeline.js';
export type { IngestOptions, IngestResult, RejectReason } from './pipeline/pipeline.js';

export {
  DEFAULT_ENROLL_OPTIONS,
  discoverCityComparables,
  enrollHotel,
  ensureDestinationDepth,
} from './pipeline/enrollHotel.js';
export type { EnrollOptions, EnrollOutcome, EnrollResult } from './pipeline/enrollHotel.js';

export {
  DEFAULT_ON_DEMAND_OPTIONS,
  GUEST_UPSTREAM,
  collectStayOnDemand,
  leadDaysOf,
  planOnDemandQueries,
  topUpComparablesOnDemand,
} from './pipeline/onDemand.js';
export type {
  OnDemandOptions,
  OnDemandResult,
  OnDemandSkipReason,
  OnDemandStay,
} from './pipeline/onDemand.js';
export { syncHotelAmenities } from './pipeline/amenities.js';
export { purgeSharedWebsites, researchHotel } from './pipeline/research.js';
export type {
  PurgeDeps,
  PurgedWebsite,
  ResearchDeps,
  ResearchOutcome,
  ResearchResult,
} from './pipeline/research.js';
export type {
  AmenitySyncDeps,
  AmenitySyncOutcome,
  AmenitySyncResult,
} from './pipeline/amenities.js';
export { parseInfo, fetchHotelInfo, fetchHotelInfoById } from './adapters/whatahotel/info.js';
export type { InfoAmenity, ParsedInfo } from './adapters/whatahotel/info.js';

export { sweepPlaces } from './pipeline/resolvePlaces.js';
export type { PlaceSweepOptions, PlaceSweepResult } from './pipeline/resolvePlaces.js';

export { PlacesClient } from './adapters/google/places.js';
export type { PlaceReputation, PlacesClientOptions } from './adapters/google/places.js';
export {
  addressCanConfirm,
  addressConfirms,
  bestMatch,
  distanceKm,
  normalizeName,
  scoreMatch,
} from './adapters/google/match.js';
export type { HotelIdentity, MatchScore, PlaceCandidate } from './adapters/google/match.js';
export { resolveHotel, searchQuery } from './adapters/google/resolve.js';
export type { Resolution, ResolutionOutcome, ResolvableHotel } from './adapters/google/resolve.js';
export {
  googleConfigured,
  googleSettings,
  openAiConfigured,
  openAiSettings,
} from './adapters/google/settings.js';
export type { GoogleSettings, OpenAiSettings } from './adapters/google/settings.js';

export { OpenAiReasoner, bundleKey, explainLive } from './adapters/openai/reasoner.js';
export type {
  ExplanationSource,
  LiveExplanation,
  ReasonerOptions,
} from './adapters/openai/reasoner.js';

export { ensureRollupFunctions, refreshBaselines } from './rollup/baseline.js';
export type { RollupOptions, RollupResult } from './rollup/baseline.js';

export {
  COMPARABLE_BASIS,
  DEFAULT_COMPARABLE_OPTIONS,
  rebuildComparables,
  similarityBetween,
} from './comparables/builder.js';
export type { ComparableBuildOptions, ComparableBuildResult } from './comparables/builder.js';

export {
  DEFAULT_SCHEDULER_OPTIONS,
  intervalHoursFor,
  isDue,
  planCollection,
  tierFor,
} from './scheduler/tiers.js';
export { mergeTasks } from './scheduler/merge.js';
export type { MergeOptions, MergedPlan } from './scheduler/merge.js';
export type { CollectionTask, CollectionTier, SchedulerOptions } from './scheduler/tiers.js';
