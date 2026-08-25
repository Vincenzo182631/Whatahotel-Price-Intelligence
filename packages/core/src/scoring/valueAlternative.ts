/**
 * Phase 5's two deterministic additions: where the selected room sits in the
 * hotel's CURRENTLY AVAILABLE inventory, and which comparable — if any — is
 * a genuinely relevant lower-priced alternative.
 *
 * Both are pure functions over data the pipeline already fetches. Neither
 * consults a model, and neither will ever claim more than the data shows.
 *
 * ── Why availability position exists ──────────────────────────────────────
 *
 * "This hotel is expensive" and "only this hotel's expensive categories are
 * available right now" are different situations that look identical in a
 * price ratio. A property whose entry-level rooms have gone, leaving a
 * suite as the available inventory, will show a huge premium against
 * comparables still selling entry-level rooms — and reading that premium as
 * the hotel's pricing would be wrong about the hotel. This signal separates
 * the two WITHOUT guessing: it reports what is available, what the catalogue
 * carries, and nothing about why the difference exists.
 *
 * The sold-out rule is absolute: a category absent from today's availability
 * is "currently unavailable", never "sold out". The source tells us a WHOLE
 * STAY is sold out (status 204); it never says that about an individual
 * category, so neither do we.
 */

import type { Minor } from '../types.js';

/** Coarse category tiers, for "is this a higher category than entry-level". */
const CLASS_RANK: Readonly<Record<string, number>> = {
  ROOM: 0,
  JUNIOR_SUITE: 1,
  SUITE: 2,
  VILLA: 3,
  RESIDENCE: 3,
  PENTHOUSE: 4,
  UNKNOWN: 1,
};

export interface AvailableCategory {
  readonly roomClass: string;
  readonly nightlyMinor: Minor;
}

export interface AvailabilityPosition {
  /** Where the selected rate sits among currently available categories. */
  readonly position: 'ENTRY' | 'MID' | 'TOP' | null;
  readonly availableCategories: number;
  readonly cheaperCategoriesAvailable: number;
  /** Is any entry-class (ROOM) category currently available at this hotel? */
  readonly entryClassAvailable: boolean;
  /**
   * True when the catalogue holds entry-class categories for this hotel but
   * none is currently available — the situation where a high available rate
   * is about inventory, not pricing. False whenever we cannot SHOW the
   * catalogued lower class exists: absence of evidence never becomes a claim.
   */
  readonly lowerCategoriesUnavailable: boolean;
  /** The whole premium read may be an inventory artefact. */
  readonly availabilityInfluenced: boolean;
}

export function assessAvailabilityPosition(
  selectedNightlyMinor: Minor,
  selectedRoomClass: string,
  availableRooms: readonly AvailableCategory[],
  cataloguedClasses: readonly string[],
): AvailabilityPosition {
  const count = availableRooms.length;
  if (count === 0) {
    return {
      position: null,
      availableCategories: 0,
      cheaperCategoriesAvailable: 0,
      entryClassAvailable: false,
      lowerCategoriesUnavailable: false,
      availabilityInfluenced: false,
    };
  }

  const cheaper = availableRooms.filter((r) => r.nightlyMinor < selectedNightlyMinor).length;
  const dearer = availableRooms.filter((r) => r.nightlyMinor > selectedNightlyMinor).length;
  const position: 'ENTRY' | 'MID' | 'TOP' = cheaper === 0 ? 'ENTRY' : dearer === 0 ? 'TOP' : 'MID';

  const entryClassAvailable = availableRooms.some((r) => (CLASS_RANK[r.roomClass] ?? 1) === 0);
  const cataloguedHasEntry = cataloguedClasses.some((c) => (CLASS_RANK[c] ?? 1) === 0);
  const selectedRank = CLASS_RANK[selectedRoomClass] ?? 1;

  // The claim needs BOTH halves proven: the catalogue carries an entry class,
  // and none of it is available today. A hotel that simply has no entry-class
  // rooms at all is not "sold out of them".
  const lowerCategoriesUnavailable = cataloguedHasEntry && !entryClassAvailable;

  return {
    position,
    availableCategories: count,
    cheaperCategoriesAvailable: cheaper,
    entryClassAvailable,
    lowerCategoriesUnavailable,
    // Influenced when the guest is looking at the cheapest thing the hotel
    // can currently offer AND that cheapest thing is a higher category than
    // the hotel's own entry level. A guest who CHOSE the suite from a menu
    // that still has entry rooms is not in this situation.
    availabilityInfluenced: position === 'ENTRY' && selectedRank > 0 && lowerCategoriesUnavailable,
  };
}

