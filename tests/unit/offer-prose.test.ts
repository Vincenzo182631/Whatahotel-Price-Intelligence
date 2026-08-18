/**
 * Offer prose must never become a room name.
 *
 * Found by the real-data probe on 2026-08-18: a customer-facing sentence read
 * "We're still building price history for the PER STAY. 30USD DAILY BREAKFAST
 * CREDIT FOR at Kimpton EPIC Miami". The source had put the tail of a
 * hotel-credit offer in `roomName`, truncated at the field's ~45-character
 * limit, and nothing rejected it.
 *
 * The tests split along the asymmetry that governs the detector. A false
 * positive throws away a real priced rate; a false negative ships one odd
 * name. So the "real room names" block is the one that must never regress —
 * it is the expensive direction — and it uses names taken verbatim from
 * production rather than invented ones, because invented room names are
 * exactly the kind that would not catch an over-eager pattern.
 */

import { describe, expect, it } from 'vitest';

import { looksLikeOfferProse } from '../../packages/core/src/normalize/text.js';
import { validateRecord } from '../../packages/ingest/src/pipeline/pipeline.js';
import type { RawRateRecord } from '../../packages/ingest/src/adapters/RateSourceAdapter.js';

describe('offer prose is not a room name', () => {
  it('catches the string that actually reached a customer', () => {
    expect(looksLikeOfferProse('PER STAY. 30USD DAILY BREAKFAST CREDIT FOR')).toBe(true);
  });

  it('catches the offer vocabulary seen in live rate plans', () => {
    for (const text of [
      '$100 Hotel Credit',
      'Hotel Credit Offer, Upgrade Upon Availability At Check In',
      'Prepay Non-Refundable Non-Changeable',
      'Up To 20% Off W Bkfst',
      'Resort fee waived',
      'Breakfast for two valued at 60USD per stay',
      'US$50 daily credit',
    ]) {
      expect(looksLikeOfferProse(text), text).toBe(true);
    }
  });

  // ── the expensive direction ────────────────────────────────────────────
  it('does NOT flag real room names from production', () => {
    for (const text of [
      'Bay View Guest Room, 1 King, 1 King, Mini',
      'Resort View Guest Room, 1 King, 1 King, Mini',
      'Premier Cityscape Room King Bed Large Window With North City',
      'City View, 1 King, Mini fridge, 440sqft/40sqm,',
      'Deluxe, 1 King, Mini fridge, Microwave,',
      'Oceanfront Junior Suite, 2 Queen',
      'Penthouse Suite with Terrace',
      'Studio, 1 King [1 KING]',
    ]) {
      expect(looksLikeOfferProse(text), text).toBe(false);
    }
  });

  it('catches a bare non-room artifact — found live at InterContinental Miami', () => {
    // Exact-name rule, not a substring: "perks" alone is a payload section
    // header that became three room types in production. A room genuinely
    // NAMED around the word must survive, which is why the pattern is ^perks$.
    expect(looksLikeOfferProse('perks')).toBe(true);
    expect(looksLikeOfferProse('  Perks ')).toBe(true);
    expect(looksLikeOfferProse('Club Perks Suite')).toBe(false);
  });

  it('treats an empty or absent name as not-prose — that is MISSING_ROOM_NAME', () => {
    // Two different faults with two different reject reasons. Conflating them
    // would hide which one a run is actually hitting.
    expect(looksLikeOfferProse('')).toBe(false);
    expect(looksLikeOfferProse(null)).toBe(false);
    expect(looksLikeOfferProse(undefined)).toBe(false);
  });
});

// ── the pipeline rejects rather than skips ─────────────────────────────────

function record(over: Partial<RawRateRecord> = {}): RawRateRecord {
  return {
    wahHotelId: '2708',
    rawRoomName: 'Bay View Guest Room, 1 King [1 KING]',
    displayRoomName: 'Bay View Guest Room, 1 King',
    sourceRoomCode: 'BK1',
    sourcePlanCode: 'WAH:2SH',
    rawPlanName: 'WhataHotel! Exclusive',
    checkIn: '2026-09-01',
    nights: 1,
    checkOut: '2026-09-02',
    adults: 2,
    children: 0,
    currency: 'USD',
    totalAmountMinor: 29945,
    taxBasis: 'GROSS',
    observedAt: '2026-08-18T12:00:00.000Z',
    ...over,
  } as RawRateRecord;
}

const OPTIONS = { maxNights: 30 } as Parameters<typeof validateRecord>[2];

describe('validateRecord rejects offer prose with its own reason', () => {
  it('accepts a real room name', () => {
    expect(validateRecord(record(), '2026-08-18', OPTIONS)).toBeNull();
  });

  it('rejects prose in the matching identity', () => {
    const bad = record({ rawRoomName: 'PER STAY. 30USD DAILY BREAKFAST CREDIT FOR' });
    expect(validateRecord(bad, '2026-08-18', OPTIONS)).toBe('OFFER_PROSE_AS_ROOM_NAME');
  });

  it('rejects prose in the customer-facing name even when the identity looks fine', () => {
    // The display name is the one that reaches a sentence a guest reads, so it
    // is checked independently rather than trusted to follow the identity.
    const bad = record({ displayRoomName: '$100 Hotel Credit per stay' });
    expect(validateRecord(bad, '2026-08-18', OPTIONS)).toBe('OFFER_PROSE_AS_ROOM_NAME');
  });

  it('still reports MISSING_ROOM_NAME when the name is simply absent', () => {
    const bad = record({ rawRoomName: '   ' });
    expect(validateRecord(bad, '2026-08-18', OPTIONS)).toBe('MISSING_ROOM_NAME');
  });
});
