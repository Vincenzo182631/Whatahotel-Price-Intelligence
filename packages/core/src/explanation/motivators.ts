/**
 * Which travel motivators this property actually supports, and the evidence
 * for each.
 *
 * Owner requirement (2026-09-18): for every one of the ten motivators the
 * preference selector offers, say whether the hotel supports it, does not,
 * or whether the evidence is thin — and let a guest see WHY rather than a
 * bare label.
 *
 * ── The line this file walks ─────────────────────────────────────────────
 *
 * Mapping evidence to a motivator is an inference, and rule 31 says name the
 * amenity rather than infer what it means. Those are reconcilable, and the
 * reconciliation is the whole design: **the evidence is published with the
 * verdict, always.** A guest reading
 *
 *     Family — SUPPORTED
 *       · Rooms list cribs and connecting rooms
 *       · Recent reviewers mention family stays
 *
 * can weigh the inference for themselves, and can disagree with it. That is a
 * different act from printing "Good for families" over a hidden rule, which
 * is what rule 30 caught in Places: `goodForChildren` was true for all 20
 * hotels sampled, and the label would have been identical on every property
 * in the catalogue with nothing a reader could check.
 *
 * So: no verdict without at least one citable evidence line. A motivator with
 * nothing behind it is LIMITED_EVIDENCE, and LIMITED_EVIDENCE is never
 * dressed up as a soft yes.
 *
 * ── Why there is no general "DOES NOT HAVE" ──────────────────────────────
 *
 * Owner decision, 2026-09-18, and it is rule 28's line held in a new place.
 * "We found no business centre" is a statement about our research, not about
 * the hotel. Measured tonight: 2,012 of the hotels we asked returned an
 * empty amenity list, which says nothing whatever about what they offer. A
 * red mark earned that way is a false negative on a property the site sells,
 * and it is permanent in the guest's mind in a way a missing row is not.
 *
 * `MEASURED_ABSENT` therefore exists but is reserved for absence we can
 * actually compute — a distance, a count, a stated term — and is never
 * produced by failing to find something. Nothing emits it yet; the geography
 * it needs (coastline distance, district proximity) is not data we hold.
 * The state is declared so the API contract does not change when it arrives.
 */
import type { Preference } from './preference.js';

export type MotivatorVerdict = 'SUPPORTED' | 'MEASURED_ABSENT' | 'LIMITED_EVIDENCE';

/** Where a piece of evidence came from, so a reader can weigh it. */
export type MotivatorEvidenceSource =
  | 'ROOM_AMENITY' // the source's own coded room amenity (rule 29)
  | 'HOTEL_PERK' // the source's stated inclusions
  | 'REVIEW_THEME' // measured over Google's positive reviews
  | 'GOOGLE_RATING'
  | 'ROOM_CATEGORY' // class and view, normalized by us (rule 11)
  | 'DEAL_SCORE'; // the comparison itself, for the value motivators

export interface MotivatorEvidence {
  readonly text: string;
  readonly source: MotivatorEvidenceSource;
}

export interface MotivatorAssessment {
  readonly motivator: Preference;
  readonly verdict: MotivatorVerdict;
  /** Never empty when SUPPORTED. Empty is what LIMITED_EVIDENCE means. */
  readonly evidence: readonly MotivatorEvidence[];
}

/**
 * Amenity labels that speak to a motivator, matched case-insensitively as
 * substrings of the source's own wording.
 *
 * Deliberately NARROW. A loose match is worse than no match: "Telephone"
 * under Business Travel would technically fire and would tell a guest
 * nothing, which is rule 9's failure and the reason rule 31 filters on
 * rarity before any of this runs. Every entry here had to be a label whose
 * presence a reader would accept as relevant on sight, because the reader
 * sees it.
 *
 * Motivators absent from this map take no evidence from amenities at all.
 */
const AMENITY_SIGNALS: Partial<Record<Preference, readonly string[]>> = {
  FAMILY: ['crib', 'connecting room', 'sofa bed', 'rollaway'],
  BUSINESS_TRAVEL: ['large desk', 'desk with electrical outlet', 'multi-line phone', 'work'],
  QUIET_RELAXATION: ['bathrobe', 'slipper', 'turn down service', 'pillow top'],
  LUXURY_EXPERIENCE: [
    'marble bathroom',
    'turn down service',
    'upgraded bathroom amenities',
    'butler',
  ],
  AMENITIES: [], // handled by breadth below, not by keyword
  BEACH_RESORT: ['outdoor space', 'balcony', 'terrace'],
};

/** Review themes that speak to a motivator. Keys come from THEME_PROSE. */
const THEME_SIGNALS: Partial<Record<Preference, readonly string[]>> = {
  BEACH_RESORT: ['beach', 'pool', 'grounds'],
  QUIET_RELAXATION: ['quiet', 'spa'],
  FAMILY: ['family'],
  LOCATION: ['location'],
  LUXURY_EXPERIENCE: ['service', 'rooms'],
  NIGHTLIFE: ['dining'],
  AMENITIES: ['pool', 'spa', 'dining'],
};

