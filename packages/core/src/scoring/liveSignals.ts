/**
 * The live-market intelligence signals.
 *
 * This model answers "is this a good rate right now, and are these good dates"
 * using only rates that exist today. It does NOT predict. Nothing here may
 * produce a claim about where a price is going — see the note on
 * `composeLiveScore`.
 *
 * Three signals:
 *
 *   S1  Comp-Set Index   this hotel vs its live comp set, same stay
 *   S2  Calendar Delta   these dates vs nearby bookable dates, same hotel/room
 *   S3  Compression      how much of the comp set is still bookable
 *
 * Each returns `available: false` with a reason rather than a neutral number
 * when it cannot be measured. A signal scored 50 because nothing was known is
 * indistinguishable from one measured at 50 — the same error as rendering an
 * absent score as zero.
 */

import type { Minor } from '../money.js';
import { median } from '../stats.js';
import type { ScoringConfig } from '../config/defaults.js';

export type LiveSignalCode = 'S1_COMP_SET' | 'S2_CALENDAR' | 'S3_COMPRESSION';

export type LiveSignalUnavailableReason =
  | 'NO_SUBJECT_RATE'
  | 'INSUFFICIENT_COMPARABLES'
  | 'INSUFFICIENT_NEIGHBOURS'
  | 'NO_AVAILABILITY_DATA';

export interface LiveSignal {
  readonly code: LiveSignalCode;
  readonly name: string;
  readonly available: boolean;
  /** 0–100, higher is better value. Null when unavailable. */
  readonly subScore: number | null;
  readonly weight: number;
  /** Weight actually applied after renormalization. */
  readonly weightApplied: number;
  readonly unavailableReason: LiveSignalUnavailableReason | null;
}

function unavailable(
  code: LiveSignalCode,
  name: string,
  weight: number,
  reason: LiveSignalUnavailableReason,
): LiveSignal {
  return {
    code,
    name,
    available: false,
    subScore: null,
    weight,
    weightApplied: 0,
    unavailableReason: reason,
  };
}

/** Map a value onto 0–100 given the points at which it scores 0 and 100. */
function scale(value: number, atZero: number, atFull: number): number {
  if (atZero === atFull) return 50;
  const t = (value - atZero) / (atFull - atZero);
  return Math.max(0, Math.min(100, Math.round(t * 100)));
}

// ── S1 · Comp-Set Index ────────────────────────────────────────────────────

export type CsiBand = 'STRONG_VALUE' | 'MARKET_RATE' | 'PREMIUM';

export interface CompetitorRate {
  readonly hotelId: string;
  readonly name: string;
  readonly nightlyMinor: Minor;
  readonly observedAt: string;
  /** False when the hotel was checked and had no inventory. */
  readonly isAvailable: boolean;
}

export interface CompSetResult {
  readonly signal: LiveSignal;
  /** subject ÷ median competitor × 100. Null when unavailable. */
  readonly csi: number | null;
  readonly band: CsiBand | null;
  /** Positive means the subject is cheaper than the competitor median. */
  readonly pctBelowMedian: number | null;
  readonly medianCompetitorNightlyMinor: Minor | null;
  readonly compsUsed: number;
  /** Checked but excluded because they were sold out or stale. */
  readonly compsExcluded: number;
}

/**
 * How this hotel's live rate compares with its comp set for the same stay.
 *
 * Every competitor must be live-validated: a rate that is missing, zero, older
 * than `maxCompAgeHours`, or attached to a sold-out hotel is EXCLUDED, never
 * substituted. A guessed competitor rate moves the median, and the median is
 * the whole benchmark.
 */
