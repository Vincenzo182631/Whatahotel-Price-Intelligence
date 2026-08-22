/**
 * The Premium Justification assessment — Phase 4's reasoning layer, held to
 * the same standard as everything else the customer reads.
 *
 * What these tests protect, in order of importance:
 *
 *   1. The Deal Score is untouched. Reputation supports a VERDICT; it moves
 *      no number. (The score-invariance test lives in live-explanation.test —
 *      here we hold the assessment layer to the same fact set.)
 *   2. "Expensive with strong differentiation" and "expensive with little
 *      differentiation" are separated by EVIDENCE, not by brand. No hotel
 *      name appears anywhere in the logic.
 *   3. A model verdict citing evidence the bundle does not carry — the text
 *      form of inventing data — is rejected whole.
 *   4. Confidence is computed from the evidence by code. The model's own
 *      grade of itself is discarded.
 *
 * Pure — no network, no keys, no database.
 */

import { describe, expect, it } from 'vitest';

import {
  deterministicAssessment,
  evidenceConfidence,
  evidencePresent,
  validateAssessment,
} from '../../packages/core/src/explanation/assessment.js';
import { DEFAULT_CONFIG } from '../../packages/core/src/index.js';
import { buildLiveExplanationBundle } from '../../packages/core/src/explanation/liveBundle.js';
import {
  computeCalendarDelta,
  computeCompression,
  computeCompSetIndex,
  computePremiumJustification,
  type CompetitorRate,
} from '../../packages/core/src/scoring/liveSignals.js';
import { composeLiveScore } from '../../packages/core/src/scoring/liveScore.js';

const NOW = new Date('2026-08-21T00:00:00Z');
const OBSERVED = '2026-08-20T23:00:00Z';

interface Shape {
  readonly subjectNightly?: number;
  readonly compNightlies?: readonly number[];
  readonly subjectBenefit?: number | null;
  readonly compBenefit?: number | null;
  readonly reputation?: { rating: number; count: number } | null;
  readonly comparableRatings?: readonly number[];
  readonly roomMatch?: string;
}

function bundleFor(shape: Shape = {}) {
  const comps: CompetitorRate[] = (shape.compNightlies ?? [60_000, 62_000, 64_000]).map((n, i) => ({
    hotelId: `c${i}`,
    name: `Comp ${i}`,
    nightlyMinor: n,
    observedAt: OBSERVED,
    isAvailable: true,
    ...(shape.compBenefit != null ? { benefitValuePerNightMinor: shape.compBenefit } : {}),
  }));
  const subjectNightly = shape.subjectNightly ?? 85_000;
  const premium = computePremiumJustification(
    subjectNightly,
    shape.subjectBenefit ?? null,
    comps,
    DEFAULT_CONFIG,
  );
  const compSet = computeCompSetIndex(
    subjectNightly,
    comps,
    DEFAULT_CONFIG,
    NOW,
    { strength: 'RESOLVED', unknown: [] },
    null,
  );
  const calendar = computeCalendarDelta(subjectNightly, [], DEFAULT_CONFIG);
  const compression = computeCompression(null, DEFAULT_CONFIG);
  return buildLiveExplanationBundle({
    configVersion: DEFAULT_CONFIG.version,
    hotelName: 'Subject Hotel',
    city: 'Testville',
    roomTypeName: 'Ocean View Room',
    checkIn: '2026-09-10',
    checkOut: '2026-09-13',
    nights: 3,
    adults: 2,
    children: 0,
    currency: 'USD',
    nightlyMinor: subjectNightly,
    totalMinor: subjectNightly * 3,
    observedAt: OBSERVED,
    result: composeLiveScore(compSet, calendar, compression, 1, DEFAULT_CONFIG),
    compSet,
    calendar,
    compression,
    premium,
    compBasis: 'CURATED',
    compRoomMatch: (shape.roomMatch as never) ?? 'CLASS_AND_VIEW',
    reputation: shape.reputation
      ? {
          source: 'GOOGLE',
          rating: shape.reputation.rating,
          review_count: shape.reputation.count,
          display_name: null,
        }
      : null,
    comparableRatings: shape.comparableRatings ?? [],
  });
}

/** A structurally valid model verdict for the given bundle. */
function draftFor(bundle: ReturnType<typeof bundleFor>, over: Record<string, unknown> = {}) {
  return {
    level: 'MEDIUM',
    reasoning: 'The room is priced above the comparable hotels for these dates.',
    key_positive_factors: [],
    key_negative_factors: ['Priced above the comparable set.'],
    confidence: 'LOW',
    recommendation: 'Consider the comparable hotels as well.',
    evidence_used: ['live_rate', 'comparable_rates'],
    ...over,
  };
}

describe('evidenceConfidence — the ladder is code, not judgement', () => {
  it('follows the comparable-count ladder from the spec', () => {
    expect(evidenceConfidence(1, 'CLASS_AND_VIEW', true)).toBe('LOW');
    expect(evidenceConfidence(3, 'CLASS_AND_VIEW', true)).toBe('MEDIUM');
    expect(evidenceConfidence(6, 'CLASS_AND_VIEW', true)).toBe('HIGH');
  });

  it('caps at the weakest link, not the strongest', () => {
    expect(evidenceConfidence(6, 'ANY', true)).toBe('LOW');
    expect(evidenceConfidence(6, 'CLASS', true)).toBe('MEDIUM');
    expect(evidenceConfidence(6, 'CLASS_AND_VIEW', false)).toBe('MEDIUM');
  });
});

