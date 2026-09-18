/**
 * Ranking a resolution by how weakly the hotel's name explains the host.
 *
 * The automated checks handle what generalises: a domain claimed by more than
 * one hotel is a brand domain, a `press.` subdomain is a newsroom. They do not
 * catch the one-hotel, one-domain case. Measured 2026-09-18:
 * `coconutgrove.com` resolved for "Mr. C Miami - Coconut Grove", because the
 * hotel's name contains its own neighbourhood and the neighbourhood has a
 * website. Nothing collided and no pattern fired.
 *
 * So instead of growing a blocklist by guesswork, this scores every
 * resolution and a person looks at the worst. The score is a PROMPT FOR
 * ATTENTION and never an automatic rejection: it would sooner flag a correct
 * resolution than reject one silently, because a wrong rejection is invisible
 * and a flagged-but-fine resolution costs somebody five seconds.
 */

/** Words that identify a category, not a property. */
const GENERIC = new Set([
  'hotel',
  'hotels',
  'resort',
  'resorts',
  'spa',
  'suites',
  'inn',
  'lodge',
  'the',
  'and',
  'by',
  'at',
  'a',
  'residences',
  'collection',
  'beach',
  'bay',
  'club',
]);

export interface ReviewSignal {
  readonly score: number;
  readonly reasons: readonly string[];
}

function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !GENERIC.has(w));
}

/**
 * Higher is more suspicious. Zero means the name explains the host well.
 *
 * `cityWords` are the destination's own words, which is what catches the
 * neighbourhood case: a host explained ONLY by geography is a place's site,
 * not a property's.
 */
export function reviewResolution(input: {
  readonly name: string;
  readonly city: string | null;
  readonly websiteUrl: string;
  readonly claims: number;
}): ReviewSignal {
  const reasons: string[] = [];
  let score = 0;

  let host: string;
  try {
    host = new URL(input.websiteUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return { score: 100, reasons: ['unparseable url'] };
  }
  const flat = host.replace(/[^a-z0-9]/g, '');
  const nameWords = tokens(input.name);
  const cityWords = new Set(tokens(input.city ?? ''));

  const matched = nameWords.filter((w) => flat.includes(w));
  const distinctive = matched.filter((w) => !cityWords.has(w));

  if (matched.length === 0) {
    score += 50;
    reasons.push('no word of the name appears in the host');
  } else if (distinctive.length === 0) {
    // The Coconut Grove case: the host is explained entirely by geography.
    score += 40;
    reasons.push('host matches only the location, not the property');
  }

  // A name whose longest word is absent is weak corroboration — but ONLY when
  // nothing substantial matched instead.
  //
  // Measured on "Halepuna Waikiki by Halekulani" → halepuna.com, which is
  // correct: Halepuna is Halekulani's sister property, so its longest word is
  // the PARENT brand and its own domain rightly does not contain it. A
  // sub-brand naming its parent is common in this catalogue, and penalising
  // it would flag exactly the hotels whose domains are most clearly their
  // own.
  const strong = distinctive.some((w) => w.length >= 5);
  const longest = [...nameWords].sort((a, b) => b.length - a.length)[0];
  if (!strong && longest && !flat.includes(longest)) {
    score += 15;
    reasons.push(`the name's most distinctive word ("${longest}") is not in the host`);
  }

  // A subdomain of somebody else's platform: the property's booking engine or
  // a franchise page, not its own site.
  const labels = host.split('.');
  if (labels.length > 2) {
    score += 10;
    reasons.push(`third-party subdomain (${labels.slice(1).join('.')})`);
  }

  // A page that answers to far more of our phrases than a hotel page does is
  // usually a city guide. EB Hotel Miami stored 11 claims from a tourism
  // board before the destination patterns caught it.
  if (input.claims >= 10) {
    score += 20;
    reasons.push(`${input.claims} claims, high enough to suggest a directory or city page`);
  }

  return { score, reasons };
}
