export type { RateQuery, RateSourceAdapter, RawRateRecord } from './adapters/RateSourceAdapter.js';

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
  observationSlot,
  validateRecord,
} from './pipeline/pipeline.js';
export type { IngestOptions, IngestResult, RejectReason } from './pipeline/pipeline.js';

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
export type { CollectionTask, CollectionTier, SchedulerOptions } from './scheduler/tiers.js';
