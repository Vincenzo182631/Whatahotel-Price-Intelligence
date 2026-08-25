/**
 * matchRoomOption, exercised for real.
 *
 * The widget is an IIFE that installs itself on globalThis when no window
 * exists, so importing the file under Node gives us the actual function the
 * browser runs — not a re-implementation that could drift.
 */
import { describe, expect, it } from 'vitest';

// Side-effect import: defines globalThis.WahPriceIntelligence.
// @ts-expect-error — the widget is deliberately untyped browser JS; this
// import exists for its side effect, and the API is read off globalThis.
await import('../../apps/web/public/widget.js');

const { matchRoomOption } = (globalThis as Record<string, any>).WahPriceIntelligence;

const OPTIONS = [
  { room_type_id: '1', name: 'Historic Room King' },
  { room_type_id: '2', name: 'Deluxe King' },
  { room_type_id: '3', name: 'DELUXE KING Partial Ocean View, Mini Fridge' },
  { room_type_id: '4', name: 'Garden View Executive Suite King Bed Lanai' },
];

describe('matchRoomOption — the display-name lock', () => {
  it('an exact match wins outright, case and punctuation aside', () => {
    expect(matchRoomOption('deluxe king', OPTIONS)?.room_type_id).toBe('2');
    expect(matchRoomOption('HISTORIC ROOM — KING', OPTIONS)?.room_type_id).toBe('1');
  });

  it('a prefix relationship matches when no exact option exists', () => {
    // The button says less than the source's full name.
    expect(matchRoomOption('Garden View Executive Suite', OPTIONS)?.room_type_id).toBe('4');
    // ...or more: the button carries the price suffix the list does not.
    expect(matchRoomOption('Historic Room King — $795/night', OPTIONS)?.room_type_id).toBe('1');
  });

  it('among prefix candidates the CLOSEST name wins, not the first', () => {
    const opts = [
      { room_type_id: 'suite', name: 'Deluxe King Suite' },
      { room_type_id: 'room', name: 'Deluxe King Room' },
    ];
    // "Deluxe King" is a prefix of both; the shorter (closer) name wins and
    // the guest is never silently upgraded to the suite.
    expect(matchRoomOption('Deluxe King Room', opts)?.room_type_id).toBe('room');
  });

  it('returns null rather than guessing when nothing plausibly matches', () => {
    expect(matchRoomOption('Presidential Villa', OPTIONS)).toBeNull();
    expect(matchRoomOption('', OPTIONS)).toBeNull();
    expect(matchRoomOption('Deluxe King', [])).toBeNull();
  });
});
