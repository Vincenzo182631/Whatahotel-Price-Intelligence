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
  describeRateTerms,
  computeCalendarDelta,
  computeCompSetIndex,
  computeCompression,
  compMatchStrength,
  unknownDimensions,
  type CalendarResult,
  type CompSetResult,
  type CompressionResult,
  type LiveScoreResult,
  type MealPlan,
  type RateAudience,
  type RefundPolicy,
  type ScoringConfig,
  type TaxBasis,
} from '@wahpi/core';

import type { Queryable } from './client.js';
import { findHotelByWahId, hasCuratedComparables, type HotelRow } from './repositories/hotels.js';
import {
  findAvailableRoomTypes,
  findCurrentRate,
  findQuotedCurrency,
} from './repositories/observations.js';
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
  /**
   * Null means "whatever this hotel is quoted in", which is the right default
   * for a widget that runs on every hotel page in the world. Pin it only when
   * the caller genuinely requires one currency and would rather see nothing
   * than a rate in another.
   */
  readonly currency: string | null;
  readonly roomTypeId?: number | null;
  readonly now?: Date;
}

export type LiveLoadFailure =
  { kind: 'HOTEL_NOT_FOUND' } | { kind: 'ROOM_TYPE_NOT_FOUND' } | { kind: 'NO_CURRENT_RATE' };

/**
 * Where the comp set came from. `CURATED` is the ranked peer set built from
 * accrued baselines; `DESTINATION` is the nearest same-destination hotels, used
 * before a destination has enough history to rank. Published rather than
 * hidden: a city-wide comparison must never be presented as a peer one.
 */
export type CompBasis = 'CURATED' | 'DESTINATION';

/** One room a guest could pick for this stay, with what it costs. */
export interface RoomOption {
  readonly roomTypeId: number;
  readonly name: string;
  readonly roomClass: string;
  readonly nightlyMinor: number;
}

export interface LoadedLiveIntelligence {
  readonly hotel: HotelRow;
  /**
   * Every room type with a live rate for this exact stay, cheapest first.
   *
   * The loader already had to build this list to choose a room; it was thrown
   * away, so a client could only ever show the engine's pick. Publishing it is
   * what lets a guest ask about the room they actually want — and the score
   * that comes back is genuinely recomputed for it, because the comp set, the
   * nearby-date series and the terms match all key off the chosen room.
   */
  readonly availableRooms: readonly RoomOption[];
  /** The currency everything in this result is denominated in. */
  readonly currency: string;
  readonly compBasis: CompBasis;
  readonly roomTypeId: number;
  readonly roomName: string;
  readonly roomSelectedBy: 'USER' | 'ENGINE';
  readonly comparabilityClass: string;
  /**
   * Human-readable rate terms. Mandatory in the UI, not optional detail: a
   * customer must be able to see WHICH product was assessed, or the assessment
   * may not apply to the one they book (docs/mvp/08 §H).
   */
  readonly rateTerms: string;
  /**
   * The basis of `totalMinor`. `nightlyMinor` is ALWAYS the base room rate
   * before taxes and fees, so the two are reported separately on screen —
   * one label describing both would be wrong about one of them.
   */
  readonly taxBasis: TaxBasis;
  /** ADR: base room rate per night, excluding taxes and fees. */
  readonly nightlyMinor: number;
  /** The whole-stay total the customer pays. Unchanged by the ADR fix. */
  readonly totalMinor: number;
  readonly taxesFeesMinor: number | null;
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

  // See findQuotedCurrency: the source prices in the hotel's local currency,
  // so an unpinned request is answered in it rather than in an assumed USD.
  const currency = request.currency ?? (await findQuotedCurrency(hotel.id, q)) ?? 'USD';

  const available = await findAvailableRoomTypes(
    hotel.id,
    request.checkIn,
    request.nights,
    request.adults,
    request.children,
    currency,
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
    currency,
  };

  const current = await findCurrentRate(stayKey, q);
  if (!current) return { kind: 'NO_CURRENT_RATE' };

  const rateAgeHours = (now.getTime() - Date.parse(current.observedAt)) / 3_600_000;

  const live = config.live;

  // The three queries are independent, so they run together rather than in
  // sequence. On a page view this is the difference between one round trip and
  // three.
  // The comparison key, and how much of it the source actually stated. Both
  // derive from the chosen rate's own terms, so a caller cannot get a strength
  // that disagrees with the match that produced it.
  const subjectTerms = {
    mealPlan: chosen.mealPlan,
    refundPolicy: chosen.refundPolicy,
    audience: chosen.audience,
  };
  const matchTerms = {
    mealPlan: chosen.mealPlan as MealPlan,
    refundPolicy: chosen.refundPolicy as RefundPolicy,
    audience: chosen.audience as RateAudience,
  };

