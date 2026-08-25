/**
 * The fact/interpretation split for the live model.
 *
 * Rule 4: the AI never computes. It receives an ExplanationBundle of
 * already-decided facts and rewords them, and every number it writes is
 * checked against that bundle before a customer sees it. These tests hold the
 * three things that makes true —
 *
 *   the bundle contains facts and an allowlist, never raw inputs;
 *   the deterministic renderer works with no model at all, and passes its own
 *     validator;
 *   a draft that fabricates a number, or predicts a price, is discarded whole.
 *
 * No key, no network. The reasoner is driven through an injected endpoint.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../packages/core/src/index.js';
import {
  buildLiveExplanationBundle,
  type LiveBundleInput,
  type LiveExplanationBundle,
} from '../../packages/core/src/explanation/liveBundle.js';
import { renderLiveExplanation } from '../../packages/core/src/explanation/liveTemplate.js';
import { validateNarrative } from '../../packages/core/src/explanation/validate.js';
import { containsPredictiveLanguage } from '../../packages/core/src/explanation/predictive.js';
import { numeralsIn } from '../../packages/core/src/explanation/bundle.js';
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

function competitors(nightly: readonly number[], benefit: number | null = null): CompetitorRate[] {
  return nightly.map((n, i) => ({
    hotelId: `comp-${i}`,
    name: `Competitor ${i}`,
    nightlyMinor: n,
    observedAt: OBSERVED,
    isAvailable: true,
    ...(benefit === null ? {} : { benefitValuePerNightMinor: benefit }),
  }));
}

interface Tweak {
  readonly subjectNightly?: number;
  readonly comps?: readonly number[];
  readonly compBenefit?: number | null;
  readonly subjectBenefit?: number | null;
  readonly reputation?: LiveBundleInput['reputation'];
  readonly comparableRatings?: readonly number[];
  readonly termsBasis?: 'MATCHED' | 'PRICE_ONLY';
}

function bundleFor(tweak: Tweak = {}): LiveExplanationBundle {
  const subjectNightly = tweak.subjectNightly ?? 44_200;
  const comps = competitors(
    tweak.comps ?? [48_000, 50_000, 52_000, 55_000],
    tweak.compBenefit ?? null,
  );

  const premium = computePremiumJustification(
    subjectNightly,
    tweak.subjectBenefit ?? null,
    comps,
    DEFAULT_CONFIG,
  );
  const compSet = computeCompSetIndex(
    subjectNightly,
    comps,
    DEFAULT_CONFIG,
    NOW,
    { strength: 'RESOLVED', unknown: [], termsBasis: tweak.termsBasis ?? 'MATCHED' },
    premium.level === 'HIGH' || premium.level === 'MODERATE' || premium.level === 'LOW'
      ? premium.effectiveCsi
      : null,
  );
  const calendar = computeCalendarDelta(
    subjectNightly,
    [46_000, 47_000, 45_500].map((n, i) => ({
      checkIn: `2026-09-0${i + 1}`,
      nightlyMinor: n,
      observedAt: OBSERVED,
      sameDow: true,
    })),
    DEFAULT_CONFIG,
  );
  const compression = computeCompression({ checked: 8, soldOut: 3 }, DEFAULT_CONFIG);
  const result = composeLiveScore(compSet, calendar, compression, 1, DEFAULT_CONFIG);

  return buildLiveExplanationBundle({
    configVersion: DEFAULT_CONFIG.version,
    hotelName: 'Loews Miami Beach',
    roomTypeName: 'Corner King',
    roomClass: 'ROOM',
    checkIn: '2026-09-10',
    checkOut: '2026-09-13',
    nights: 3,
    adults: 2,
    children: 0,
    currency: 'USD',
    nightlyMinor: subjectNightly,
    totalMinor: subjectNightly * 3,
    observedAt: OBSERVED,
    result,
    compSet,
    calendar,
    compression,
    premium,
    compBasis: 'CURATED',
    compRoomMatch: 'CLASS_AND_VIEW',
    reputation: tweak.reputation ?? null,
    comparableRatings: tweak.comparableRatings ?? [],
  });
}

describe('the live bundle carries facts, not inputs', () => {
  it('publishes an allowlist that covers what the renderer writes', () => {
    const bundle = bundleFor();
    const rendered = renderLiveExplanation(bundle);
    expect(rendered.text.length).toBeGreaterThan(0);

    const check = validateNarrative(rendered.text, bundle.constraints);
    // The deterministic renderer failing its OWN validator would mean the
    // safe fallback is the thing that ships a fabricated number.
    expect(check.violations).toEqual([]);
  });

  it('never states a future price', () => {
    for (const tweak of [
      {},
      { subjectNightly: 70_000 },
      { subjectNightly: 30_000 },
      { comps: [] as number[] },
      { subjectBenefit: 6_000, compBenefit: 1_000 },
      { subjectNightly: 62_000, subjectBenefit: 500, compBenefit: 400 },
      {
        reputation: {
          source: 'GOOGLE' as const,
          rating: 4.6,
          review_count: 3200,
          display_name: null,
        },
      },
    ]) {
      const text = renderLiveExplanation(bundleFor(tweak)).text;
      expect(containsPredictiveLanguage(text), text).toBe(false);
    }
  });

  it('renders an absent score as absent, never as zero — and never narrates the absence', () => {
    const bundle = bundleFor({ comps: [] });
    const text = renderLiveExplanation(bundle).text;
    // The price is still stated confidently; the missing comparison is an
    // internal condition, not customer copy (owner directive, 2026-08-26).
    expect(text).toMatch(/a night before taxes and fees\./);
    expect(text).not.toMatch(/\b0 out of 10\b/);
    expect(text).not.toMatch(/not enough|could not|unable to|insufficient|unavailable/i);
  });

  it('no rendering, scored or not, exposes an internal data limitation', () => {
    const BANNED = /not enough|could not verify|unable to|insufficient|we do not have enough/i;
    for (const tweak of [
      {},
      { comps: [] as number[] },
      { subjectNightly: 70_000 },
      { termsBasis: 'PRICE_ONLY' as const },
      { subjectBenefit: 6_000, compBenefit: 1_000 },
    ]) {
      const text = renderLiveExplanation(bundleFor(tweak)).text;
      expect(BANNED.test(text), text).toBe(false);
    }
  });
});

describe('reputation is context, not a term', () => {
  it('is null — never zero — when nothing was matched', () => {
    const bundle = bundleFor();
    expect(bundle.reputation.subject).toBeNull();
    expect(bundle.reputation.comparable_median_rating).toBeNull();
  });

  it('does not move the score', () => {
    const without = bundleFor();
    const with_ = bundleFor({
      reputation: { source: 'GOOGLE', rating: 4.8, review_count: 5000, display_name: null },
      comparableRatings: [3.9, 4.0, 4.1, 4.2],
    });
    expect(with_.verdict.score).toBe(without.verdict.score);
    expect(with_.market.comp_set.index).toBe(without.market.comp_set.index);
    expect(with_.constraints.reputation_is_not_scored).toBe(true);
  });

  it('states the rating with its review count attached', () => {
    const bundle = bundleFor({
      subjectNightly: 44_200,
      reputation: { source: 'GOOGLE', rating: 4.6, review_count: 3200, display_name: null },
    });
    const text = renderLiveExplanation(bundle).text;
    // Only reached when there is no premium sentence competing for the slot.
    if (text.includes('Google')) {
      expect(text).toContain('4.6');
      expect(text).toContain('3,200');
    }
    expect(validateNarrative(text, bundle.constraints).violations).toEqual([]);
  });

  it('withholds a comparables median until three comparables carry one', () => {
    const thin = bundleFor({ comparableRatings: [4.1, 4.3] });
    expect(thin.reputation.comparable_median_rating).toBeNull();
    expect(thin.reputation.comparables_with_rating).toBe(0);

    const enough = bundleFor({ comparableRatings: [4.1, 4.3, 4.5] });
    expect(enough.reputation.comparable_median_rating).toBe(4.3);
    expect(enough.reputation.comparables_with_rating).toBe(3);
  });
});

describe('money reaches the model in display form only', () => {
  it('rejects a draft that presents minor units as a price', () => {
    // The failure this guards is not hypothetical: the first model-written
    // explanation in production read total_minor 232676 and wrote "a total
    // of $232,676" — cents as dollars, a hundredfold overstatement — and
    // the old allowlist passed it.
    const bundle = bundleFor({ subjectNightly: 44_200 });
    const minor = bundle.price.total_minor;
    const check = validateNarrative(
      `The stay costs $${minor.toLocaleString('en-US')} in total.`,
      bundle.constraints,
    );
    expect(check.ok).toBe(false);
    expect(check.violations.join(' ')).toContain(String(minor));
  });

  it('carries the display forms the prose should copy', () => {
    const bundle = bundleFor({ subjectNightly: 44_200 });
    expect(bundle.price.nightly_display).toBe('$442');
    expect(bundle.price.total_display).toBe('$1,326');
    // And the major amounts inside them are on the allowlist.
    const allowed = new Set(bundle.constraints.allowed_numbers);
    expect(allowed.has(442)).toBe(true);
    expect(allowed.has(1326)).toBe(true);
    expect(allowed.has(bundle.price.total_minor)).toBe(false);
  });
});

describe('validateNarrative', () => {
  const constraints = { allowed_numbers: [3, 10, 442, 7.2], max_sentences: 3 };

  it('accepts prose built only from listed numbers', () => {
    expect(validateNarrative('It is $442 a night, rated 7.2 out of 10.', constraints).ok).toBe(
      true,
    );
  });

  it('rejects a number the engine never computed', () => {
    const check = validateNarrative('It is 18% below the market.', constraints);
    expect(check.ok).toBe(false);
    expect(check.violations.join(' ')).toContain('18');
  });

  it('rejects a forecast even when every number is legitimate', () => {
    const check = validateNarrative('At $442 the price will rise soon.', constraints);
    expect(check.ok).toBe(false);
    expect(check.violations.join(' ')).toContain('predictive');
  });

  it('rejects an over-long answer', () => {
    expect(validateNarrative('One. Two. Three. Four.', constraints).ok).toBe(false);
  });

  it('rejects an empty answer', () => {
    expect(validateNarrative('   ', constraints).ok).toBe(false);
  });
});

describe('every numeral the renderer writes is in the allowlist', () => {
  it('holds across a spread of market shapes', () => {
    const shapes: Tweak[] = [
      { subjectNightly: 30_000 },
      { subjectNightly: 44_200 },
      { subjectNightly: 62_000, subjectBenefit: 8_000, compBenefit: 1_000 },
      { subjectNightly: 62_000, subjectBenefit: 500, compBenefit: 400 },
      { subjectNightly: 62_000 },
      { comps: [48_000] },
      { reputation: { source: 'GOOGLE', rating: 4.9, review_count: 32, display_name: 'X' } },
    ];
    for (const shape of shapes) {
      const bundle = bundleFor(shape);
      const text = renderLiveExplanation(bundle).text;
      const allowed = new Set(bundle.constraints.allowed_numbers);
      for (const n of numeralsIn(text)) {
        expect(allowed.has(Math.round(n * 10) / 10), `${n} in "${text}"`).toBe(true);
      }
    }
  });
});

describe('the price-only comparison is disclosed wherever it is rendered', () => {
  it('carries terms_basis on the bundle and the qualifier in the narrative', () => {
    const bundle = bundleFor({ termsBasis: 'PRICE_ONLY' });
    expect(bundle.market.comp_set.terms_basis).toBe('PRICE_ONLY');

    const rendered = renderLiveExplanation(bundle);
    expect(rendered.text).toContain('compared on price alone');
    // The disclosure must not cost the renderer its own validator.
    const check = validateNarrative(rendered.text, bundle.constraints);
    expect(check.violations).toEqual([]);
  });

  it('a terms-matched bundle never carries the qualifier', () => {
    const bundle = bundleFor();
    expect(bundle.market.comp_set.terms_basis).toBe('MATCHED');
    expect(renderLiveExplanation(bundle).text).not.toContain('compared on price alone');
  });
});

describe('V3 — data-limitation language rejects a draft whole', () => {
  it('rejects the phrases a model might use to narrate a system condition', () => {
    const bundle = bundleFor();
    for (const bad of [
      'We do not have enough data to compare this rate.',
      'Insufficient data prevents a full comparison.',
      'We could not verify the comparable rates.',
      'Unfortunately, market data is unavailable for these dates.',
      'There is not enough comparable information for these dates.',
    ]) {
      const check = validateNarrative(bad, bundle.constraints);
      expect(check.violations.join(' '), bad).toContain('data-limitation');
    }
  });

  it('passes honest caveats stated about the product, not the system', () => {
    const bundle = bundleFor();
    const ok = 'The rates do not state what each includes, so the comparison rests on price alone.';
    const check = validateNarrative(ok, bundle.constraints);
    expect(check.violations).toEqual([]);
  });
});
