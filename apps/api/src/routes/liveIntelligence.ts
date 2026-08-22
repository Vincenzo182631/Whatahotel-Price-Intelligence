/**
 * GET /api/v1/live-intelligence — the live-market answer.
 *
 * Sibling of /price-intelligence, not a replacement. That endpoint scores a
 * rate against this hotel's accrued history; this one scores it against the
 * market as it stands today — the comp set, nearby bookable dates, and how much
 * of the comparable market is left. It needs no baseline, which is what makes
 * it usable from the first week of collection.
 *
 * ── THIS ENDPOINT DOES NOT PREDICT ────────────────────────────────────────
 *
 * Nothing in the response may state or imply a future price. `verdict:
 * "BOOK_NOW"` means "this is a good rate against today's market", never "book
 * before it goes up". Every field below is a measurement of something that
 * exists right now.
 *
 * Absent signals are reported as absent, with the reason. They are never
 * substituted with a neutral value, and a missing score is `null` rather than
 * zero — a zero renders to a customer as "terrible deal".
 */

import {
  PREFERENCES,
  buildLiveExplanationBundle,
  chooseAlternative,
  liveBandLabel,
  liveVerdictLabel,
  parsePreference,
  premiumJustificationSummary,
  type ReputationFact,
} from '@wahpi/core';
import {
  findHotelByWahId,
  findVerifiedReputations,
  findVerifiedReputationsByWahIds,
  isLiveLoadFailure,
  loadActiveConfig,
  loadLiveIntelligence,
  promoteHotelForCollection,
} from '@wahpi/data';
import {
  OpenAiReasoner,
  collectStayOnDemand,
  enrollHotel,
  ensureDestinationDepth,
  explainLive,
  openAiSettings,
  topUpComparablesOnDemand,
  type OnDemandResult,
} from '@wahpi/ingest';

import {
  ApiError,
  cacheHeaders,
  money,
  nightsBetween,
  optionalInt,
  requireDate,
  requireString,
  sendJson,
  type Handler,
} from '../http.js';

/**
 * Short, because the answer is only as good as the rates behind it. A cached
 * comp-set index outlives the freshness bound its own inputs were filtered on
 * if this runs long.
 */
const TTL_SECONDS = 300;

/**
 * Rounded for transport, not for computation.
 *
 * The engine works in full precision and the score is already composed by the
 * time these are read; publishing `113.60519107104696` only invites a client to
 * re-derive a band from a figure it should be reading directly.
 */
const round1 = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 10) / 10;

const round3 = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 1000) / 1000;

/**
 * One reasoner for the process, not one per request.
 *
 * Its cache is keyed on the bundle's facts, so two guests looking at the same
 * stay in the same hour share one call. A per-request instance would carry an
 * empty cache every time and pay for every page view.
 *
 * Null when OPENAI_API_KEY is unset, which is a supported configuration: the
 * deterministic renderer answers, and nothing about the response shape moves.
 */
let reasoner: OpenAiReasoner | null | undefined;
function liveReasoner(): OpenAiReasoner | null {
  if (reasoner === undefined) {
    const settings = openAiSettings();
    reasoner = OpenAiReasoner.fromEnv({
      model: settings.model,
      timeoutMs: settings.timeoutMs,
      cacheMinutes: settings.cacheMinutes,
    });
  }
  return reasoner;
}

/**
 * Plain language, no jargon, and never a prediction.
 *
 * Each line states what was measured and stops there. "Appears" and "may not"
 * are load-bearing: this is a judgement from the evidence we hold, not a claim
 * about what the hotel is worth.
 */
function premiumSummary(level: string): string {
  return premiumJustificationSummary(level);
}