  const compLimit = Math.max(live.csi.minComps + 3, 8);

  const [curatedCompetitors, neighbours, curatedCompression] = await Promise.all([
    findCompetitorRates(
      hotel.id,
      request.checkIn,
      request.nights,
      request.adults,
      request.children,
      currency,
      // Terms, not the class: the class is hotel-specific and can never match
      // a competitor. See findCompetitorRates and normalize/compMatch.ts.
      subjectTerms,
      // One more than needed, so a single stale comp does not drop the set
      // below the minimum.
      compLimit,
      live.csi.maxCompAgeHours,
      false,
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
      currency,
      live.calendar.windowDays,
      live.csi.maxCompAgeHours,
      q,
    ),
    findMarketCompression(
      hotel.id,
      request.checkIn,
      request.nights,
      request.adults,
      compLimit,
      // Deliberately the same freshness bound as the comp-set query: the two
      // signals must agree about which hotels are bookable.
      live.csi.maxCompAgeHours,
      false,
      q,
    ),
  ]);

  /**
   * A curated comp set that yields too few USABLE rates falls back, exactly as
   * an empty one does.
   *
   * "Curated set exists" was the wrong trigger. Existing and useless is the
   * worse case and it was the one left unhandled: hotel 1198 held a ranked
   * comp set that produced 0 usable rates on three separate stays, so the
   * index — 45% of the live score — was permanently unavailable in our
   * best-collected destination. The on-demand top-up could not rescue it
   * either; it fetched 128 competitor rates and inserted none, because every
   * one was already stored and none matched the subject's terms. The pool was
   * wrong, not stale.
   *
   * Only widen when it would actually help. If the destination yields no more
   * than the curated set did, the curated answer stands, and the basis keeps
   * saying CURATED — reporting a fallback that changed nothing would be a
   * false admission of weaker evidence.
   */
  const hadCurated = await hasCuratedComparables(hotel.id, q);
  let competitors = curatedCompetitors;
  let compressionInput = curatedCompression;
  let compBasis: CompBasis = hadCurated ? 'CURATED' : 'DESTINATION';

  if (hadCurated && competitors.length < live.csi.minComps) {
    const [widened, widenedCompression] = await Promise.all([
      findCompetitorRates(
        hotel.id,
        request.checkIn,
        request.nights,
        request.adults,
        request.children,
        currency,
        subjectTerms,
        compLimit,
        live.csi.maxCompAgeHours,
        true,
        q,
      ),
      findMarketCompression(
        hotel.id,
        request.checkIn,
        request.nights,
        request.adults,
        compLimit,
        live.csi.maxCompAgeHours,
        true,
        q,
      ),
    ]);
    if (widened.length > competitors.length) {
      competitors = widened;
      // Compression must describe the same market the comp set does.
      compressionInput = widenedCompression;
      compBasis = 'DESTINATION';
    }
  }

  const compSet = computeCompSetIndex(current.nightlyMinor, competitors, config, now, {
    strength: compMatchStrength(matchTerms),
    unknown: unknownDimensions(matchTerms),
  });
  const calendar = computeCalendarDelta(current.nightlyMinor, neighbours, config);
  const compression = computeCompression(compressionInput, config);

  return {
    hotel,
    availableRooms: available.map((r) => ({
      roomTypeId: r.roomTypeId,
      name: r.canonicalName,
      roomClass: r.roomClass,
      nightlyMinor: r.nightlyMinor,
    })),
    currency,
    compBasis,
    roomTypeId: chosen.roomTypeId,
    roomName: chosen.canonicalName,
    roomSelectedBy: request.roomTypeId != null ? 'USER' : 'ENGINE',
    comparabilityClass: chosen.comparabilityClass,
    rateTerms: describeRateTerms({
      mealPlan: current.mealPlan as MealPlan,
      refundPolicy: current.refundPolicy as RefundPolicy,
      audience: current.audience as RateAudience,
    }),
    taxBasis: current.taxBasis,
    nightlyMinor: current.nightlyMinor,
    totalMinor: current.totalMinor,
    taxesFeesMinor: current.taxesFeesMinor,
    observedAt: current.observedAt,
    rateAgeHours,
    result: composeLiveScore(compSet, calendar, compression, rateAgeHours, config),
    compSet,
    calendar,
    compression,
  };
}
