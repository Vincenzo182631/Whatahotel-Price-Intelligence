/**
 * The live-market ExplanationBundle — the ONLY input a language model receives
 * when explaining a live score.
 *
 * The history model has had one of these since M5 (`bundle.ts`). The live
 * model, which is what the widget actually renders, had none: the API returned
 * numbers and the widget wrote sentences from them. That works for a template
 * and stops working the moment a model is involved, because a model given raw
 * results will compute — and rule 4 says the AI never computes.
 *
 * So the split is the same as before and for the same reason:
 *
 *   FACTS         everything below `constraints`. Computed by the engine, all
 *                 of it already decided, none of it open to interpretation.
 *   INTERPRETATION the two or three sentences a model writes from those facts.
 *
 * `constraints.allowed_numbers` is the enforcement. Any numeral in generated
 * prose that is not in that list is a fabricated statistic, and the output is
 * rejected rather than corrected — see `validateNarrative`.
 *
 * ── Reputation is here, and it is NOT here to be scored ───────────────────
 *
 * `reputation` carries a Google rating when we hold a VERIFIED one. It is
 * evidence a reader can weigh — "4.6 from 3,200 reviews" says something about
 * whether a premium is defensible — and it is deliberately absent from every
 * numeric path in `packages/core/src/scoring`. A rating is not a price and it
 * does not belong in a price index. `constraints.reputation_is_not_scored`
 * states that to the model as well, because a model handed a 4.6 next to a
 * score will otherwise explain the score with the 4.6.
 *
 * Absent reputation is absent. Never 0 — a hotel rendered as 0.0 stars because
 * a match was doubtful would be a libel, and the same principle as rule 3.
 */

import type {
  CalendarResult,
  CompressionResult,
  CompSetResult,
  PremiumJustificationResult,
} from '../scoring/liveSignals.js';
import type { LiveScoreResult } from '../scoring/liveScore.js';
import { liveBandLabel, liveVerdictLabel } from '../scoring/liveScore.js';
import { numeralsIn } from './bundle.js';
import type { Preference } from './preference.js';

export const LIVE_BUNDLE_VERSION = 5;

/** A rating that survived matching. Rating and count travel together. */
export interface ReputationFact {
  readonly source: 'GOOGLE';
  readonly rating: number;
  /** Null when Google states a rating but no count. Never invented. */
  readonly review_count: number | null;
  readonly display_name: string | null;
}

