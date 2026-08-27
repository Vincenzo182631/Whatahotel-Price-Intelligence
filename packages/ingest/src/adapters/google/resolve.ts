/**
 * Resolving a hotel to a Google place, and refreshing what that place says.
 *
 * Split from the HTTP client and from the matcher so the decision table below
 * is testable without a network or a key. Each outcome is a deliberate choice
 * about what happens NEXT time, which is the part that is easy to get wrong:
 *
 *   candidates + clears the bar  → VERIFIED, details fetched, refreshed daily
 *   candidates + misses the bar  → UNVERIFIED, nothing stored, NOT retried
 *   Google answered, nothing     → NO_MATCH, NOT retried
 *   the call failed              → nothing written at all, retried next sweep
 *
 * The last row is why `searchText` distinguishes null from empty. Writing
 * NO_MATCH on a timeout would retire a hotel from reputation permanently
 * because of a four-second blip, and nothing would ever say so.
 */

import type { PlaceCandidate } from './match.js';
import { addressCanConfirm, bestMatch } from './match.js';
import type { PlacesClient, PlaceReputation } from './places.js';
import { extractReviewThemes } from './themes.js';

export interface ResolvableHotel {
  readonly hotelId: number;
  readonly name: string;
  readonly city: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  /** Merchant street address, from the public hotel page. See match.ts. */
  readonly streetAddress: string | null;
  /**
   * Where the coordinates above came from (migration 0018).
   *
   * 'GOOGLE' means they came from a previous VERIFIED match, and they are
   * therefore NOT independent evidence about this hotel's position. Scoring a
   * Google candidate against them would be Google confirming itself — the same
   * error the street-address rule exists to prevent. Treated as absent when a
   * fresh match is scored; a refresh never re-matches, so it is unaffected.
   */
  readonly coordinateSource?: 'SOURCE' | 'GOOGLE' | null;
  /** Already resolved? Refresh the reputation without paying for a search. */
  readonly placeId: string | null;
}

export interface ResolutionOutcome {
  readonly status: 'VERIFIED' | 'UNVERIFIED' | 'NO_MATCH';
  readonly confidence: number | null;
  readonly placeId: string | null;
  readonly rating: number | null;
  readonly userRatingCount: number | null;
  readonly displayName: string | null;
  readonly formattedAddress: string | null;
  readonly mapsUri: string | null;
  /**
   * The place's own coordinates, as Google returned them.
   *
   * Both field masks already request `location` — this is what the matcher
   * uses to tell two same-brand properties apart — so these arrive on every
   * VERIFIED outcome at no extra cost. They were being dropped here.
   *
   * Null on every non-VERIFIED outcome: an unmatched hotel has no place, and a
   * place we did not trust enough to store a rating for is not one to take a
   * position from either.
   */
  readonly latitude: number | null;
  readonly longitude: number | null;
  /** Google's own short description of the place, verbatim. */
  readonly editorialSummary: string | null;
  /** Themes measured over the review sample. See themes.ts for the rules. */
  readonly reviewThemes: readonly string[];
  /** Why we landed here — for the sweep log, never for the guest. */
  readonly reasons: readonly string[];
}

/**
 * Its own type so a caller cannot confuse "no match" with "did not ask".
 *
 * FAILED         we asked and the call broke. Write nothing, retry later.
 * SKIPPED_NO_GEO we did not ask, because the answer could not have been used.
 */
export type Resolution =
  ResolutionOutcome | { readonly status: 'FAILED' } | { readonly status: 'SKIPPED_NO_GEO' };

/**
 * The Text Search query.
 *
 * The street address goes in when we hold one. It narrows the candidate set
 * at no extra cost — the call is billed the same either way — and it is the
 * difference between Google offering us every Four Seasons in the state and
 * offering us the one on this street.
 */
export function searchQuery(hotel: ResolvableHotel): string {
  return [hotel.name, hotel.streetAddress, hotel.city].filter(Boolean).join(' ');
}

const reputationOf = (
  place: PlaceReputation | null,
  fallback: PlaceCandidate,
): Pick<
  ResolutionOutcome,
  | 'rating'
  | 'userRatingCount'
  | 'displayName'
  | 'formattedAddress'
  | 'mapsUri'
  | 'latitude'
  | 'longitude'
  | 'editorialSummary'
  | 'reviewThemes'
> => ({
  rating: place?.rating ?? null,
  userRatingCount: place?.userRatingCount ?? null,
  displayName: place?.displayName ?? fallback.displayName,
  formattedAddress: place?.formattedAddress ?? fallback.formattedAddress,
  // The Details response and the search candidate both carry a position. The
  // candidate is the fallback because a failed Details call still leaves us
  // holding the coordinates the match was scored on.
  latitude: place?.latitude ?? fallback.latitude,
  longitude: place?.longitude ?? fallback.longitude,
  mapsUri: place?.mapsUri ?? null,
  editorialSummary: place?.editorialSummary ?? null,
  reviewThemes: place ? extractReviewThemes(place.reviews) : [],
});

