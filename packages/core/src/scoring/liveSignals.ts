/**
 * The live-market intelligence signals.
 *
 * This model answers "is this a good rate right now, and are these good dates"
 * using only rates that exist today. It does NOT predict. Nothing here may
 * produce a claim about where a price is going — see the note on
 * `composeLiveScore`.
 *
 * Three signals:
 *
 *   S1  Comp-Set Index   this hotel vs its live comp set, same stay
 *   S2  Calendar Delta   these dates vs nearby bookable dates, same hotel/room
 *   S3  Compression      how much of the comp set is still bookable
 *
 * Each returns `available: false` with a reason rather than a neutral number
 * when it cannot be measured. A signal scored 50 because nothing was known is
 * indistinguishable from one measured at 50 — the same error as rendering an
 * absent score as zero.
 */

import type { CompMatchStrength } from '../normalize/compMatch.js';
import type { Minor } from '../money.js';
import { median } from '../stats.js';
import type { ScoringConfig } from '../config/defaults.js';

export type LiveSignalCode = 'S1_COMP_SET' | 'S2_CALENDAR' | 'S3_COMPRESSION';

export type LiveSignalUnavailableReason =
  | 'NO_SUBJECT_RATE'
  | 'INSUFFICIENT_COMPARABLES'
  | 'INSUFFICIENT_NEIGHBOURS'
  | 'NO_AVAILABILITY_DATA';

export interface LiveSignal {
  readonly code: LiveSignalCode;
  readonly name: string;
  readonly available: boolean;
  /** 0–100, higher is better value. Null when unavailable. */
  readonly subScore: number | null;
  readonly weight: number;
  /** Weight actually applied after renormalization. */
  readonly weightApplied: number;
  readonly unavailableReason: LiveSignalUnavailableReason | null;
}

function unavailable(
  code: LiveSignalCode,
  name: string,
  weight: number,
  reason: LiveSignalUnavailableReason,
): LiveSignal {
  return {
    code,
    name,
    available: false,
    subScore: null,
    weight,
    weightApplied: 0,
    unavailableReason: reason,
  };
}

/** Map a value onto 0–100 given the points at which it scores 0 and 100. */
function scale(value: number, atZero: number, atFull: number): number {
  if (atZero === atFull) return 50;
  const t = (value - atZero) / (atFull - atZero);
  return Math.max(0, Math.min(100, Math.round(t * 100)));
}

// ── S1 · Comp-Set Index ────────────────────────────────────────────────────

export type CsiBand = 'STRONG_VALUE' | 'MARKET_RATE' | 'PREMIUM';

export interface CompetitorRate {
  readonly hotelId: string;
  readonly name: string;
  readonly nightlyMinor: Minor;
  readonly observedAt: string;
  /** False when the hotel was checked and had no inventory. */
  readonly isAvailable: boolean;
  /**
   * The per-night cash value of what this rate INCLUDES — breakfast, a
   * property credit, an upgrade, late checkout — already discounted by each
   * benefit's realization factor. Undefined means "we do not know what this
   * hotel includes", which is NOT the same as "it includes nothing" and must
   * never be scored as zero. See computePremiumJustification.
   */
  readonly benefitValuePerNightMinor?: Minor;
}

export interface CompSetResult {
  readonly signal: LiveSignal;
  /**
   * How much of the cross-hotel match rested on stated terms.
   *
   * Carried on the result rather than inferred downstream, because a caller
   * that has to reconstruct it will eventually forget to — and the failure
   * mode is a comparison presented as firmer than it is. See compMatch.ts.
   */
  readonly matchStrength: CompMatchStrength;
  /** Dimensions the source left unstated on both sides of the comparison. */
  readonly unknownDimensions: readonly string[];
  /** subject ÷ median competitor × 100. Null when unavailable. */
  readonly csi: number | null;
  readonly band: CsiBand | null;
  /** Positive means the subject is cheaper than the competitor median. */
  readonly pctBelowMedian: number | null;
  readonly medianCompetitorNightlyMinor: Minor | null;
  readonly compsUsed: number;
  /** Checked but excluded because they were sold out or stale. */
  readonly compsExcluded: number;
}

