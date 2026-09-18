/**
 * Reading motivator evidence from a page we fetched.
 *
 * Every claim this produces exists because a specific phrase appeared in a
 * specific document at a specific URL. That is the point: a guest can open
 * the link and look for the phrase. "The property's site mentions a kids
 * club" is checkable and can be shown to be wrong; "good for families" is
 * neither, and rule 30 is what the second one costs.
 *
 * ── Narrow on purpose ────────────────────────────────────────────────────
 *
 * The phrase lists below are specific nouns, not topic words. "business" on a
 * hotel page matches "business hours" and would fire Business Travel on every
 * property in the catalogue — rule 9's failure, and the same shape as
 * `goodForChildren` being true for all 20 hotels Places was asked about. A
 * phrase earns its place here only if a reader who saw it highlighted on the
 * page would accept it as relevant.
 *
 * ── What is deliberately absent ──────────────────────────────────────────
 *
 * No model. The extraction is a substring match over visible text, so it can
 * be read, tested and argued with. A language model reading the same page
 * would write better sentences and would also, occasionally, write a
 * confident sentence about a spa the page never mentioned. The layer exists
 * to stop exactly that, so it does not contain the thing it is guarding
 * against. Model rewording can sit ON TOP later, against this bundle, the
 * way rule 4 already has it for every other sentence.
 *
 * NEGATIVE EVIDENCE IS NOT PRODUCED. A page that never says "spa" is not a
 * hotel without one — pages omit things, and a fetch can fail or return a
 * cookie wall. Absence here means no claim, never a claim of absence.
 */

/** Motivator -> phrases whose presence on the property's own page is evidence. */
const PAGE_SIGNALS: Readonly<Record<string, readonly string[]>> = {
  BEACH_RESORT: [
    'beachfront',
    'beach club',
    'private beach',
    'on the beach',
    'oceanfront',
    'water sports',
    'snorkel',
    'beach access',
  ],
  FAMILY: [
    'kids club',
    "kids' club",
    'children’s club',
    'family suite',
    'babysitting',
    'kids menu',
    'family friendly',
    'connecting rooms',
  ],
  BUSINESS_TRAVEL: [
    'business center',
    'business centre',
    'meeting room',
    'conference room',
    'boardroom',
    'event space',
    'co-working',
  ],
  QUIET_RELAXATION: [
    'spa',
    'wellness',
    'adults only',
    'adults-only',
    'yoga',
    'meditation',
    'thermal',
    'sauna',
  ],
  NIGHTLIFE: ['rooftop bar', 'cocktail bar', 'lounge', 'live music', 'nightclub', 'speakeasy'],
  AMENITIES: [
    'fitness center',
    'fitness centre',
    'swimming pool',
    'infinity pool',
    'tennis',
    'golf course',
    'concierge',
  ],
  LUXURY_EXPERIENCE: [
    'butler',
    'michelin',
    'private chef',
    'chauffeur',
    'penthouse',
    'presidential suite',
  ],
  LOCATION: [
    'walking distance',
    'steps from',
    'minutes from',
    'city center',
    'city centre',
    'historic district',
  ],
};

/** Human wording for a matched phrase, so the claim reads as a citation. */
function claimFor(phrase: string): string {
  return `The property's own site mentions "${phrase}"`;
}

export interface ResearchedClaim {
  readonly motivator: string;
  readonly claim: string;
}

/**
 * Strip a page to its visible text.
 *
 * Deliberately crude and deliberately conservative: script and style bodies
 * are removed first, because a phrase matched inside a tracking script or a
 * JSON blob is not something a reader could find on the page. Attribute
 * values go too, for the same reason — `alt="beachfront"` is not the page
 * saying it.
 */
export function visibleText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&rsquo;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Claims supported by this page, at most `perMotivator` each.
 *
 * Capped because a resort page saying "beachfront" five different ways is one
 * piece of evidence, not five, and a guest reading five near-identical lines
 * is reading our matcher rather than the hotel.
 */
export function extractClaims(html: string, perMotivator = 2): readonly ResearchedClaim[] {
  const text = visibleText(html);
  const out: ResearchedClaim[] = [];
  for (const [motivator, phrases] of Object.entries(PAGE_SIGNALS)) {
    let found = 0;
    for (const phrase of phrases) {
      if (found >= perMotivator) break;
      if (text.includes(phrase.toLowerCase())) {
        out.push({ motivator, claim: claimFor(phrase) });
        found += 1;
      }
    }
  }
  return out;
}
