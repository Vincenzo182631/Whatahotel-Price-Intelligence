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
  | 'DEAL_SCORE' // the comparison itself, for the value motivators
  | 'WEBSITE' // read from the property's own site (migration 0022)
  | 'GOOGLE_EDITORIAL' // Google's own description, quoted as Google's (rule 32)
  | 'STREET_ADDRESS'; // the address the hotel's own page states (rule 24)

export interface MotivatorEvidence {
  readonly text: string;
  readonly source: MotivatorEvidenceSource;
  /**
   * Where this can be checked, for WEBSITE evidence. A researched claim
   * without a citation is the thing the research layer exists to prevent, so
   * the type carries the URL rather than trusting a renderer to find it.
   */
  readonly sourceUrl?: string;
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
  /**
   * Claims read from the property's own website (migration 0022), each with
   * the URL it came from. Empty when the hotel has not been researched, which
   * is not a statement about the hotel.
   */
  readonly websiteClaims?: readonly {
    readonly motivator: string;
    readonly claim: string;
    readonly sourceUrl: string;
  }[];
  /**
   * Google's own description of the property (rule 32), on 2,214 of 3,223
   * active hotels. The most varied per-hotel prose this system holds, and
   * until now it informed the hotel-value card and nothing else.
   *
   * It is AREA evidence as much as hotel evidence — Google's summaries
   * routinely place a property ("steps from the beach", "in the historic
   * centre"), which is the class of fact our preference answers were most
   * short of.
   */
  readonly editorialSummary?: string | null;
  /** The street address the hotel's OWN page states (rule 24). */
  readonly streetAddress?: string | null;
}

/**
 * Words in Google's description that speak to a motivator.
 *
 * The same narrowness as AMENITY_SIGNALS and for the same reason: a loose
 * match is worse than none. "Location" would hit every summary ever written;
 * "steps from the beach" is a placement a reader can check against a map.
 *
 * What is matched is GOOGLE'S OWN SENTENCE, and what renders quotes it as
 * Google's (rule 32). The inference is ours and is visible — a reader who
 * disagrees that a beachfront mention means a beach holiday can say so.
 */
const EDITORIAL_SIGNALS: Partial<Record<Preference, readonly string[]>> = {
  BEACH_RESORT: ['beach', 'oceanfront', 'seafront', 'waterfront', 'lagoon', 'shore'],
  LOCATION: [
    'steps from',
    'minutes from',
    'overlooking',
    'historic centre',
    'historic center',
    'downtown',
    'old town',
    'city centre',
    'city center',
    'waterfront',
  ],
  NIGHTLIFE: ['nightlife', 'bars', 'rooftop bar', 'clubs', 'entertainment district'],
  QUIET_RELAXATION: ['secluded', 'tranquil', 'serene', 'peaceful', 'retreat'],
  LUXURY_EXPERIENCE: ['landmark', 'iconic', 'historic', 'grande dame'],
  FAMILY: ['family-friendly', 'families'],
  AMENITIES: ['spa', 'pool', 'fitness', 'restaurants'],
};

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

    // ── AREA evidence ────────────────────────────────────────────────
    //
    // Added 2026-09-18 after reading the WhataHotel advisor's system prompt,
    // which draws a line we did not have: its "never invent" rule covers
    // HOTEL facts (rating, amenities, perks, price) while the surrounding
    // AREA — attractions, restaurants, the nearest airport, getting around —
    // may come from general knowledge.
    //
    // The line is right and the sourcing is where we differ. Theirs allows
    // recall; ours cites two things we already hold and had never fed to a
    // motivator: Google's own description of the property, and the street
    // address the hotel's own page states. Both are quoted rather than
    // interpreted, so a guest can check either.
    //
    // Measured the same day: asked whether W Aspen has a pool, their advisor
    // asserted it — a HOTEL fact by their own rule, absent from their page's
    // payload and from every curated file in their repository. It was true.
    // Ten other probes obeyed the rule. A prompt is a rule the model follows
    // most of the time; this is the reason ours stays evidence-backed even
    // where theirs need not be.
    const editorial = (input.editorialSummary ?? '').toLowerCase();
    const editorialHits = (EDITORIAL_SIGNALS[motivator] ?? []).filter((w) => editorial.includes(w));
    if (editorialHits.length > 0) {
      evidence.push({
        // Attributed in the sentence itself, never folded into our own voice
        // (rule 32): a reader can weigh "Google says this" and cannot weigh
        // an unattributed claim.
        text: `Google's description of this property mentions ${editorialHits.slice(0, 2).join(' and ')}`,
        source: 'GOOGLE_EDITORIAL',
      });
    }

    // Where the property actually is, in the merchant's own words. Only for
    // LOCATION: an address is an answer to "where is this", and padding the
    // other nine motivators with it would be noise.
    if (motivator === 'LOCATION' && input.streetAddress) {
      evidence.push({
        text: `The property's own page gives its address as ${input.streetAddress}`,
        source: 'STREET_ADDRESS',
      });
    }

    // What the property's own site says. Last in the list on purpose: our own
    // measured evidence leads, and the citation follows it. Each carries its
    // URL so a guest can open the page and look for the phrase — which is the
    // whole reason this is evidence and a model's recollection is not.
    for (const w of input.websiteClaims ?? []) {
      if (w.motivator !== motivator) continue;
      evidence.push({ text: w.claim, source: 'WEBSITE', sourceUrl: w.sourceUrl });
    }

    out.push({
      motivator,
      verdict: evidence.length > 0 ? 'SUPPORTED' : 'LIMITED_EVIDENCE',
      evidence,
    });
  }

  return out;
}