/**
 * How this hotel's live rate compares with its comp set for the same stay.
 *
 * Every competitor must be live-validated: a rate that is missing, zero, older
 * than `maxCompAgeHours`, or attached to a sold-out hotel is EXCLUDED, never
 * substituted. A guessed competitor rate moves the median, and the median is
 * the whole benchmark.
 */
export function computeCompSetIndex(
  subjectNightlyMinor: Minor,
  competitors: readonly CompetitorRate[],
  config: ScoringConfig,
  now: Date,
  /**
   * How the competitors were matched. Defaults to RESOLVED so existing
   * callers and fixtures keep their meaning; the loader passes the real value.
   */
  match: { strength: CompMatchStrength; unknown: readonly string[] } = {
    strength: 'RESOLVED',
    unknown: [],
  },
  /**
   * When supplied, the sub-score is computed on the EFFECTIVE ratio — both
   * sides net of what their rates include — instead of the raw price ratio.
   *
   * This is the contextual price penalty. A hotel 30% dearer that includes
   * enough to cover most of the gap is not 30% dearer to the guest, and the
   * raw ratio says it is. Only supplied when both sides' inclusions are
   * actually known; otherwise the penalty is exactly what it always was.
   *
   * The BANDS stay on the raw CSI on purpose: "priced above comparable
   * hotels" is a fact about the price, and a guest comparing our label to the
   * two numbers on screen must not find it arguing with them.
   */
  effectiveCsi: number | null = null,
): CompSetResult {
  const cfg = config.live.csi;
  const weight = config.live.weight.compSet;
  const name = 'Comparable hotels';
  const empty = {
    csi: null,
    band: null,
    pctBelowMedian: null,
    medianCompetitorNightlyMinor: null,
    matchStrength: match.strength,
    unknownDimensions: match.unknown,
  } as const;

  if (!Number.isFinite(subjectNightlyMinor) || subjectNightlyMinor <= 0) {
    return {
      signal: unavailable('S1_COMP_SET', name, weight, 'NO_SUBJECT_RATE'),
      ...empty,
      compsUsed: 0,
      compsExcluded: 0,
    };
  }

  const maxAgeMs = cfg.maxCompAgeHours * 3_600_000;
  const usable = competitors.filter((c) => {
    if (!c.isAvailable) return false;
    if (!Number.isFinite(c.nightlyMinor) || c.nightlyMinor <= 0) return false;
    const age = now.getTime() - Date.parse(c.observedAt);
    return Number.isFinite(age) && age <= maxAgeMs;
  });
  const excluded = competitors.length - usable.length;

  if (usable.length < cfg.minComps) {
    return {
      signal: unavailable('S1_COMP_SET', name, weight, 'INSUFFICIENT_COMPARABLES'),
      ...empty,
      compsUsed: usable.length,
      compsExcluded: excluded,
    };
  }

  const compMedian = median(usable.map((c) => c.nightlyMinor));
  const csi = (subjectNightlyMinor / compMedian) * 100;
  const pctBelowMedian = ((compMedian - subjectNightlyMinor) / compMedian) * 100;

  const band: CsiBand =
    csi <= cfg.strongValueMax ? 'STRONG_VALUE' : csi <= cfg.fairMax ? 'MARKET_RATE' : 'PREMIUM';

  return {
    signal: {
      code: 'S1_COMP_SET',
      name,
      available: true,
      subScore: scale(effectiveCsi ?? csi, cfg.scoreAtCsi.zero, cfg.scoreAtCsi.full),
      weight,
      weightApplied: 0,
      unavailableReason: null,
    },
    matchStrength: match.strength,
    unknownDimensions: match.unknown,
    csi,
    band,
    pctBelowMedian,
    medianCompetitorNightlyMinor: Math.round(compMedian),
    compsUsed: usable.length,
    compsExcluded: excluded,
  };
}

// ── S2 · Calendar Delta ────────────────────────────────────────────────────

export type CalendarBand = 'DIP' | 'NORMAL' | 'COMPRESSED';

