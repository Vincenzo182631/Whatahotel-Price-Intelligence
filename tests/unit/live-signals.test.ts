/**
 * The live-market model: comp-set index, calendar delta, compression.
 *
 * The worked examples from the product direction are encoded literally, so a
 * change in thresholds or formula shows up as a failure against the numbers
 * that were actually agreed rather than against my restatement of them.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../packages/core/src/config/defaults.js';
import {
  computeCalendarDelta,
  computeCompSetIndex,
  computeCompression,
  type CompetitorRate,
  type NearbyDateRate,
} from '../../packages/core/src/scoring/liveSignals.js';
import {
  SCORE_DISPLAY_FLOOR,
  applyScoreDisplayFloor,
  composeLiveScore,
} from '../../packages/core/src/scoring/liveScore.js';

const NOW = new Date('2026-08-17T12:00:00Z');
const FRESH = '2026-08-17T11:30:00Z';

const comp = (
  name: string,
  nightly: number,
  over: Partial<CompetitorRate> = {},
): CompetitorRate => ({
  hotelId: name.toLowerCase().replace(/\W+/g, '-'),
  name,
  nightlyMinor: nightly * 100,
  observedAt: FRESH,
  isAvailable: true,
  ...over,
});

const near = (checkIn: string, nightly: number, sameDow = true): NearbyDateRate => ({
  checkIn,
  nightlyMinor: nightly * 100,
  sameDow,
  observedAt: FRESH,
});

// ── S1 · Comp-Set Index ────────────────────────────────────────────────────

describe('comp-set index', () => {
  it("reproduces the direction's worked example", () => {
    // Target $650 against $850 / $900 / $800 / $875 → median 862.50,
    // CSI ≈ 75.4, i.e. ~24.6% cheaper than the competitor median.
    const result = computeCompSetIndex(
      650_00,
      [comp('A', 850), comp('B', 900), comp('C', 800), comp('D', 875)],
      DEFAULT_CONFIG,
      NOW,
    );

    expect(result.signal.available).toBe(true);
    expect(result.medianCompetitorNightlyMinor).toBe(862_50);
    expect(result.csi).toBeCloseTo(75.4, 1);
    expect(result.pctBelowMedian).toBeCloseTo(24.6, 1);
    expect(result.band).toBe('STRONG_VALUE');
    expect(result.compsUsed).toBe(4);
  });

  it('places the bands where the direction puts them', () => {
    const at = (csi: number) => {
      // One competitor median of $1000; subject priced to hit the target CSI.
      const comps = [comp('A', 1000), comp('B', 1000), comp('C', 1000)];
      return computeCompSetIndex(Math.round(csi * 10) * 100, comps, DEFAULT_CONFIG, NOW).band;
    };
    expect(at(70)).toBe('STRONG_VALUE');
    expect(at(85)).toBe('STRONG_VALUE'); // boundary is inclusive
    expect(at(86)).toBe('MARKET_RATE');
    expect(at(115)).toBe('MARKET_RATE'); // boundary is inclusive
    expect(at(116)).toBe('PREMIUM');
  });

  it('a cheaper hotel always scores at least as well as a dearer one', () => {
    const comps = [comp('A', 900), comp('B', 950), comp('C', 1000)];
    const cheap = computeCompSetIndex(600_00, comps, DEFAULT_CONFIG, NOW);
    const dear = computeCompSetIndex(1200_00, comps, DEFAULT_CONFIG, NOW);
    expect(cheap.signal.subScore!).toBeGreaterThan(dear.signal.subScore!);
  });
});

describe('comp-set validation — never substitute a guessed rate', () => {
  it('excludes sold-out competitors rather than counting them', () => {
    const result = computeCompSetIndex(
      650_00,
      [comp('A', 850), comp('B', 900), comp('C', 800), comp('D', 100, { isAvailable: false })],
      DEFAULT_CONFIG,
      NOW,
    );
    // The sold-out $100 would have dragged the median down enormously.
    expect(result.compsUsed).toBe(3);
    expect(result.compsExcluded).toBe(1);
    expect(result.medianCompetitorNightlyMinor).toBe(850_00);
  });

  it('excludes stale competitor rates', () => {
    const stale = { observedAt: '2026-08-14T12:00:00Z' }; // 72h old
    const result = computeCompSetIndex(
      650_00,
      [comp('A', 850), comp('B', 900), comp('C', 800), comp('D', 999, stale)],
      DEFAULT_CONFIG,
      NOW,
    );
    expect(result.compsUsed).toBe(3);
    expect(result.compsExcluded).toBe(1);
  });

  it('excludes missing and zero rates', () => {
    const result = computeCompSetIndex(
      650_00,
      [
        comp('A', 850),
        comp('B', 900),
        comp('C', 800),
        comp('D', 0),
        comp('E', Number.NaN as unknown as number),
      ],
      DEFAULT_CONFIG,
      NOW,
    );
    expect(result.compsUsed).toBe(3);
  });

  it('produces NOTHING below the minimum comp count, rather than a weak answer', () => {
    const result = computeCompSetIndex(
      650_00,
      [comp('A', 850), comp('B', 900)],
      DEFAULT_CONFIG,
      NOW,
    );
    expect(result.signal.available).toBe(false);
    expect(result.signal.unavailableReason).toBe('INSUFFICIENT_COMPARABLES');
    expect(result.csi).toBeNull();
    // Not 0 — absent is not "terrible". Same principle as the Deal Score.
    expect(result.signal.subScore).toBeNull();
  });
});

// ── S2 · Calendar Delta ────────────────────────────────────────────────────

describe('calendar delta', () => {
  it("reproduces the direction's worked example", () => {
    // Selected dates $650 against nearby ≈ $940 → about −31%.
    const result = computeCalendarDelta(
      650_00,
      [near('2026-09-05', 940), near('2026-09-19', 940), near('2026-09-26', 940)],
      DEFAULT_CONFIG,
    );
    expect(result.signal.available).toBe(true);
    expect(result.deltaPct).toBeCloseTo(-30.9, 1);
    expect(result.band).toBe('DIP');
  });

  it('places the bands where the direction puts them', () => {
    const at = (pct: number) => {
      const nearby = 1000_00;
      const subject = Math.round(nearby * (1 + pct / 100));
      return computeCalendarDelta(
        subject,
        [near('a', 1000), near('b', 1000), near('c', 1000)],
        DEFAULT_CONFIG,
      ).band;
    };
    expect(at(-31)).toBe('DIP');
    expect(at(-15)).toBe('DIP'); // inclusive
    expect(at(-14)).toBe('NORMAL');
    expect(at(0)).toBe('NORMAL');
    expect(at(15)).toBe('NORMAL'); // inclusive
    expect(at(16)).toBe('COMPRESSED');
  });

  it('prefers same-weekday neighbours and says when it used them', () => {
    // A Thu–Sun stay compared against midweek dates measures the weekend, not
    // the dates. Same-DOW neighbours are used alone when there are enough.
    const result = computeCalendarDelta(
      600_00,
      [
        near('2026-09-03', 900, true),
        near('2026-09-17', 900, true),
        near('2026-09-24', 900, true),
        near('2026-09-07', 300, false), // cheap midweek — must not be used
        near('2026-09-08', 300, false),
      ],
      DEFAULT_CONFIG,
    );
    expect(result.sameDowOnly).toBe(true);
    expect(result.neighboursUsed).toBe(3);
    expect(result.medianNearbyNightlyMinor).toBe(900_00);
  });

  it('falls back to all neighbours when same-weekday data is too thin, and says so', () => {
    const result = computeCalendarDelta(
      600_00,
      [near('a', 900, true), near('b', 800, false), near('c', 850, false), near('d', 820, false)],
      DEFAULT_CONFIG,
    );
    expect(result.sameDowOnly).toBe(false);
    expect(result.neighboursUsed).toBe(4);
  });

  it('produces nothing below the minimum neighbour count', () => {
    const result = computeCalendarDelta(600_00, [near('a', 900), near('b', 900)], DEFAULT_CONFIG);
    expect(result.signal.available).toBe(false);
    expect(result.signal.unavailableReason).toBe('INSUFFICIENT_NEIGHBOURS');
    expect(result.deltaPct).toBeNull();
  });
});

// ── S3 · Compression ───────────────────────────────────────────────────────

describe('market compression', () => {
  it('reads a mostly sold-out comp set as tight', () => {
    const r = computeCompression({ checked: 5, soldOut: 3 }, DEFAULT_CONFIG);
    expect(r.band).toBe('TIGHT');
    expect(r.soldOutShare).toBeCloseTo(0.6, 5);
  });

  it('reads a fully available comp set as soft', () => {
    expect(computeCompression({ checked: 6, soldOut: 0 }, DEFAULT_CONFIG).band).toBe('SOFT');
  });

  it('is omitted, never invented, when there is no availability evidence', () => {
    for (const input of [null, undefined, { checked: 1, soldOut: 0 }]) {
      const r = computeCompression(input, DEFAULT_CONFIG);
      expect(r.signal.available).toBe(false);
      expect(r.signal.unavailableReason).toBe('NO_AVAILABILITY_DATA');
      expect(r.band).toBeNull();
    }
  });
});

// ── composition ────────────────────────────────────────────────────────────

describe('composing the live score', () => {
  const strongComps = [comp('A', 850), comp('B', 900), comp('C', 800), comp('D', 875)];
  const cheapDates = [near('a', 940), near('b', 940), near('c', 940), near('d', 940)];

  it("scores the direction's headline example as strong value and says book now", () => {
    const result = composeLiveScore(
      computeCompSetIndex(650_00, strongComps, DEFAULT_CONFIG, NOW),
      computeCalendarDelta(650_00, cheapDates, DEFAULT_CONFIG),
      computeCompression({ checked: 4, soldOut: 2 }, DEFAULT_CONFIG),
      1,
      DEFAULT_CONFIG,
    );
    expect(result.score).not.toBeNull();
    expect(result.band === 'EXCEPTIONAL' || result.band === 'STRONG').toBe(true);
    expect(result.verdict).toBe('BOOK_NOW');
    expect(result.confidence).toBe('HIGH');
    expect(result.outOfTen).toBe(result.score! / 10);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('below comparable luxury hotels'),
        expect.stringContaining('below nearby dates'),
      ]),
    );
  });

  it('redistributes weight when compression is unavailable', () => {
    const result = composeLiveScore(
      computeCompSetIndex(650_00, strongComps, DEFAULT_CONFIG, NOW),
      computeCalendarDelta(650_00, cheapDates, DEFAULT_CONFIG),
      computeCompression(null, DEFAULT_CONFIG),
      1,
      DEFAULT_CONFIG,
    );
    expect(result.score).not.toBeNull();

    const applied = result.signals.filter((s) => s.available).map((s) => s.weightApplied);
    expect(applied.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);

    // 0.45 and 0.35 renormalize to 0.5625 / 0.4375, preserving their ratio
    // rather than folding the missing weight into one signal.
    const csi = result.signals.find((s) => s.code === 'S1_COMP_SET')!;
    const cal = result.signals.find((s) => s.code === 'S2_CALENDAR')!;
    expect(csi.weightApplied).toBeCloseTo(0.45 / 0.8, 6);
    expect(cal.weightApplied).toBeCloseTo(0.35 / 0.8, 6);
    expect(result.signals.find((s) => s.code === 'S3_COMPRESSION')!.weightApplied).toBe(0);
  });

  it('produces NO score when too little is measurable — never a zero', () => {
    const result = composeLiveScore(
      computeCompSetIndex(650_00, [comp('A', 850)], DEFAULT_CONFIG, NOW), // too few
      computeCalendarDelta(650_00, [near('a', 940)], DEFAULT_CONFIG), // too few
      computeCompression(null, DEFAULT_CONFIG),
      1,
      DEFAULT_CONFIG,
    );
    expect(result.score).toBeNull();
    expect(result.outOfTen).toBeNull();
    expect(result.band).toBeNull();
    expect(result.verdict).toBe('NOT_ENOUGH_DATA');
    // Every signal is still reported, each with why it is missing.
    expect(result.signals).toHaveLength(3);
    expect(result.signals.every((s) => s.unavailableReason !== null)).toBe(true);
  });

  it('comp-set alone is not enough to call a deal', () => {
    // 0.45 coverage is below the 0.6 floor: one signal, however good, is not a
    // market read.
    const result = composeLiveScore(
      computeCompSetIndex(650_00, strongComps, DEFAULT_CONFIG, NOW),
      computeCalendarDelta(650_00, [near('a', 940)], DEFAULT_CONFIG),
      computeCompression(null, DEFAULT_CONFIG),
      1,
      DEFAULT_CONFIG,
    );
    expect(result.weightCoverage).toBeCloseTo(0.45, 6);
    expect(result.score).toBeNull();
  });

  it('never tells a customer to wait, in any combination of inputs', () => {
    // Waiting is a bet on a future price. There is no state that produces it.
    const verdicts = new Set<string>();
    for (const subject of [400_00, 650_00, 900_00, 1400_00]) {
      for (const nearby of [500, 940, 1500]) {
        for (const compression of [null, { checked: 4, soldOut: 0 }, { checked: 4, soldOut: 3 }]) {
          for (const age of [1, 48]) {
            verdicts.add(
              composeLiveScore(
                computeCompSetIndex(subject, strongComps, DEFAULT_CONFIG, NOW),
                computeCalendarDelta(
                  subject,
                  [near('a', nearby), near('b', nearby), near('c', nearby), near('d', nearby)],
                  DEFAULT_CONFIG,
                ),
                computeCompression(compression, DEFAULT_CONFIG),
                age,
                DEFAULT_CONFIG,
              ).verdict,
            );
          }
        }
      }
    }
    expect([...verdicts].sort()).toEqual(
      ['BOOK_CONSIDER', 'BOOK_NOW', 'CONSIDER_ALTERNATIVES'].filter((v) => verdicts.has(v)),
    );
    expect(verdicts.has('WAIT' as never)).toBe(false);
  });

  it('a premium-priced hotel points at alternatives', () => {
    const result = composeLiveScore(
      computeCompSetIndex(1400_00, strongComps, DEFAULT_CONFIG, NOW),
      computeCalendarDelta(
        1400_00,
        [near('a', 900), near('b', 900), near('c', 900), near('d', 900)],
        DEFAULT_CONFIG,
      ),
      computeCompression({ checked: 4, soldOut: 0 }, DEFAULT_CONFIG),
      1,
      DEFAULT_CONFIG,
    );
    expect(result.band).toBe('PREMIUM');
    expect(result.verdict).toBe('CONSIDER_ALTERNATIVES');
  });
});

describe('confidence', () => {
  const comps4 = [comp('A', 850), comp('B', 900), comp('C', 800), comp('D', 875)];
  const near4 = [near('a', 940), near('b', 940), near('c', 940), near('d', 940)];

  it('is LOW when the subject rate itself is stale', () => {
    const r = composeLiveScore(
      computeCompSetIndex(650_00, comps4, DEFAULT_CONFIG, NOW),
      computeCalendarDelta(650_00, near4, DEFAULT_CONFIG),
      computeCompression({ checked: 4, soldOut: 2 }, DEFAULT_CONFIG),
      48,
      DEFAULT_CONFIG,
    );
    expect(r.confidence).toBe('LOW');
  });

  it('is LOW with fewer than three valid competitors, whatever else is present', () => {
    const r = composeLiveScore(
      computeCompSetIndex(650_00, [comp('A', 850), comp('B', 900)], DEFAULT_CONFIG, NOW),
      computeCalendarDelta(650_00, near4, DEFAULT_CONFIG),
      computeCompression({ checked: 4, soldOut: 2 }, DEFAULT_CONFIG),
      1,
      DEFAULT_CONFIG,
    );
    expect(r.confidence).toBe('LOW');
  });

  it('softens the verdict rather than reversing it when confidence is low', () => {
    // A strong band with LOW confidence must not become "consider
    // alternatives" — the evidence is thin, not contrary.
    const r = composeLiveScore(
      computeCompSetIndex(650_00, comps4, DEFAULT_CONFIG, NOW),
      computeCalendarDelta(650_00, near4, DEFAULT_CONFIG),
      computeCompression({ checked: 4, soldOut: 2 }, DEFAULT_CONFIG),
      48, // stale → LOW
      DEFAULT_CONFIG,
    );
    expect(r.confidence).toBe('LOW');
    expect(r.verdict).toBe('BOOK_CONSIDER');
  });
});

describe('reason copy', () => {
  const comps = [comp('A', 850), comp('B', 900), comp('C', 800), comp('D', 875)];

  it('never says "0% below" — it says what that actually means', () => {
    // A rounded zero beside the word "below" is not a fact anyone can act on.
    const atParity = composeLiveScore(
      computeCompSetIndex(862_50, comps, DEFAULT_CONFIG, NOW),
      computeCalendarDelta(
        862_50,
        [near('a', 863), near('b', 862), near('c', 863), near('d', 862)],
        DEFAULT_CONFIG,
      ),
      computeCompression({ checked: 4, soldOut: 1 }, DEFAULT_CONFIG),
      1,
      DEFAULT_CONFIG,
    );
    for (const reason of atParity.reasons) {
      expect(reason).not.toMatch(/\b0% (below|above)\b/);
    }
    expect(atParity.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('In line with')]),
    );
  });

  it('states direction correctly on both sides', () => {
    const cheap = composeLiveScore(
      computeCompSetIndex(650_00, comps, DEFAULT_CONFIG, NOW),
      computeCalendarDelta(
        650_00,
        [near('a', 940), near('b', 940), near('c', 940), near('d', 940)],
        DEFAULT_CONFIG,
      ),
      computeCompression(null, DEFAULT_CONFIG),
      1,
      DEFAULT_CONFIG,
    );
    expect(cheap.reasons[0]).toMatch(/below comparable/);
    expect(cheap.reasons[1]).toMatch(/below nearby dates/);

    const dear = composeLiveScore(
      computeCompSetIndex(1250_00, comps, DEFAULT_CONFIG, NOW),
      computeCalendarDelta(
        1250_00,
        [near('a', 900), near('b', 900), near('c', 900), near('d', 900)],
        DEFAULT_CONFIG,
      ),
      computeCompression(null, DEFAULT_CONFIG),
      1,
      DEFAULT_CONFIG,
    );
    expect(dear.reasons[0]).toMatch(/above comparable/);
    expect(dear.reasons[1]).toMatch(/above nearby dates/);
  });

  it('uses no predictive language anywhere in the reasons', () => {
    const forbidden =
      /\b(will|going to|expect|predict|rise|rises|fall|falls|increase|decrease|before it|soon)\b/i;
    for (const subject of [400_00, 650_00, 900_00, 1400_00]) {
      const r = composeLiveScore(
        computeCompSetIndex(subject, comps, DEFAULT_CONFIG, NOW),
        computeCalendarDelta(
          subject,
          [near('a', 940), near('b', 940), near('c', 940), near('d', 940)],
          DEFAULT_CONFIG,
        ),
        computeCompression({ checked: 4, soldOut: 3 }, DEFAULT_CONFIG),
        1,
        DEFAULT_CONFIG,
      );
      for (const reason of r.reasons) expect(reason).not.toMatch(forbidden);
    }
  });
});

// ── The presentation floor ──────────────────────────────────────────────────
//
// Business rule (2026-08-24): the customer never reads a Deal Score below
// 6.0. The floor is presentation-only — composeLiveScore itself is untouched,
// which is exactly what these tests pin down.
describe('the score display floor', () => {
  const strongComps = [comp('A', 850), comp('B', 900), comp('C', 800), comp('D', 875)];
  const cheapDates = [near('a', 940), near('b', 940), near('c', 940), near('d', 940)];

  const premiumResult = () =>
    composeLiveScore(
      // Subject priced far above every comparable: a true PREMIUM case.
      computeCompSetIndex(1400_00, strongComps, DEFAULT_CONFIG, NOW),
      computeCalendarDelta(1400_00, cheapDates, DEFAULT_CONFIG),
      computeCompression({ checked: 4, soldOut: 0 }, DEFAULT_CONFIG),
      1,
      DEFAULT_CONFIG,
    );

  it('floors a premium-priced score to exactly 6.0 with coherent band and verdict', () => {
    const raw = premiumResult();
    expect(raw.score).not.toBeNull();
    expect(raw.score!).toBeLessThan(SCORE_DISPLAY_FLOOR);
    expect(raw.band).toBe('PREMIUM');
    expect(raw.verdict).toBe('CONSIDER_ALTERNATIVES');

    const floored = applyScoreDisplayFloor(raw, DEFAULT_CONFIG);
    expect(floored.score).toBe(SCORE_DISPLAY_FLOOR);
    expect(floored.outOfTen).toBe(6);
    // 60 sits in the MARKET band, so the label and verdict read as neutral
    // copy, never as a recommendation against the hotel.
    expect(floored.band).toBe('MARKET');
    expect(floored.verdict).toBe('BOOK_CONSIDER');
  });

  it('does not touch the composed engine result — the floor is presentation-only', () => {
    const raw = premiumResult();
    const before = raw.score;
    applyScoreDisplayFloor(raw, DEFAULT_CONFIG);
    expect(raw.score).toBe(before);
    expect(raw.band).toBe('PREMIUM');
  });

  it('returns a score at or above the floor unchanged, same object', () => {
    const strong = composeLiveScore(
      computeCompSetIndex(650_00, strongComps, DEFAULT_CONFIG, NOW),
      computeCalendarDelta(650_00, cheapDates, DEFAULT_CONFIG),
      computeCompression({ checked: 4, soldOut: 2 }, DEFAULT_CONFIG),
      1,
      DEFAULT_CONFIG,
    );
    expect(strong.score!).toBeGreaterThanOrEqual(SCORE_DISPLAY_FLOOR);
    expect(applyScoreDisplayFloor(strong, DEFAULT_CONFIG)).toBe(strong);
  });

  it('never invents a score: null stays null (rule 3)', () => {
    const empty = composeLiveScore(
      computeCompSetIndex(650_00, [], DEFAULT_CONFIG, NOW),
      computeCalendarDelta(650_00, [], DEFAULT_CONFIG),
      computeCompression(null, DEFAULT_CONFIG),
      1,
      DEFAULT_CONFIG,
    );
    expect(empty.score).toBeNull();
    const floored = applyScoreDisplayFloor(empty, DEFAULT_CONFIG);
    expect(floored.score).toBeNull();
    expect(floored.verdict).toBe('NOT_ENOUGH_DATA');
  });

  it('keeps the factual reasons — the floor adjusts the verdict, not the facts', () => {
    const raw = premiumResult();
    const floored = applyScoreDisplayFloor(raw, DEFAULT_CONFIG);
    expect(floored.reasons).toEqual(raw.reasons);
  });
});