/**
 * Lower-case an evidence line's first letter so it can be folded into a
 * sentence, EXCEPT where the line opens on a proper noun.
 *
 * Measured against production 2026-09-18: the Beach & resort answer for The
 * Royal Hawaiian read "and google's description of this property mentions
 * beach". Rule 32 publishes Google's words AS Google's, and a lower-cased
 * name reads as a typo rather than as an attribution.
 *
 * The exception list is the set of names THIS module emits, so it is a
 * statement about the code below rather than a reading of the corpus — rule
 * 31's objection to frozen lists is about claims made on data, not about our
 * own vocabulary. A test pins that every line this module can emit is either
 * covered here or safe to uncapitalize.
 */
const PROPER_NOUN_PREFIXES = ['Google'] as const;

function uncapitalize(text: string): string {
  if (text.length === 0) return text;
  if (PROPER_NOUN_PREFIXES.some((name) => text.startsWith(name))) return text;
  return text[0]!.toLowerCase() + text.slice(1);
}

/**
 * The advisor's answer to a clicked preference, written from the motivator's
 * own evidence and nothing else.
 *
 * Shared on purpose. A scored stay reads it through the personalization
 * layer, and a stay with NO RATE AT ALL reads the same sentences — the
 * evidence a motivator rests on is hotel-level (amenities, review themes,
 * perks, a researched page), so it survives the absence of a price entirely.
 * Two renderers would be two voices for one question, and the guest clicking
 * "Family" cannot tell which mode answered them.
 *
 * It states the evidence and stops. "Rooms list cribs and connecting rooms"
 * is checkable and rejectable; "well suited to families" is a conclusion over
 * a hidden rule, which is rule 30's `goodForChildren` in better clothes. The
 * verdict word is never rendered for the same reason.
 *
 * Null when the motivator is thin or absent, which leaves the caller to say
 * plainly that the information is limited — the honest answer, and never
 * dressed up as a soft yes (rule 33).
 *
 * Carries no price, no comparison and no score, so a HOTEL_ONLY response can
 * publish it without the mode's one hard rule being a matter of care: there
 * is nothing about a rate in here to leak.
 */
export function renderMotivatorAnswer(
  assessment: MotivatorAssessment | null | undefined,
): { readonly insight: string; readonly reasons: readonly string[] } | null {
  if (!assessment || assessment.verdict !== 'SUPPORTED') return null;
  if (assessment.evidence.length === 0) return null;

  // At most two lead the sentence: the rest are published beside it as
  // reasons and in the motivators block, so repeating them would pad.
  const lead = assessment.evidence.slice(0, 2).map((e) => uncapitalize(e.text));
  const insight =
    lead.length === 1 ? `For this stay, ${lead[0]}.` : `For this stay, ${lead[0]}, and ${lead[1]}.`;

  return {
    insight,
    reasons: assessment.evidence
      .slice(0, 3)
      .map((e) => (e.text.endsWith('.') ? e.text : `${e.text}.`)),
  };
}

/**
 * What this property DOES show, when the preference the guest clicked shows
 * nothing.
 *
 * Copied in SHAPE from the WhataHotel advisor, examined 2026-09-18. Asked
 * whether W Aspen has a pool and a beach, it answered the literal question,
 * said why ("Aspen is a mountain destination"), and pointed somewhere useful.
 * Ours said "limited information is available" and stopped — a true sentence
 * that leaves a guest with less than they arrived with.
 *
 * What is NOT copied is where its answer came from. "W Aspen has a pool" is
 * absent from the data that page carries, so it is editorial or model recall:
 * true in that instance, unverifiable in general, and the thing rules 4 and
 * 34 exist to keep out. This pivot invents nothing. Every word of it is
 * evidence already measured for this same hotel, for a different motivator,
 * on the same request — nine of which were computed and thrown away whenever
 * the tenth came back empty.
 *
 * The two VALUE motivators are excluded: they answer a question about the
 * RATE, and a guest asking about the beach is not asking about the price.
 *
 * Says nothing about what the hotel lacks. "We hold no evidence" is a
 * statement about our research (rule 33), the limited sentence beside this
 * one already makes it, and a verdict on the property is what rule 28
 * forbids outright.
 */
export function renderMotivatorPivot(
  all: readonly MotivatorAssessment[],
  selected: Preference,
): string | null {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const m of all) {
    if (m.motivator === selected) continue;
    if (m.motivator === 'GENERAL_VALUE' || m.motivator === 'BEST_VALUE') continue;
    if (m.verdict !== 'SUPPORTED') continue;
    for (const e of m.evidence) {
      const key = e.text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(e.text.replace(/\.$/, ''));
    }
  }
  if (lines.length === 0) return null;

  // Two at most. A pivot is a pointer, not a second answer, and the full
  // assessment for all ten rides in the response beside it.
  const first = uncapitalize(lines[0] as string);
  const second = lines.length > 1 ? uncapitalize(lines[1] as string) : null;
  return second === null
    ? `What this property does show: ${first}.`
    : `What this property does show: ${first}, and ${second}.`;
}
