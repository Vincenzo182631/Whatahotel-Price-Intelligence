/**
 * Property-based invariants P1–P12 (docs/mvp/07-testing.md §3).
 *
 * P1, P3 and P11 are release blockers: a failure in any of them stops a deploy.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { analyze } from '../../packages/core/src/analyze.js';
import { DEFAULT_CONFIG } from '../../packages/core/src/config/defaults.js';
import { numeralsIn } from '../../packages/core/src/explanation/bundle.js';
import type { BaselineLevel, MatchMethod, ScoringInput } from '../../packages/core/src/types.js';
import {
  NOW,
  checkInWithLeadDays,
  makeBaseline,
  makeComparables,
  makeCurrent,
  makeQuery,
  makeSeries,
} from '../support/fixtures.js';

const BLOCKER_RUNS = 5000;
const STANDARD_RUNS = 1000;

const LEVELS: readonly BaselineLevel[] = ['L0', 'L1', 'L2', 'L3', 'L4'];
const METHODS: readonly MatchMethod[] = [
  'SOURCE_ID',
  'ALIAS_EXACT',
  'ALIAS_FUZZY',
  'ATTRIBUTE_INFERRED',
];

interface Knobs {
  readonly n: number;
  readonly medianMinor: number;
  readonly spread: number;
  readonly currentRatio: number;
  readonly level: BaselineLevel;
  readonly matchConf: number;
  readonly matchMethod: MatchMethod;
  readonly nSources: number;
  readonly unresolvedShare: number;
  readonly leadDays: number;
  readonly seriesPoints: number;
  readonly trendDelta: number;
  readonly compCount: number;
  readonly compIndex: number;
  readonly ageHours: number;
  readonly roomsLeft: number;
  readonly eventImpact: number;
  readonly nights: number;
  readonly onlyNonRefundable: boolean;
}

const arbKnobs: fc.Arbitrary<Knobs> = fc.record({
  n: fc.integer({ min: 0, max: 200 }),
  medianMinor: fc.integer({ min: 8000, max: 300000 }),
  spread: fc.double({ min: 0.02, max: 0.8, noNaN: true, noDefaultInfinity: true }),
  currentRatio: fc.double({ min: 0.4, max: 2.0, noNaN: true, noDefaultInfinity: true }),
  level: fc.constantFrom(...LEVELS),
  matchConf: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  matchMethod: fc.constantFrom(...METHODS),
  nSources: fc.integer({ min: 1, max: 3 }),
  unresolvedShare: fc.double({ min: 0, max: 0.5, noNaN: true, noDefaultInfinity: true }),
  leadDays: fc.integer({ min: 0, max: 200 }),
  seriesPoints: fc.integer({ min: 0, max: 14 }),
  trendDelta: fc.double({ min: -0.4, max: 0.4, noNaN: true, noDefaultInfinity: true }),
  compCount: fc.integer({ min: 0, max: 10 }),
  compIndex: fc.double({ min: 0.6, max: 1.4, noNaN: true, noDefaultInfinity: true }),
  ageHours: fc.double({ min: 0, max: 200, noNaN: true, noDefaultInfinity: true }),
  roomsLeft: fc.integer({ min: -1, max: 20 }),
  eventImpact: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  nights: fc.integer({ min: 1, max: 14 }),
  onlyNonRefundable: fc.boolean(),
});

function buildInput(k: Knobs, overrides: Partial<Knobs> = {}): ScoringInput {
  const knobs = { ...k, ...overrides };
  const median = knobs.medianMinor;
  const lo = Math.max(1000, Math.round(median * (1 - knobs.spread)));
  const hi = Math.round(median * (1 + knobs.spread));
  const currentNightly = Math.max(1000, Math.round(median * knobs.currentRatio));

  const baseline =
    knobs.n > 0
      ? makeBaseline({
          n: knobs.n,
          level: knobs.level,
          ladder: [
            [0, lo],
            [0.5, median],
            [1, hi],
          ],
          meanMatchConfidence: knobs.matchConf,
          nSources: knobs.nSources,
          crossSourceCv: knobs.nSources > 1 ? 0.05 : null,
          unresolvedShare: knobs.unresolvedShare,
        })
      : null;

  const observedAt = new Date(NOW.getTime() - knobs.ageHours * 3_600_000).toISOString();

  return {
    query: makeQuery({
      checkIn: checkInWithLeadDays(knobs.leadDays),
      nights: knobs.nights,
    }),
    current: makeCurrent(currentNightly, {
      totalMinor: currentNightly * knobs.nights,
      observedAt,
      matchMethod: knobs.matchMethod,
      matchConfidence: knobs.matchConf,
      roomsLeft: knobs.roomsLeft < 0 ? null : knobs.roomsLeft,
      onlyNonRefundableAvailable: knobs.onlyNonRefundable,
    }),
    baseline,
    series:
      knobs.seriesPoints > 0
        ? makeSeries({
            points: knobs.seriesPoints,
            spanDays: 7,
            endMinor: currentNightly,
            deltaFraction: knobs.trendDelta,
          })
        : [],
    comparables:
      knobs.compCount > 0
        ? makeComparables({
            count: knobs.compCount,
            index: knobs.compIndex,
            baselineMedianMinor: median,
          })
        : [],
    benefits: [],
    demand:
      knobs.eventImpact > 0
        ? { events: [{ name: 'Event', impactScore: knobs.eventImpact }] }
        : null,
    now: NOW,
  };
}

const run = (k: Knobs, o: Partial<Knobs> = {}) => analyze(buildInput(k, o), DEFAULT_CONFIG);

describe('P1 · WAIT requires confidence at or above the floor [RELEASE BLOCKER]', () => {
  it('holds for all generated inputs', () => {
    fc.assert(
      fc.property(arbKnobs, (k) => {
        const { analysis } = run(k);
        if (analysis.recommendation === 'WAIT') {
          expect(analysis.confidence).toBeGreaterThanOrEqual(DEFAULT_CONFIG.rec.wait.confidenceMin);
        }
      }),
      { numRuns: BLOCKER_RUNS },
    );
  });
});

describe('P2 · INSUFFICIENT_DATA if and only if the score is null', () => {
  it('holds for all generated inputs', () => {
    fc.assert(
      fc.property(arbKnobs, (k) => {
        const { analysis } = run(k);
        const insufficient = analysis.recommendation === 'INSUFFICIENT_DATA';
        expect(analysis.dealScore === null).toBe(insufficient);
        expect(analysis.dealScoreBand === null).toBe(insufficient);
      }),
      { numRuns: STANDARD_RUNS },
    );
  });
});

describe('P3 · Monotonicity: a lower price never lowers the Deal Score [RELEASE BLOCKER]', () => {
  it('holds with the trend series held fixed', () => {
    fc.assert(
      fc.property(
        arbKnobs,
        fc.double({ min: 0.02, max: 0.5, noNaN: true, noDefaultInfinity: true }),
        (k, drop) => {
          const dearer = run(k);
          const cheaper = run(k, { currentRatio: k.currentRatio * (1 - drop) });
          if (dearer.analysis.dealScore === null || cheaper.analysis.dealScore === null) return;
          expect(cheaper.analysis.dealScore).toBeGreaterThanOrEqual(dearer.analysis.dealScore);
        },
      ),
      { numRuns: BLOCKER_RUNS },
    );
  });
});

describe('P4 · Scores and confidence stay inside their ranges', () => {
  it('holds for all generated inputs', () => {
    fc.assert(
      fc.property(arbKnobs, (k) => {
        const { analysis } = run(k);
        if (analysis.dealScore !== null) {
          expect(analysis.dealScore).toBeGreaterThanOrEqual(0);
          expect(analysis.dealScore).toBeLessThanOrEqual(100);
          expect(Number.isInteger(analysis.dealScore)).toBe(true);
        }
        expect(analysis.confidence).toBeGreaterThanOrEqual(0);
        expect(analysis.confidence).toBeLessThanOrEqual(100);
        expect(Number.isInteger(analysis.confidence)).toBe(true);
      }),
      { numRuns: STANDARD_RUNS },
    );
  });
});

describe('P5 · More observations never lower confidence', () => {
  it('holds when the distribution shape is unchanged', () => {
    fc.assert(
      fc.property(arbKnobs, fc.integer({ min: 1, max: 150 }), (k, extra) => {
        const base = { ...k, n: Math.max(1, k.n) };
        const fewer = run(base);
        const more = run(base, { n: base.n + extra });
        expect(more.analysis.confidence).toBeGreaterThanOrEqual(fewer.analysis.confidence - 1);
      }),
      { numRuns: STANDARD_RUNS },
    );
  });
});

describe('P6 · Older data never raises confidence', () => {
  it('holds for all generated inputs', () => {
    fc.assert(
      fc.property(
        arbKnobs,
        fc.double({ min: 1, max: 100, noNaN: true, noDefaultInfinity: true }),
        (k, older) => {
          const fresh = run(k);
          const stale = run(k, { ageHours: k.ageHours + older });
          expect(stale.analysis.confidence).toBeLessThanOrEqual(fresh.analysis.confidence);
        },
      ),
      { numRuns: STANDARD_RUNS },
    );
  });
});

describe('P7 · Applied weights sum to 1.0 after redistribution', () => {
  it('holds whenever a score was produced', () => {
    fc.assert(
      fc.property(arbKnobs, (k) => {
        const { analysis } = run(k);
        if (analysis.dealScore === null) return;
        const total = analysis.factors.reduce((sum, f) => sum + f.weightApplied, 0);
        expect(Math.abs(total - 1)).toBeLessThan(1e-9);
      }),
      { numRuns: STANDARD_RUNS },
    );
  });
});

describe('P8 · Every number in the explanation is in the bundle allowlist', () => {
  it('holds for all generated inputs', () => {
    fc.assert(
      fc.property(arbKnobs, (k) => {
        const { bundle, explanation } = run(k);
        const allowed = bundle.constraints.allowed_numbers;
        const tolerance = DEFAULT_CONFIG.explanation.numericTolerance;
        for (const n of numeralsIn(explanation.text)) {
          const ok = allowed.some((a) => Math.abs(a - n) <= tolerance);
          expect(ok, `"${n}" not allowed in: ${explanation.text}`).toBe(true);
        }
      }),
      { numRuns: STANDARD_RUNS },
    );
  });
});

describe('P9 · The engine is deterministic', () => {
  it('produces identical output for identical input', () => {
    fc.assert(
      fc.property(arbKnobs, (k) => {
        const a = run(k);
        const b = run(k);
        expect(JSON.stringify(a.analysis)).toBe(JSON.stringify(b.analysis));
        expect(a.explanation.text).toBe(b.explanation.text);
      }),
      { numRuns: STANDARD_RUNS },
    );
  });
});

describe('P10 · Too few observations always forces INSUFFICIENT_DATA', () => {
  it('holds below the absolute floor', () => {
    fc.assert(
      fc.property(
        arbKnobs,
        fc.integer({ min: 0, max: DEFAULT_CONFIG.rec.minObsAbs - 1 }),
        (k, n) => {
          const { analysis } = run(k, { n });
          expect(analysis.recommendation).toBe('INSUFFICIENT_DATA');
          expect(analysis.dealScore).toBeNull();
        },
      ),
      { numRuns: STANDARD_RUNS },
    );
  });
});

describe('P11 · Any tripped guard removes WAIT [RELEASE BLOCKER]', () => {
  it('holds for all generated inputs', () => {
    fc.assert(
      fc.property(arbKnobs, (k) => {
        const { analysis } = run(k);
        if (analysis.waitBlockedBy.length > 0) {
          expect(analysis.recommendation).not.toBe('WAIT');
        }
      }),
      { numRuns: BLOCKER_RUNS },
    );
  });
});

describe('P12 · A widened baseline is penalised in confidence', () => {
  it('L3 and L4 never score above their multiplier against L0', () => {
    fc.assert(
      fc.property(arbKnobs, fc.constantFrom<BaselineLevel>('L3', 'L4'), (k, level) => {
        const base = { ...k, n: Math.max(DEFAULT_CONFIG.rec.minObsAbs, k.n) };
        const tight = run(base, { level: 'L0' });
        const widened = run(base, { level });
        const multiplier = DEFAULT_CONFIG.baseline.levelMultiplier[level];
        // +1 absorbs integer rounding at each end.
        expect(widened.analysis.confidence).toBeLessThanOrEqual(
          Math.ceil(tight.analysis.confidence * multiplier) + 1,
        );
      }),
      { numRuns: STANDARD_RUNS },
    );
  });
});
