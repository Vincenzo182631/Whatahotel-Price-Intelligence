/**
 * Premium Justification — is a hotel dearer because it gives more?
 *
 * Pure-engine tests: the whole point of keeping packages/core I/O-free is that
 * cases like "30% dearer and materially better" can be stated as data instead
 * of conjured in a database.
 *
 * The measure is MONEY against money — what a rate includes against what the
 * comparables include — because that is the only quality signal the source
 * actually gives us. Star ratings, guest scores, amenities and service are not
 * in any endpoint we can reach (see computePremiumJustification's header), and
 * inventing them to satisfy a spec would be the exact dishonesty the honesty
 * rules exist to prevent.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../packages/core/src/index.js';
import {
  computeCompSetIndex,
  computePremiumJustification,
  type CompetitorRate,
} from '../../packages/core/src/scoring/liveSignals.js';

const NOW = new Date('2026-08-21T00:00:00Z');
const OBSERVED = '2026-08-20T23:00:00Z';

/** Four comparables at $550-625, median $587.50 — the brief's own example. */
function comps(benefitPerNight: number | null): CompetitorRate[] {
  return [55_000, 57_500, 60_000, 62_500].map((nightly, i) => ({
    hotelId: `C${i}`,
    name: `Comp ${i}`,
    nightlyMinor: nightly,
    observedAt: OBSERVED,
    isAvailable: true,
    ...(benefitPerNight === null ? {} : { benefitValuePerNightMinor: benefitPerNight }),
  }));
}

const justify = (subject: number, subjectBenefit: number | null, compBenefit: number | null) =>
  computePremiumJustification(subject, subjectBenefit, comps(compBenefit), DEFAULT_CONFIG);

describe('premium justification', () => {
  it('A · expensive but materially better — high justification, penalty eased', () => {
    // $750 against a $587.50 median is +27.7%. It includes $150/night that the
    // comparables' $20 does not, so $130 of the $162.50 gap is covered.
    const r = justify(75_000, 15_000, 2_000);
    expect(r.premiumPct).toBeCloseTo(27.7, 0);
    expect(r.level).toBe('HIGH');

    // The contextual penalty: effective $600 against effective $567.50 is a
    // far smaller gap than the raw ratio, so the sub-score must be higher.
    const raw = computeCompSetIndex(75_000, comps(2_000), DEFAULT_CONFIG, NOW);
    const eased = computeCompSetIndex(
      75_000,
      comps(2_000),
      DEFAULT_CONFIG,
      NOW,
      undefined,
      r.effectiveCsi,
    );
    expect(eased.signal.subScore as number).toBeGreaterThan(raw.signal.subScore as number);
    // The BAND still reports the truth about the price.
    expect(eased.band).toBe('PREMIUM');
  });

  it('B · expensive but similar — low justification, penalty stands', () => {
    const r = justify(75_000, 2_500, 2_000);
    expect(r.level).toBe('LOW');
    const raw = computeCompSetIndex(75_000, comps(2_000), DEFAULT_CONFIG, NOW);
    const scored = computeCompSetIndex(
      75_000,
      comps(2_000),
      DEFAULT_CONFIG,
      NOW,
      undefined,
      r.effectiveCsi,
    );
    // Within a point of the raw penalty: nothing was earned, nothing is given.
    expect(
      Math.abs((scored.signal.subScore as number) - (raw.signal.subScore as number)),
    ).toBeLessThanOrEqual(2);
  });

  it('C · expensive and includes LESS — very low, penalty gets harder', () => {
    const r = justify(75_000, 0, 8_000);
    expect(r.level).toBe('LOW');
    expect(r.coveredPct as number).toBeLessThan(0);
    const raw = computeCompSetIndex(75_000, comps(8_000), DEFAULT_CONFIG, NOW);
    const harder = computeCompSetIndex(
      75_000,
      comps(8_000),
      DEFAULT_CONFIG,
      NOW,
      undefined,
      r.effectiveCsi,
    );
    expect(harder.signal.subScore as number).toBeLessThan(raw.signal.subScore as number);
  });

  it('D · cheaper than the comp set — no premium to justify', () => {
    const r = justify(47_000, 2_000, 2_000);
    expect(r.level).toBe('NOT_PREMIUM');
    expect(r.premiumPct as number).toBeLessThan(0);
    // And it does not quietly become a mark against the dearer hotels.
    expect(r.confidence).toBe('HIGH');
  });

  it('E · brand-agnostic — the verdict is the evidence, nothing else', () => {
    // Same numbers, different names. If a brand ever mattered, these diverge.
    const luxury = computePremiumJustification(
      75_000,
      15_000,
      comps(2_000).map((c) => ({ ...c, name: 'Four Seasons ' + c.name })),
      DEFAULT_CONFIG,
    );
    const unknown = computePremiumJustification(
      75_000,
      15_000,
      comps(2_000).map((c) => ({ ...c, name: 'Budget Inn ' + c.name })),
      DEFAULT_CONFIG,
    );
    expect(luxury.level).toBe(unknown.level);
    expect(luxury.coveredPct).toBe(unknown.coveredPct);
  });

  it('F · the premium is measured on the SELECTED category, not the cheapest', () => {
    // Same hotel, same comparables, two categories. The suite's premium is its
    // own; scoring it on the entry room's price would answer a question the
    // guest did not ask.
    const entry = justify(50_000, 5_000, 2_000);
    const suite = justify(99_400, 5_000, 2_000);
    expect(entry.premiumPct).not.toBe(suite.premiumPct);
    expect(suite.premiumPct as number).toBeGreaterThan(entry.premiumPct as number);
  });

  it('G · thin evidence lowers confidence rather than inventing a verdict', () => {
    // Nobody's inclusions are known: we can see the gap and nothing about what
    // is given for it. That is LIMITED_DATA, never a soft yes.
    const blind = justify(75_000, null, null);
    expect(blind.level).toBe('LIMITED_DATA');
    expect(blind.confidence).toBe('LOW');
    expect(blind.effectiveCsi).toBeNull();

    // And with the subject known but only one comparable speaking, the verdict
    // exists but is not confident.
    const oneComp: CompetitorRate[] = [
      {
        hotelId: 'C0',
        name: 'C0',
        nightlyMinor: 55_000,
        observedAt: OBSERVED,
        isAvailable: true,
        benefitValuePerNightMinor: 2_000,
      },
      { hotelId: 'C1', name: 'C1', nightlyMinor: 57_500, observedAt: OBSERVED, isAvailable: true },
      { hotelId: 'C2', name: 'C2', nightlyMinor: 60_000, observedAt: OBSERVED, isAvailable: true },
    ];
    const thin = computePremiumJustification(75_000, 15_000, oneComp, DEFAULT_CONFIG);
    expect(thin.compsWithBenefits).toBe(1);
    expect(thin.confidence).toBe('LOW');
  });

  it('never treats an unknown inclusion as a zero one', () => {
    // A comp that told us nothing must not drag the market's included value
    // down — that would manufacture a justified premium out of our own gaps.
    const silent = justify(75_000, 15_000, null);
    expect(silent.level).toBe('LIMITED_DATA');
    expect(silent.medianCompBenefitPerNightMinor).toBeNull();
  });
});