describe('the luxury rule — evidence separates, brand never does', () => {
  const premiumShape: Shape = {
    subjectNightly: 85_000,
    compNightlies: [60_000, 62_000, 64_000, 61_000, 63_000, 62_500],
  };

  it('a strongly-evidenced premium CAN be assessed as justified', () => {
    // ~37% premium, strong verified reputation, comparables rated lower.
    const bundle = bundleFor({
      ...premiumShape,
      reputation: { rating: 4.7, count: 4328 },
      comparableRatings: [4.1, 4.2, 4.3, 4.0],
    });
    const check = validateAssessment(
      draftFor(bundle, {
        level: 'HIGH',
        reasoning:
          'The rate is above the comparable hotels, and the premium appears supported by a stronger verified guest reputation than the comparables hold.',
        key_positive_factors: ['Guest rating well above the comparable median.'],
        evidence_used: [
          'live_rate',
          'comparable_rates',
          'premium_pct',
          'google_rating',
          'google_review_count',
          'comparable_google_ratings',
        ],
      }),
      bundle,
    );
    expect(check.violations).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.value?.level).toBe('HIGH');
    // Confidence came from the ladder, not from the draft's own claim.
    expect(check.value?.confidence).toBe('HIGH');
  });

  it('the SAME premium without differentiating evidence cannot claim HIGH', () => {
    // Identical prices; no reputation, no included-value data. HIGH would
    // rest on nothing the system can point to, so the gate refuses it.
    const bundle = bundleFor(premiumShape);
    const check = validateAssessment(draftFor(bundle, { level: 'HIGH' }), bundle);
    expect(check.ok).toBe(false);
    expect(check.violations.join(' ')).toContain('HIGH without reputation');
  });

  it('and the numbers themselves never moved for reputation', () => {
    const plain = bundleFor(premiumShape);
    const famous = bundleFor({ ...premiumShape, reputation: { rating: 4.9, count: 9000 } });
    expect(famous.verdict.score).toBe(plain.verdict.score);
    expect(famous.premium.premium_pct).toBe(plain.premium.premium_pct);
  });
});

describe('validateAssessment — rejection, never repair', () => {
  it('rejects a verdict citing evidence the bundle does not carry', () => {
    const bundle = bundleFor(); // no reputation
    const check = validateAssessment(
      draftFor(bundle, { evidence_used: ['live_rate', 'google_rating'] }),
      bundle,
    );
    expect(check.ok).toBe(false);
    expect(check.violations.join(' ')).toContain('cites absent evidence google_rating');
  });

  it('rejects an invented numeral anywhere in the verdict text', () => {
    const bundle = bundleFor();
    const check = validateAssessment(
      draftFor(bundle, { reasoning: 'The rate is 55% above the market.' }),
      bundle,
    );
    expect(check.ok).toBe(false);
    expect(check.violations.join(' ')).toContain('55');
  });

  it('rejects predictive language in any field', () => {
    const bundle = bundleFor();
    const check = validateAssessment(
      draftFor(bundle, { recommendation: 'Book before the price rises.' }),
      bundle,
    );
    expect(check.ok).toBe(false);
    expect(check.violations.join(' ')).toContain('predictive');
  });

  it('rejects an unknown level, an unknown evidence key, and an evidence-free verdict', () => {
    const bundle = bundleFor();
    expect(validateAssessment(draftFor(bundle, { level: 'AMAZING' }), bundle).ok).toBe(false);
    expect(validateAssessment(draftFor(bundle, { evidence_used: ['vibes'] }), bundle).ok).toBe(
      false,
    );
    expect(validateAssessment(draftFor(bundle, { evidence_used: [] }), bundle).ok).toBe(false);
  });

  it("overrides the model's own confidence with the computed one", () => {
    const bundle = bundleFor({
      compNightlies: [60_000, 62_000, 64_000, 61_000, 63_000, 62_500],
      reputation: { rating: 4.5, count: 900 },
    });
    const check = validateAssessment(draftFor(bundle, { confidence: 'LOW' }), bundle);
    expect(check.ok).toBe(true);
    expect(check.value?.confidence).toBe('HIGH');
  });
});

describe('deterministicAssessment — the floor with no model at all', () => {
  it('maps the money-vs-money levels and invents nothing', () => {
    const bundle = bundleFor({ subjectBenefit: 500, compBenefit: 400 });
    const assessment = deterministicAssessment(bundle);
    expect(assessment).not.toBeNull();
    expect(['HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT_DATA']).toContain(assessment?.level);
    expect(assessment?.key_positive_factors).toEqual([]);
    expect(assessment?.source).toBe('DETERMINISTIC');
  });

  it('is null when there is no premium to justify', () => {
    const bundle = bundleFor({ subjectNightly: 55_000 });
    expect(bundle.premium.level).toBe('NOT_PREMIUM');
    expect(deterministicAssessment(bundle)).toBeNull();
  });

  it("reports INSUFFICIENT_DATA when neither side's inclusions are known", () => {
    const bundle = bundleFor();
    expect(deterministicAssessment(bundle)?.level).toBe('INSUFFICIENT_DATA');
  });
});

describe('evidencePresent — the citation whitelist is grounded in the bundle', () => {
  it('tracks what the bundle actually carries', () => {
    const bare = evidencePresent(bundleFor());
    expect(bare.has('live_rate')).toBe(true);
    expect(bare.has('google_rating')).toBe(false);

    const rated = evidencePresent(bundleFor({ reputation: { rating: 4.5, count: 100 } }));
    expect(rated.has('google_rating')).toBe(true);
    expect(rated.has('google_review_count')).toBe(true);
  });
});
