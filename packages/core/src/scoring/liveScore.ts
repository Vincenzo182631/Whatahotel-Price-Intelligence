/**
 * Composing the live signals into a Deal Score and a verdict.
 *
 * ── THIS IS NOT A PRICE PREDICTOR ─────────────────────────────────────────
 *
 * Every output here describes prices that exist NOW: this hotel against its
 * live comp set, these dates against other bookable dates, how much of the
 * comparable market is left. Nothing may say or imply that a price will rise,
 * fall, or hold. "Book now" here means "this is a good rate against today's
 * market", never "book before it goes up".
 *
 * The distinction is not stylistic. The product does not have the data to
 * support a forecast, and a forecast is the one claim a customer would hold
 * against us later.
 */

import type { ScoringConfig } from '../config/defaults.js';
import { roundHalfAwayFromZero } from '../money.js';
import type {
  CalendarResult,
  CompSetResult,
  CompressionResult,
  LiveSignal,
} from './liveSignals.js';

export type LiveBand = 'EXCEPTIONAL' | 'STRONG' | 'MARKET' | 'PREMIUM';
export type LiveVerdict =
  'BOOK_NOW' | 'BOOK_CONSIDER' | 'CONSIDER_ALTERNATIVES' | 'NOT_ENOUGH_DATA';
export type LiveConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface LiveScoreResult {
  /** 0–100, or null when too little was measurable. NEVER 0 for "unknown". */
  readonly score: number | null;
  /** The same figure as the customer sees it: 0.0–10.0. */
  readonly outOfTen: number | null;
  readonly band: LiveBand | null;
  readonly verdict: LiveVerdict;
  readonly confidence: LiveConfidence;
  readonly signals: readonly LiveSignal[];
  /** Share of total weight that was actually available. */
  readonly weightCoverage: number;
  readonly reasons: readonly string[];
}

const BAND_LABEL: Record<LiveBand, string> = {
  EXCEPTIONAL: 'Exceptional value',
  STRONG: 'Strong value',
  MARKET: 'Market rate',
  PREMIUM: 'Premium pricing',
};

export function liveBandLabel(band: LiveBand): string {
  return BAND_LABEL[band];
}

const VERDICT_LABEL: Record<LiveVerdict, string> = {
  BOOK_NOW: 'Book now',
  // Not "Book / consider" — a label reading as two options with a slash asks
  // the customer to make our decision for us.
  BOOK_CONSIDER: 'Consider booking',
  CONSIDER_ALTERNATIVES: 'Consider alternatives',
  // The customer-facing label for the no-score verdict names what the panel
  // DOES show — the hotel-value assessment — not the system condition that
  // led there (owner directive, 2026-08-26: internal data limitations are
  // not customer-facing copy). The verdict CODE stays NOT_ENOUGH_DATA:
  // machines read the code, people read the label.
  NOT_ENOUGH_DATA: 'Hotel value insight',
};

export function liveVerdictLabel(verdict: LiveVerdict): string {
  return VERDICT_LABEL[verdict];
}

function bandFor(score: number, config: ScoringConfig): LiveBand {
  const b = config.live.band;
  if (score >= b.exceptionalMin) return 'EXCEPTIONAL';
  if (score >= b.strongMin) return 'STRONG';
  if (score >= b.marketMin) return 'MARKET';
  return 'PREMIUM';
}

/**
 * Confidence in the evidence, not in the price.
 *
 * Deliberately reported as a word rather than a number: a two-decimal
 * confidence invites a precision the inputs do not support. Score 91 with LOW
 * confidence and score 91 with HIGH confidence are different products, and the
 * customer needs to be able to tell them apart at a glance.
 */
