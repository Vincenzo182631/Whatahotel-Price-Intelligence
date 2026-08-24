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
  computePremiumJustification,
  computeCompression,
  compMatchStrength,
  unknownDimensions,
  type CalendarResult,
  type CompSetResult,
  type PremiumJustificationResult,
  type CompressionResult,
  type LiveScoreResult,
  type MealPlan,
  type RateAudience,
  type RefundPolicy,
  type ScoringConfig,
  type TaxBasis,
  assessAvailabilityPosition,
} from '@wahpi/core';

import type { Queryable } from './client.js';
import { findBenefits } from './repositories/context.js';
import {
  findHotelByWahId,
  hasCuratedComparables,
  listRoomTypes,
  type HotelRow,
} from './repositories/hotels.js';
import {
  findAvailableRates,
  findAvailableRoomTypes,
  findCurrentRate,
  findQuotedCurrency,
  resolveRoomCode,
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
  /**
   * A specific rate plan for the chosen room — the `rate_id` a client read
   * from `rate_options`. Null/absent means the cheapest plan, which is the
   * behaviour every request had before rate selection existed.
   */
  readonly rateId?: string | null;
  /**
   * The SOURCE's booking code for one priced row ("E1KBB0") — the identity
   * a whatahotel.com page actually holds. Resolves to our room and rate;
   * explicit roomTypeId/rateId win when also given. An unresolvable code
   * degrades to the engine's pick rather than failing: the page still gets
   * an answer, and `roomCodeMatch` says what happened.
   */
  readonly roomCode?: string | null;
  readonly now?: Date;
}

export type LiveLoadFailure =
  | { kind: 'HOTEL_NOT_FOUND' }
  | { kind: 'ROOM_TYPE_NOT_FOUND' }
  | { kind: 'RATE_NOT_FOUND' }
  | { kind: 'NO_CURRENT_RATE' };

/**
 * Where the comp set came from. `CURATED` is the ranked peer set built from
 * accrued baselines; `DESTINATION` is the nearest same-destination hotels, used
 * before a destination has enough history to rank. Published rather than
 * hidden: a city-wide comparison must never be presented as a peer one.
 */
export type CompBasis = 'CURATED' | 'DESTINATION';

/**
 * How closely the competitors' ROOMS match the one being scored.
 *
 * `CLASS_AND_VIEW` is a genuine like-for-like: an ocean-view suite measured
 * against other ocean-view suites. `CLASS` drops the view. `ANY` is the old
 * behaviour — whatever room each competitor sells on matching terms, usually
 * their cheapest — which is the only thing available in a market where nobody
 * else sells that category, and must be disclosed rather than presented as
 * equivalence. Never fabricate an equivalent room: report the rung.
 */
export type CompRoomMatch = 'CLASS_AND_VIEW' | 'CLASS' | 'ANY';

/** One room a guest could pick for this stay, with what it costs. */
export interface RoomOption {
  readonly roomTypeId: number;
  readonly name: string;
  readonly roomClass: string;
  readonly nightlyMinor: number;
}

