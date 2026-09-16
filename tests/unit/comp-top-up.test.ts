/**
 * When a request goes back for more competitors before answering.
 *
 * The bug this pins: config v9 lets a room-matched comparison carry on two
 * comps instead of three, and the top-up only fired when the comparison was
 * MISSING. Two comps is not missing, so a request with a thin, skewed set
 * stopped looking and reported a confident number about the wrong market.
 *
 * Measured on Four Seasons Paris George V, 6-8 Oct 2026: two stored
 * comparables read "45% above comparable luxury hotels" at LOW confidence.
 * One more real peer — one fetch away — took the set to four, the median from
 * EUR 2,205 to EUR 2,768, the reading to "16% above", and confidence to HIGH.
 *
 * The error has a direction, which is why it matters: a half-collected market
 * loses its dearest members first, so a thin set skews AGAINST the most
 * expensive hotel in it. That is the apples-to-apples failure of rules 20
 * and 21, arriving through coverage rather than through matching.
 */

import { describe, expect, it } from 'vitest';

import { needsMoreComparables } from '../../packages/core/src/scoring/liveSignals.js';
import { DEFAULT_CONFIG } from '../../packages/core/src/config/defaults.js';

const csi = DEFAULT_CONFIG.live.csi;

const compSet = (over: {
  compsUsed?: number;
  termsBasis?: 'MATCHED' | 'PRICE_ONLY';
  unavailableReason?: 'INSUFFICIENT_COMPARABLES' | null;
}) => ({
  compsUsed: over.compsUsed ?? 5,
  termsBasis: over.termsBasis ?? ('MATCHED' as const),
  signal: { unavailableReason: over.unavailableReason ?? null },
});

describe('deciding to fetch more competitors', () => {
  it('fetches when the comparison could not be produced', () => {
    expect(
      needsMoreComparables(compSet({ unavailableReason: 'INSUFFICIENT_COMPARABLES' }), csi),
    ).toBe(true);
  });

  it('fetches when only price could be compared', () => {
    // The terms-matched ladder found nothing; fresh comps may fix it properly.
    expect(needsMoreComparables(compSet({ termsBasis: 'PRICE_ONLY' }), csi)).toBe(true);
  });

  it('fetches when the index is riding on the reduced floor', () => {
    // The George V case. The index exists, terms matched, and it is still
    // two hotels' opinion of a market.
    expect(csi.minCompsRoomMatched).toBeLessThan(csi.minComps);
    expect(needsMoreComparables(compSet({ compsUsed: csi.minCompsRoomMatched }), csi)).toBe(true);
  });

  it('does not fetch once the full minimum is met', () => {
    // Latency is not free, and a comparison at the real minimum is the one
    // the config says is answerable.
    expect(needsMoreComparables(compSet({ compsUsed: csi.minComps }), csi)).toBe(false);
    expect(needsMoreComparables(compSet({ compsUsed: csi.minComps + 4 }), csi)).toBe(false);
  });
});