const THEME_WORDS: Readonly<Record<string, string>> = {
  beach: 'the beach',
  pool: 'the pool',
  spa: 'the spa',
  quiet: 'the quiet atmosphere',
  family: 'family stays',
  location: 'the location',
  service: 'service',
  rooms: 'the rooms',
  dining: 'dining',
  grounds: 'the grounds',
};

export interface MotivatorInput {
  readonly roomAmenities: readonly string[];
  readonly reviewThemes: readonly string[];
  readonly perks: readonly string[];
  readonly rating: number | null;
  readonly comparableMedianRating: number | null;
  /** The live Deal Score, already floored for display, or null. */
  readonly dealScoreOutOfTen: number | null;
}

const ALL_MOTIVATORS: readonly Preference[] = [
  'GENERAL_VALUE',
  'BEST_VALUE',
  'LUXURY_EXPERIENCE',
  'LOCATION',
  'AMENITIES',
  'BEACH_RESORT',
  'FAMILY',
  'NIGHTLIFE',
  'QUIET_RELAXATION',
  'BUSINESS_TRAVEL',
];

/**
 * How many distinct amenities count as a property whose ROOMS are the point.
 * Measured 2026-09-18: the median hotel holds six, so this asks for a list
 * meaningfully longer than typical rather than for a round number.
 */
const AMENITY_BREADTH = 10;

function matchAmenities(
  amenities: readonly string[],
  needles: readonly string[],
): readonly string[] {
  const hit: string[] = [];
  for (const a of amenities) {
    const low = a.toLowerCase();
    if (needles.some((n) => low.includes(n))) hit.push(a);
  }
  return hit;
}

/**
 * Assess every motivator from the evidence held for this hotel.
 *
 * Pure, like everything under core: its inputs are its arguments. The two
 * VALUE motivators are different in kind from the other eight — they are
 * questions about the RATE, which the Deal Score already answers, so they
 * cite the score rather than a property attribute. Saying so is more honest
 * than hunting for a "value" amenity that does not exist.
 */
export function assessMotivators(input: MotivatorInput): readonly MotivatorAssessment[] {
  const out: MotivatorAssessment[] = [];

  for (const motivator of ALL_MOTIVATORS) {
    const evidence: MotivatorEvidence[] = [];

    // ── The two value motivators: the comparison IS the evidence ──
    if (motivator === 'GENERAL_VALUE' || motivator === 'BEST_VALUE') {
      if (input.dealScoreOutOfTen !== null) {
        evidence.push({
          text: `The rate scores ${input.dealScoreOutOfTen} out of 10 against comparable rooms`,
          source: 'DEAL_SCORE',
        });
      }
      if (motivator === 'BEST_VALUE' && input.perks.length > 0) {
        evidence.push({
          text: `The rate includes ${input.perks.slice(0, 3).join(', ').toLowerCase()}`,
          source: 'HOTEL_PERK',
        });
      }
      out.push({
        motivator,
        verdict: evidence.length > 0 ? 'SUPPORTED' : 'LIMITED_EVIDENCE',
        evidence,
      });
      continue;
    }

    // ── Amenities, by breadth rather than by keyword ──
    if (motivator === 'AMENITIES' && input.roomAmenities.length >= AMENITY_BREADTH) {
      evidence.push({
        text: `The source states ${input.roomAmenities.length} room amenities, including ${input.roomAmenities.slice(0, 3).join(', ').toLowerCase()}`,
        source: 'ROOM_AMENITY',
      });
    }

    const amenityHits = matchAmenities(input.roomAmenities, AMENITY_SIGNALS[motivator] ?? []);
    if (amenityHits.length > 0) {
      evidence.push({
        text: `Rooms list ${amenityHits.slice(0, 3).join(', ').toLowerCase()}`,
        source: 'ROOM_AMENITY',
      });
    }

    const themeHits = (THEME_SIGNALS[motivator] ?? []).filter((t) =>
      input.reviewThemes.includes(t),
    );
    if (themeHits.length > 0) {
      const words = themeHits.map((t) => THEME_WORDS[t] ?? t);
      evidence.push({
        text: `Recent reviewers mention ${words.slice(0, 3).join(', ')}`,
        source: 'REVIEW_THEME',
      });
    }

    // A rating supports LUXURY_EXPERIENCE only when it is genuinely above the
    // comparables' median. The inverse claim is never made (rule 22, and the
    // premium-support rule): we do not tell a guest a hotel is worse than its
    // neighbours.
    if (
      motivator === 'LUXURY_EXPERIENCE' &&
      input.rating !== null &&
      input.comparableMedianRating !== null &&
      input.rating > input.comparableMedianRating
    ) {
      evidence.push({
        text: `Rated ${input.rating}, above the ${input.comparableMedianRating} median of its comparables`,
        source: 'GOOGLE_RATING',
      });
    }

    out.push({
      motivator,
      verdict: evidence.length > 0 ? 'SUPPORTED' : 'LIMITED_EVIDENCE',
      evidence,
    });
  }

  return out;
}
