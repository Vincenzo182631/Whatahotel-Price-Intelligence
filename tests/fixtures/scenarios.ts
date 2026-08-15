/**
 * The nine required scenarios (docs/mvp/07-testing.md §2), plus S8b.
 *
 * Each carries a `protects` note explaining what it guards, so a future
 * engineer changing a weight can see immediately what they are about to break.
 *
 * Expectations are ranges and bands, not exact values. Asserting an exact score
 * would make every recalibration a test rewrite; these assert the properties
 * that must survive calibration.
 */

import type { ScoringInput } from '../../packages/core/src/types.js';
import type { ConfidenceBand, Recommendation, ScoreBand } from '../../packages/core/src/types.js';
import {
  NOW,
  checkInWithLeadDays,
  makeBaseline,
  makeComparables,
  makeCurrent,
  makeQuery,
  makeSeries,
} from '../support/fixtures.js';

export interface ScenarioExpectation {
  readonly dealScore?: readonly [number, number] | null;
  readonly dealScoreBand?: ScoreBand;
  readonly confidence?: readonly [number, number];
  readonly confidenceBand?: ConfidenceBand;
  readonly recommendation: Recommendation | readonly Recommendation[];
  readonly gateFired?: string;
  readonly waitBlockedByIncludes?: readonly string[];
  readonly reasonCodesInclude?: readonly string[];
  readonly caveatCodesInclude?: readonly string[];
  readonly caveatsEmpty?: boolean;
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly protects: string;
  readonly input: ScoringInput;
  readonly expect: ScenarioExpectation;
}

const BREAKFAST = {
  code: 'BREAKFAST_2',
  displayName: 'Breakfast for two',
  basis: 'PER_NIGHT' as const,
  valueMinor: 7000,
  realizationFactor: 0.7,
};

const CREDIT = {
  code: 'HOTEL_CREDIT',
  displayName: '$100 hotel credit',
  basis: 'PER_STAY' as const,
  valueMinor: 10000,
  realizationFactor: 0.8,
};

// ── S1 ────────────────────────────────────────────────────────────────────
const s1: Scenario = {
  id: 'S1',
  title: 'Excellent deal',
  protects:
    'The happy path. Broad factor agreement must reach the EXCELLENT band and BOOK_NOW via G2.',
  input: {
    query: makeQuery({ checkIn: checkInWithLeadDays(35) }),
    current: makeCurrent(68900),
    baseline: makeBaseline({
      n: 84,
      // Thin lower tail with a tight cluster above: 689 sits near the 9th percentile.
      ladder: [
        [0, 62100],
        [0.085, 68500],
        [0.5, 74800],
        [0.9, 88100],
        [1, 92500],
      ],
      nSources: 2,
      crossSourceCv: 0.03,
    }),
    series: makeSeries({ points: 8, spanDays: 7, endMinor: 68900, deltaFraction: 0.09 }),
    comparables: makeComparables({ count: 6, index: 1.01, baselineMedianMinor: 74000 }),
    benefits: [BREAKFAST, CREDIT],
    now: NOW,
  },
  expect: {
    dealScore: [80, 97],
    dealScoreBand: 'EXCELLENT',
    confidence: [80, 100],
    confidenceBand: 'HIGH',
    recommendation: 'BOOK_NOW',
    gateFired: 'G2',
    reasonCodesInclude: ['BELOW_HISTORICAL_AVERAGE', 'BELOW_COMPARABLE_HOTELS', 'PRICE_RISING_7D'],
  },
};

// ── S2 ────────────────────────────────────────────────────────────────────
const s2: Scenario = {
  id: 'S2',
  title: 'Normal price',
  protects:
    'CONSIDER, not WAIT. Guards against the WAIT threshold drifting up until the engine tells people to wait on ordinary rates.',
  input: {
    query: makeQuery({ checkIn: checkInWithLeadDays(45) }),
    current: makeCurrent(73500),
    baseline: makeBaseline({
      n: 60,
      ladder: [
        [0, 61000],
        [0.25, 70500],
        [0.5, 74000],
        [0.75, 79000],
        [1, 92000],
      ],
    }),
    series: makeSeries({ points: 7, spanDays: 7, endMinor: 73500, deltaFraction: 0.005 }),
    comparables: makeComparables({ count: 6, index: 1.0, baselineMedianMinor: 74000 }),
    benefits: [],
    now: NOW,
  },
  expect: {
    dealScore: [45, 62],
    dealScoreBand: 'FAIR',
    confidence: [70, 100],
    recommendation: 'CONSIDER',
    gateFired: 'G5',
  },
};