export const liveIntelligenceHandler: Handler = async (_req, res, ctx) => {
  const { url } = ctx;

  const wahHotelId = requireString(url, 'hotel_id');
  const checkIn = requireDate(url, 'check_in');
  const checkOut = requireDate(url, 'check_out');
  const nights = nightsBetween(checkIn, checkOut);
  const adults = optionalInt(url, 'adults', 2, 1, 10);
  const children = optionalInt(url, 'children', 0, 0, 10);
  // No default. The source prices in the HOTEL's currency — Doha answers in
  // QAR, Miami in USD — so assuming USD made every non-US hotel report "no
  // rate for these dates" when what we actually had was a rate we refused to
  // look at. Null means "answer in whatever this hotel is quoted in"; a caller
  // that pins a currency still gets exactly that one or nothing.
  const currencyParam = url.searchParams.get('currency');
  const requestedCurrency = currencyParam === null ? null : currencyParam.toUpperCase();
  const roomTypeParam = url.searchParams.get('room_type_id');

  const roomTypeId = roomTypeParam === null ? null : Number(roomTypeParam);
  if (roomTypeParam !== null && !Number.isInteger(roomTypeId)) {
    throw new ApiError('INVALID_PARAMETER', 'room_type_id must be an integer', {
      value: roomTypeParam,
    });
  }

  // A specific rate plan for the chosen room — the `rate_id` a client read
  // from `subject.rate_options`. Absent means the cheapest plan, which is
  // what every request got before rate selection existed.
  const rateId = url.searchParams.get('rate_id');

  // The guest's stated preference (Phase 6). Absent means GENERAL_VALUE —
  // the un-personalized answer, byte-for-byte what it was before the
  // preference existed. An unrecognised value is a 400 rather than a silent
  // default: a guest who picked "family" and silently got the generic answer
  // would be reading a personalization that was never made.
  const preferenceParam = url.searchParams.get('preference');
  const parsedPreference = parsePreference(preferenceParam);
  if (preferenceParam !== null && preferenceParam !== '' && parsedPreference === null) {
    throw new ApiError('INVALID_PARAMETER', 'preference is not recognised', {
      value: preferenceParam,
      allowed: PREFERENCES,
    });
  }
  const preference = parsedPreference ?? 'GENERAL_VALUE';

  const { config } = await loadActiveConfig();
  const now = new Date();

  const request = {
    wahHotelId,
    checkIn,
    nights,
    adults,
    children,
    currency: requestedCurrency,
    roomTypeId,
    rateId,
    now,
  };
  let loaded = await loadLiveIntelligence(request, config);
  let onDemand: OnDemandResult | null = null;
  let onDemandError: string | null = null;

  // Automatic catalogue enrollment. A hotel nobody has synced is not a hotel
  // that does not exist — the source knows its whole inventory, so ask. This
  // is what makes the widget work on every whatahotel.com page rather than
  // only the destinations someone remembered to sync. A source that does not
  // recognise the id still ends in the honest 404 below.
  let enrolled: string | null = null;
  if (isLiveLoadFailure(loaded) && loaded.kind === 'HOTEL_NOT_FOUND') {
    const result = await enrollHotel(wahHotelId);
    enrolled = result.outcome;
    if (result.outcome === 'ENROLLED') {
      loaded = await loadLiveIntelligence(request, config);
    }
  }

  // On-demand collection: a stay nothing has collected is fetched live, right
  // now, and scored from what comes back — the same pipeline, validation and
  // honesty rules as scheduled collection. If the fetch yields nothing that
  // can be verified, the answer stays the honest 409 below; a fabricated
  // score is never the fallback.
  if (isLiveLoadFailure(loaded) && loaded.kind === 'NO_CURRENT_RATE') {
    const hotel = await findHotelByWahId(wahHotelId);
    if (hotel) {
      // Before spending on rates, make sure we know who this hotel's
      // neighbours are. The sweep catalogues hotels one id at a time and has
      // no notion of a city, so a destination can be populated unevenly, and
      // an on-demand fetch with no comparables produces a rate we cannot put
      // in context. One indexed query when the destination is already deep
      // enough; one API call when it is not.
      try {
        await ensureDestinationDepth(wahHotelId);
      } catch (err) {
        console.error('destination depth check failed:', (err as Error).message);
      }
      try {
        onDemand = await collectStayOnDemand({
          hotelId: hotel.id,
          wahHotelId,
          checkIn,
          nights,
          adults,
          children,
        });
      } catch (err) {
        // Never let a collection fault break the read path. err.message only,
        // sanitized: driver errors can carry connection strings, and anything
        // resembling a URL or credential is stripped before it can leave the
        // process in a response or a log line.
        onDemandError = String((err as Error).message ?? err)
          .replace(/[a-z]+:\/\/\S+/gi, '<url>')
          .slice(0, 200);
        console.error('on-demand collection error:', onDemandError);
      }
      if (onDemand?.subjectTracked) {
        loaded = await loadLiveIntelligence(request, config);
      }
    }
  }

  // A guest looking at a hotel is the signal that its history is worth
  // accruing. The full-inventory sweep catalogues every hotel the source has
  // at tier OFF — scoreable on demand, but off the collection schedule, because
  // scheduling all of inventory would take months per cycle. This promotes on
  // first real interest, so scheduled collection follows demand. Never allowed
  // to break the read: a failed promotion costs a day of baseline, not a score.
  if (!isLiveLoadFailure(loaded) || loaded.kind !== 'HOTEL_NOT_FOUND') {
    try {
      await promoteHotelForCollection(wahHotelId);
    } catch (err) {
      console.error('collection promotion failed:', (err as Error).message);
    }
  }

  if (isLiveLoadFailure(loaded)) {
    switch (loaded.kind) {
      case 'HOTEL_NOT_FOUND':
        throw new ApiError('HOTEL_NOT_FOUND', 'No such hotel.', {
          hotel_id: wahHotelId,
          // Whether we tried to learn about it, and what the source said.
          enrollment: enrolled,
        });
      case 'ROOM_TYPE_NOT_FOUND':
        throw new ApiError('ROOM_TYPE_NOT_FOUND', 'No such room type for this hotel.', {
          room_type_id: roomTypeParam,
        });
      case 'RATE_NOT_FOUND':
        // The pinned rate plan is no longer bookable for this stay — the
        // offer went away, or the guest moved the dates. Distinct from
        // ROOM_TYPE_NOT_FOUND so a client can drop the rate pin and retry
        // with the room's current cheapest plan.
        throw new ApiError('RATE_NOT_FOUND', 'That rate is no longer available for this stay.', {
          rate_id: rateId,
        });
      case 'NO_CURRENT_RATE':
        throw new ApiError('NO_CURRENT_RATE', 'No available rate for these dates.', {
          hotel_id: wahHotelId,
          check_in: checkIn,
          // Why the live attempt (if any) could not help — "sold out right
          // now" and "we did not try" are different answers for the UI.
          on_demand: onDemand
            ? {
                performed: onDemand.performed,
                skipped: onDemand.skipped ?? null,
                rates_fetched: onDemand.ratesFetched,
              }
            : onDemandError
              ? { performed: false, error: onDemandError }
              : null,
        });
    }
  }

  // A stored subject rate is not the same as an answerable stay. The Comp-Set
  // Index is 45% of the live score, and it needs `minComps` competitor rates on
  // the subject's terms — so a hotel we have collected, sitting in a
  // destination we have not, scores nothing and would have gone on scoring
  // nothing: the on-demand path above fires only when the SUBJECT is missing.
  // Measured on hotel 2008 after the catalogue sweep widened its destination —
  // stored rate, one usable comp, no score.
  //
  // Topping up is the same fetch, the same pipeline and the same ledger; it
  // carries its own hold because the subject's guard cannot bound it. If the
  // comp set is still thin afterwards, the answer stays the honest empty one.
  let compTopUp: OnDemandResult | null = null;
  if (
    !isLiveLoadFailure(loaded) &&
    loaded.compSet.signal.unavailableReason === 'INSUFFICIENT_COMPARABLES'
  ) {
    try {
      compTopUp = await topUpComparablesOnDemand({
        hotelId: loaded.hotel.id,
        wahHotelId,
        checkIn,
        nights,
        adults,
        children,
      });
      if ((compTopUp?.inserted ?? 0) > 0) {
        const reloaded = await loadLiveIntelligence(request, config);
        if (!isLiveLoadFailure(reloaded)) loaded = reloaded;
      }
    } catch (err) {
      // Never break the read for it: the honest empty comp set is a valid
      // answer, a 500 is not.
      console.error('comp-set top-up failed:', (err as Error).message);
    }
  }

  const { result, compSet, calendar, compression, premium } = loaded;
  // Whatever the hotel is actually quoted in, resolved by the loader.
  const currency = loaded.currency;

  /**
   * The renormalized weight for a signal.
   *
   * Read from `result.signals`, NOT from the CompSetResult/CalendarResult the
   * signal came in on: composeLiveScore renormalizes into fresh objects and
   * leaves the originals untouched, so the originals still carry the
   * pre-composition `weightApplied` of 0. Reading them reported every signal as
   * contributing nothing to a score they demonstrably produced.
   */
  const applied = (code: string): number => {
    const signal = result.signals.find((s) => s.code === code);
    return round3(signal?.weightApplied ?? 0) ?? 0;
  };

  /**
   * Guest reputation — context, never a term in the score.
   *
   * Read from what the reputation sweep already resolved (scripts/resolve-places.mjs).
   * Nothing is fetched from Google on a page view: a rating belongs to the
   * hotel rather than to the stay, so there is nothing per-request to look up,
   * and a guest's request should not pay for a discovery that benefits
   * everyone after them.
   *
   * Only VERIFIED matches are returned — the repository enforces that, not the
   * caller — and an unmatched or doubtfully matched hotel yields null. Never a
   * zero rating: 0.0 stars is a claim about the property, and one we have no
   * basis for.
   */
  let subjectReputation: ReputationFact | null = null;
  let subjectEditorialSummary: string | null = null;
  let subjectReviewThemes: readonly string[] = [];
  let comparableRatings: number[] = [];
  let competitorReputations = new Map<
    string,
    { rating: number | null; userRatingCount: number | null }
  >();
  try {
    const [subject, comps] = await Promise.all([
      findVerifiedReputations([loaded.hotel.id]),
      findVerifiedReputationsByWahIds(loaded.competitorWahIds),
    ]);
    competitorReputations = comps;
    const mine = subject.get(loaded.hotel.id);
    if (mine && mine.rating !== null) {
      subjectReputation = {
        source: 'GOOGLE',
        rating: mine.rating,
        review_count: mine.userRatingCount,
        display_name: mine.displayName,
      };
    }
    // Property evidence for the hotel-value reading — VERIFIED rows only,
    // same guarantee as the rating itself.
    if (mine) {
      subjectEditorialSummary = mine.editorialSummary;
      subjectReviewThemes = mine.reviewThemes;
    }
    comparableRatings = [...comps.values()]
      .map((r) => r.rating)
      .filter((r): r is number => r !== null);
  } catch (err) {
    // Context is optional; the price answer is not. A reputation lookup that
    // fails costs the reader a sentence, not the response.
    console.error('reputation lookup failed:', (err as Error).message);
  }

  /**
   * The better-value alternative, chosen deterministically from the same
   * comp set the score used — never the cheapest for its own sake, and null
   * when nothing genuinely qualifies. The full priced comp roster stays
   * unpublished; ONE relevant alternative is the product feature.
   */
  const alternative = chooseAlternative(
    loaded.nightlyMinor,
    loaded.competitorRates.map((c) => ({
      wahHotelId: c.wahHotelId,
      name: c.name,
      nightlyMinor: c.nightlyMinor,
      isAvailable: c.isAvailable,
      rating: competitorReputations.get(c.wahHotelId)?.rating ?? null,
      reviewCount: competitorReputations.get(c.wahHotelId)?.userRatingCount ?? null,
    })),
    // Tilts the RANKING among eligible candidates only — a preference can
    // never conjure an alternative the eligibility rule would not allow.
    preference,
  );

  const bundle = buildLiveExplanationBundle({
    configVersion: config.version,
    preference,
    hotelName: loaded.hotel.name,
    city: loaded.hotel.destination,
    roomTypeName: loaded.roomName,
    roomClass:
      loaded.availableRooms.find((r) => r.roomTypeId === loaded.roomTypeId)?.roomClass ?? null,
    roomViewType: loaded.roomViewType,
    checkIn,
    checkOut,
    nights,
    adults,
    children,
    currency,
    nightlyMinor: loaded.nightlyMinor,
    totalMinor: loaded.totalMinor,
    observedAt: loaded.observedAt,
    result,
    compSet,
    calendar,
    compression,
    premium,
    compBasis: loaded.compBasis,
    compRoomMatch: loaded.compRoomMatch,
    reputation: subjectReputation,
    perks: loaded.benefitNames,
    editorialSummary: subjectEditorialSummary,
    reviewThemes: subjectReviewThemes,
    comparableRatings,
    availability: loaded.availability,
    alternative: alternative
      ? {
          name: alternative.name,
          nightlyMinor: alternative.nightlyMinor,
          rating: alternative.rating,
          reviewCount: alternative.reviewCount,
        }
      : null,
  });

  /**
   * The prose a customer reads.
   *
   * `explainLive` returns the deterministic sentences when no model is
   * configured, when the call fails, and when the draft fails validation — so
   * this never throws and never blocks. `source` is published because a
   * reader of the API is entitled to know whether a sentence was written by a
   * template or by a model that was then checked against the facts above.
   */
  const explanation = await explainLive(liveReasoner(), bundle);
  if (explanation.source === 'TEMPLATE' && (explanation.failure || explanation.violations.length)) {
    // Server log only — the violations name specific numbers and belong to
    // our validator, not to the customer's stay. The response carries the
    // coarse reason below.
    console.error(
      'explanation fell back to TEMPLATE:',
      explanation.failure ?? `draft rejected: ${explanation.violations.join('; ')}`,
    );
  }

  const body = {
    generated_at: now.toISOString(),
    model: 'LIVE_MARKET',
    config_version: config.version,
    // Whether this answer required fetching the stay live just now. STORED is
    // the common case and the fast one; LIVE_FETCH means the guest's search
    // itself widened the dataset.
    data_source: onDemand?.subjectTracked ? 'LIVE_FETCH' : 'STORED',

    subject: {
      hotel: {
        hotel_id: loaded.hotel.wahHotelId,
        name: loaded.hotel.name,
        destination: loaded.hotel.destination,
        luxury_tier: loaded.hotel.luxuryTier,
      },
      room_type: {
        room_type_id: String(loaded.roomTypeId),
        name: loaded.roomName,
        selected_by: loaded.roomSelectedBy,
      },
      /**
       * Every rate plan bookable for the CHOSEN room, cheapest first, and
       * which of them this answer describes. Re-request with `rate_id` to
       * score another: the terms match, the comp set and the booking link
       * all key on the selected plan, so the answer is recomputed rather
       * than repriced.
       */
      rate_options: loaded.rateOptions.map((r) => ({
        rate_id: r.rateId,
        name: r.name,
        refund_policy: r.refundPolicy,
        nightly: money(r.nightlyMinor, currency),
        total: money(r.totalMinor, currency),
      })),
      selected_rate_id: loaded.selectedRateId,
      rate_selected_by: loaded.rateSelectedBy,
      // Every room bookable for THIS stay, cheapest first, so a client can
      // offer the choice rather than only ever showing the engine's pick.
      // Re-request with `room_type_id` to score any of them: the comp set, the
      // nearby-date series and the terms match are all keyed on the chosen
      // room, so the answer is recomputed rather than relabelled.
      room_options: loaded.availableRooms.map((room) => ({
        room_type_id: String(room.roomTypeId),
        name: room.name,
        room_class: room.roomClass,
        nightly: money(room.nightlyMinor, currency),
      })),
      rate_plan: {
        summary: loaded.rateTerms,
        comparability_class: loaded.comparabilityClass,
      },
      stay: { check_in: checkIn, check_out: checkOut, nights, adults, children },
    },

    price: {
      // ADR: the BASE room rate per night, before taxes and fees — the same
      // basis whatahotel.com quotes, so the widget and the page around it
      // never disagree about what a night costs. NOT total / nights.
      nightly: money(loaded.nightlyMinor, currency),
      nightly_basis: 'NET',
      // The whole-stay cost the customer commits to, taxes and fees included.
      total: money(loaded.totalMinor, currency),
      total_basis: loaded.taxBasis,
      taxes_fees: money(loaded.taxesFeesMinor, currency),
      // Retained for consumers written before the two bases diverged. It has
      // always described the TOTAL, which is what it still describes.
      tax_basis: loaded.taxBasis,
      observed_at: loaded.observedAt,
      age_hours: Math.round(loaded.rateAgeHours * 10) / 10,
    },

    verdict: {
      // Both forms: the 0–100 the engine works in and the 0–10 the customer
      // reads. Deriving the second in the client would let a rounding rule
      // drift out of step with the bands.
      score: result.score,
      out_of_ten: result.outOfTen,
      band: result.band,
      band_label: result.band === null ? null : liveBandLabel(result.band),
      verdict: result.verdict,
      verdict_label: liveVerdictLabel(result.verdict),
      // A word, not a number. See assessLiveConfidence — a two-decimal
      // confidence would invite a precision the inputs do not support.
      confidence: result.confidence,
      weight_coverage: round3(result.weightCoverage),
      reasons: result.reasons,
    },

    /**
     * Is the price premium supported by what the rate includes?
     *
     * Deliberately its own block rather than folded into `verdict`: a hotel
     * can be poor VALUE and still a defensible choice, and collapsing the two
     * into one number is how "expensive" becomes "bad". `level` answers the
     * premium question, `verdict.score` answers the value question, and they
     * are allowed to disagree.
     *
     * `LIMITED_DATA` means we can see the price gap and nothing about what
     * either side gives for it. It is never a soft yes.
     */
    premium_justification: {
      level: premium.level,
      confidence: premium.confidence,
      premium_pct: round1(premium.premiumPct),
      // How much of the premium the extra included value actually covers.
      covered_pct: round1(premium.coveredPct),
      included_value_nightly: money(premium.subjectBenefitPerNightMinor, currency),
      comparable_included_value_nightly: money(premium.medianCompBenefitPerNightMinor, currency),
      comparables_with_included_value: premium.compsWithBenefits,
      effective_index: round1(premium.effectiveCsi),
      summary: premiumSummary(premium.level),
      /**
       * The reasoned verdict: is the premium supported by the evidence?
       *
       * `level` above stays the deterministic money-vs-money answer,
       * untouched. This block may weigh the verified guest reputation as
       * SUPPORTING evidence — which is as far as reputation ever reaches:
       * it still moves no score. `source` says who wrote the verdict;
       * MODEL means it passed the full validation gate (numeric allowlist,
       * no predictions, every cited piece of evidence present in the
       * bundle, confidence computed by code). An invalid model verdict is
       * discarded whole and DETERMINISTIC ships. Null when there is no
       * premium to justify.
       */
      assessment: explanation.assessment
        ? {
            level: explanation.assessment.level,
            // The customer-facing frame — consultative by policy. Clients
            // should label from THIS, not from `level`.
            position: explanation.assessment.position,
            reasoning: explanation.assessment.reasoning,
            paying_more_for: explanation.assessment.paying_more_for || null,
            availability_context: explanation.assessment.availability_context || null,
            key_positive_factors: explanation.assessment.key_positive_factors,
            key_negative_factors: explanation.assessment.key_negative_factors,
            confidence: explanation.assessment.confidence,
            recommendation: explanation.assessment.recommendation,
            evidence_used: explanation.assessment.evidence_used,
            source: explanation.assessment.source,
          }
        : null,
    },

    /**
     * WHY YOU MIGHT CHOOSE THIS HOTEL (Phase 6.X) — the other half of the
     * decision. Price Intelligence says how the price compares; this says
     * what is attractive about the property, from evidence only: the
     * verified rating, themes measured over Google's review sample, the
     * source's own perk inclusions, and Google's editorial sentence. The
     * supporting signals are code-built chips a model can cite but never
     * invent. Null when the evidence is too thin — the widget then hides
     * the section rather than stretching (hide, don't break).
     */
    hotel_value: explanation.hotelValue
      ? {
          headline: explanation.hotelValue.headline,
          summary: explanation.hotelValue.summary,
          supporting_signals: explanation.hotelValue.supporting_facts,
          confidence: explanation.hotelValue.confidence,
          evidence_used: explanation.hotelValue.evidence_used,
          source: explanation.hotelValue.source,
        }
      : null,

    /**
     * Where the selected rate sits in the hotel's currently available
     * inventory. `lower_categories_unavailable` is asserted only when the
     * catalogue provably carries an entry class none of which is available
     * today — and it means exactly "currently unavailable", never "sold
     * out", which the source only ever states for a whole stay.
     */
    availability: {
      selected_position: bundle.availability.selected_position,
      available_categories: bundle.availability.available_categories,
      cheaper_categories_available: bundle.availability.cheaper_categories_available,
      entry_class_available: bundle.availability.entry_class_available,
      lower_categories_unavailable: bundle.availability.lower_categories_unavailable,
      availability_influenced: bundle.availability.availability_influenced,
    },

    /**
     * The better-value alternative — information, not a pitch. One relevant
     * comparable at a meaningfully lower current rate, ranked by saving AND
     * verified reputation, never merely the cheapest. Null when nothing
     * qualifies, and rendered as nothing.
     */
    alternative: alternative
      ? {
          hotel_id: alternative.wahHotelId,
          name: alternative.name,
          nightly: money(alternative.nightlyMinor, currency),
          save_nightly: money(alternative.saveNightlyMinor, currency),
          rating: alternative.rating,
          review_count: alternative.reviewCount,
          // With a stated preference, the personalization's reason names why
          // this candidate suits THAT preference; otherwise the assessment's.
          reason:
            explanation.personalization?.alternative_reason ||
            explanation.assessment?.alternative_reason ||
            'A comparable stay is currently available at a lower rate.',
        }
      : null,

    /**
     * The personalization layer (Phase 6) — the SAME facts, read through the
     * guest's stated preference. Null when the preference is GENERAL_VALUE
     * (the default), so an un-personalized response is exactly the response
     * this endpoint returned before preferences existed.
     *
     * Nothing above this block moves with the preference: the score, the
     * prices, the premium, the availability read and the reputation are
     * identical for every preference by construction — personalization is
     * built from the finished fact bundle, after every number is decided.
     * The only other preference-sensitive field is the alternative's
     * RANKING (never its eligibility) and its reason sentence.
     *
     * `source` says who wrote it: MODEL passed the full validation gate
     * (numeric allowlist, no predictions, no citing evidence the bundle
     * does not hold); DETERMINISTIC is the code-written reading that ships
     * when the model is unavailable or its draft was rejected. A preference
     * for which we hold no specific evidence — amenities, family,
     * nightlife, quiet, business — says so plainly rather than inventing a
     * fit.
     */
    personalization: explanation.personalization
      ? {
          preference: explanation.personalization.preference,
          personalized_insight: explanation.personalization.personalized_insight,
          why_this_hotel_may_fit: explanation.personalization.why_this_hotel_may_fit,
          what_to_consider: explanation.personalization.what_to_consider,
          alternative_reason: explanation.personalization.alternative_reason || null,
          confidence: explanation.personalization.confidence,
          evidence_used: explanation.personalization.evidence_used,
          source: explanation.personalization.source,
        }
      : null,

    /**
     * Everything a client needs to book THIS exact rate on whatahotel.com.
     *
     * The room and rate codes are the source's own booking identifiers,
     * read from the same capture the displayed price came from — so the
     * booking page opens on the rate the widget scored, never a relative
     * of it. Null when the capture did not state the codes: the button is
     * then disabled rather than pointed at a guessed URL. The session
     * tokens (`cfid`/`cftoken`) the source's own links carry are
     * deliberately absent — they are per-session credentials, and the
     * booking page issues fresh ones.
     */
    booking: loaded.booking
      ? {
          room_code: loaded.booking.roomCode,
          rate_code: loaded.booking.rateCode,
          url:
            'https://whatahotel.com/booking/booking_info.cfm?' +
            new URLSearchParams({
              room: loaded.booking.roomCode,
              rate: loaded.booking.rateCode,
              hotel: loaded.hotel.wahHotelId,
              checkin: checkIn,
              checkout: checkOut,
              guests: String(adults),
              children: String(children),
              rooms: '1',
            }).toString(),
        }
      : null,

    /**
     * What other guests say about the property.
     *
     * Present ONLY when the hotel was matched to a Google place with enough
     * confidence to be sure it is the same property, and Google holds a
     * rating for it. Otherwise the whole block is null — absent, not zero.
     *
     * `rating` and `review_count` are published together on purpose: 4.9 from
     * 32 reviews and 4.7 from 4,500 are not the same claim, and a client
     * rendering the first without the second would present them as though
     * they were.
     *
     * This does not move `verdict.score`. Nothing in packages/core/src/scoring
     * reads it. It is evidence for the explanation and a fact for the reader.
     */
    reputation: subjectReputation
      ? {
          source: 'GOOGLE',
          rating: subjectReputation.rating,
          review_count: subjectReputation.review_count,
          display_name: subjectReputation.display_name,
          affects_score: false,
          // How the comparables rate, when enough of them carry a rating —
          // three, below which an "average" is one hotel wearing a plural.
          comparable_median_rating: bundle.reputation.comparable_median_rating,
          comparables_with_rating: bundle.reputation.comparables_with_rating,
        }
      : null,

    /**
     * The customer-facing sentences, and where they came from.
     *
     * TEMPLATE  the deterministic renderer wrote them.
     * MODEL     a language model reworded the facts and the draft passed
     *           validation — every numeral present in the bundle's allowlist,
     *           no predictive language.
     * CACHE     an identical set of facts was reworded recently.
     *
     * The model never computes and never sees a rate source; it is handed the
     * finished facts and asked for readable English. A draft that fails
     * validation is discarded whole, and TEMPLATE ships instead.
     */
    explanation: {
      text: explanation.text,
      sentences: explanation.sentences,
      source: explanation.source,
      /**
       * Why the sentences are the template's, when they are. OpenAI's error
       * enums ("http_401 invalid_api_key", "insufficient_quota") or our own
       * markers ("not_configured", "draft_rejected", "timeout_or_network").
       * Never the key, never free text. Null when a model answered — and
       * null is the state worth reaching: the first live deployment fell
       * back on every request and nothing anywhere could say why.
       */
      fallback_reason:
        explanation.source === 'TEMPLATE'
          ? (explanation.failure ?? (explanation.violations.length > 0 ? 'draft_rejected' : null))
          : null,
    },

    signals: {
      comp_set: {
        available: compSet.signal.available,
        // CURATED = the ranked peer set built from accrued baselines.
        // DESTINATION = the nearest hotels in the same destination, which is
        // what a city we have not collected long enough to rank falls back to.
        // Published so nothing renders a city-wide comparison as a peer one.
        basis: loaded.compBasis,
        // How closely the competitors' ROOMS match the one being scored.
        // CLASS_AND_VIEW is a genuine like-for-like; ANY means nobody else
        // sells an equivalent category and the comparison is against whatever
        // they do sell. Published so a premium room is never made to look
        // overpriced against entry-level rooms without the reader knowing.
        room_match: loaded.compRoomMatch,
        unavailable_reason: compSet.signal.unavailableReason,
        sub_score: compSet.signal.subScore,
        weight: compSet.signal.weight,
        weight_applied: applied('S1_COMP_SET'),
        index: round1(compSet.csi),
        band: compSet.band,
        pct_below_median: round1(compSet.pctBelowMedian),
        median_competitor_nightly: money(compSet.medianCompetitorNightlyMinor, currency),
        // Named competitor rates are deliberately not returned. The counts are
        // the evidence a customer needs; the individual prices are another
        // hotel's commercial data.
        comps_used: compSet.compsUsed,
        comps_excluded: compSet.compsExcluded,
        // How much of the cross-hotel match rested on stated terms, and what
        // the source left unstated. Exposed because a consumer rendering the
        // index without this would present a term-blind comparison as
        // like-for-like. See packages/core/src/normalize/compMatch.ts.
        match_strength: compSet.matchStrength,
        unknown_dimensions: compSet.unknownDimensions,
        // Whether this request fetched competitor rates live to build the
        // comparison, and what came back. Null when the stored comp set was
        // already sufficient, which is the common case.
        topped_up: compTopUp
          ? {
              performed: compTopUp.performed,
              skipped: compTopUp.skipped ?? null,
              rates_fetched: compTopUp.ratesFetched,
              inserted: compTopUp.inserted,
            }
          : null,
      },
      calendar: {
        available: calendar.signal.available,
        unavailable_reason: calendar.signal.unavailableReason,
        sub_score: calendar.signal.subScore,
        weight: calendar.signal.weight,
        weight_applied: applied('S2_CALENDAR'),
        delta_pct: round1(calendar.deltaPct),
        band: calendar.band,
        median_nearby_nightly: money(calendar.medianNearbyNightlyMinor, currency),
        neighbours_used: calendar.neighboursUsed,
        // Whether the comparison held day-of-week fixed. A customer asking
        // about a Thursday deserves to know if we measured it against weekends.
        same_weekday_only: calendar.sameDowOnly,
        window_days: config.live.calendar.windowDays,
      },
      compression: {
        available: compression.signal.available,
        unavailable_reason: compression.signal.unavailableReason,
        sub_score: compression.signal.subScore,
        weight: compression.signal.weight,
        weight_applied: applied('S3_COMPRESSION'),
        sold_out_share: round3(compression.soldOutShare),
        band: compression.band,
        checked: compression.checked,
        sold_out: compression.soldOut,
      },
    },
  };

  sendJson(res, 200, body, {
    ...cacheHeaders(TTL_SECONDS, TTL_SECONDS * 2),
    'x-request-id': ctx.requestId,
  });
};