export function computeCompSetIndex(
  subjectNightlyMinor: Minor,
  competitors: readonly CompetitorRate[],
  config: ScoringConfig,
  now: Date,
): CompSetResult {
  const cfg = config.live.csi;
  const weight = config.live.weight.compSet;
  const name = 'Comparable hotels';
  const empty = {
    csi: null,
    band: null,
    pctBelowMedian: null,
    medianCompetitorNightlyMinor: null,
  } as const;

  if (!Number.isFinite(subjectNightlyMinor) || subjectNightlyMinor <= 0) {
    return {
      signal: unavailable('S1_COMP_SET', name, weight, 'NO_SUBJECT_RATE'),
      ...empty,
      compsUsed: 0,
      compsExcluded: 0,
    };
  }

  const maxAgeMs = cfg.maxCompAgeHours * 3_600_000;
  const usable = competitors.filter((c) => {
    if (!c.isAvailable) return false;
    if (!Number.isFinite(c.nightlyMinor) || c.nightlyMinor <= 0) return false;
    const age = now.getTime() - Date.parse(c.observedAt);
    return Number.isFinite(age) && age <= maxAgeMs;
  });
  const excluded = competitors.length - usable.length;

  if (usable.length < cfg.minComps) {
    return {
      signal: unavailable('S1_COMP_SET', name, weight, 'INSUFFICIENT_COMPARABLES'),
      ...empty,
      compsUsed: usable.length,
      compsExcluded: excluded,
    };
  }

  const compMedian = median(usable.map((c) => c.nightlyMinor));
  const csi = (subjectNightlyMinor / compMedian) * 100;
  const pctBelowMedian = ((compMedian - subjectNightlyMinor) / compMedian) * 100;

  const band: CsiBand =
    csi <= cfg.strongValueMax ? 'STRONG_VALUE' : csi <= cfg.fairMax ? 'MARKET_RATE' : 'PREMIUM';

  return {
    signal: {
      code: 'S1_COMP_SET',
      name,
      available: true,
      subScore: scale(csi, cfg.scoreAtCsi.zero, cfg.scoreAtCsi.full),
      weight,
      weightApplied: 0,
      unavailableReason: null,
    },
    csi,
    band,
    pctBelowMedian,
    medianCompetitorNightlyMinor: Math.round(compMedian),
    compsUsed: usable.length,
    compsExcluded: excluded,
  };
}

// ── S2 · Calendar Delta ────────────────────────────────────────────────────

export type CalendarBand = 'DIP' | 'NORMAL' | 'COMPRESSED';

export interface NearbyDateRate {
  readonly checkIn: string;
  readonly nightlyMinor: Minor;
  /** True when this stay starts on the same weekday as the subject's. */
  readonly sameDow: boolean;
  readonly observedAt: string;
}

export interface CalendarResult {
  readonly signal: LiveSignal;
  /** (subject − nearby) ÷ nearby × 100. Negative means cheaper. */
  readonly deltaPct: number | null;
  readonly band: CalendarBand | null;
  readonly medianNearbyNightlyMinor: Minor | null;
  readonly neighboursUsed: number;
  /** True when the comparison used same-weekday neighbours only. */
  readonly sameDowOnly: boolean;
}

/**
 * How the selected dates compare with nearby bookable dates for the same room.
 *
 * Same-weekday neighbours are used ALONE when there are enough of them. A
 * Thursday–Sunday stay measured against a Monday–Thursday one is measuring the
 * weekend, not the dates — the caller is expected to have already matched
 * hotel, room, occupancy and length of stay.
 *
 * This is a statement about prices that exist right now on other dates. It is
 * NOT a forecast about the selected dates.
 */