export interface LiveExplanationBundle {
  readonly bundle_version: number;
  readonly config_version: number;
  readonly model: 'LIVE_MARKET';
  /**
   * The guest's stated preference — Phase 6. An INTERPRETATION input only:
   * every fact below is identical for every preference, and the bundle key
   * (the reasoner's cache key) hashes the whole bundle, so two preferences
   * can never share a cached narrative. GENERAL_VALUE means no
   * personalization is produced at all.
   */
  readonly preference: Preference;
  readonly subject: {
    readonly hotel_name: string;
    /** The destination, for location context. Null when uncatalogued. */
    readonly city: string | null;
    readonly room_type_name: string;
    readonly room_class: string | null;
    /**
     * The view category of the selected room ('OCEAN', 'CITY', …), when the
     * normalizer resolved one. The only physical room attribute the source
     * states, so the only one personalization may ever lean on.
     */
    readonly room_view: string | null;
    readonly check_in: string;
    readonly check_out: string;
    readonly nights: number;
    readonly adults: number;
    readonly children: number;
  };
  readonly price: {
    readonly currency: string;
    /** ADR — the base room rate per night, before taxes and fees. */
    readonly nightly_minor: number;
    /** The whole stay, taxes and fees included. */
    readonly total_minor: number;
    /**
     * The same two amounts as the customer reads them ("$776", "$2,327").
     * Present so the model never has to convert units — converting is
     * computing, and the one time it tried it shipped cents as dollars.
     */
    readonly nightly_display: string;
    readonly total_display: string;
    readonly observed_at: string;
  };
  readonly verdict: {
    readonly score: number | null;
    readonly out_of_ten: number | null;
    readonly band: string | null;
    readonly band_label: string | null;
    readonly verdict: string;
    readonly verdict_label: string;
    readonly confidence: string;
    readonly weight_coverage: number;
    readonly reasons: readonly string[];
  };
  readonly premium: {
    readonly level: string;
    readonly confidence: string;
    readonly premium_pct: number | null;
    readonly covered_pct: number | null;
    readonly included_value_nightly_minor: number | null;
    readonly comparable_included_value_nightly_minor: number | null;
    readonly comparables_with_included_value: number;
    /** Subject nightly minus the comparable median, when both are known. */
    readonly price_difference_nightly_minor: number | null;
    /** The same figure as prose should carry it ("$230"). */
    readonly price_difference_display: string | null;
  };
  /**
   * Where the selected rate sits in the hotel's currently available
   * inventory. This is what separates "an expensive hotel" from "a hotel
   * whose lower-priced categories are currently unavailable" — two
   * situations a price ratio cannot tell apart. Nothing here is inferred:
   * `lower_categories_unavailable` is true only when the catalogue provably
   * carries an entry class and none of it is available today, and no field
   * ever claims a category is sold out.
   */
  readonly availability: {
    readonly selected_position: 'ENTRY' | 'MID' | 'TOP' | null;
    readonly available_categories: number;
    readonly cheaper_categories_available: number;
    readonly entry_class_available: boolean;
    readonly lower_categories_unavailable: boolean;
    readonly availability_influenced: boolean;
  };
  /**
   * The most relevant lower-priced comparable, chosen deterministically
   * (chooseAlternative). Null when nothing genuinely qualifies. The model
   * may explain it; it may not choose it or invent one.
   */
  readonly alternative: {
    readonly name: string;
    readonly nightly_minor: number;
    readonly nightly_display: string;
    readonly save_nightly_minor: number;
    readonly save_display: string;
    readonly rating: number | null;
    readonly review_count: number | null;
  } | null;
  readonly market: {
    readonly comp_set: {
      readonly available: boolean;
      readonly basis: string | null;
      readonly room_match: string | null;
      readonly index: number | null;
      readonly band: string | null;
      readonly pct_below_median: number | null;
      readonly median_competitor_nightly_minor: number | null;
      readonly comps_used: number;
      readonly match_strength: string;
      /** MATCHED or PRICE_ONLY — whether rate terms were held equal at all. */
      readonly terms_basis: string;
      readonly unavailable_reason: string | null;
    };
    readonly calendar: {
      readonly available: boolean;
      readonly delta_pct: number | null;
      readonly band: string | null;
      readonly median_nearby_nightly_minor: number | null;
      readonly neighbours_used: number;
      readonly same_weekday_only: boolean;
      readonly unavailable_reason: string | null;
    };
    readonly compression: {
      readonly available: boolean;
      readonly sold_out_pct: number | null;
      readonly band: string | null;
      readonly checked: number;
      readonly sold_out: number;
      readonly unavailable_reason: string | null;
    };
  };
  /**
   * Verified facts about the PROPERTY itself — the evidence base for "why
   * you might choose this hotel". Nothing here is inferred: perks are the
   * source's own preferred-partner inclusions by their curated names, the
   * editorial summary is Google's own sentence stored verbatim by the
   * sweep, and review themes are measured over the <=5-review sample
   * Google returns (positive reviews only — see the ingest themes module).
   * The sample caveat is part of the fact: themes describe what RECENT
   * REVIEWERS mention, never what all guests think.
   */
  readonly hotel_facts: {
    readonly perks: readonly string[];
    readonly editorial_summary: string | null;
    readonly review_themes: readonly string[];
    /**
     * The verified signal chips, built HERE so the model, the validator
     * and the renderer share one vocabulary. A model cites these strings
     * verbatim or its hotel-value draft is rejected — it cannot invent a
     * badge, and it cannot be failed for not guessing a string it was
     * never shown.
     */
    readonly supporting_signals: readonly string[];
  };
  readonly reputation: {
    /** Null when unmatched, doubtfully matched, or unrated. Never zero. */
    readonly subject: ReputationFact | null;
    /** The comparables' median rating, when enough of them carry one. */
    readonly comparable_median_rating: number | null;
    readonly comparables_with_rating: number;
  };
  readonly constraints: {
    readonly allowed_numbers: readonly number[];
    readonly currency_symbol: string;
    readonly must_not_predict: true;
    /** Reputation informs reasoning. It is not a term in the score. */
    readonly reputation_is_not_scored: true;
    readonly max_sentences: number;
  };
}

