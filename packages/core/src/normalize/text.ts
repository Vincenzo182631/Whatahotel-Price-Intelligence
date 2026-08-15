/**
 * Deterministic text normalization for room-type matching.
 *
 * Order is fixed and must not be reordered casually — abbreviation expansion
 * has to run after punctuation stripping (so `w/` survives as a token) and
 * before filler removal (so `ste` becomes `suite` before we decide what is
 * marketing noise). See docs/mvp/01-data-architecture.md §3.
 */

/** Curated, not learned. Every entry is a decision someone can review. */
export const ABBREVIATIONS: ReadonlyMap<string, string> = new Map([
  ['ovk', 'ocean view king'],
  ['ov', 'ocean view'],
  ['cv', 'city view'],
  ['gv', 'garden view'],
  ['pv', 'pool view'],
  ['mv', 'mountain view'],
  ['dbl', 'double'],
  ['sgl', 'single'],
  ['twn', 'twin'],
  ['qn', 'queen'],
  ['kg', 'king'],
  ['ste', 'suite'],
  ['jr', 'junior'],
  ['dlx', 'deluxe'],
  ['std', 'standard'],
  ['sup', 'superior'],
  ['exec', 'executive'],
  ['apt', 'apartment'],
  ['bdrm', 'bedroom'],
  ['br', 'bedroom'],
  ['w', 'with'],
  ['bal', 'balcony'],
  ['terr', 'terrace'],
  ['acc', 'accessible'],
  ['nonsmk', 'non smoking'],
  ['ns', 'non smoking'],
]);

/**
 * Marketing filler that carries no distinguishing information.
 *
 * Deliberately conservative: words that could separate two real room tiers
 * (deluxe, superior, premium, executive, grand) are NOT here, because merging
 * two price tiers is the failure mode that most damages the score.
 */
export const FILLER_WORDS: ReadonlySet<string> = new Set([
  'our',
  'the',
  'a',
  'an',
  'luxury',
  'luxurious',
  'signature',
  'beautiful',
  'stunning',
  'spacious',
  'lovely',
  'exclusive',
  'room',
  'rooms',
  'accommodation',
  'accommodations',
  'guestroom',
  'guest',
  'style',
  'styled',
  'type',
]);

export function normalizeRoomName(raw: string): string {
  const stripped = raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9/\s-]/g, ' ')
    .replace(/[/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const expanded = stripped
    .split(' ')
    .filter(Boolean)
    .flatMap((token) => {
      const replacement = ABBREVIATIONS.get(token);
      return replacement ? replacement.split(' ') : [token];
    });

  // Filler is dropped only when something survives — "Room" alone must stay
  // "room" rather than normalizing to the empty string.
  const kept = expanded.filter((t) => !FILLER_WORDS.has(t));
  const result = (kept.length > 0 ? kept : expanded).join(' ').trim();
  return result;
}

/** Character trigrams, matching the shape pg_trgm uses. */
export function trigrams(text: string): Set<string> {
  const padded = `  ${text.trim()} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i += 1) {
    out.add(padded.slice(i, i + 3));
  }
  return out;
}

/**
 * Trigram similarity in [0, 1] — the same Jaccard measure `pg_trgm` uses, so
 * the TypeScript matcher and a future SQL-side match agree.
 */
export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}