// ── The better-value alternative ──────────────────────────────────────────

export interface AlternativeCandidate {
  /** The source's hotel id — what the API answers for. */
  readonly wahHotelId: string;
  readonly name: string;
  readonly nightlyMinor: Minor;
  readonly isAvailable: boolean;
  readonly rating?: number | null;
  readonly reviewCount?: number | null;
}

export interface ValueAlternative {
  readonly wahHotelId: string;
  readonly name: string;
  readonly nightlyMinor: Minor;
  readonly saveNightlyMinor: Minor;
  readonly rating: number | null;
  readonly reviewCount: number | null;
}

/**
 * How the saving/reputation blend tilts for a stated preference (Phase 6).
 *
 * The eligibility rule NEVER moves — a preference cannot conjure an
 * alternative that is not genuinely cheaper — only the ranking among
 * already-eligible candidates does. A value-focused guest weighs the saving
 * harder; an experience-focused guest weighs verified reputation harder;
 * everyone else gets the Phase 5 default unchanged.
 */
const ALTERNATIVE_WEIGHTS: Readonly<Record<string, { saving: number; reputation: number }>> = {
  BEST_VALUE: { saving: 0.7, reputation: 0.3 },
  LUXURY_EXPERIENCE: { saving: 0.3, reputation: 0.7 },
};
const DEFAULT_ALTERNATIVE_WEIGHTS = { saving: 0.55, reputation: 0.45 };

/**
 * The most RELEVANT lower-priced comparable, which is deliberately not the
 * cheapest one.
 *
 * Eligible: currently available and at least 10% below the selected rate —
 * below that the "alternative" is noise wearing a discount. Ranked by a
 * blend of saving and verified reputation, where reputation counts only as
 * far as its review volume earns: a 4.9 from 30 reviews is weaker evidence
 * than a 4.5 from 5,000, and an unrated hotel sits at a neutral floor rather
 * than zero — unrated is unknown, not bad.
 *
 * Null when nothing qualifies. The widget shows nothing rather than
 * stretching for an alternative that is not really one.
 */
export function chooseAlternative(
  subjectNightlyMinor: Minor,
  candidates: readonly AlternativeCandidate[],
  preference?: string,
): ValueAlternative | null {
  const eligible = candidates.filter(
    (c) => c.isAvailable && c.nightlyMinor <= subjectNightlyMinor * 0.9 && c.nightlyMinor > 0,
  );
  if (eligible.length === 0) return null;

  const weights =
    (preference !== undefined ? ALTERNATIVE_WEIGHTS[preference] : undefined) ??
    DEFAULT_ALTERNATIVE_WEIGHTS;

  const score = (c: AlternativeCandidate): number => {
    const savingShare = (subjectNightlyMinor - c.nightlyMinor) / subjectNightlyMinor;
    let reputation = 0.5; // unknown: neutral, never zero
    if (c.rating != null && c.rating > 0) {
      const volume = Math.min(1, Math.log10(Math.max(1, c.reviewCount ?? 1)) / 3.5);
      reputation = (c.rating / 5) * (0.5 + 0.5 * volume);
    }
    return savingShare * weights.saving + reputation * weights.reputation;
  };

  let best = eligible[0] as AlternativeCandidate;
  for (const c of eligible) if (score(c) > score(best)) best = c;

  return {
    wahHotelId: best.wahHotelId,
    name: best.name,
    nightlyMinor: best.nightlyMinor,
    saveNightlyMinor: subjectNightlyMinor - best.nightlyMinor,
    rating: best.rating ?? null,
    reviewCount: best.reviewCount ?? null,
  };
}

// ── The SUPERIOR alternative (upsell, never downsell) ─────────────────────

export interface SuperiorCandidate {
  readonly wahHotelId: string;
  readonly name: string;
  readonly nightlyMinor: Minor;
  readonly isAvailable: boolean;
  readonly rating: number | null;
  readonly reviewCount: number | null;
  /** Review themes measured by the sweep, when held. Evidence for the pitch. */
  readonly themes?: readonly string[];
}

export interface SuperiorAlternative {
  readonly wahHotelId: string;
  readonly name: string;
  readonly nightlyMinor: Minor;
  /** Positive when the superior hotel costs MORE per night (the usual upsell). */
  readonly priceDeltaNightlyMinor: Minor;
  readonly rating: number;
  readonly reviewCount: number | null;
  readonly themes: readonly string[];
}