export interface LiveBundleInput {
  readonly configVersion: number;
  /** Defaults to GENERAL_VALUE — the un-personalized Phase 5 behaviour. */
  readonly preference?: Preference;
  readonly hotelName: string;
  readonly city?: string | null;
  readonly roomTypeName: string;
  readonly roomClass?: string | null;
  readonly roomViewType?: string | null;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly nights: number;
  readonly adults: number;
  readonly children: number;
  readonly currency: string;
  readonly nightlyMinor: number;
  readonly totalMinor: number;
  readonly observedAt: string;
  readonly result: LiveScoreResult;
  readonly compSet: CompSetResult;
  readonly calendar: CalendarResult;
  readonly compression: CompressionResult;
  readonly premium: PremiumJustificationResult;
  readonly compBasis?: string | null;
  readonly compRoomMatch?: string | null;
  readonly reputation?: ReputationFact | null;
  /** Perk display names for this hotel, the source's own inclusions. */
  readonly perks?: readonly string[];
  readonly editorialSummary?: string | null;
  readonly reviewThemes?: readonly string[];
  readonly comparableRatings?: readonly number[];
  readonly availability?: {
    readonly position: 'ENTRY' | 'MID' | 'TOP' | null;
    readonly availableCategories: number;
    readonly cheaperCategoriesAvailable: number;
    readonly entryClassAvailable: boolean;
    readonly lowerCategoriesUnavailable: boolean;
    readonly availabilityInfluenced: boolean;
  } | null;
  readonly alternative?: {
    readonly name: string;
    readonly nightlyMinor: number;
    readonly rating: number | null;
    readonly reviewCount: number | null;
  } | null;
  readonly maxSentences?: number;
}

/** Customer-facing chip for each review-theme key the ingest side emits. */
const THEME_CHIP: Readonly<Record<string, string>> = {
  service: 'Praised service',
  location: 'Location',
  beach: 'Beach',
  pool: 'Pool',
  spa: 'Spa',
  rooms: 'Rooms',
  dining: 'Dining',
  views: 'Views',
  cleanliness: 'Cleanliness',
  quiet: 'Quiet setting',
  family: 'Family stays',
  grounds: 'Grounds',
};

/**
 * The CITABLE vocabulary is wider than the DISPLAYED chips: a model citing
 * a genuine perk that didn't fit the four-chip display is not inventing
 * anything. Display capping happens at render time (hotelValue.ts).
 */
const MAX_SIGNALS = 8;

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  AED: 'AED ',
  QAR: 'QAR ',
};

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** "$2,327" — the major-unit form, the only form prose may carry. */
function displayMoney(currency: string, minor: number): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? '';
  const major = Math.round(minor / 100).toLocaleString('en-US');
  return symbol ? `${symbol}${major}` : `${major} ${currency}`;
}

function addNumber(set: Set<number>, value: number | null | undefined): void {
  if (value === null || value === undefined || !Number.isFinite(value)) return;
  set.add(round1(value));
  // The absolute value too: prose says "8% cheaper", the fact says −8.
  if (value < 0) set.add(round1(-value));
}

/**
 * Money enters the allowlist as its MAJOR-unit display form only.
 *
 * The minor value used to be allowed too, and the first model-written
 * explanation in production exploited exactly that: it read a
 * `total_minor` of 232676 from the bundle and wrote "a total of $232,676"
 * — cents presented as dollars, a hundredfold overstatement of a real
 * hotel's price — and the validator PASSED it, because 232676 was on the
 * list. The deterministic renderer only ever writes major amounts, so
 * allowing the minor form protected nothing and permitted the one misuse a
 * price is actually vulnerable to. Now a draft quoting a minor value fails
 * validation and the template ships instead.
 */
function addMoney(set: Set<number>, minor: number | null | undefined): void {
  if (minor === null || minor === undefined || !Number.isFinite(minor)) return;
  addNumber(set, Math.round(minor / 100));
}

