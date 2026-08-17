/**
 * Reason and caveat derivation.
 *
 * Every reason is a COMPUTED FACT with a complete, human-readable sentence
 * produced deterministically here. The language model's job downstream is to
 * select and combine these, never to derive them.
 *
 * See docs/mvp/04-explanation-engine.md §2.
 */

import { formatMoney, type Money } from '../money.js';
import type { Minor } from '../types.js';

export type ReasonDirection = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
export type ReasonUnit = 'PERCENT' | 'CURRENCY_MINOR' | 'DAYS' | 'COUNT' | 'SCORE' | 'NONE';

export interface ReasonFact {
  readonly code: string;
  readonly direction: ReasonDirection;
  readonly magnitude: number;
  readonly unit: ReasonUnit;
  readonly fact: string;
  readonly supporting: Readonly<Record<string, number | string | readonly string[]>>;
}

export interface CaveatFact {
  readonly code: string;
  readonly text: string;
}

/** Percentage below which a difference is not worth mentioning as a reason. */
const MATERIAL_PCT = 1.5;

export interface ReasonInputs {
  readonly currency: string;
  readonly currentNightlyMinor: Minor;
  readonly typicalNightlyMinor: Minor | null;
  readonly pctBelowTypical: number | null;
  readonly percentileRank: number | null;
  readonly lookbackDays: number;
  readonly nObservations: number;
  readonly lowestMinor: Minor | null;

  readonly pctVsCompMedian: number | null;
  readonly compCount: number;
  readonly compMedianMinor: Minor | null;

  readonly trendPct: number | null;
  readonly trendWindowDays: number;
  readonly trendStartMinor: Minor | null;

  readonly seasonalIndex: number | null;
  readonly demandPressure: number;
  readonly demandEvents: readonly string[];

  readonly benefitValuePerNightMinor: Minor;
  readonly effectiveNightlyMinor: Minor | null;
  readonly benefitNames: readonly string[];
}