export interface NearbyDateRate {
  readonly checkIn: string;
  readonly nightlyMinor: Minor;
  /** True when this stay starts on the same weekday as the subject's. */
  readonly sameDow: boolean;
  readonly observedAt: string;
}

export interface CalendarResult {
  readonly signal: LiveSignal;
  /** (subject − nearby) ÷ nearby × 100. Negative means cheaper. */
  readonly deltaPct: number | null;
  readonly band: CalendarBand | null;
  readonly medianNearbyNightlyMinor: Minor | null;
  readonly neighboursUsed: number;
  /** True when the comparison used same-weekday neighbours only. */
  readonly sameDowOnly: boolean;
}

/**
 * How the selected dates compare with nearby bookable dates for the same room.
 *
 * Same-weekday neighbours are used ALONE when there are enough of them. A
 * Thursday–Sunday stay measured against a Monday–Thursday one is measuring the
 * weekend, not the dates — the caller is expected to have already matched
 * hotel, room, occupancy and length of stay.
 *
 * This is a statement about prices that exist right now on other dates. It is
 * NOT a forecast about the selected dates.
 */
export function computeCalendarDelta(
  subjectNightlyMinor: Minor,
  neighbours: readonly NearbyDateRate[],
  config: ScoringConfig,
): CalendarResult {
  const cfg = config.live.calendar;
  const weight = config.live.weight.calendar;
  const name = 'Nearby dates';
  const empty = { deltaPct: null, band: null, medianNearbyNightlyMinor: null } as const;

  if (!Number.isFinite(subjectNightlyMinor) || subjectNightlyMinor <= 0) {
    return {
      signal: unavailable('S2_CALENDAR', name, weight, 'NO_SUBJECT_RATE'),
      ...empty,
      neighboursUsed: 0,
      sameDowOnly: false,
    };
  }

  const valid = neighbours.filter((n) => Number.isFinite(n.nightlyMinor) && n.nightlyMinor > 0);
  const sameDow = valid.filter((n) => n.sameDow);

  // Same-weekday alone if it clears the bar; otherwise everything, and the
  // caller is told which happened so the copy can be honest about it.
  const useSameDowOnly = cfg.preferSameDow && sameDow.length >= cfg.minNeighbours;
  const pool = useSameDowOnly ? sameDow : valid;

  if (pool.length < cfg.minNeighbours) {
    return {
      signal: unavailable('S2_CALENDAR', name, weight, 'INSUFFICIENT_NEIGHBOURS'),
      ...empty,
      neighboursUsed: pool.length,
      sameDowOnly: useSameDowOnly,
    };
  }

  const nearbyMedian = median(pool.map((n) => n.nightlyMinor));
  const deltaPct = ((subjectNightlyMinor - nearbyMedian) / nearbyMedian) * 100;

  const band: CalendarBand =
    deltaPct <= cfg.dipMax ? 'DIP' : deltaPct <= cfg.normalMax ? 'NORMAL' : 'COMPRESSED';

  return {
    signal: {
      code: 'S2_CALENDAR',
      name,
      available: true,
      subScore: scale(deltaPct, cfg.delta.zero, cfg.delta.full),
      weight,
      weightApplied: 0,
      unavailableReason: null,
    },
    deltaPct,
    band,
    medianNearbyNightlyMinor: Math.round(nearbyMedian),
    neighboursUsed: pool.length,
    sameDowOnly: useSameDowOnly,
  };
}

// ── S3 · Market compression ────────────────────────────────────────────────

export type CompressionBand = 'TIGHT' | 'MODERATE' | 'SOFT';

export interface CompressionInput {
  /** Comp-set hotels checked for this exact stay. */
  readonly checked: number;
  /** Of those, how many had no inventory. */
  readonly soldOut: number;
}

export interface CompressionResult {
  readonly signal: LiveSignal;
  readonly soldOutShare: number | null;
  readonly band: CompressionBand | null;
  readonly checked: number;
  readonly soldOut: number;
}

/**
 * How much of the comparable market is still bookable.
 *
 * A hotel priced below its comp set means more when most of that set is gone.
 * The evidence is real: the source answers status 204 for a sold-out stay, and
 * the collector records it per hotel and date.
 *
 * Absent evidence the signal is omitted and its weight is redistributed. It is
 * never inferred from a missing rate — a hotel we failed to reach is not a
 * hotel that is sold out.
 */
