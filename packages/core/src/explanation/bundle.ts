/**
 * The ExplanationBundle — the ONLY input the language model ever receives.
 *
 * No raw observations, no database access, no tools. Its entire job is to turn
 * this list of already-computed facts into two or three readable sentences.
 * See docs/mvp/04-explanation-engine.md.
 */

import type { AnalysisResult } from '../types.js';
import type { CaveatFact, ReasonFact } from './reasonCodes.js';

export const BUNDLE_VERSION = 1;

export interface ExplanationBundle {
  readonly bundle_version: number;
  readonly config_version: number;
  readonly subject: {
    readonly hotel_name: string;
    readonly room_type_name: string;
    readonly check_in: string;
    readonly check_out: string;
    readonly nights: number;
    readonly adults: number;
    readonly children: number;
  };
  readonly verdict: {
    readonly recommendation: string;
    readonly deal_score: number | null;
    readonly deal_score_band: string | null;
    readonly confidence: number;
    readonly confidence_band: string;
    readonly gate_fired: string;
  };
  readonly price: {
    readonly currency: string;
    readonly nightly_minor: number;
    readonly total_minor: number;
    readonly effective_nightly_minor: number | null;
    readonly observed_at: string;
  };
  readonly baseline: {
    readonly level: string;
    readonly n_observations: number;
    readonly lookback_days: number;
    readonly median_nightly_minor: number | null;
    readonly min_nightly_minor: number | null;
    readonly max_nightly_minor: number | null;
  };
  readonly factors: readonly ReasonFact[];
  readonly caveats: readonly CaveatFact[];
  readonly constraints: {
    /**
     * Every number the model is permitted to state. Output is validated
     * against this list before display — the primary guard against fabricated
     * statistics (validator V1).
     */
    readonly allowed_numbers: readonly number[];
    readonly currency_symbol: string;
    readonly must_not_predict: true;
    readonly max_sentences: number;
  };
}

function addNumber(set: Set<number>, value: number | null | undefined): void {
  if (value === null || value === undefined || !Number.isFinite(value)) return;
  set.add(round1(value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Minor units also enter the allowlist as their major-unit display form. */
function addMoneyNumber(set: Set<number>, minor: number | null | undefined): void {
  if (minor === null || minor === undefined || !Number.isFinite(minor)) return;
  addNumber(set, minor);
  addNumber(set, Math.round(minor / 100));
}

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
};

export function buildExplanationBundle(
  analysis: AnalysisResult,
  reasons: readonly ReasonFact[],
  caveats: readonly CaveatFact[],
  maxSentences: number,
): ExplanationBundle {
  const { query, baseline } = analysis;

  const allowed = new Set<number>();
  addNumber(allowed, analysis.dealScore);
  addNumber(allowed, analysis.confidence);
  addNumber(allowed, query.nights);
  addNumber(allowed, query.adults);
  if (query.children > 0) addNumber(allowed, query.children);
  addNumber(allowed, baseline.nObservations);
  addNumber(allowed, baseline.lookbackDays);
  addNumber(
    allowed,
    baseline.percentileRank === null ? null : Math.round(baseline.percentileRank * 100),
  );

  addMoneyNumber(allowed, analysis.currentNightlyMinor);
  addMoneyNumber(allowed, analysis.currentTotalMinor);
  addMoneyNumber(allowed, analysis.effectiveNightlyMinor);
  addMoneyNumber(allowed, analysis.benefitValuePerNightMinor);
  addMoneyNumber(allowed, baseline.typicalNightlyMinor);
  addMoneyNumber(allowed, baseline.p10Minor);
  addMoneyNumber(allowed, baseline.p90Minor);
  addMoneyNumber(allowed, baseline.lowestMinor);
  addMoneyNumber(allowed, baseline.highestMinor);

  for (const r of reasons) {
    addNumber(allowed, r.magnitude);
    if (r.unit === 'CURRENCY_MINOR') addMoneyNumber(allowed, r.magnitude);
    for (const value of Object.values(r.supporting)) {
      if (typeof value === 'number') {
        if (value > 1000) addMoneyNumber(allowed, value);
        else addNumber(allowed, value);
      }
    }
  }

  // Any numeral appearing in a fact or caveat the engine itself wrote is by
  // definition permitted. Without this, a caveat like "we need at least 30
  // rates" would fail its own validator — the allowlist has to cover every
  // string the deterministic renderer can emit, not just the numeric fields.
  for (const r of reasons) for (const n of numeralsIn(r.fact)) addNumber(allowed, n);
  for (const c of caveats) for (const n of numeralsIn(c.text)) addNumber(allowed, n);

  const checkOut = addDays(query.checkIn, query.nights);

  return {
    bundle_version: BUNDLE_VERSION,
    config_version: analysis.configVersion,
    subject: {
      hotel_name: query.hotelName,
      room_type_name: query.roomTypeName,
      check_in: query.checkIn,
      check_out: checkOut,
      nights: query.nights,
      adults: query.adults,
      children: query.children,
    },
    verdict: {
      recommendation: analysis.recommendation,
      deal_score: analysis.dealScore,
      deal_score_band: analysis.dealScoreBand,
      confidence: analysis.confidence,
      confidence_band: analysis.confidenceBand,
      gate_fired: analysis.gateFired,
    },
    price: {
      currency: query.currency,
      nightly_minor: analysis.currentNightlyMinor,
      total_minor: analysis.currentTotalMinor,
      effective_nightly_minor: analysis.effectiveNightlyMinor,
      observed_at: analysis.dataAsOf,
    },
    baseline: {
      level: baseline.level,
      n_observations: baseline.nObservations,
      lookback_days: baseline.lookbackDays,
      median_nightly_minor: baseline.typicalNightlyMinor,
      min_nightly_minor: baseline.lowestMinor,
      max_nightly_minor: baseline.highestMinor,
    },
    factors: reasons,
    caveats,
    constraints: {
      allowed_numbers: [...allowed].sort((a, b) => a - b),
      currency_symbol: CURRENCY_SYMBOLS[query.currency] ?? '',
      must_not_predict: true,
      max_sentences: maxSentences,
    },
  };
}

/** Every numeral in a string, including inside `$1,234` and `8%`. */
export function numeralsIn(text: string): number[] {
  const matches = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return matches.map((m) => Number(m.replace(/,/g, ''))).filter((n) => Number.isFinite(n));
}

function addDays(isoDate: string, days: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