/**
 * The geography of this hotel that is independent of Google.
 *
 * Coordinates written by a previous VERIFIED match are not evidence about the
 * hotel — they are Google's own claim, and letting them corroborate a Google
 * candidate is circular. Anything else is the source catalogue's own reading
 * and stands on its own.
 *
 * Absent provenance is read as SOURCE: every row placed before migration 0018
 * came from the catalogue, and the migration backfills them to say so.
 */
function independentGeography(hotel: ResolvableHotel): {
  latitude: number | null;
  longitude: number | null;
} {
  if (hotel.coordinateSource === 'GOOGLE') return { latitude: null, longitude: null };
  return { latitude: hotel.latitude, longitude: hotel.longitude };
}

export async function resolveHotel(
  client: PlacesClient,
  hotel: ResolvableHotel,
  minConfidence: number,
): Promise<Resolution> {
  // Already mapped: the match was decided once and does not get re-decided on
  // a refresh. Re-searching would let a strong new candidate silently steal a
  // hotel's identity between two page views.
  if (hotel.placeId) {
    const place = await client.details(hotel.placeId);
    if (!place) return { status: 'FAILED' };
    return {
      status: 'VERIFIED',
      // Confidence belongs to the original match; a refresh does not re-earn
      // it, and the caller leaves the stored value alone by passing null.
      confidence: null,
      placeId: place.placeId,
      rating: place.rating,
      userRatingCount: place.userRatingCount,
      displayName: place.displayName,
      formattedAddress: place.formattedAddress,
      mapsUri: place.mapsUri,
      // A refresh is how the 17 already-VERIFIED-but-unplaced hotels get
      // placed: the mapping was made before this outcome carried a position,
      // and Details has been returning one all along.
      latitude: place.latitude,
      longitude: place.longitude,
      editorialSummary: place.editorialSummary,
      reviewThemes: extractReviewThemes(place.reviews),
      reasons: ['refresh of an existing mapping'],
    };
  }

  // Nothing geographic on OUR side, and no existing mapping to refresh.
  //
  // scoreMatch caps such a candidate at 0.65 — below the 0.7 threshold — so
  // there is no candidate Google could return that would clear the bar.
  // Asking anyway would spend a Text Search call to obtain a foregone
  // UNVERIFIED, and UNVERIFIED is never retried: one sweep would permanently
  // retire every hotel whose geography we happen not to hold yet.
  //
  // A street address lifts that cap — but only one that CAN confirm, meaning
  // one carrying a house number. Holding an address with no number changes
  // nothing about the ceiling, so asking on the strength of it is the same
  // foredoomed call, and it costs more than the call: UNVERIFIED is never
  // re-queued, so it spends the hotel's one retry on a decided outcome.
  //
  // With no usable geography of either kind, this is a gap in our own
  // catalogue rather than a fact about the hotel, and it closes the moment
  // either arrives. So: do not call, do not write, and let the next sweep
  // find it again. Same reasoning as FAILED.
  // `== null` rather than `=== null`: a caller that simply omits the address
  // means the same thing as one that states it has none, and reading undefined
  // as "present" would spend a doomed Text Search call on every such hotel.
  //
  // One more thing this check must NOT count as geography of our own:
  // coordinates that came from Google in the first place (migration 0018).
  // Scoring a Google candidate against Google's own earlier answer would find
  // perfect agreement and mean nothing — the same self-confirmation the
  // street-address rule exists to prevent, which is why
  // google_formatted_address is kept apart from the merchant's street_address.
  //
  // The path is narrow: a hotel holding GOOGLE coordinates also holds a
  // place_id, and the branch above short-circuits to a refresh before reaching
  // here. It opens the moment a place_id is cleared to request a re-match,
  // which is precisely when the guard has to already be in place.
  const independent = independentGeography(hotel);
  if (
    (independent.latitude === null || independent.longitude === null) &&
    !addressCanConfirm(hotel.streetAddress ?? null)
  ) {
    return { status: 'SKIPPED_NO_GEO' };
  }

  const candidates = await client.searchText(searchQuery(hotel));
  if (candidates === null) return { status: 'FAILED' };

  if (candidates.length === 0) {
    return {
      status: 'NO_MATCH',
      confidence: null,
      placeId: null,
      rating: null,
      userRatingCount: null,
      displayName: null,
      formattedAddress: null,
      mapsUri: null,
      latitude: null,
      longitude: null,
      editorialSummary: null,
      reviewThemes: [],
      reasons: ['Google returned no lodging for this query'],
    };
  }

  const match = bestMatch({ ...hotel, ...independent }, candidates, minConfidence);
  if (!match) {
    // We DO record which candidate came closest, so a later threshold change
    // can be reasoned about — but nothing about it is stored as fact and
    // nothing about it is shown.
    return {
      status: 'UNVERIFIED',
      confidence: null,
      placeId: null,
      rating: null,
      userRatingCount: null,
      displayName: null,
      formattedAddress: null,
      mapsUri: null,
      latitude: null,
      longitude: null,
      editorialSummary: null,
      reviewThemes: [],
      reasons: [`best candidate below ${minConfidence}`],
    };
  }

  const place = await client.details(match.candidate.placeId);
  return {
    status: 'VERIFIED',
    confidence: Number(match.score.confidence.toFixed(2)),
    placeId: match.candidate.placeId,
    ...reputationOf(place, match.candidate),
    reasons: match.score.reasons,
  };
}