// ── S3 ────────────────────────────────────────────────────────────────────
const s3: Scenario = {
  id: 'S3',
  title: 'Overpriced hotel',
  protects:
    'The only scenario that should yield WAIT. All eight never-WAIT guards must evaluate clear.',
  input: {
    query: makeQuery({ checkIn: checkInWithLeadDays(50) }),
    current: makeCurrent(91500),
    baseline: makeBaseline({
      n: 70,
      ladder: [
        [0, 58000],
        [0.5, 70000],
        [0.96, 91000],
        [1, 96000],
      ],
    }),
    series: makeSeries({ points: 7, spanDays: 7, endMinor: 91500, deltaFraction: 0 }),
    comparables: makeComparables({ count: 6, index: 1.02, baselineMedianMinor: 70000 }),
    benefits: [],
    now: NOW,
  },
  expect: {
    dealScore: [0, 28],
    dealScoreBand: 'POOR',
    confidence: [70, 100],
    recommendation: 'WAIT',
    gateFired: 'G4',
    reasonCodesInclude: ['ABOVE_HISTORICAL_AVERAGE', 'ABOVE_COMPARABLE_HOTELS'],
  },
};

// ── S4 ────────────────────────────────────────────────────────────────────
const s4: Scenario = {
  id: 'S4',
  title: 'Rapidly increasing price',
  protects:
    'Urgency routing (G3) and, critically, that W3 removes WAIT before any score path runs.',
  input: {
    query: makeQuery({ checkIn: checkInWithLeadDays(22) }),
    current: makeCurrent(74000),
    baseline: makeBaseline({
      n: 55,
      ladder: [
        [0, 64000],
        [0.42, 74000],
        [0.5, 76000],
        [1, 94000],
      ],
    }),
    series: makeSeries({ points: 10, spanDays: 7, endMinor: 74000, deltaFraction: 0.18 }),
    comparables: makeComparables({ count: 5, index: 1.0, baselineMedianMinor: 76000 }),
    benefits: [],
    demand: { events: [{ name: 'Art Basel preview', impactScore: 0.4 }] },
    now: NOW,
  },
  expect: {
    dealScore: [55, 78],
    confidence: [60, 100],
    recommendation: 'BOOK_NOW',
    gateFired: 'G3',
    waitBlockedByIncludes: ['W3'],
    reasonCodesInclude: ['PRICE_RISING_7D'],
  },
};

// ── S5 ────────────────────────────────────────────────────────────────────
const s5: Scenario = {
  id: 'S5',
  title: 'Rapidly falling price',
  protects:
    'The boundary between "good rate" and "good time". F1 high and F3 low must land on CONSIDER — never a confident BOOK_NOW that ignores the decline, never a WAIT the score does not support.',
  input: {
    query: makeQuery({ checkIn: checkInWithLeadDays(60) }),
    current: makeCurrent(70000),
    baseline: makeBaseline({
      n: 65,
      ladder: [
        [0, 63000],
        [0.22, 70000],
        [0.5, 82000],
        [1, 104000],
      ],
    }),
    series: makeSeries({ points: 9, spanDays: 7, endMinor: 70000, deltaFraction: -0.15 }),
    comparables: makeComparables({ count: 6, index: 1.0, baselineMedianMinor: 82000 }),
    benefits: [],
    demand: { events: [{ name: 'Local conference', impactScore: 0.1 }] },
    now: NOW,
  },
  expect: {
    dealScore: [58, 82],
    confidence: [65, 100],
    recommendation: 'CONSIDER',
    gateFired: 'G5',
    reasonCodesInclude: ['PRICE_FALLING_7D'],
  },
};

// ── S6 ────────────────────────────────────────────────────────────────────
const s6: Scenario = {
  id: 'S6',
  title: 'Insufficient historical data',
  protects:
    'dealScore must be null, NOT 0. A zero renders to the customer as "terrible deal". The single most important assert in the suite.',
  input: {
    query: makeQuery({ checkIn: checkInWithLeadDays(40) }),
    current: makeCurrent(68900),
    baseline: makeBaseline({
      n: 7,
      level: 'L3',
      ladder: [
        [0, 64000],
        [0.5, 72000],
        [1, 81000],
      ],
    }),
    series: makeSeries({ points: 3, spanDays: 7, endMinor: 68900, deltaFraction: 0.01 }),
    comparables: [],
    benefits: [],
    now: NOW,
  },
  expect: {
    dealScore: null,
    recommendation: 'INSUFFICIENT_DATA',
    gateFired: 'G0',
    caveatCodesInclude: ['LIMITED_HISTORY'],
  },
};