/** One room upgrade at the SAME property — the non-competing recommendation. */
export interface RoomUpgrade {
  readonly roomTypeId: number;
  readonly name: string;
  readonly roomClass: string;
  readonly nightlyMinor: Minor;
  readonly priceDeltaNightlyMinor: Minor;
}

/**
 * The business rule, in code where prompts cannot lose it: a guest already
 * booking a Four Seasons is never pointed at another hotel. Matching is on
 * the property name because that is what the catalogue carries; it is
 * deliberately broad (any spelling that contains the brand words).
 */
export function isProtectedBrand(hotelName: string): boolean {
  return /four\s*seasons/i.test(hotelName);
}

/**
 * A genuinely SUPERIOR comparable — the upsell, chosen by verified guest
 * standing, never by price.
 *
 * Eligible: currently available, rated meaningfully ABOVE the subject
 * (at least +0.15 when the subject has a rating; at least 4.5 when it does
 * not) on a review volume that means something (200+), and priced AT OR
 * ABOVE the guest's current nightly rate. The price floor is the upsell
 * contract (owner rule, 2026-08-25): a "step up" that undercuts the booking
 * reads as a contradiction, not a bargain — doubly so because the
 * candidate's rate comes from the comp set, which at a relaxed room-match
 * rung may be the competitor's entry-level category shown against the
 * guest's suite. Price still does not RANK candidates — among those at or
 * above the floor, the volume-weighted rating decides. Null when no
 * candidate clears every bar — the section hides rather than stretches —
 * and ALWAYS null for a protected brand: the rule lives here, not in a
 * prompt.
 */
export function chooseSuperiorAlternative(
  subject: {
    readonly hotelName: string;
    readonly nightlyMinor: Minor;
    readonly rating: number | null;
  },
  candidates: readonly SuperiorCandidate[],
): SuperiorAlternative | null {
  if (isProtectedBrand(subject.hotelName)) return null;

  const bar = subject.rating !== null ? subject.rating + 0.15 : 4.5;
  // Note: a candidate that itself IS a protected brand stays eligible —
  // upselling INTO a Four Seasons is not the failure mode. The rule only
  // protects the guest's existing selection.
  const eligible = candidates.filter(
    (c) =>
      c.isAvailable &&
      c.rating !== null &&
      c.rating >= bar &&
      (c.reviewCount ?? 0) >= 200 &&
      c.nightlyMinor >= subject.nightlyMinor,
  );

  if (eligible.length === 0) return null;

  const strength = (c: SuperiorCandidate): number => {
    const volume = Math.min(1, Math.log10(Math.max(1, c.reviewCount ?? 1)) / 3.5);
    return ((c.rating ?? 0) / 5) * (0.5 + 0.5 * volume);
  };
  let best = eligible[0] as SuperiorCandidate;
  for (const c of eligible) if (strength(c) > strength(best)) best = c;

  return {
    wahHotelId: best.wahHotelId,
    name: best.name,
    nightlyMinor: best.nightlyMinor,
    priceDeltaNightlyMinor: best.nightlyMinor - subject.nightlyMinor,
    rating: best.rating as number,
    reviewCount: best.reviewCount ?? null,
    themes: best.themes ?? [],
  };
}

/**
 * The room upgrade at the SAME property: the cheapest available room in a
 * HIGHER category than the one selected. Null when the guest is already in
 * the top category on offer. This is the recommendation that can never
 * compete with the booking — it deepens it.
 */
export function chooseRoomUpgrade(
  selectedRoomClass: string,
  selectedNightlyMinor: Minor,
  availableRooms: readonly {
    readonly roomTypeId: number;
    readonly name: string;
    readonly roomClass: string;
    readonly nightlyMinor: Minor;
  }[],
): RoomUpgrade | null {
  const selectedRank = CLASS_RANK[selectedRoomClass] ?? 1;
  const upgrades = availableRooms.filter(
    (r) => (CLASS_RANK[r.roomClass] ?? 1) > selectedRank && r.nightlyMinor > selectedNightlyMinor,
  );
  if (upgrades.length === 0) return null;
  let best = upgrades[0] as (typeof upgrades)[number];
  for (const r of upgrades) if (r.nightlyMinor < best.nightlyMinor) best = r;
  return {
    roomTypeId: best.roomTypeId,
    name: best.name,
    roomClass: best.roomClass,
    nightlyMinor: best.nightlyMinor,
    priceDeltaNightlyMinor: best.nightlyMinor - selectedNightlyMinor,
  };
}