/** One rate plan a guest could pick for the chosen room. */
export interface RateOption {
  /** Opaque to clients; pass back as `rate_id` to select this plan. */
  readonly rateId: string;
  /** The offer's name, or a description built from its stated terms. */
  readonly name: string;
  readonly refundPolicy: string;
  readonly nightlyMinor: number;
  readonly totalMinor: number;
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
  /**
   * The source ids of the competitors the comparison actually used.
   *
   * Their PRICES are deliberately not returned — another hotel's commercial
   * data — but their identities are what lets a caller attach context we hold
   * about them, such as a guest rating.
   */
  readonly competitorWahIds: readonly string[];
  /**
   * The comparables' current rates, for the alternative chooser ONLY. The
   * API never publishes this list — one chosen alternative is a product
   * feature, the full priced roster is other hotels' commercial data.
   */
  readonly competitorRates: readonly {
    readonly wahHotelId: string;
    readonly name: string;
    readonly nightlyMinor: number;
    readonly isAvailable: boolean;
  }[];
  /** Where the selected rate sits in currently available inventory. */
  readonly availability: {
    readonly position: 'ENTRY' | 'MID' | 'TOP' | null;
    readonly availableCategories: number;
    readonly cheaperCategoriesAvailable: number;
    readonly entryClassAvailable: boolean;
    readonly lowerCategoriesUnavailable: boolean;
    readonly availabilityInfluenced: boolean;
  };
  readonly compRoomMatch: CompRoomMatch;
  /** Is the price premium supported by what the rate includes? */
  readonly premium: PremiumJustificationResult;
  /**
   * The hotel's perk inclusions by their curated display names — the
   * source's own preferred-partner benefits ("Breakfast for two", "Hotel
   * credit"). Verified WhataHotel data, for the hotel-value evidence; the
   * VALUES already feed premium justification above.
   */
  readonly benefitNames: readonly string[];
  readonly roomTypeId: number;
  readonly roomName: string;
  /**
   * The chosen room's view category ('OCEAN', 'CITY', …), or null when the
   * normalizer resolved none. The only physical room attribute the source
   * states, published for the personalization layer — nothing in scoring
   * reads it from here.
   */
  readonly roomViewType: string | null;
  readonly roomSelectedBy: 'USER' | 'ENGINE';
  /**
   * Every rate plan bookable for the CHOSEN room on this stay, cheapest
   * first. The room list surfaces each room's cheapest plan; this is how a
   * guest picks the flexible offer over the cheapest one and gets the whole
   * answer — price, score, comparison, booking link — recomputed for it.
   */
  readonly rateOptions: readonly RateOption[];
  /** How a request's room_code fared: RESOLVED, NOT_FOUND, or null (none sent). */
  readonly roomCodeMatch: 'RESOLVED' | 'NOT_FOUND' | null;
  readonly selectedRateId: string;
  readonly rateSelectedBy: 'USER' | 'ENGINE';
  /**
   * The source's booking identifiers for the SELECTED rate, read from the
   * capture itself. Null when the capture did not state them — a booking
   * link is then not offered rather than guessed.
   */
  readonly booking: { readonly roomCode: string; readonly rateCode: string } | null;
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

  // The source's own booking code, resolved to our identity. Explicit ids
  // win; a code that resolves fills BOTH the room and the rate, because a
  // bookCode names one priced row.
  let effectiveRoomTypeId = request.roomTypeId ?? null;
  let effectiveRateId = request.rateId ?? null;
  let roomCodeMatch: 'RESOLVED' | 'NOT_FOUND' | null = null;
  if (request.roomCode) {
    const resolved = await resolveRoomCode(
      hotel.id,
      request.checkIn,
      request.nights,
      request.adults,
      request.children,
      currency,
      request.roomCode,
      q,
    );
    roomCodeMatch = resolved ? 'RESOLVED' : 'NOT_FOUND';
    if (resolved) {
      if (effectiveRoomTypeId === null) effectiveRoomTypeId = resolved.roomTypeId;
      if (effectiveRateId === null) effectiveRateId = resolved.comparabilityClass;
    }
  }

  const chosen =
    effectiveRoomTypeId != null
      ? available.find((r) => r.roomTypeId === effectiveRoomTypeId)
      : available[0];
  if (!chosen) {
    // An explicit id the caller stated is a hard miss; a room-code miss
    // already degraded to the engine pick above, so only the explicit case
    // reaches here.
    return request.roomTypeId != null
      ? { kind: 'ROOM_TYPE_NOT_FOUND' }
      : { kind: 'NO_CURRENT_RATE' };
  }