// ── S7 ────────────────────────────────────────────────────────────────────
const s7: Scenario = {
  id: 'S7',
  title: 'High price volatility',
  protects:
    'Score and confidence must DIVERGE. Volatility makes a percentile fragile, not false — the score stays high while confidence drops out of the HIGH band. This is what proves the two-number design earns its keep.',
  input: {
    query: makeQuery({ checkIn: checkInWithLeadDays(40) }),
    current: makeCurrent(61000),
    baseline: makeBaseline({
      n: 50,
      // Flash sales below and peak spikes above: cv well past the caveat threshold.
      ladder: [
        [0, 34000],
        [0.18, 61000],
        [0.5, 80000],
        [0.85, 138000],
        [1, 182000],
      ],
    }),
    series: makeSeries({ points: 6, spanDays: 7, endMinor: 61000, deltaFraction: 0.004 }),
    comparables: makeComparables({ count: 6, index: 1.0, baselineMedianMinor: 80000 }),
    benefits: [],
    now: NOW,
  },
  expect: {
    dealScore: [60, 88],
    confidence: [55, 74],
    confidenceBand: 'MODERATE',
    recommendation: ['BOOK_NOW', 'CONSIDER'],
    caveatCodesInclude: ['HIGH_VOLATILITY'],
  },
};

// ── S8 ────────────────────────────────────────────────────────────────────
const s8: Scenario = {
  id: 'S8',
  title: 'Poor room-type matching',
  protects:
    'The multiplicative confidence design must COMPOUND the match, ladder and unresolved-class penalties rather than averaging them away. Under an arithmetic mean this would still clear 70 and permit a recommendation.',
  input: {
    query: makeQuery({ checkIn: checkInWithLeadDays(40) }),
    current: makeCurrent(68900),
    baseline: makeBaseline({
      n: 40,
      level: 'L4',
      meanMatchConfidence: 0.78,
      unresolvedShare: 0.25,
      ladder: [
        [0, 58000],
        [0.3, 68900],
        [0.5, 74000],
        [1, 96000],
      ],
    }),
    series: makeSeries({ points: 6, spanDays: 7, endMinor: 68900, deltaFraction: 0.01 }),
    comparables: makeComparables({ count: 4, index: 1.0, baselineMedianMinor: 74000 }),
    benefits: [],
    now: NOW,
  },
  expect: {
    confidence: [0, 60],
    recommendation: ['CONSIDER', 'INSUFFICIENT_DATA'],
    caveatCodesInclude: ['WEAK_ROOM_MATCH', 'BASELINE_WIDENED'],
  },
};

const s8b: Scenario = {
  id: 'S8b',
  title: 'Poor room-type matching — below the blocking threshold',
  protects: 'f_match below rec.matchMin must force INSUFFICIENT_DATA via G0.',
  input: {
    ...s8.input,
    current: makeCurrent(68900, { matchMethod: 'ALIAS_FUZZY', matchConfidence: 0.6 }),
    baseline: makeBaseline({
      n: 40,
      level: 'L4',
      meanMatchConfidence: 0.52,
      unresolvedShare: 0.25,
      ladder: [
        [0, 58000],
        [0.3, 68900],
        [0.5, 74000],
        [1, 96000],
      ],
    }),
  },
  expect: {
    dealScore: null,
    recommendation: 'INSUFFICIENT_DATA',
    gateFired: 'G0',
    caveatCodesInclude: ['WEAK_ROOM_MATCH'],
  },
};

// ── S9 ────────────────────────────────────────────────────────────────────
const s9: Scenario = {
  id: 'S9',
  title: 'Conflicting market signals',
  protects:
    'Conflict must not be laundered into a middling score with no explanation. Both opposing reasons must survive into the bundle, and confidence must STAY HIGH — the data is good, only the signals disagree.',
  input: {
    query: makeQuery({ checkIn: checkInWithLeadDays(45) }),
    current: makeCurrent(69000),
    baseline: makeBaseline({
      n: 70,
      ladder: [
        [0, 63000],
        [0.12, 69000],
        [0.5, 78000],
        [1, 96000],
      ],
    }),
    series: makeSeries({ points: 8, spanDays: 7, endMinor: 69000, deltaFraction: 0.02 }),
    // The whole market is discounting harder than the subject, and is cheaper
    // in absolute terms too — so F1 and F2 genuinely disagree.
    comparables: makeComparables({
      count: 6,
      index: 0.8,
      indexSpread: 0.03,
      baselineMedianMinor: 72000,
    }),
    benefits: [],
    demand: { events: [{ name: 'Music festival', impactScore: 0.55 }] },
    now: NOW,
  },
  expect: {
    dealScore: [45, 72],
    confidence: [75, 100],
    confidenceBand: 'HIGH',
    recommendation: 'CONSIDER',
    gateFired: 'G5',
    reasonCodesInclude: ['BELOW_HISTORICAL_AVERAGE', 'ABOVE_COMPARABLE_HOTELS'],
  },
};

export const SCENARIOS: readonly Scenario[] = [s1, s2, s3, s4, s5, s6, s7, s8, s8b, s9];