export function assessLiveConfidence(
  compSet: CompSetResult,
  calendar: CalendarResult,
  compression: CompressionResult,
  rateAgeHours: number,
  config: ScoringConfig,
): LiveConfidence {
  const cfg = config.live.confidence;

  // A stale subject rate caps everything: if we cannot vouch for the price we
  // are analysing, nothing built on it is trustworthy.
  if (!Number.isFinite(rateAgeHours) || rateAgeHours > cfg.maxRateAgeHours) return 'LOW';

  // The comp set is the primary signal. Without a real one, LOW regardless of
  // what else is present — the direction is explicit that fewer than three
  // valid competitors must not read as reliable.
  if (!compSet.signal.available || compSet.compsUsed < cfg.mediumMinComps) return 'LOW';

  // A comparison built on terms the source never stated is real evidence but
  // weaker evidence, and it must not be able to reach the top band. OPAQUE —
  // nothing stated on either side — is weaker still: the competitors are alike
  // only in being unclassifiable, which is a thin basis for a confident
  // verdict. See normalize/compMatch.ts for why the tolerant key exists at all.
  if (compSet.matchStrength === 'OPAQUE') return 'LOW';

  // The price-only rung compared rates whose terms were not held equal at
  // all — the weakest comparison the system is willing to make. It exists so
  // a hotel selling only a package or reward rate still gets an answer, and
  // the answer is honest precisely because it can never read as confident.
  if (compSet.termsBasis === 'PRICE_ONLY') return 'LOW';

  const strongComps = compSet.compsUsed >= cfg.highMinComps;
  const strongCalendar =
    calendar.signal.available && calendar.neighboursUsed >= cfg.highMinNeighbours;
  const resolvedMatch = compSet.matchStrength === 'RESOLVED';

  if (strongComps && strongCalendar && resolvedMatch) return 'HIGH';
  if (compSet.compsUsed >= cfg.mediumMinComps) return 'MEDIUM';
  return 'MEDIUM';
}

/**
 * Weighted mean over whichever signals are available, renormalized.
 *
 * A missing signal must not drag the score toward zero, and must not be
 * silently replaced by a neutral 50 either — its weight is redistributed
 * proportionally across the signals that were actually measured. Below
 * `minWeightCoverage` no score is produced at all.
 */
export function composeLiveScore(
  compSet: CompSetResult,
  calendar: CalendarResult,
  compression: CompressionResult,
  rateAgeHours: number,
  config: ScoringConfig,
): LiveScoreResult {
  const raw = [compSet.signal, calendar.signal, compression.signal];
  const available = raw.filter((s) => s.available && s.subScore !== null);

  const totalWeight = raw.reduce((sum, s) => sum + s.weight, 0);
  const availableWeight = available.reduce((sum, s) => sum + s.weight, 0);
  const coverage = totalWeight === 0 ? 0 : availableWeight / totalWeight;

  const confidence = assessLiveConfidence(compSet, calendar, compression, rateAgeHours, config);

  if (available.length === 0 || coverage + 1e-9 < config.live.minWeightCoverage) {
    return {
      score: null,
      outOfTen: null,
      band: null,
      verdict: 'NOT_ENOUGH_DATA',
      confidence,
      // Report every signal, including why each missing one is missing.
      signals: raw,
      weightCoverage: coverage,
      reasons: [],
    };
  }

  const signals = raw.map((s) =>
    s.available && s.subScore !== null
      ? { ...s, weightApplied: s.weight / availableWeight }
      : { ...s, weightApplied: 0 },
  );

  const weighted = signals.reduce(
    (sum, s) => (s.subScore === null ? sum : sum + s.subScore * s.weightApplied),
    0,
  );
  const score = Math.max(0, Math.min(100, Math.round(roundHalfAwayFromZero(weighted))));
  const band = bandFor(score, config);

  return {
    score,
    outOfTen: Math.round(score) / 10,
    band,
    verdict: verdictFor(band, confidence),
    confidence,
    signals,
    weightCoverage: coverage,
    reasons: buildReasons(compSet, calendar, compression),
  };
}

/**
 * The verdict.
 *
 * A recommendation to book is a statement about the market as it stands, so
 * low confidence softens it rather than reversing it — there is no state in
 * which this product tells a customer to wait, because waiting is a bet on a
 * future price and we do not forecast.
 */
function verdictFor(band: LiveBand, confidence: LiveConfidence): LiveVerdict {
  if (band === 'PREMIUM') return 'CONSIDER_ALTERNATIVES';
  if (band === 'EXCEPTIONAL' || band === 'STRONG') {
    return confidence === 'LOW' ? 'BOOK_CONSIDER' : 'BOOK_NOW';
  }
  return 'BOOK_CONSIDER';
}

