export { closePool, db, getPool, withTransaction } from './client.js';
export type { Pool, PoolClient, Queryable } from './client.js';

export {
  findComparableIdentities,
  findHotelByWahId,
  hasCuratedComparables,
  listRoomTypes,
  listSiblingRoomTypeIds,
  promoteHotelForCollection,
  searchHotels,
} from './repositories/hotels.js';
export type { HotelRow, HotelSearchResult, RoomTypeRow } from './repositories/hotels.js';

export {
  findAvailableRates,
  findAvailableRoomTypes,
  findCurrentRate,
  findQuotedCurrency,
  findSameStaySeries,
  findSeriesGaps,
} from './repositories/observations.js';
export type {
  AvailableRateRow,
  CurrentRateRow,
  SeriesGap,
  StayKey,
} from './repositories/observations.js';

export {
  baselineMedianFor,
  countStaleBaselines,
  resolveBaseline,
  upsertBaseline,
  upsertBaselines,
} from './repositories/baselines.js';
export type { BaselineLookup, BaselineUpsert } from './repositories/baselines.js';

export {
  DEFAULT_GRID_SPEC,
  GRID_COVERAGE_TOLERANCE_DAYS,
  backoffHours,
  countRecentAttempts,
  findMissingGridStays,
  gridLeadDays,
  planGridTopUp,
  recordCollectionAttempts,
  wasStayRecentlyFruitless,
} from './repositories/collection.js';
export type { AttemptOutcome, GridSpec, GridStay } from './repositories/collection.js';

export {
  findResolutionTargets,
  findVerifiedReputations,
  findVerifiedReputationsByWahIds,
  saveResolution,
} from './repositories/reputation.js';
export type {
  HotelReputation,
  ResolutionResult,
  ResolutionTarget,
} from './repositories/reputation.js';

export {
  findCompetitorRates,
  findMarketCompression,
  findNearbyDateRates,
} from './repositories/liveContext.js';

export { isLiveLoadFailure, loadLiveIntelligence } from './loadLiveIntelligence.js';
export type {
  CompBasis,
  CompRoomMatch,
  LiveLoadFailure,
  LiveRequest,
  LoadedLiveIntelligence,
  RateOption,
  RoomOption,
} from './loadLiveIntelligence.js';

export {
  findBenefits,
  findComparableRates,
  findDemand,
  upsertComparables,
} from './repositories/context.js';

export {
  clearConfigCache,
  findAnalysisByPublicId,
  loadActiveConfig,
  newPublicId,
  persistAnalysis,
} from './repositories/analyses.js';
export type { PersistAnalysisInput } from './repositories/analyses.js';

export { isLoadFailure, loadScoringInput } from './loadScoringInput.js';
export type { AnalysisRequest, LoadedScoringInput, LoadFailure } from './loadScoringInput.js';
