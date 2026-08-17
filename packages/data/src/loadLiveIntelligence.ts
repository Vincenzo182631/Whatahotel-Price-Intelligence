/**
 * Assembling the live-market intelligence for one stay.
 *
 * Reuses the existing hotel / room / current-rate selection so the live model
 * and the history model always describe the SAME subject — a divergence there
 * would show two different prices for one room on one page.
 *
 * Everything is read from stored observations. As elsewhere in this project the
 * API never calls a rate source synchronously on a page view; staleness is
 * handled by excluding rates rather than by fetching on demand.
 */

import {
  composeLiveScore,
  computeCalendarDelta,
  computeCompSetIndex,
  computeCompression,
  type CalendarResult,
  type CompSetResult,
  type CompressionResult,
  type LiveScoreResult,
  type ScoringConfig,
} from '@wahpi/core';

import type { Queryable } from './client.js';
import { findHotelByWahId, type HotelRow } from './repositories/hotels.js';
import { findAvailableRoomTypes, findCurrentRate } from './repositories/observations.js';
import {
  findCompetitorRates,
  findMarketCompression,
  findNearbyDateRates,
} from './repositories/liveContext.js';

export interface LiveRequest {
  readonly wahHotelId: string;
  readonly checkIn: string;
  readonly nights: number;
  readonly adults: number;
  readonly children: number;
  readonly currency: string;
  readonly roomTypeId?: number | null;
  readonly now?: Date;
}

export type LiveLoadFailure =
  { kind: 'HOTEL_NOT_FOUND' } | { kind: 'ROOM_TYPE_NOT_FOUND' } | { kind: 'NO_CURRENT_RATE' };

export interface LoadedLiveIntelligence {
  readonly hotel: HotelRow;
  readonly roomTypeId: number;
  readonly roomName: string;
  readonly roomSelectedBy: 'USER' | 'ENGINE';
  readonly comparabilityClass: string;
  readonly nightlyMinor: number;
  readonly totalMinor: number;
  readonly observedAt: string;
  readonly rateAgeHours: number;
  readonly result: LiveScoreResult;
  /** The signal detail, for explanation and debugging. */
  readonly compSet: CompSetResult;
  readonly calendar: CalendarResult;
  readonly compression: CompressionResult;
}

export function isLiveLoadFailure(
  value: LoadedLiveIntelligence | LiveLoadFailure,
): value is LiveLoadFailure {
  return (value as LiveLoadFailure).kind !== undefined;
}

export async function loadLiveIntelligence(
  request: LiveRequest,
  config: ScoringConfig,
  q?: Queryable,
): Promise<LoadedLiveIntelligence | LiveLoadFailure> {
  const now = request.now ?? new Date();

  const hotel = await findHotelByWahId(request.wahHotelId, q);
  if (!hotel) return { kind: 'HOTEL_NOT_FOUND' };

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

  const rateAgeHours = (now.getTime() - Date.parse(current.observedAt)) / 3_600_000;

  const live = config.live;

  // The three queries are independent, so they run together rather than in
  // sequence. On a page view this is the difference between one round trip and
  // three.
  const [competitors, neighbours, compressionInput] = await Promise.all([
    findCompetitorRates(
      hotel.id,
      request.checkIn,
      request.nights,
      request.adults,
      request.children,
      request.currency,
      chosen.comparabilityClass,
      // One more than needed, so a single stale comp does not drop the set
      // below the minimum.
      Math.max(live.csi.minComps + 3, 8),
      live.csi.maxCompAgeHours,
      q,
    ),
    findNearbyDateRates(
      hotel.id,
      chosen.roomTypeId,
      chosen.comparabilityClass,
      request.checkIn,
      request.nights,
      request.adults,
      request.children,
      request.currency,
      live.calendar.windowDays,
      live.csi.maxCompAgeHours,
      q,
    ),
    findMarketCompression(
      hotel.id,
      request.checkIn,
      request.nights,
      request.adults,
      Math.max(live.csi.minComps + 3, 8),
      // Deliberately the same freshness bound as the comp-set query: the two
      // signals must agree about which hotels are bookable.
      live.csi.maxCompAgeHours,
      q,
    ),
  ]);

  const compSet = computeCompSetIndex(current.nightlyMinor, competitors, config, now);
  const calendar = computeCalendarDelta(current.nightlyMinor, neighbours, config);
  const compression = computeCompression(compressionInput, config);

  return {
    hotel,
    roomTypeId: chosen.roomTypeId,
    roomName: chosen.canonicalName,
    roomSelectedBy: request.roomTypeId != null ? 'USER' : 'ENGINE',
    comparabilityClass: chosen.comparabilityClass,
    nightlyMinor: current.nightlyMinor,
    totalMinor: current.totalMinor,
    observedAt: current.observedAt,
    rateAgeHours,
    result: composeLiveScore(compSet, calendar, compression, rateAgeHours, config),
    compSet,
    calendar,
    compression,
  };
}