function m(amountMinor: Minor, currency: string): Money {
  return { amountMinor, currency };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Ordered strongest-first, so the explanation leads with what mattered most. */
export function deriveReasons(input: ReasonInputs): readonly ReasonFact[] {
  const reasons: ReasonFact[] = [];
  const cur = input.currency;

  // F1 — position against the hotel's own history
  if (input.pctBelowTypical !== null && input.typicalNightlyMinor !== null) {
    const pct = round1(Math.abs(input.pctBelowTypical));
    const percentile =
      input.percentileRank === null ? null : Math.round(input.percentileRank * 100);

    if (input.pctBelowTypical >= MATERIAL_PCT) {
      const nearLow = input.lowestMinor !== null && input.currentNightlyMinor <= input.lowestMinor;
      reasons.push({
        code: nearLow ? 'NEW_LOW' : 'BELOW_HISTORICAL_AVERAGE',
        direction: 'POSITIVE',
        magnitude: pct,
        unit: 'PERCENT',
        fact: nearLow
          ? `At ${formatMoney(m(input.currentNightlyMinor, cur))} this is the lowest rate we have recorded for this room in the last ${input.lookbackDays} days.`
          : `The current rate is ${pct}% below the typical rate for this room over the last ${input.lookbackDays} days.`,
        supporting: {
          current_minor: input.currentNightlyMinor,
          typical_minor: input.typicalNightlyMinor,
          ...(percentile !== null ? { percentile } : {}),
        },
      });
    } else if (input.pctBelowTypical <= -MATERIAL_PCT) {
      reasons.push({
        code: 'ABOVE_HISTORICAL_AVERAGE',
        direction: 'NEGATIVE',
        magnitude: pct,
        unit: 'PERCENT',
        fact: `The current rate is ${pct}% above the typical rate for this room over the last ${input.lookbackDays} days.`,
        supporting: {
          current_minor: input.currentNightlyMinor,
          typical_minor: input.typicalNightlyMinor,
          ...(percentile !== null ? { percentile } : {}),
        },
      });
    }
  }

  // F2 — position against comparable hotels
  if (input.pctVsCompMedian !== null && input.compCount > 0) {
    const pct = round1(Math.abs(input.pctVsCompMedian));
    if (input.pctVsCompMedian >= MATERIAL_PCT) {
      reasons.push({
        code: 'BELOW_COMPARABLE_HOTELS',
        direction: 'POSITIVE',
        magnitude: pct,
        unit: 'PERCENT',
        fact: `The rate is ${pct}% below the median of ${input.compCount} comparable hotels for the same dates.`,
        supporting: {
          comp_count: input.compCount,
          ...(input.compMedianMinor !== null ? { comp_median_minor: input.compMedianMinor } : {}),
        },
      });
    } else if (input.pctVsCompMedian <= -MATERIAL_PCT) {
      reasons.push({
        code: 'ABOVE_COMPARABLE_HOTELS',
        direction: 'NEGATIVE',
        magnitude: pct,
        unit: 'PERCENT',
        fact: `The rate is ${pct}% above the median of ${input.compCount} comparable hotels for the same dates.`,
        supporting: {
          comp_count: input.compCount,
          ...(input.compMedianMinor !== null ? { comp_median_minor: input.compMedianMinor } : {}),
        },
      });
    }
  }

  // F3 — recent movement
  if (input.trendPct !== null && Math.abs(input.trendPct) >= MATERIAL_PCT) {
    const pct = round1(Math.abs(input.trendPct));
    const rising = input.trendPct > 0;
    reasons.push({
      code: rising ? 'PRICE_RISING_7D' : 'PRICE_FALLING_7D',
      direction: rising ? 'POSITIVE' : 'NEGATIVE',
      magnitude: pct,
      unit: 'PERCENT',
      fact: rising
        ? `The rate for this stay has increased ${pct}% over the past ${input.trendWindowDays} days.`
        : `The rate for this stay has decreased ${pct}% over the past ${input.trendWindowDays} days.`,
      supporting: {
        window_days: input.trendWindowDays,
        ...(input.trendStartMinor !== null ? { start_minor: input.trendStartMinor } : {}),
      },
    });
  }

  // F5 — demand context
  if (input.demandPressure >= 0.6 && input.demandEvents.length > 0) {
    reasons.push({
      code: 'EVENT_DRIVEN_DEMAND',
      direction: 'NEGATIVE',
      magnitude: round1(input.demandPressure * 100),
      unit: 'PERCENT',
      fact: `Demand for these dates is elevated by ${input.demandEvents.join(', ')}.`,
      supporting: { events: input.demandEvents },
    });
  }

  // F4 — seasonality
  if (input.seasonalIndex !== null && input.seasonalIndex <= 0.9) {
    const pct = round1((1 - input.seasonalIndex) * 100);
    reasons.push({
      code: 'LOW_SEASON',
      direction: 'POSITIVE',
      magnitude: pct,
      unit: 'PERCENT',
      fact: `These dates fall in a period that typically prices ${pct}% below this hotel's annual norm.`,
      supporting: { seasonal_index: input.seasonalIndex },
    });
  }

  // F6 — included value
  if (input.benefitValuePerNightMinor > 0 && input.effectiveNightlyMinor !== null) {
    reasons.push({
      code: 'BENEFITS_INCLUDED',
      direction: 'POSITIVE',
      magnitude: input.benefitValuePerNightMinor,
      unit: 'CURRENCY_MINOR',
      fact: `Included benefits are valued at about ${formatMoney(m(input.benefitValuePerNightMinor, cur))} per night, giving an effective rate of ${formatMoney(m(input.effectiveNightlyMinor, cur))}.`,
      supporting: { benefits: input.benefitNames },
    });
  }

  return reasons;
}

export interface CaveatInputs {
  readonly baselineLevel: string;
  readonly nObservations: number;
  readonly minObsTarget: number;
  readonly volatilityCv: number;
  readonly volatilityCvMax: number;
  readonly rateAgeHours: number;
  readonly maxCurrentAgeHours: number;
  readonly matchQuality: number;
  readonly nSources: number;
  readonly compCount: number;
  readonly minComps: number;
  readonly insufficientReasons: readonly string[];
}

export function deriveCaveats(input: CaveatInputs): readonly CaveatFact[] {
  const caveats: CaveatFact[] = [];

  if (input.insufficientReasons.includes('INSUFFICIENT_OBSERVATIONS')) {
    caveats.push({
      code: 'LIMITED_HISTORY',
      text: `We have only ${input.nObservations} recorded rates for this room, and need at least ${input.minObsTarget} to assess it reliably.`,
    });
  } else if (input.nObservations < input.minObsTarget) {
    caveats.push({
      code: 'LIMITED_HISTORY',
      text: `This assessment is based on a limited number of recorded rates (${input.nObservations}).`,
    });
  }

  if (input.baselineLevel === 'L3' || input.baselineLevel === 'L4') {
    caveats.push({
      code: 'BASELINE_WIDENED',
      text:
        input.baselineLevel === 'L4'
          ? 'We are comparing against similar rooms at this hotel, not this exact room type.'
          : 'We are comparing across a wider range of dates than usual for this room.',
    });
  }

  if (input.volatilityCv > input.volatilityCvMax) {
    caveats.push({
      code: 'HIGH_VOLATILITY',
      text: "This room's price has been unusually volatile, so any single reading is less durable.",
    });
  }

  if (input.rateAgeHours > input.maxCurrentAgeHours) {
    caveats.push({
      code: 'STALE_DATA',
      text: `This rate was last observed ${Math.round(input.rateAgeHours)} hours ago and may have changed.`,
    });
  }

  if (input.matchQuality < 0.75) {
    caveats.push({
      code: 'WEAK_ROOM_MATCH',
      text: 'We are less certain that the historical rates describe exactly this room type.',
    });
  }

  if (input.nSources <= 1) {
    caveats.push({
      code: 'SINGLE_SOURCE',
      text: 'This assessment draws on a single rate source, so we cannot cross-check it.',
    });
  }

  if (input.compCount < input.minComps) {
    caveats.push({
      code: 'NO_COMPARABLES',
      text: 'We did not have enough comparable hotels with live rates for these dates.',
    });
  }

  // SHORT_LEAD_TIME went with WAIT in config v4. Its text — "these dates are
  // close enough that rates are unlikely to soften" — was a forecast, and it
  // existed only to argue against a verdict the engine no longer produces.

  return caveats;
}