export function computeCalendarDelta(
  subjectNightlyMinor: Minor,
  neighbours: readonly NearbyDateRate[],
  config: ScoringConfig,
): CalendarResult {
  const cfg = config.live.calendar;
  const weight = config.live.weight.calendar;
  const name = 'Nearby dates';
  const empty = { deltaPct: null, band: null, medianNearbyNightlyMinor: null } as const;

  if (!Number.isFinite(subjectNightlyMinor) || subjectNightlyMinor <= 0) {
    return {
      signal: unavailable('S2_CALENDAR', name, weight, 'NO_SUBJECT_RATE'),
      ...empty,
      neighboursUsed: 0,
      sameDowOnly: false,
    };
  }

  const valid = neighbours.filter((n) => Number.isFinite(n.nightlyMinor) && n.nightlyMinor > 0);
  const sameDow = valid.filter((n) => n.sameDow);

  // Same-weekday alone if it clears the bar; otherwise everything, and the
  // caller is told which happened so the copy can be honest about it.
  const useSameDowOnly = cfg.preferSameDow && sameDow.length >= cfg.minNeighbours;
  const pool = useSameDowOnly ? sameDow : valid;

  if (pool.length < cfg.minNeighbours) {
    return {
      signal: unavailable('S2_CALENDAR', name, weight, 'INSUFFICIENT_NEIGHBOURS'),
      ...empty,
      neighboursUsed: pool.length,
      sameDowOnly: useSameDowOnly,
    };
  }

  const nearbyMedian = median(pool.map((n) => n.nightlyMinor));
  const deltaPct = ((subjectNightlyMinor - nearbyMedian) / nearbyMedian) * 100;

  const band: CalendarBand =
    deltaPct <= cfg.dipMax ? 'DIP' : deltaPct <= cfg.normalMax ? 'NORMAL' : 'COMPRESSED';

  return {
    signal: {
      code: 'S2_CALENDAR',
      name,
      available: true,
      subScore: scale(deltaPct, cfg.delta.zero, cfg.delta.full),
      weight,
      weightApplied: 0,
      unavailableReason: null,
    },
    deltaPct,
    band,
    medianNearbyNightlyMinor: Math.round(nearbyMedian),
    neighboursUsed: pool.length,
    sameDowOnly: useSameDowOnly,
  };
}

// ── S3 · Market compression ────────────────────────────────────────────────

export type CompressionBand = 'TIGHT' | 'MODERATE' | 'SOFT';

export interface CompressionInput {
  /** Comp-set hotels checked for this exact stay. */
  readonly checked: number;
  /** Of those, how many had no inventory. */
  readonly soldOut: number;
}

export interface CompressionResult {
  readonly signal: LiveSignal;
  readonly soldOutShare: number | null;
  readonly band: CompressionBand | null;
  readonly checked: number;
  readonly soldOut: number;
}

/**
 * How much of the comparable market is still bookable.
 *
 * A hotel priced below its comp set means more when most of that set is gone.
 * The evidence is real: the source answers status 204 for a sold-out stay, and
 * the collector records it per hotel and date.
 *
 * Absent evidence the signal is omitted and its weight is redistributed. It is
 * never inferred from a missing rate — a hotel we failed to reach is not a
 * hotel that is sold out.
 */
export function computeCompression(
  input: CompressionInput | null | undefined,
  config: ScoringConfig,
): CompressionResult {
  const cfg = config.live.compression;
  const weight = config.live.weight.compression;
  const name = 'Market availability';

  if (!input || input.checked < cfg.minChecked) {
    return {
      signal: unavailable('S3_COMPRESSION', name, weight, 'NO_AVAILABILITY_DATA'),
      soldOutShare: null,
      band: null,
      checked: input?.checked ?? 0,
      soldOut: input?.soldOut ?? 0,
    };
  }

  const share = input.soldOut / input.checked;
  const band: CompressionBand =
    share >= cfg.tightMin ? 'TIGHT' : share <= cfg.softMax ? 'SOFT' : 'MODERATE';

  // A tight market makes an already-good rate more notable; a soft one makes it
  // less so. This signal modulates, so its range is deliberately narrow — it
  // must not be able to carry a verdict on its own.
  const subScore = band === 'TIGHT' ? 85 : band === 'MODERATE' ? 55 : 35;

  return {
    signal: {
      code: 'S3_COMPRESSION',
      name,
      available: true,
      subScore,
      weight,
      weightApplied: 0,
      unavailableReason: null,
    },
    soldOutShare: share,
    band,
    checked: input.checked,
    soldOut: input.soldOut,
  };
}