/**
 * The presentation floor — an owner business rule (2026-08-24): the customer
 * never reads a Deal Score below 6.0. WhataHotel sells every hotel the widget
 * appears on, so the score's job on-page is to rank good against better, not
 * to talk a guest out of the catalogue.
 *
 * What this deliberately is NOT:
 * - It is not scoring. composeLiveScore is untouched; the true score keeps
 *   flowing into calibration, gates, alternative selection and any stored
 *   record. Flooring those would poison the only data that could ever tell
 *   us what the weights should be.
 * - It is not data. The comp-set facts, premium justification and reasons
 *   stay true: a floored response may still say "priced above comparable
 *   hotels", because that is a fact about the price, not a verdict.
 *
 * Apply it at the response boundary, to the SAME result object the
 * explanation bundle is built from — a floored number beside a narrative
 * quoting the true one would contradict itself in front of the customer.
 * A null score stays null (rule 3): the floor raises real scores, it never
 * invents one.
 */
export const SCORE_DISPLAY_FLOOR = 60;

export function applyScoreDisplayFloor(
  result: LiveScoreResult,
  config: ScoringConfig,
): LiveScoreResult {
  if (result.score === null || result.score >= SCORE_DISPLAY_FLOOR) return result;
  const band = bandFor(SCORE_DISPLAY_FLOOR, config);
  return {
    ...result,
    score: SCORE_DISPLAY_FLOOR,
    outOfTen: SCORE_DISPLAY_FLOOR / 10,
    band,
    verdict: verdictFor(band, result.confidence),
  };
}

/**
 * The customer-facing bullets.
 *
 * Only measured facts, phrased in the present tense. No sentence here may
 * describe a direction of travel.
 */
/** "a, b and c" — an Oxford-comma-free list for prose, not a debug dump. */
function listPhrase(items: readonly string[]): string {
  if (items.length === 1) return items[0] as string;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function buildReasons(
  compSet: CompSetResult,
  calendar: CalendarResult,
  compression: CompressionResult,
): string[] {
  const out: string[] = [];

  // A rounded 0% reads as nonsense next to the word "below" — "0% below nearby
  // dates" is not a fact anyone can act on. Under a point either way, say what
  // it means instead.
  const NEGLIGIBLE_PCT = 1;

  if (compSet.signal.available && compSet.pctBelowMedian !== null) {
    const value = compSet.pctBelowMedian;
    const pct = Math.abs(Math.round(value));
    out.push(
      pct < NEGLIGIBLE_PCT
        ? 'In line with comparable luxury hotels'
        : value > 0
          ? `${pct}% below comparable luxury hotels`
          : `${pct}% above comparable luxury hotels`,
    );
    // Say what the comparison could NOT hold fixed. Without this the bullet
    // above reads as like-for-like on cancellation terms, which the tolerant
    // key does not guarantee — it matched rates the source left equally
    // unstated. Disclosing the limit is the price of using the weaker key.
    // The price-only rung held NO terms fixed, so it gets the blunter
    // sentence instead of a list of dimensions it never consulted.
    if (compSet.termsBasis === 'PRICE_ONLY') {
      out.push('Compared by price alone — rate terms and inclusions differ across hotels');
    } else if (compSet.matchStrength !== 'RESOLVED' && compSet.unknownDimensions.length > 0) {
      out.push(`Comparison does not account for ${listPhrase(compSet.unknownDimensions)}`);
    }
  }

  if (calendar.signal.available && calendar.deltaPct !== null) {
    const value = calendar.deltaPct;
    const pct = Math.abs(Math.round(value));
    out.push(
      pct < NEGLIGIBLE_PCT
        ? 'In line with nearby dates'
        : value < 0
          ? `${pct}% below nearby dates`
          : `${pct}% above nearby dates`,
    );
  }

  if (compression.signal.available && compression.band === 'TIGHT') {
    out.push(`${compression.soldOut} of ${compression.checked} comparable hotels are sold out`);
  }

  return out;
}
