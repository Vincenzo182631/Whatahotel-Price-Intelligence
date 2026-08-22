/**
 * Review themes — a measurement over Google's review sample, not a summary
 * a model wrote and not quotes we republish.
 *
 * Google returns at most five reviews per place, so anything derived from
 * them is a claim about RECENT REVIEWERS, never about guests in general —
 * wording that downstream copy must keep. Extraction is deliberately dumb
 * and deterministic:
 *
 *   - only reviews rated 4 or 5 contribute. A one-star review that mentions
 *     the pool is not evidence the pool is a strength, and mining
 *     complaints for selling points would be the exact dishonesty this
 *     product exists to avoid;
 *   - a theme qualifies when at least TWO distinct positive reviews mention
 *     it. One person praising the spa is one person's stay; two is a
 *     recurring theme in the sample;
 *   - the vocabulary is a fixed lexicon. An unrecognised delight is left
 *     out rather than invented, same rule as the perk parser.
 */

export interface ReviewSnippet {
  /** The review's own star rating, 1–5. */
  readonly rating: number | null;
  readonly text: string;
}

/** Theme key → the words that count as mentioning it. */
const THEME_LEXICON: ReadonlyArray<{ key: string; pattern: RegExp }> = [
  { key: 'service', pattern: /\b(service|staff|concierge|hospitality|attentive|friendly)\b/i },
  { key: 'location', pattern: /\b(location|located|convenient|close to|walkable)\b/i },
  { key: 'beach', pattern: /\b(beach|beachfront|oceanfront|shore)\b/i },
  { key: 'pool', pattern: /\b(pool|pools)\b/i },
  { key: 'spa', pattern: /\b(spa|massage|wellness)\b/i },
  { key: 'rooms', pattern: /\b(room|rooms|suite|suites|spacious|comfortable bed)\b/i },
  { key: 'dining', pattern: /\b(restaurant|dining|food|breakfast|cuisine|chef)\b/i },
  { key: 'views', pattern: /\b(view|views|scenery|sunset)\b/i },
  { key: 'cleanliness', pattern: /\b(clean|spotless|immaculate)\b/i },
  { key: 'quiet', pattern: /\b(quiet|peaceful|relaxing|tranquil|serene)\b/i },
  { key: 'family', pattern: /\b(family|kids|children|child)\b/i },
  { key: 'grounds', pattern: /\b(grounds|garden|gardens|property|landscap)\b/i },
];

/** Customer-facing words for each theme key, shared with the widget copy. */
export const THEME_LABEL: Readonly<Record<string, string>> = {
  service: 'service',
  location: 'location',
  beach: 'the beach',
  pool: 'the pool',
  spa: 'the spa',
  rooms: 'the rooms',
  dining: 'dining',
  views: 'the views',
  cleanliness: 'cleanliness',
  quiet: 'a quiet atmosphere',
  family: 'family stays',
  grounds: 'the grounds',
};

const MAX_THEMES = 5;

export function extractReviewThemes(
  reviews: readonly ReviewSnippet[] | null | undefined,
): string[] {
  const positive = (reviews ?? []).filter(
    (r) => r.rating !== null && r.rating >= 4 && r.text.trim().length > 0,
  );
  if (positive.length < 2) return [];

  const counts = new Map<string, number>();
  for (const review of positive) {
    for (const { key, pattern } of THEME_LEXICON) {
      if (pattern.test(review.text)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_THEMES)
    .map(([key]) => key);
}
