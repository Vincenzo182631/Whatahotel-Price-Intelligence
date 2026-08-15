/**
 * Rate-plan classification into comparability classes.
 *
 * A $689 non-refundable room-only rate and a $689 flexible bed-and-breakfast
 * rate are not the same product. Comparing them produces false signals in both
 * directions, and the difference is invisible in the data unless modelled
 * explicitly. See docs/mvp/01-data-architecture.md §4.
 */

import type { MealPlan, RateAudience, RefundPolicy } from '../types.js';
import { UNRESOLVED_CLASS } from '../types.js';

export type MealPlanGroup = 'ROOM_ONLY' | 'BREAKFAST_INCLUDED' | 'BOARD_INCLUDED';
export type RefundGroup = 'FLEXIBLE' | 'RESTRICTED';
export type AudienceGroup = 'PUBLIC' | 'PRIVATE';

export interface RatePlanTerms {
  readonly mealPlan: MealPlan;
  readonly refundPolicy: RefundPolicy;
  readonly audience: RateAudience;
}

export interface ComparabilityResult {
  readonly comparabilityClass: string;
  readonly resolved: boolean;
  readonly mealPlanGroup: MealPlanGroup | null;
  readonly refundGroup: RefundGroup | null;
  readonly audienceGroup: AudienceGroup | null;
}

export function mealPlanGroup(meal: MealPlan): MealPlanGroup | null {
  switch (meal) {
    case 'ROOM_ONLY':
      return 'ROOM_ONLY';
    case 'BREAKFAST':
      return 'BREAKFAST_INCLUDED';
    case 'HALF_BOARD':
    case 'FULL_BOARD':
    case 'ALL_INCLUSIVE':
      return 'BOARD_INCLUDED';
    case 'UNKNOWN':
      return null;
  }
}

export function refundGroup(policy: RefundPolicy): RefundGroup | null {
  switch (policy) {
    case 'REFUNDABLE':
      return 'FLEXIBLE';
    case 'PARTIALLY_REFUNDABLE':
    case 'NON_REFUNDABLE':
      return 'RESTRICTED';
    case 'UNKNOWN':
      return null;
  }
}

export function audienceGroup(audience: RateAudience): AudienceGroup | null {
  switch (audience) {
    case 'PUBLIC':
    case 'MEMBER':
      return 'PUBLIC';
    case 'CONSORTIA':
    case 'NEGOTIATED':
      return 'PRIVATE';
    case 'OPAQUE':
    case 'UNKNOWN':
      return null;
  }
}

/**
 * Twelve classes, deliberately coarse. Finer classes fragment the baseline and
 * starve every distribution of observations; refine only if calibration shows
 * within-class dispersion materially exceeds across-class dispersion.
 */
export function classifyComparability(terms: RatePlanTerms): ComparabilityResult {
  const meal = mealPlanGroup(terms.mealPlan);
  const refund = refundGroup(terms.refundPolicy);
  const audience = audienceGroup(terms.audience);

  if (meal === null || refund === null || audience === null) {
    return {
      comparabilityClass: UNRESOLVED_CLASS,
      resolved: false,
      mealPlanGroup: meal,
      refundGroup: refund,
      audienceGroup: audience,
    };
  }

  return {
    comparabilityClass: `${meal}|${refund}|${audience}`,
    resolved: true,
    mealPlanGroup: meal,
    refundGroup: refund,
    audienceGroup: audience,
  };
}

/** Human-readable rate terms for the UI. The customer must see what was assessed. */
export function describeRateTerms(terms: RatePlanTerms): string {
  const parts: string[] = [];

  switch (terms.mealPlan) {
    case 'BREAKFAST':
      parts.push('Breakfast included');
      break;
    case 'HALF_BOARD':
      parts.push('Half board');
      break;
    case 'FULL_BOARD':
      parts.push('Full board');
      break;
    case 'ALL_INCLUSIVE':
      parts.push('All inclusive');
      break;
    case 'ROOM_ONLY':
      parts.push('Room only');
      break;
    case 'UNKNOWN':
      break;
  }

  switch (terms.refundPolicy) {
    case 'REFUNDABLE':
      parts.push('Free cancellation');
      break;
    case 'PARTIALLY_REFUNDABLE':
      parts.push('Partial refund');
      break;
    case 'NON_REFUNDABLE':
      parts.push('Non-refundable');
      break;
    case 'UNKNOWN':
      break;
  }

  if (terms.audience === 'CONSORTIA' || terms.audience === 'NEGOTIATED') {
    parts.push('Preferred partner rate');
  }

  return parts.length > 0 ? parts.join(' · ') : 'Rate terms unconfirmed';
}

export const ALL_COMPARABILITY_CLASSES: readonly string[] = (
  ['ROOM_ONLY', 'BREAKFAST_INCLUDED', 'BOARD_INCLUDED'] as const
).flatMap((meal) =>
  (['FLEXIBLE', 'RESTRICTED'] as const).flatMap((refund) =>
    (['PUBLIC', 'PRIVATE'] as const).map((audience) => `${meal}|${refund}|${audience}`),
  ),
);
