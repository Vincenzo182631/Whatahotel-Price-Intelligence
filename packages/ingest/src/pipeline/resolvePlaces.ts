/**
 * The reputation sweep: resolve hotels to Google places and refresh what they
 * say.
 *
 * Runs on a schedule rather than on a page view, for two reasons. Text Search
 * is billed per call and a guest's request should not pay for a discovery that
 * benefits everyone after them; and a reputation is a property of the hotel,
 * not of the stay being asked about, so there is nothing per-request to
 * recompute. The API reads only what this has already stored.
 *
 * The consequence is stated rather than hidden: a hotel enrolled between two
 * sweeps has no rating yet, and renders with no rating — which is the same
 * honest absence as an unmatched one.
 */

import {
  findResolutionTargets,
  saveResolution,
  type Queryable,
  type ResolutionTarget,
} from '@wahpi/data';

import { googleSettings } from '../adapters/google/settings.js';
import { PlacesClient } from '../adapters/google/places.js';
import { resolveHotel } from '../adapters/google/resolve.js';

export interface PlaceSweepOptions {
  readonly limit?: number;
  readonly client?: PlacesClient | null;
  readonly q?: Queryable;
  readonly onHotel?: (info: {
    hotel: ResolutionTarget;
    status: string;
    confidence: number | null;
    reasons: readonly string[];
  }) => void;
}

export interface PlaceSweepResult {
  readonly considered: number;
  readonly verified: number;
  readonly unverified: number;
  readonly noMatch: number;
  /** Calls that failed. Deliberately NOT written to the database. */
  readonly failed: number;
  /**
   * Hotels we hold no coordinates for. Never asked about, never written.
   *
   * Counted separately and loudly: a sweep that is mostly this number is not
   * a reputation problem, it is a catalogue one, and the two want different
   * fixes.
   */
  readonly skippedNoGeo: number;
  readonly skipped: 'NOT_CONFIGURED' | null;
}

export async function sweepPlaces(options: PlaceSweepOptions = {}): Promise<PlaceSweepResult> {
  const empty = {
    considered: 0,
    verified: 0,
    unverified: 0,
    noMatch: 0,
    failed: 0,
    skippedNoGeo: 0,
  };
  const client = options.client === undefined ? PlacesClient.fromEnv() : options.client;
  if (!client) return { ...empty, skipped: 'NOT_CONFIGURED' };

  const settings = googleSettings();
  const targets = await findResolutionTargets(
    options.limit ?? 200,
    settings.refreshHours,
    options.q,
  );

  let verified = 0;
  let unverified = 0;
  let noMatch = 0;
  let failed = 0;
  let skippedNoGeo = 0;

  for (const hotel of targets) {
    const outcome = await resolveHotel(client, hotel, settings.minMatchConfidence);
    if (outcome.status === 'SKIPPED_NO_GEO') {
      skippedNoGeo += 1;
      options.onHotel?.({
        hotel,
        status: 'SKIPPED_NO_GEO',
        confidence: null,
        reasons: ['no coordinates on our side — nothing Google returned could clear the bar'],
      });
      continue;
    }

    if (outcome.status === 'FAILED') {
      // Nothing written: the hotel stays in the queue and is retried next
      // sweep. See resolve.ts — recording NO_MATCH here would retire it
      // permanently over a transient timeout.
      failed += 1;
      options.onHotel?.({ hotel, status: 'FAILED', confidence: null, reasons: [] });
      continue;
    }

    await saveResolution(
      hotel.hotelId,
      {
        status: outcome.status,
        // Null on a refresh; saveResolution keeps the confidence the
        // original match earned rather than blanking it.
        confidence: outcome.confidence,
        placeId: outcome.placeId,
        rating: outcome.rating,
        userRatingCount: outcome.userRatingCount,
        displayName: outcome.displayName,
        formattedAddress: outcome.formattedAddress,
        mapsUri: outcome.mapsUri,
        editorialSummary: outcome.editorialSummary,
        reviewThemes: outcome.reviewThemes,
      },
      options.q,
    );

    if (outcome.status === 'VERIFIED') verified += 1;
    else if (outcome.status === 'UNVERIFIED') unverified += 1;
    else noMatch += 1;

    options.onHotel?.({
      hotel,
      status: outcome.status,
      confidence: outcome.confidence,
      reasons: outcome.reasons,
    });
  }

  return {
    considered: targets.length,
    verified,
    unverified,
    noMatch,
    failed,
    skippedNoGeo,
    skipped: null,
  };
}
