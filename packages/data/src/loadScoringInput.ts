/**
 * Assembles a ScoringInput from stored data.
 *
 * This is the seam between the database and the pure engine: everything the
 * engine needs is gathered here and handed over as plain values, including the
 * clock. Nothing below this line performs I/O.
 */

import type {
  MatchMethod,
  MealPlan,
  RateAudience,
  RefundPolicy,
  ScoringConfig,
  ScoringInput,
  TaxBasis,
} from '@wahpi/core';
import {
  classifyComparability,
  describeRateTerms,
  dowBucketFor,
  leadBucketFor,
  seasonBandFor,
} from '@wahpi/core';

import type { Queryable } from './client.js';
import { resolveBaseline } from './repositories/baselines.js';
import { findBenefits, findComparableRates, findDemand } from './repositories/context.js';
import { findHotelByWahId, type HotelRow } from './repositories/hotels.js';
import {
  findAvailableRoomTypes,
  findCurrentRate,
  findSameStaySeries,
  findSeriesGaps,
  type SeriesGap,
} from './repositories/observations.js';

export interface AnalysisRequest {
  readonly wahHotelId: string;
  readonly checkIn: string;
  readonly nights: number;
  readonly adults: number;
  readonly children: number;
  readonly currency: string;
  readonly roomTypeId?: number | null;
  readonly now?: Date;
}

export type LoadFailure =
  { kind: 'HOTEL_NOT_FOUND' } | { kind: 'ROOM_TYPE_NOT_FOUND' } | { kind: 'NO_CURRENT_RATE' };

export interface LoadedScoringInput {
  readonly input: ScoringInput;
  readonly hotel: HotelRow;
  readonly roomTypeId: number;
  readonly ratePlanId: number;
  readonly rateTerms: string;
  readonly roomSelectedBy: 'USER' | 'ENGINE';
  readonly seriesGaps: readonly SeriesGap[];
  readonly baselineRejected: ReadonlyArray<{ level: string; nObservations: number }>;
  readonly compCount: number;
}

export async function loadScoringInput(
  request: AnalysisRequest,
  config: ScoringConfig,
  q?: Queryable,
): Promise<LoadedScoringInput | LoadFailure> {
  const now = request.now ?? new Date();

  const hotel = await findHotelByWahId(request.wahHotelId, q);
  if (!hotel) return { kind: 'HOTEL_NOT_FOUND' };

  // Room selection: honour an explicit choice, otherwise take the cheapest
  // available room and report that we chose it (docs/mvp/08 §3A).
  const available = await findAvailableRoomTypes(
    hotel.id,
    request.checkIn,
    request.nights,
    request.adults,
    request.children,
    request.currency,
    q,
  );
  if (available.length === 0) return { kind: 'NO_CURRENT_RATE' };

  const chosen =
    request.roomTypeId != null
      ? available.find((r) => r.roomTypeId === request.roomTypeId)
      : available[0];
  if (!chosen) {
    return request.roomTypeId != null
      ? { kind: 'ROOM_TYPE_NOT_FOUND' }
      : { kind: 'NO_CURRENT_RATE' };
  }

  const stayKey = {
    hotelId: hotel.id,
    roomTypeId: chosen.roomTypeId,
    comparabilityClass: chosen.comparabilityClass,
    checkIn: request.checkIn,
    nights: request.nights,
    adults: request.adults,
    children: request.children,
    currency: request.currency,
  };

  const current = await findCurrentRate(stayKey, q);
  if (!current) return { kind: 'NO_CURRENT_RATE' };

  const nowDate = now.toISOString().slice(0, 10);
  const leadTimeDays = Math.round(
    (Date.parse(`${request.checkIn}T00:00:00Z`) - Date.parse(`${nowDate}T00:00:00Z`)) / 86_400_000,
  );

  const { distribution, rejected } = await resolveBaseline(
    {
      hotelId: hotel.id,
      roomTypeId: chosen.roomTypeId,
      comparabilityClass: chosen.comparabilityClass,
      currency: request.currency,
      seasonBand: seasonBandFor(request.checkIn),
      dowBucket: dowBucketFor(request.checkIn),
      leadBucket: leadBucketFor(leadTimeDays),
      lookbackDays: config.score.lookbackDays,
    },
    config.baseline.minObsAbs,
    config.baseline.minObsTarget,
    q,
  );

  const series = await findSameStaySeries(stayKey, config.score.lookbackDays, q);

  const comparables = await findComparableRates(
    hotel.id,
    request.checkIn,
    request.nights,
    request.adults,
    request.children,
    request.currency,
    Math.max(config.confidence.coverageTargetComps, config.score.market.minComps) + 3,
    config.rec.maxCurrentAgeHours,
    q,
  );

  const benefits = await findBenefits(hotel.id, current.ratePlanId, request.checkIn, q);
  const demand = await findDemand(
    hotel.destinationId,
    request.checkIn,
    request.nights,
    current.roomsLeft,
    q,
  );

  const terms = {
    mealPlan: current.mealPlan as MealPlan,
    refundPolicy: current.refundPolicy as RefundPolicy,
    audience: current.audience as RateAudience,
  };

  const input: ScoringInput = {
    query: {
      hotelId: hotel.wahHotelId,
      hotelName: hotel.name,
      roomTypeId: String(chosen.roomTypeId),
      roomTypeName: chosen.canonicalName,
      comparabilityClass: classifyComparability(terms).comparabilityClass,
      checkIn: request.checkIn,
      nights: request.nights,
      adults: request.adults,
      children: request.children,
      currency: request.currency,
    },
    current: {
      nightlyMinor: current.nightlyMinor,
      totalMinor: current.totalMinor,
      observedAt: current.observedAt,
      taxBasis: current.taxBasis as TaxBasis,
      refundable: current.refundPolicy === 'REFUNDABLE',
      matchMethod: current.matchMethod as MatchMethod,
      matchConfidence: current.matchConfidence,
      comparabilityClass: current.comparabilityClass,
      roomsLeft: current.roomsLeft,
      onlyNonRefundableAvailable: current.onlyNonRefundableAvailable,
    },
    baseline: distribution,
    series,
    comparables,
    // F4 stays unavailable until a destination seasonality calendar exists —
    // see docs/mvp/02 §3, F4. Wired here rather than silently omitted.
    seasonality: null,
    demand,
    benefits,
    now,
  };

  return {
    input,
    hotel,
    roomTypeId: chosen.roomTypeId,
    ratePlanId: current.ratePlanId,
    rateTerms: describeRateTerms(terms),
    roomSelectedBy: request.roomTypeId != null ? 'USER' : 'ENGINE',
    seriesGaps: findSeriesGaps(series, config.score.lookbackDays),
    baselineRejected: rejected,
    compCount: comparables.length,
  };
}

export function isLoadFailure(value: LoadedScoringInput | LoadFailure): value is LoadFailure {
  return 'kind' in value;
}
