/**
 * Money is integer minor units. Never floating point.
 *
 * Floating-point cents produce off-by-one percentages, which make a Deal Score
 * irreproducible — the same query can render 91 one day and 90 the next with no
 * price change. See docs/mvp/01-data-architecture.md §5.
 */

export type Minor = number;
export type Currency = string;

export interface Money {
  readonly amountMinor: Minor;
  readonly currency: Currency;
}

export class CurrencyMismatchError extends Error {
  constructor(a: Currency, b: Currency) {
    super(`Currency mismatch: ${a} vs ${b}`);
    this.name = 'CurrencyMismatchError';
  }
}

export function money(amountMinor: Minor, currency: Currency): Money {
  if (!Number.isInteger(amountMinor)) {
    throw new TypeError(`Money must be an integer in minor units, got ${amountMinor}`);
  }
  return { amountMinor, currency };
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

/** Scale by a real factor, rounding half away from zero to stay in minor units. */
export function scaleMoney(m: Money, factor: number): Money {
  return money(roundHalfAwayFromZero(m.amountMinor * factor), m.currency);
}

/**
 * The Average Daily Rate: the BASE room rate per night, before taxes and fees.
 * Mirrors the `nightly_amount_minor` generated column exactly (migration 0011).
 *
 * Not the grand total over nights. `totalMinor` is gross on this source, so
 * dividing it inflated every nightly figure by the tax factor (~18-25%) and
 * put the widget on a different basis than the whatahotel.com page around it.
 *
 * `taxesFeesMinor` null means the source stated no tax split, which is read as
 * "the total IS the base rate" rather than as a reason to discard the rate.
 */
export function nightlyRate(
  totalMinor: Minor,
  taxesFeesMinor: Minor | null,
  nights: number,
): Minor {
  if (!Number.isInteger(nights) || nights <= 0) {
    throw new RangeError(`nights must be a positive integer, got ${nights}`);
  }
  return roundHalfAwayFromZero((totalMinor - (taxesFeesMinor ?? 0)) / nights);
}

/**
 * Postgres `round(numeric)` rounds half away from zero; JS `Math.round` rounds
 * half toward +Infinity. They disagree on negatives, and on .5 exactly. The
 * engine must match the database or a recomputed score will drift from a
 * stored one.
 */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Relative difference of `value` against `reference`, as a percentage. */
export function pctDifference(value: number, reference: number): number {
  if (reference === 0) return 0;
  return ((value - reference) / reference) * 100;
}

/** How far below `reference` `value` sits, as a positive percentage when cheaper. */
export function pctBelow(value: number, reference: number): number {
  if (reference === 0) return 0;
  return ((reference - value) / reference) * 100;
}

export function formatMoney(m: Money, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(m.amountMinor / 100);
}
