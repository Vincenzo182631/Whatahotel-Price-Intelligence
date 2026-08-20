export {
  WHATAHOTEL_INGEST_TUNING,
  WHATAHOTEL_SOURCE_CODE,
  createWhataHotelAdapter,
  toRecords,
} from './adapter.js';
export type { WhataHotelAdapterOptions } from './adapter.js';

export { WahClient, redact } from './client.js';
export type { WahClientOptions } from './client.js';

export {
  comparabilityClassFor,
  offerSlugFor,
  parseHotel,
  parseMoney,
  parsePerk,
  parsePerks,
  parseRateTerms,
  parseRoom,
  parseRoomDesc,
  sourcePlanCodeFor,
} from './parse.js';

export { parseLenientJson, stripTrailingCommas } from './json.js';
export type { LenientParseResult } from './json.js';
export type { ParsedHotel, ParsedMoney, ParsedPerk, ParsedRatePlan, ParsedRoom } from './parse.js';

export {
  DEFAULT_SWEEP_OPTIONS,
  cityStartingRates,
  ensureWhataHotelSource,
  highestKnownHotelId,
  sweepCatalog,
  syncHotelById,
  syncHotelsFromCity,
  syncHotelsFromSearch,
} from './catalog.js';
export type {
  CatalogSweepOptions,
  CatalogSweepResult,
  CatalogSyncResult,
  NewHotelTier,
} from './catalog.js';

export { WAH_NO_AVAILABILITY_CODE, WahApiError } from './types.js';
export type { WahHotel, WahRatesResponse, WahRoom, WahStatus } from './types.js';
