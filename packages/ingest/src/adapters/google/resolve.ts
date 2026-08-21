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
import { bestMatch } from './match.js';
import type { PlacesClient, PlaceReputation } from './places.js';

export interface ResolvableHotel {
  readonly hotelId: number;
  readonly name: string;
  readonly city: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
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
  /** Why we landed here — for the sweep log, never for the guest. */
  readonly reasons: readonly string[];
}

/** Its own type so a caller cannot confuse "no match" with "did not ask". */
export type Resolution = ResolutionOutcome | { readonly status: 'FAILED' };

export function searchQuery(hotel: ResolvableHotel): string {
  return [hotel.name, hotel.city].filter(Boolean).join(' ');
}

const reputationOf = (
  place: PlaceReputation | null,
  fallback: PlaceCandidate,
): Pick<
  ResolutionOutcome,
  'rating' | 'userRatingCount' | 'displayName' | 'formattedAddress' | 'mapsUri'
> => ({
  rating: place?.rating ?? null,
  userRatingCount: place?.userRatingCount ?? null,
  displayName: place?.displayName ?? fallback.displayName,
  formattedAddress: place?.formattedAddress ?? fallback.formattedAddress,
  mapsUri: place?.mapsUri ?? null,
});

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
      reasons: ['refresh of an existing mapping'],
    };
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
      reasons: ['Google returned no lodging for this query'],
    };
  }

  const match = bestMatch(hotel, candidates, minConfidence);
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