/** The median of a numeric list, or null when empty. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function buildLiveExplanationBundle(input: LiveBundleInput): LiveExplanationBundle {
  const { result, compSet, calendar, compression, premium } = input;

  const priceDiffMinor =
    compSet.medianCompetitorNightlyMinor === null
      ? null
      : input.nightlyMinor - compSet.medianCompetitorNightlyMinor;

  const compRatings = (input.comparableRatings ?? []).filter(
    (r) => Number.isFinite(r) && r > 0 && r <= 5,
  );
  // Two ratings is not a market. Below that the "comparables average" is one
  // hotel wearing a plural, so it is omitted rather than reported thinly.
  const compMedian = compRatings.length >= 3 ? median(compRatings) : null;

  const soldOutPct =
    compression.soldOutShare === null ? null : round1(compression.soldOutShare * 100);

  const allowed = new Set<number>();
  addNumber(allowed, result.score);
  addNumber(allowed, result.outOfTen);
  addNumber(allowed, input.nights);
  addNumber(allowed, input.adults);
  if (input.children > 0) addNumber(allowed, input.children);
  addMoney(allowed, input.nightlyMinor);
  addMoney(allowed, input.totalMinor);
  addNumber(allowed, compSet.csi);
  addNumber(allowed, compSet.pctBelowMedian);
  addMoney(allowed, compSet.medianCompetitorNightlyMinor);
  addNumber(allowed, compSet.compsUsed);
  addNumber(allowed, calendar.deltaPct);
  addMoney(allowed, calendar.medianNearbyNightlyMinor);
  addNumber(allowed, calendar.neighboursUsed);
  addNumber(allowed, soldOutPct);
  addNumber(allowed, compression.checked);
  addNumber(allowed, compression.soldOut);
  addNumber(allowed, premium.premiumPct);
  addNumber(allowed, premium.coveredPct);
  addMoney(allowed, premium.subjectBenefitPerNightMinor);
  addMoney(allowed, premium.medianCompBenefitPerNightMinor);
  addNumber(allowed, premium.compsWithBenefits);
  addNumber(allowed, premium.effectiveCsi);
  addMoney(allowed, priceDiffMinor);
  if (input.alternative) {
    addMoney(allowed, input.alternative.nightlyMinor);
    addMoney(allowed, input.nightlyMinor - input.alternative.nightlyMinor);
    addNumber(allowed, input.alternative.rating);
    addNumber(allowed, input.alternative.reviewCount);
  }
  if (input.availability) {
    addNumber(allowed, input.availability.availableCategories);
    addNumber(allowed, input.availability.cheaperCategoriesAvailable);
  }
  // Denominators the deterministic renderer itself writes — "7.2 out of 10",
  // "4.6 out of 5". Same principle as the reason-code numerals below: a
  // sentence the engine authored must not fail the engine's own validator.
  if (result.outOfTen !== null) addNumber(allowed, 10);
  if (input.reputation) addNumber(allowed, 5);
  addNumber(allowed, input.reputation?.rating);
  addNumber(allowed, input.reputation?.review_count);
  addNumber(allowed, compMedian);
  addNumber(allowed, compRatings.length >= 3 ? compRatings.length : null);
  // Dates are numerals too, and a sentence naming the stay would otherwise
  // fail its own validator.
  for (const n of numeralsIn(`${input.checkIn} ${input.checkOut}`)) addNumber(allowed, n);
  // Numerals inside verified source text ("A 100 hotel credit", Google's
  // editorial sentence) are quotable facts, not computations.
  for (const perk of input.perks ?? []) for (const n of numeralsIn(perk)) addNumber(allowed, n);
  for (const n of numeralsIn(input.editorialSummary ?? '')) addNumber(allowed, n);
  for (const reason of result.reasons) for (const n of numeralsIn(reason)) addNumber(allowed, n);

  return {
    bundle_version: LIVE_BUNDLE_VERSION,
    config_version: input.configVersion,
    model: 'LIVE_MARKET',
    preference: input.preference ?? 'GENERAL_VALUE',
    subject: {
      hotel_name: input.hotelName,
      city: input.city ?? null,
      room_type_name: input.roomTypeName,
      room_class: input.roomClass ?? null,
      room_view: input.roomViewType ?? null,
      check_in: input.checkIn,
      check_out: input.checkOut,
      nights: input.nights,
      adults: input.adults,
      children: input.children,
    },
    price: {
      currency: input.currency,
      nightly_minor: input.nightlyMinor,
      total_minor: input.totalMinor,
      nightly_display: displayMoney(input.currency, input.nightlyMinor),
      total_display: displayMoney(input.currency, input.totalMinor),
      observed_at: input.observedAt,
    },
    verdict: {
      score: result.score,
      out_of_ten: result.outOfTen,
      band: result.band,
      band_label: result.band === null ? null : liveBandLabel(result.band),
      verdict: result.verdict,
      verdict_label: liveVerdictLabel(result.verdict),
      confidence: result.confidence,
      weight_coverage: result.weightCoverage,
      reasons: result.reasons,
    },
    premium: {
      level: premium.level,
      confidence: premium.confidence,
      premium_pct: premium.premiumPct === null ? null : round1(premium.premiumPct),
      covered_pct: premium.coveredPct === null ? null : round1(premium.coveredPct),
      included_value_nightly_minor: premium.subjectBenefitPerNightMinor,
      comparable_included_value_nightly_minor: premium.medianCompBenefitPerNightMinor,
      comparables_with_included_value: premium.compsWithBenefits,
      price_difference_nightly_minor: priceDiffMinor,
      price_difference_display:
        priceDiffMinor === null ? null : displayMoney(input.currency, Math.abs(priceDiffMinor)),
    },
    availability: {
      selected_position: input.availability?.position ?? null,
      available_categories: input.availability?.availableCategories ?? 0,
      cheaper_categories_available: input.availability?.cheaperCategoriesAvailable ?? 0,
      entry_class_available: input.availability?.entryClassAvailable ?? false,
      lower_categories_unavailable: input.availability?.lowerCategoriesUnavailable ?? false,
      availability_influenced: input.availability?.availabilityInfluenced ?? false,
    },
    alternative: input.alternative
      ? {
          name: input.alternative.name,
          nightly_minor: input.alternative.nightlyMinor,
          nightly_display: displayMoney(input.currency, input.alternative.nightlyMinor),
          save_nightly_minor: input.nightlyMinor - input.alternative.nightlyMinor,
          save_display: displayMoney(
            input.currency,
            input.nightlyMinor - input.alternative.nightlyMinor,
          ),
          rating: input.alternative.rating,
          review_count: input.alternative.reviewCount,
        }
      : null,
    market: {
      comp_set: {
        available: compSet.signal.available,
        basis: input.compBasis ?? null,
        room_match: input.compRoomMatch ?? null,
        index: compSet.csi === null ? null : round1(compSet.csi),
        band: compSet.band,
        pct_below_median: compSet.pctBelowMedian === null ? null : round1(compSet.pctBelowMedian),
        median_competitor_nightly_minor: compSet.medianCompetitorNightlyMinor,
        comps_used: compSet.compsUsed,
        match_strength: compSet.matchStrength,
        terms_basis: compSet.termsBasis,
        unavailable_reason: compSet.signal.unavailableReason,
      },
      calendar: {
        available: calendar.signal.available,
        delta_pct: calendar.deltaPct === null ? null : round1(calendar.deltaPct),
        band: calendar.band,
        median_nearby_nightly_minor: calendar.medianNearbyNightlyMinor,
        neighbours_used: calendar.neighboursUsed,
        same_weekday_only: calendar.sameDowOnly,
        unavailable_reason: calendar.signal.unavailableReason,
      },
      compression: {
        available: compression.signal.available,
        sold_out_pct: soldOutPct,
        band: compression.band,
        checked: compression.checked,
        sold_out: compression.soldOut,
        unavailable_reason: compression.signal.unavailableReason,
      },
    },
    hotel_facts: (() => {
      const perks = (input.perks ?? []).slice(0, 6);
      const themes = (input.reviewThemes ?? []).slice(0, 5);
      const signals: string[] = [];
      if (input.reputation) signals.push(`★ ${input.reputation.rating} Google rating`);
      for (const theme of themes) {
        const chip = THEME_CHIP[theme];
        if (chip) signals.push(chip);
      }
      for (const perk of perks) signals.push(perk);
      return {
        perks,
        editorial_summary: input.editorialSummary ?? null,
        review_themes: themes,
        supporting_signals: signals.slice(0, MAX_SIGNALS),
      };
    })(),
    reputation: {
      subject: input.reputation ?? null,
      comparable_median_rating: compMedian === null ? null : round1(compMedian),
      comparables_with_rating: compMedian === null ? 0 : compRatings.length,
    },
    constraints: {
      allowed_numbers: [...allowed].sort((a, b) => a - b),
      currency_symbol: CURRENCY_SYMBOLS[input.currency] ?? '',
      must_not_predict: true,
      reputation_is_not_scored: true,
      max_sentences: input.maxSentences ?? 3,
    },
  };
}
