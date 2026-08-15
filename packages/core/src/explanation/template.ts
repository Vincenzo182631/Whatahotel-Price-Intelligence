/**
 * Deterministic template renderer.
 *
 * Pure function, no model, no I/O. This path must always work: the MVP ships
 * with it fully functional before the model path is enabled, so the AI layer
 * can be turned off at any moment without customer impact.
 *
 * See docs/mvp/04-explanation-engine.md §6.
 */

import type { ExplanationBundle } from './bundle.js';

const VERDICT_CLAUSE: Readonly<Record<string, string>> = {
  BOOK_NOW: 'Based on this, we recommend booking now.',
  WAIT: 'Based on this, it may be worth waiting.',
  CONSIDER: 'On balance this looks like an ordinary rate for this room.',
  INSUFFICIENT_DATA: '',
};

export interface RenderedExplanation {
  readonly text: string;
  readonly generator: 'TEMPLATE';
}

export function renderTemplate(bundle: ExplanationBundle, maxFactors: number): RenderedExplanation {
  const { verdict, factors, caveats, price, subject } = bundle;
  const symbol = bundle.constraints.currency_symbol;

  if (verdict.recommendation === 'INSUFFICIENT_DATA') {
    const nightly = formatMinor(price.nightly_minor, symbol);
    const caveat = caveats[0]?.text ?? '';
    return {
      text: [
        `We're still building price history for the ${subject.room_type_name} at ${subject.hotel_name}, so we can't assess this rate yet.`,
        caveat,
        `The current rate is ${nightly} per night.`,
      ]
        .filter(Boolean)
        .join(' '),
      generator: 'TEMPLATE',
    };
  }

  const chosen = factors.slice(0, Math.max(1, maxFactors));
  const sentences: string[] = [];

  if (chosen.length === 0) {
    sentences.push(
      `At ${formatMinor(price.nightly_minor, symbol)} per night, this rate sits close to what we typically see for this room.`,
    );
  } else {
    // Join the first two facts into one sentence where they read naturally
    // together, then keep the rest as their own sentences.
    const first = chosen[0];
    const second = chosen[1];
    if (first && second && first.direction === second.direction) {
      sentences.push(`${stripPeriod(first.fact)}, and ${lowerFirst(stripPeriod(second.fact))}.`);
      for (const f of chosen.slice(2)) sentences.push(f.fact);
    } else {
      for (const f of chosen) sentences.push(f.fact);
    }
  }

  const clause = VERDICT_CLAUSE[verdict.recommendation];
  if (clause) sentences.push(clause);

  if (caveats.length > 0) {
    const caveat = caveats[0];
    if (caveat) sentences.push(caveat.text);
  }

  return {
    text: sentences.slice(0, bundle.constraints.max_sentences + 1).join(' '),
    generator: 'TEMPLATE',
  };
}

function stripPeriod(text: string): string {
  return text.endsWith('.') ? text.slice(0, -1) : text;
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}

function formatMinor(minor: number, symbol: string): string {
  return `${symbol}${Math.round(minor / 100).toLocaleString('en-US')}`;
}