export function computeCompression(
  input: CompressionInput | null | undefined,
  config: ScoringConfig,
): CompressionResult {
  const cfg = config.live.compression;
  const weight = config.live.weight.compression;
  const name = 'Market availability';

  if (!input || input.checked < cfg.minChecked) {
    return {
      signal: unavailable('S3_COMPRESSION', name, weight, 'NO_AVAILABILITY_DATA'),
      soldOutShare: null,
      band: null,
      checked: input?.checked ?? 0,
      soldOut: input?.soldOut ?? 0,
    };
  }

  const share = input.soldOut / input.checked;
  const band: CompressionBand =
    share >= cfg.tightMin ? 'TIGHT' : share <= cfg.softMax ? 'SOFT' : 'MODERATE';

  // A tight market makes an already-good rate more notable; a soft one makes it
  // less so. This signal modulates, so its range is deliberately narrow — it
  // must not be able to carry a verdict on its own.
  const subScore = band === 'TIGHT' ? 85 : band === 'MODERATE' ? 55 : 35;

  return {
    signal: {
      code: 'S3_COMPRESSION',
      name,
      available: true,
      subScore,
      weight,
      weightApplied: 0,
      unavailableReason: null,
    },
    soldOutShare: share,
    band,
    checked: input.checked,
    soldOut: input.soldOut,
  };
}

// ── Premium Justification ──────────────────────────────────────────────────
//
// "This hotel is expensive, therefore it is bad" is the failure mode this
// exists to remove. The Comp-Set Index is a PRICE ratio: a hotel 30% above its
// comp set scores zero on the largest component of the live score, whatever it
// offers for the money. That is right for a value question and wrong for the
// question a guest actually asks about a premium property.
//
// ── What we can honestly measure, and what we cannot ──────────────────────
//
// The brief lists ratings, service, spa, dining and amenities. Measured
// 2026-08-21, NONE of them are available to us:
//
//   - `hotel.star_rating` and `hotel.luxury_tier` are never written by any
//     catalogue sync, because no endpoint returns them.
//   - Guest ratings appear in no endpoint at all.
//   - Amenities, dining and policies exist only behind `method=info`, which
//     answers 500 for our API key on every hotel tried (7/7).
//
// What IS real, validated and substantial is what each rate INCLUDES: the
// preferred-partner benefits — breakfast for two, a property credit, an
// upgrade, late checkout — parsed from the source's own `perks` array, valued
// with realization factors, and already the basis of factor F6. The catalogue
// sweep wrote 9,259 of them.
//
// So justification is measured in MONEY, against money. A hotel charging $100
// more per night while including $150 of value the others do not is not
// expensive; it is cheaper, and the raw price ratio says the opposite. That is
// a real quality-and-experience differential, brand-agnostic by construction,
// and it needs no invented units to compare against a price premium.
//
// When neither side's inclusions are known we say LIMITED_DATA and leave the
// price penalty exactly as it was. Absence of evidence never becomes evidence
// of a justified premium — that would be flattery, and the guest is the one
// who pays for it.

export type PremiumLevel = 'HIGH' | 'MODERATE' | 'LOW' | 'NOT_PREMIUM' | 'LIMITED_DATA';

/**
 * Structurally identical to LiveConfidence in liveScore.ts, declared here
 * rather than imported: liveScore already imports this module, and the cycle
 * is not worth one type alias.
 */
export type PremiumConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface PremiumJustificationResult {
  /** How much dearer than the comp median, as a percentage. Negative = cheaper. */
  readonly premiumPct: number | null;
  /**
   * The share of that premium covered by value this rate includes and the
   * comparables do not, as a percentage of the comp median. Null when neither
   * side's inclusions are known.
   */
  readonly coveredPct: number | null;
  readonly level: PremiumLevel;
  readonly confidence: PremiumConfidence;
  /** The comp median once both sides are net of what they include. */
  readonly effectiveCsi: number | null;
  readonly subjectBenefitPerNightMinor: Minor | null;
  readonly medianCompBenefitPerNightMinor: Minor | null;
  /** How many comparables told us what they include. */
  readonly compsWithBenefits: number;
}

