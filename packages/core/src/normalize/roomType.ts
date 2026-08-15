/**
 * Room-type matching: raw source string → canonical room type, with a method
 * and a confidence that is always reported honestly.
 *
 * Never a silent best guess. Poor matching does not quietly corrupt the Deal
 * Score — it visibly lowers confidence, and below `rec.matchMin` it forces
 * INSUFFICIENT_DATA. See docs/mvp/01-data-architecture.md §3.
 */

import type { MatchMethod, RoomClass } from '../types.js';
import { extractAttributes, roomClassesCompatible, type RoomAttributes } from './attributes.js';
import { normalizeRoomName, trigramSimilarity } from './text.js';

export interface RoomTypeCandidate {
  readonly roomTypeId: string;
  readonly normalizedName: string;
  readonly sourceCodes?: readonly string[];
  readonly aliases?: readonly string[];
  readonly roomClass: RoomClass;
}

export interface RoomTypeMatch {
  readonly roomTypeId: string | null;
  readonly method: MatchMethod;
  readonly confidence: number;
  readonly normalizedName: string;
  readonly attributes: RoomAttributes;
  /** Set when the match should be queued for operator confirmation. */
  readonly needsReview: boolean;
  readonly rejectedForClassMismatch: readonly string[];
}

export interface MatchOptions {
  /** Below this trigram similarity a fuzzy match is not made at all. */
  readonly fuzzyMinSimilarity?: number;
  /** A fuzzy match must beat the runner-up by this margin to be unambiguous. */
  readonly fuzzyMinMargin?: number;
}

const DEFAULTS: Required<MatchOptions> = {
  fuzzyMinSimilarity: 0.45,
  fuzzyMinMargin: 0.08,
};

const CONFIDENCE = {
  SOURCE_ID: 1.0,
  ALIAS_EXACT: 0.95,
  ATTRIBUTE_INFERRED: 0.5,
} as const;

/** Fuzzy confidence scales with similarity across the 0.60–0.90 band. */
function fuzzyConfidence(similarity: number, minSimilarity: number): number {
  const t = (similarity - minSimilarity) / (1 - minSimilarity);
  return 0.6 + Math.max(0, Math.min(1, t)) * 0.3;
}

export function matchRoomType(
  rawName: string,
  candidates: readonly RoomTypeCandidate[],
  options: MatchOptions = {},
  sourceCode?: string | null,
): RoomTypeMatch {
  const opts = { ...DEFAULTS, ...options };
  const normalized = normalizeRoomName(rawName);
  const attributes = extractAttributes(normalized);

  const base = {
    normalizedName: normalized,
    attributes,
    rejectedForClassMismatch: [] as string[],
  };

  // Step 1 — structured source code. The preferred path (U9).
  if (sourceCode) {
    const hit = candidates.find((c) => c.sourceCodes?.includes(sourceCode));
    if (hit) {
      return {
        ...base,
        roomTypeId: hit.roomTypeId,
        method: 'SOURCE_ID',
        confidence: CONFIDENCE.SOURCE_ID,
        needsReview: false,
      };
    }
  }

  // Step 2 — exact match on the canonical name or a known alias.
  const exact = candidates.find(
    (c) => c.normalizedName === normalized || c.aliases?.includes(normalized),
  );
  if (exact) {
    return {
      ...base,
      roomTypeId: exact.roomTypeId,
      method: 'ALIAS_EXACT',
      confidence: CONFIDENCE.ALIAS_EXACT,
      needsReview: false,
    };
  }

  // Hard rule: a ROOM never merges with a SUITE, whatever the strings say.
  const rejected: string[] = [];
  const eligible = candidates.filter((c) => {
    const ok = roomClassesCompatible(attributes.roomClass, c.roomClass);
    if (!ok) rejected.push(c.roomTypeId);
    return ok;
  });

  if (eligible.length === 0) {
    return {
      ...base,
      rejectedForClassMismatch: rejected,
      roomTypeId: null,
      method: 'UNMATCHED',
      confidence: 0,
      needsReview: true,
    };
  }

  // Step 3 — trigram similarity, within this hotel only.
  const scored = eligible
    .map((c) => ({
      candidate: c,
      similarity: Math.max(
        trigramSimilarity(normalized, c.normalizedName),
        ...(c.aliases ?? []).map((a) => trigramSimilarity(normalized, a)),
      ),
    }))
    .sort((a, b) => b.similarity - a.similarity);

  const best = scored[0];
  const runnerUp = scored[1];

  if (best && best.similarity >= opts.fuzzyMinSimilarity) {
    const margin = best.similarity - (runnerUp?.similarity ?? 0);
    // An ambiguous fuzzy match is worse than no match: it silently merges two
    // room tiers. Require a clear winner.
    if (margin >= opts.fuzzyMinMargin || scored.length === 1) {
      return {
        ...base,
        rejectedForClassMismatch: rejected,
        roomTypeId: best.candidate.roomTypeId,
        method: 'ALIAS_FUZZY',
        confidence: fuzzyConfidence(best.similarity, opts.fuzzyMinSimilarity),
        needsReview: true,
      };
    }
  }

  // Step 4 — attribute vector, only if it identifies exactly one candidate.
  const byAttributes = eligible.filter((c) => {
    const candidateAttrs = extractAttributes(c.normalizedName);
    return (
      candidateAttrs.roomClass === attributes.roomClass &&
      candidateAttrs.bedConfig === attributes.bedConfig &&
      candidateAttrs.view === attributes.view
    );
  });

  if (byAttributes.length === 1 && attributes.roomClass !== 'UNKNOWN') {
    const only = byAttributes[0]!;
    return {
      ...base,
      rejectedForClassMismatch: rejected,
      roomTypeId: only.roomTypeId,
      method: 'ATTRIBUTE_INFERRED',
      confidence: CONFIDENCE.ATTRIBUTE_INFERRED,
      needsReview: true,
    };
  }

  // Step 5 — stored, excluded from scoring, queued for review.
  return {
    ...base,
    rejectedForClassMismatch: rejected,
    roomTypeId: null,
    method: 'UNMATCHED',
    confidence: 0,
    needsReview: true,
  };
}