  // Every plan bookable for the chosen room. The room list surfaced the
  // cheapest; a rate_id request picks another, and everything downstream —
  // the stay key, the terms match, the score — keys on the plan the guest
  // actually selected rather than on the cheapest one.
  const rateRows = await findAvailableRates(
    hotel.id,
    chosen.roomTypeId,
    request.checkIn,
    request.nights,
    request.adults,
    request.children,
    currency,
    q,
  );
  let selectedRate =
    effectiveRateId != null
      ? rateRows.find((r) => r.comparabilityClass === effectiveRateId)
      : (rateRows.find((r) => r.comparabilityClass === chosen.comparabilityClass) ?? rateRows[0]);
  if (!selectedRate) {
    // Same asymmetry as the room: only an EXPLICIT rate_id may hard-fail.
    // A rate that arrived via room_code resolution falls back to the
    // room's cheapest plan rather than failing the page.
    if (request.rateId != null) return { kind: 'RATE_NOT_FOUND' };
    selectedRate =
      rateRows.find((r) => r.comparabilityClass === chosen.comparabilityClass) ?? rateRows[0];
    if (!selectedRate) return { kind: 'NO_CURRENT_RATE' };
  }

  const stayKey = {
    hotelId: hotel.id,
    roomTypeId: chosen.roomTypeId,
    comparabilityClass: selectedRate.comparabilityClass,
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
  // The SELECTED rate's terms, not the room list's cheapest-plan terms: a
  // guest who picked the flexible offer must be compared on that offer.
  const subjectTerms = {
    mealPlan: current.mealPlan,
    refundPolicy: current.refundPolicy,
    audience: current.audience,
  };
  const matchTerms = {
    mealPlan: current.mealPlan as MealPlan,
    refundPolicy: current.refundPolicy as RefundPolicy,
    audience: current.audience as RateAudience,
  };

  const compLimit = Math.max(live.csi.minComps + 3, 8);

  /**
   * Competitors, on the closest equivalent ROOM that actually exists.
   *
   * Three rungs, strongest first, stopping at the first that can carry the
   * index. The point is §5 of the room-category work: a guest asking about an
   * Ocean View suite should be measured against comparable rooms, not against
   * each competitor's cheapest entry-level one — otherwise a dearer category
   * scores badly by construction rather than by evidence.
   *
   * The fallback is not a failure, it is the market: in a destination where
   * nobody else sells that category there IS no equivalent, and the honest
   * move is to compare on what exists and say so. `compRoomMatch` rides in the
   * response for exactly that reason.
   */
  const competitorsFor = (roomClass: string | null, viewType: string | null) =>
    findCompetitorRates(
      hotel.id,
      request.checkIn,
      request.nights,
      request.adults,
      request.children,
      currency,
      // Terms, not the class: the comparability class is hotel-specific and
      // can never match a competitor. See normalize/compMatch.ts.
      subjectTerms,
      // One more than needed, so a single stale comp does not drop the set
      // below the minimum.
      compLimit,
      live.csi.maxCompAgeHours,
      false,
      roomClass,
      viewType,
      q,
    );

  const [curatedCompetitors, neighbours, curatedCompression] = await Promise.all([
    competitorsFor(chosen.roomClass, chosen.viewType),
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
  // Walk down the room-equivalence ladder only as far as necessary.
  let compRoomMatch: CompRoomMatch = 'CLASS_AND_VIEW';
  let roomMatched = curatedCompetitors;
  if (roomMatched.length < live.csi.minComps) {
    const byClass = await competitorsFor(chosen.roomClass, null);
    if (byClass.length > roomMatched.length) {
      roomMatched = byClass;
      compRoomMatch = 'CLASS';
    }
  }
  if (roomMatched.length < live.csi.minComps) {
    const anyRoom = await competitorsFor(null, null);
    if (anyRoom.length > roomMatched.length) {
      roomMatched = anyRoom;
      compRoomMatch = 'ANY';
    }
  }

  const hadCurated = await hasCuratedComparables(hotel.id, q);
  let competitors = roomMatched;
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
        // The widened set drops the room filter too. It exists precisely
        // because nothing closer was available, so re-imposing equivalence
        // here would guarantee it finds nothing either.
        null,
        null,
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
      compRoomMatch = 'ANY';
      // Compression must describe the same market the comp set does.
      compressionInput = widenedCompression;
      compBasis = 'DESTINATION';
    }
  }

  /**
   * What the SUBJECT's rate includes, per night — the same benefit machinery
   * factor F6 uses, reused rather than reimplemented.
   *
   * Null, not zero, when the hotel has no benefit rows: a hotel we hold no
   * perk data for has not been shown to include nothing, and scoring it as
   * nothing would penalise a gap in OUR data as though it were a gap in the
   * hotel's offering.
   */
  const subjectBenefits = await findBenefits(hotel.id, null, request.checkIn, q);
  const subjectBenefitPerNight =
    subjectBenefits.length === 0
      ? null
      : Math.round(
          subjectBenefits.reduce((total: number, b) => {
            const realized = b.valueMinor * b.realizationFactor;
            return total + (b.basis === 'PER_NIGHT' ? realized : realized / request.nights);
          }, 0),
        );

  const premium = computePremiumJustification(
    current.nightlyMinor,
    subjectBenefitPerNight,
    competitors,
    config,
  );

  const compSet = computeCompSetIndex(
    current.nightlyMinor,
    competitors,
    config,
    now,
    {
      strength: compMatchStrength(matchTerms),
      unknown: unknownDimensions(matchTerms),
    },
    // The contextual penalty. Only when both sides' inclusions are known —
    // otherwise the price ratio stands exactly as it did.
    premium.level === 'HIGH' || premium.level === 'MODERATE' || premium.level === 'LOW'
      ? premium.effectiveCsi
      : null,
  );
  const calendar = computeCalendarDelta(current.nightlyMinor, neighbours, config);
  const compression = computeCompression(compressionInput, config);

  // Availability position: the catalogued classes are the proof side of
  // "lower categories currently unavailable" — without them the claim is
  // never made (rule: absence of evidence is not evidence of sold-out).
  const cataloguedClasses = (await listRoomTypes(hotel.id, q)).map((t) => t.roomClass);
  const availability = assessAvailabilityPosition(
    current.nightlyMinor,
    chosen.roomClass,
    available.map((r) => ({ roomClass: r.roomClass, nightlyMinor: r.nightlyMinor })),
    cataloguedClasses,
  );

  return {
    hotel,
    availability,
    benefitNames: subjectBenefits.map((b) => b.displayName),
    competitorRates: competitors.map((c) => ({
      wahHotelId: c.hotelId,
      name: c.name,
      nightlyMinor: c.nightlyMinor,
      isAvailable: c.isAvailable,
    })),
    availableRooms: available.map((r) => ({
      roomTypeId: r.roomTypeId,
      name: r.canonicalName,
      roomClass: r.roomClass,
      nightlyMinor: r.nightlyMinor,
    })),
    currency,
    compBasis,
    compRoomMatch,
    competitorWahIds: competitors.filter((c) => c.isAvailable).map((c) => c.hotelId),
    premium,
    roomTypeId: chosen.roomTypeId,
    roomName: chosen.canonicalName,
    // UNKNOWN means the source did not state a view; in bundle semantics
    // "null is unknown — say nothing about it", so it maps to null here.
    roomViewType: chosen.viewType && chosen.viewType !== 'UNKNOWN' ? chosen.viewType : null,
    roomSelectedBy: request.roomTypeId != null || roomCodeMatch === 'RESOLVED' ? 'USER' : 'ENGINE',
    rateOptions: rateRows.map((r) => ({
      rateId: r.comparabilityClass,
      name:
        r.planName ??
        describeRateTerms({
          mealPlan: r.mealPlan as MealPlan,
          refundPolicy: r.refundPolicy as RefundPolicy,
          audience: r.audience as RateAudience,
        }),
      refundPolicy: r.refundPolicy,
      nightlyMinor: r.nightlyMinor,
      totalMinor: r.totalMinor,
    })),
    roomCodeMatch,
    selectedRateId: selectedRate.comparabilityClass,
    rateSelectedBy:
      request.rateId != null || (roomCodeMatch === 'RESOLVED' && effectiveRateId !== null)
        ? 'USER'
        : 'ENGINE',
    booking:
      selectedRate.sourceRoomCode && selectedRate.sourceRateCode
        ? { roomCode: selectedRate.sourceRoomCode, rateCode: selectedRate.sourceRateCode }
        : null,
    comparabilityClass: selectedRate.comparabilityClass,
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
