/**
 * The deterministic renderer for the live model.
 *
 * This is the FLOOR, not the fallback. Rule 4: the template must always work
 * with the language model disabled, and everything the model produces is
 * measured against what this would have said. If a generated sentence fails
 * validation, this is what ships, and nothing about the page degrades except
 * the prose.
 *
 * It writes at most three sentences, in descending order of what a guest
 * actually asked: what does it cost and is it good, how does it compare, and
 * what else is worth knowing. Nothing here states or implies a future price.
 */

import type { LiveExplanationBundle } from './liveBundle.js';

export interface RenderedLiveExplanation {
  readonly text: string;
  readonly sentences: readonly string[];
  readonly source: 'TEMPLATE';
}

/**
 * Thousands separators, because "3200 reviews" and "$1250 a night" read as
 * typos. The validator strips commas before comparing, so grouping a number
 * does not change whether it is on the allowlist.
 */
const group = (value: number): string => value.toLocaleString('en-US');

function money(bundle: LiveExplanationBundle, minor: number): string {
  const symbol = bundle.constraints.currency_symbol;
  const major = group(Math.round(minor / 100));
  return symbol ? `${symbol}${major}` : `${major} ${bundle.price.currency}`;
}

const pct = (value: number): string => `${Math.abs(value)}%`;

/** "1 hotel" / "6 hotels" — a plural on a count of one reads as a typo. */
const count = (n: number, singular: string): string =>
  `${group(n)} ${singular}${n === 1 ? '' : 's'}`;

function verdictSentence(bundle: LiveExplanationBundle): string {
  const name = `${bundle.subject.room_type_name} at ${bundle.subject.hotel_name}`;
  const price = money(bundle, bundle.price.nightly_minor);
  if (bundle.verdict.out_of_ten === null) {
    return `${name} is ${price} a night before taxes and fees, and there is not enough live market data to rate it.`;
  }
  const band = bundle.verdict.band_label ? ` — ${bundle.verdict.band_label.toLowerCase()}` : '';
  return `${name} is ${price} a night before taxes and fees, and we rate it ${bundle.verdict.out_of_ten} out of 10${band}.`;
}

/**
 * The strongest market fact we actually hold.
 *
 * Comp set first because it is the heaviest signal and the one a guest can
 * check; the calendar and the compression are what remains when nobody
 * comparable is bookable. When none of the three is available the sentence is
 * omitted rather than softened into "the market looks about right" — a
 * confident-sounding sentence built on no evidence is the failure this whole
 * system exists to avoid.
 */
function marketSentence(bundle: LiveExplanationBundle): string | null {
  const { comp_set: comps, calendar, compression } = bundle.market;

  if (comps.available && comps.pct_below_median !== null && comps.comps_used > 0) {
    const median =
      comps.median_competitor_nightly_minor === null
        ? null
        : money(bundle, comps.median_competitor_nightly_minor);
    const side = comps.pct_below_median >= 0 ? 'below' : 'above';
    const basis = comps.room_match === 'ANY' ? 'rooms' : 'comparable rooms';
    const at = median ? ` ${median} median` : ' median';
    // The price-only rung compared rates whose terms were not held equal;
    // the sentence must carry that limit itself, because it is the sentence
    // a guest will quote.
    const qualifier =
      comps.terms_basis === 'PRICE_ONLY'
        ? ', compared on price alone — rate terms and inclusions differ'
        : '';
    return `That is ${pct(comps.pct_below_median)} ${side} the${at} for ${basis} at ${count(comps.comps_used, 'nearby hotel')} on the same dates${qualifier}.`;
  }

  if (calendar.available && calendar.delta_pct !== null) {
    const side = calendar.delta_pct <= 0 ? 'cheaper than' : 'dearer than';
    const scope = calendar.same_weekday_only ? 'the same weekday nearby' : 'nearby dates';
    return `These dates are ${pct(calendar.delta_pct)} ${side} ${count(calendar.neighbours_used, 'other date')} on ${scope} for this room.`;
  }

  if (compression.available && compression.sold_out_pct !== null) {
    return `${compression.sold_out} of the ${compression.checked} comparable hotels we checked are already sold out for these dates.`;
  }

  return null;
}

/**
 * What else is worth knowing: whether a premium buys anything, or what other
 * guests think of the property.
 *
 * Premium outranks reputation because it answers a question about THIS price,
 * and reputation is only ever context. Reputation is stated with its review
 * count attached — a rating without one invites a reader to treat 32 reviews
 * and 4,500 as the same evidence.
 */
function contextSentence(bundle: LiveExplanationBundle): string | null {
  const premium = bundle.premium;
  if (
    (premium.level === 'HIGH' || premium.level === 'MODERATE') &&
    premium.included_value_nightly_minor !== null &&
    premium.covered_pct !== null
  ) {
    const extent = premium.level === 'HIGH' ? 'most of' : 'part of';
    return `The rate includes ${money(bundle, premium.included_value_nightly_minor)} a night of extras, covering ${extent} the price gap.`;
  }
  if (premium.level === 'LOW' && premium.premium_pct !== null) {
    return `The rate is ${pct(premium.premium_pct)} above the comparable median and what it includes covers little of that.`;
  }
  if (premium.level === 'LIMITED_DATA' && premium.premium_pct !== null && premium.premium_pct > 0) {
    return `It is ${pct(premium.premium_pct)} above the comparable median, and we do not have enough information about what each rate includes to say whether that is justified.`;
  }

  const reputation = bundle.reputation.subject;
  if (reputation) {
    const reviews =
      reputation.review_count === null ? '' : ` from ${count(reputation.review_count, 'review')}`;
    return `Guests rate the property ${reputation.rating} out of 5 on Google${reviews}.`;
  }

  return null;
}

export function renderLiveExplanation(bundle: LiveExplanationBundle): RenderedLiveExplanation {
  const sentences = [verdictSentence(bundle), marketSentence(bundle), contextSentence(bundle)]
    .filter((s): s is string => s !== null)
    .slice(0, bundle.constraints.max_sentences);

  return { text: sentences.join(' '), sentences, source: 'TEMPLATE' };
}
