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
): ValueAlternative | null {
  const eligible = candidates.filter(
    (c) => c.isAvailable && c.nightlyMinor <= subjectNightlyMinor * 0.9 && c.nightlyMinor > 0,
  );
  if (eligible.length === 0) return null;

  const score = (c: AlternativeCandidate): number => {
    const savingShare = (subjectNightlyMinor - c.nightlyMinor) / subjectNightlyMinor;
    let reputation = 0.5; // unknown: neutral, never zero
    if (c.rating != null && c.rating > 0) {
      const volume = Math.min(1, Math.log10(Math.max(1, c.reviewCount ?? 1)) / 3.5);
      reputation = (c.rating / 5) * (0.5 + 0.5 * volume);
    }
    return savingShare * 0.55 + reputation * 0.45;
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