/**
 * Is the premium supported by what the rate includes?
 *
 * Deliberately NOT a weighted factor competing for score. It reports a verdict
 * of its own (§7 — Value and Overall must not collapse into one number) and it
 * modulates the price penalty through the effective CSI, which is the same
 * comparison run on the price the guest effectively pays.
 */
export function computePremiumJustification(
  subjectNightlyMinor: Minor,
  subjectBenefitPerNightMinor: Minor | null,
  competitors: readonly CompetitorRate[],
  config: ScoringConfig,
): PremiumJustificationResult {
  const cfg = config.live.premium;
  const usable = competitors.filter(
    (c) => c.isAvailable && Number.isFinite(c.nightlyMinor) && c.nightlyMinor > 0,
  );

  const none: PremiumJustificationResult = {
    premiumPct: null,
    coveredPct: null,
    level: 'LIMITED_DATA',
    confidence: 'LOW',
    effectiveCsi: null,
    subjectBenefitPerNightMinor: subjectBenefitPerNightMinor,
    medianCompBenefitPerNightMinor: null,
    compsWithBenefits: 0,
  };

  if (usable.length < config.live.csi.minComps || subjectNightlyMinor <= 0) return none;

  const compMedian = median(usable.map((c) => c.nightlyMinor));
  if (compMedian <= 0) return none;
  const premiumPct = ((subjectNightlyMinor - compMedian) / compMedian) * 100;

  // Cheaper than the comp set: there is no premium to justify. Say so plainly
  // rather than inventing a verdict about a question nobody asked.
  if (premiumPct <= cfg.premiumThresholdPct) {
    return {
      ...none,
      premiumPct,
      level: 'NOT_PREMIUM',
      confidence: 'HIGH',
      effectiveCsi: (subjectNightlyMinor / compMedian) * 100,
    };
  }

  // Only comparables that actually told us what they include may speak to what
  // the market includes. A comp with no benefit data is silent, not zero.
  const known = usable.filter((c) => typeof c.benefitValuePerNightMinor === 'number');
  const compsWithBenefits = known.length;
  const haveEvidence = subjectBenefitPerNightMinor !== null && compsWithBenefits > 0;

  if (!haveEvidence) {
    // The common case today, and the honest one: we can see the price gap and
    // nothing about what either side gives for it. The penalty stands.
    return { ...none, premiumPct, level: 'LIMITED_DATA', confidence: 'LOW' };
  }

  const medianCompBenefit = median(known.map((c) => c.benefitValuePerNightMinor as number));
  const subjectBenefit = subjectBenefitPerNightMinor as number;

  // Net of what each side includes. Both sides adjusted, or it is not a
  // comparison — discounting only the subject would be exactly the brand
  // favouritism this must not do.
  const effectiveSubject = Math.max(0, subjectNightlyMinor - subjectBenefit);
  const effectiveComp = Math.max(1, compMedian - medianCompBenefit);
  const effectiveCsi = (effectiveSubject / effectiveComp) * 100;

  const coveredPct = ((subjectBenefit - medianCompBenefit) / compMedian) * 100;
  const share = coveredPct / premiumPct;

  const level: PremiumLevel =
    share >= cfg.highCoverShare ? 'HIGH' : share >= cfg.moderateCoverShare ? 'MODERATE' : 'LOW';

  // Thin evidence is still evidence, but it is not certainty. One comparable
  // stating its inclusions cannot carry a confident verdict about a market.
  const confidence: PremiumConfidence =
    compsWithBenefits >= cfg.confidentCompsWithBenefits && usable.length >= cfg.confidentComps
      ? 'HIGH'
      : compsWithBenefits >= 2
        ? 'MEDIUM'
        : 'LOW';

  return {
    premiumPct,
    coveredPct,
    level,
    confidence,
    effectiveCsi,
    subjectBenefitPerNightMinor: subjectBenefit,
    medianCompBenefitPerNightMinor: medianCompBenefit,
    compsWithBenefits,
  };
}
