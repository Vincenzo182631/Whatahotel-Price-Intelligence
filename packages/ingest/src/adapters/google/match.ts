/**
 * Deciding whether a Google place IS the hotel we asked about.
 *
 * Pure, and separate from the HTTP client, because this is the part that can
 * be wrong in a way nobody notices: a plausible-looking mismatch shows one
 * property's reputation on another property's page. That is worse than showing
 * no reputation at all, so the bar is deliberately high and the default answer
 * is "not sure".
 *
 * Text Search happily returns the nearest hotel, a restaurant inside the
 * hotel, or a different property of the same brand three miles away. "Four
 * Seasons Hotel Miami" and "Four Seasons Resort Palm Beach" share most of
 * their words. Name similarity alone cannot separate those; coordinates can.
 */

export interface PlaceCandidate {
  readonly placeId: string;
  readonly displayName: string;
  readonly formattedAddress: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

export interface HotelIdentity {
  readonly name: string;
  readonly city: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  /**
   * The merchant's own street address, from the public hotel page.
   *
   * Independent of Google, which is the whole point: corroborating a Google
   * candidate with a Google-derived address would be Google confirming itself.
   */
  readonly streetAddress?: string | null;
}

export interface MatchScore {
  readonly confidence: number;
  readonly reasons: readonly string[];
}

/** Lowercase, unaccented, punctuation-free, and stripped of hotel filler. */
export function normalizeName(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      // Words that appear in half of all hotel names carry no discriminating
      // power; leaving them in makes every pair look similar.
      .replace(/\b(hotel|resort|and|spa|the|a|by|at|collection|autograph)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Dice coefficient over word bigrams — tolerant of order and small edits. */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (s: string): string[] => {
    const words = s.split(' ');
    if (words.length === 1) return words;
    const out: string[] = [];
    for (let i = 0; i < words.length - 1; i += 1) out.push(`${words[i]} ${words[i + 1]}`);
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  const pool = new Map<string, number>();
  for (const g of ga) pool.set(g, (pool.get(g) ?? 0) + 1);
  let hits = 0;
  for (const g of gb) {
    const n = pool.get(g) ?? 0;
    if (n > 0) {
      hits += 1;
      pool.set(g, n - 1);
    }
  }
  return (2 * hits) / (ga.length + gb.length);
}

/** Kilometres between two points, spherical law of cosines. Good to metres. */
export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const r = 6371;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Street-address agreement between our record and a Google candidate.
 *
 * This exists to rescue the hotels that hold no coordinates. It is the same
 * KIND of evidence as distance — where the building is, rather than what it
 * is called — which is why it is allowed to lift the no-coordinates ceiling
 * that name similarity alone can never lift.
 *
 * It is deliberately one-directional: it can CONFIRM, never refute. Two
 * records of the same property routinely disagree on the house number
 * ("L.G. Smith Blvd # 103" against Google's "L.G. Smith Blvd 101"), and a
 * false refutation would retire a correct match permanently, because
 * UNVERIFIED is never retried. Distance keeps the refuting role; it earns it
 * by being unambiguous.
 */

const STREET_WORDS: Record<string, string> = {
  street: 'st',
  drive: 'dr',
  road: 'rd',
  avenue: 'ave',
  boulevard: 'blvd',
  lane: 'ln',
  place: 'pl',
  court: 'ct',
  highway: 'hwy',
  parkway: 'pkwy',
  square: 'sq',
  terrace: 'ter',
  suite: 'ste',
  north: 'n',
  south: 's',
  east: 'e',
  west: 'w',
};

/** Lowercase, unaccented, with street suffixes reduced to one spelling. */
function normalizeAddress(value: string): string[] {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((token) => STREET_WORDS[token] ?? token)
    .filter(Boolean);
}

/**
 * House numbers, wherever the local convention puts them.
 *
 * "455 Grand Bay Drive" leads with it, "Mitropoleos 49" trails it, so position
 * carries no meaning across this catalogue and every standalone number counts.
 * Long numbers are dropped: a postcode is not a house number, and Google's
 * formatted address usually carries one.
 */
function houseNumbers(tokens: readonly string[]): Set<string> {
  return new Set(tokens.filter((t) => /^[0-9]{1,4}$/.test(t)));
}

/** The words that actually name the street, minus numbers and suffixes. */
function streetWords(tokens: readonly string[]): Set<string> {
  const suffixes = new Set(Object.values(STREET_WORDS));
  return new Set(tokens.filter((t) => !/^[0-9]+$/.test(t) && !suffixes.has(t) && t.length > 2));
}

/**
 * Could this address ever confirm anything?
 *
 * addressConfirms needs a shared house number, so an address without one can
 * never lift the no-coordinates ceiling however well it reads. That makes the
 * distinction load-bearing OUTSIDE the matcher too: resolveHotel uses it to
 * decide whether asking Google is worth a call, because a foredoomed ask
 * spends the hotel's ONE retry — UNVERIFIED is never re-queued — on an
 * outcome that was decided before the request left.
 *
 * Learned the expensive way: gating the call on merely HAVING an address
 * retired 35 hotels in a single sweep, which is exactly what the
 * SKIPPED_NO_GEO comment was written to prevent.
 */
export function addressCanConfirm(address: string | null): boolean {
  return !!address && houseNumbers(normalizeAddress(address)).size > 0;
}

/**
 * True when both records name the same building.
 *
 * Requires BOTH a shared house number and overlapping street words. Either
 * alone is far too weak: house number 1 is shared by half of every city, and
 * "ocean drive" appears in a dozen places within one destination.
 */
export function addressConfirms(ours: string | null, theirs: string | null): boolean {
  if (!ours || !theirs) return false;
  const a = normalizeAddress(ours);
  const b = normalizeAddress(theirs);

  const numbersA = houseNumbers(a);
  const numbersB = houseNumbers(b);
  if (numbersA.size === 0 || numbersB.size === 0) return false;
  if (![...numbersA].some((n) => numbersB.has(n))) return false;

  const wordsA = streetWords(a);
  const wordsB = streetWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  const shared = [...wordsA].filter((w) => wordsB.has(w)).length;
  return shared / Math.min(wordsA.size, wordsB.size) >= 0.5;
}

/**
 * How confident are we that this candidate is this hotel?
 *
 * Name similarity is the base. Coordinates are the arbiter: within 300m is
 * decisive corroboration, beyond 5km is decisive refutation however well the
 * names read. City agreement is weaker evidence and only ever additive —
 * a shared city cannot rescue a name that does not match.
 *
 * When we hold no coordinates for our own hotel the ceiling is capped, because
 * the one signal that separates same-brand properties is missing and a
 * confident answer would be unearned. A street address that agrees lifts that
 * cap — it answers the same question coordinates answer, and it reaches us
 * from the merchant rather than from Google.
 */
export function scoreMatch(hotel: HotelIdentity, candidate: PlaceCandidate): MatchScore {
  const reasons: string[] = [];
  const nameScore = similarity(normalizeName(hotel.name), normalizeName(candidate.displayName));
  reasons.push(`name ${nameScore.toFixed(2)}`);

  let confidence = nameScore;
  // Applied at the END, not inline: a later bonus must not lift a candidate
  // back over a ceiling that exists precisely because the decisive evidence
  // is missing.
  let ceiling = 1;

  const haveGeo =
    hotel.latitude !== null &&
    hotel.longitude !== null &&
    candidate.latitude !== null &&
    candidate.longitude !== null;

  if (haveGeo) {
    const km = distanceKm(
      hotel.latitude as number,
      hotel.longitude as number,
      candidate.latitude as number,
      candidate.longitude as number,
    );
    reasons.push(`${km.toFixed(2)}km apart`);
    if (km <= 0.3) confidence = Math.min(1, confidence + 0.35);
    else if (km <= 1) confidence = Math.min(1, confidence + 0.15);
    else if (km <= 5) confidence = Math.max(0, confidence - 0.1);
    else {
      // Same name, wrong continent-ish. Distance wins outright.
      reasons.push('rejected: beyond 5km');
      return { confidence: 0, reasons };
    }
  } else if (addressConfirms(hotel.streetAddress ?? null, candidate.formattedAddress)) {
    // Same building by street address. Slightly under the 0.35 a sub-300m
    // fix earns: an address is a transcription and can be stale, where a
    // coordinate pair is a measurement.
    confidence = Math.min(1, confidence + 0.3);
    reasons.push('street address agrees');
  } else {
    reasons.push('no coordinates — capped');
    ceiling = 0.65;
  }

  const haystack = `${candidate.formattedAddress ?? ''} ${candidate.displayName}`.toLowerCase();
  if (hotel.city && haystack.includes(hotel.city.toLowerCase())) {
    confidence = Math.min(1, confidence + 0.1);
    reasons.push('city agrees');
  }

  return { confidence: Math.max(0, Math.min(ceiling, confidence)), reasons };
}

/** The best candidate, or null when none clears the bar. */
export function bestMatch(
  hotel: HotelIdentity,
  candidates: readonly PlaceCandidate[],
  minConfidence: number,
): { candidate: PlaceCandidate; score: MatchScore } | null {
  let best: { candidate: PlaceCandidate; score: MatchScore } | null = null;
  for (const candidate of candidates) {
    const score = scoreMatch(hotel, candidate);
    if (!best || score.confidence > best.score.confidence) best = { candidate, score };
  }
  return best && best.score.confidence >= minConfidence ? best : null;
}
