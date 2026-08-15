/**
 * Attribute extraction from a normalized room name.
 *
 * These feed the matcher's hard rules and the UI. `room_class` in particular is
 * load-bearing: a ROOM must never merge into a SUITE baseline regardless of
 * string similarity, because mixing two price tiers is the failure that most
 * damages the Deal Score.
 */

import type { BedConfig, RoomClass, ViewType } from '../types.js';

export interface RoomAttributes {
  readonly roomClass: RoomClass;
  readonly bedConfig: BedConfig;
  readonly view: ViewType;
}

// Ordered: the first match wins, so more specific classes are listed first.
const CLASS_PATTERNS: ReadonlyArray<readonly [RegExp, RoomClass]> = [
  [/\bpenthouse\b/, 'PENTHOUSE'],
  [/\b(residence|apartment)\b/, 'RESIDENCE'],
  [/\b(villa|bungalow|casita)\b/, 'VILLA'],
  [/\b(junior suite|jr suite|junior)\b/, 'JUNIOR_SUITE'],
  [/\bsuite\b/, 'SUITE'],
  [/\b(room|studio|double|twin|single|king|queen)\b/, 'ROOM'],
];

const BED_PATTERNS: ReadonlyArray<readonly [RegExp, BedConfig]> = [
  [/\b(two|2|three|3|multiple)\s+(king|queen|double|twin|bed)/, 'MULTIPLE'],
  [/\bking\b/, 'KING'],
  [/\bqueen\b/, 'QUEEN'],
  [/\bdouble\b/, 'DOUBLE'],
  [/\btwin\b/, 'TWIN'],
  [/\bsingle\b/, 'SINGLE'],
];

const VIEW_PATTERNS: ReadonlyArray<readonly [RegExp, ViewType]> = [
  [/\b(partial ocean|partial sea|side ocean|ocean side)\b/, 'PARTIAL_OCEAN'],
  [/\b(ocean|sea|beach|water)\s*(view|front|facing)?\b/, 'OCEAN'],
  [/\b(city|skyline|urban)\s*(view|facing)?\b/, 'CITY'],
  [/\b(garden|park)\s*(view|facing)?\b/, 'GARDEN'],
  [/\bpool\s*(view|side|facing)?\b/, 'POOL'],
  [/\b(mountain|valley)\s*(view|facing)?\b/, 'MOUNTAIN'],
  [/\b(interior|inside|atrium|no view)\b/, 'INTERIOR'],
];

function firstMatch<T>(
  text: string,
  patterns: ReadonlyArray<readonly [RegExp, T]>,
  fallback: T,
): T {
  for (const [pattern, value] of patterns) {
    if (pattern.test(text)) return value;
  }
  return fallback;
}

export function extractAttributes(normalizedName: string): RoomAttributes {
  return {
    roomClass: firstMatch(normalizedName, CLASS_PATTERNS, 'UNKNOWN'),
    bedConfig: firstMatch(normalizedName, BED_PATTERNS, 'UNKNOWN'),
    view: firstMatch(normalizedName, VIEW_PATTERNS, 'UNKNOWN'),
  };
}

/**
 * Whether two room classes may ever share a baseline.
 *
 * UNKNOWN is permissive — it means "we could not tell", not "we determined it
 * is different" — but the match confidence is reduced elsewhere when it occurs.
 */
export function roomClassesCompatible(a: RoomClass, b: RoomClass): boolean {
  if (a === 'UNKNOWN' || b === 'UNKNOWN') return true;
  return a === b;
}
