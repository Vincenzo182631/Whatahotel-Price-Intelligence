/**
 * The guest's stated travel preference — Phase 6's ONE new input.
 *
 * This is an interpretation-layer input, not a scoring input. The Deal Score,
 * the ADR, the premium computation, the availability read and the reputation
 * facts are identical for every preference; what changes is which of the
 * already-computed facts get foregrounded and how the alternative is ranked.
 * That separation is structural: the score is composed before the preference
 * is ever consulted, so a preference CANNOT move a number even by accident.
 *
 * GENERAL_VALUE is the default and means "no personalization" — the response
 * is byte-for-byte what Phase 5 produced. Nothing regresses for a guest who
 * never touches the selector.
 */

export const PREFERENCES = [
  'GENERAL_VALUE',
  'BEST_VALUE',
  'LUXURY_EXPERIENCE',
  'LOCATION',
  'AMENITIES',
  'BEACH_RESORT',
  'FAMILY',
  'NIGHTLIFE',
  'QUIET_RELAXATION',
  'BUSINESS_TRAVEL',
] as const;

export type Preference = (typeof PREFERENCES)[number];

/** Customer-facing names, shared by the widget and any other client. */
export const PREFERENCE_LABEL: Readonly<Record<Preference, string>> = {
  GENERAL_VALUE: 'General value',
  BEST_VALUE: 'Best value',
  LUXURY_EXPERIENCE: 'Luxury & experience',
  LOCATION: 'Location',
  AMENITIES: 'Amenities',
  BEACH_RESORT: 'Beach & resort',
  FAMILY: 'Family',
  NIGHTLIFE: 'Nightlife',
  QUIET_RELAXATION: 'Quiet & relaxation',
  BUSINESS_TRAVEL: 'Business travel',
};

/**
 * Parse a caller-supplied preference. Null for anything unrecognised — the
 * caller decides whether that is a 400 or a silent default, but this function
 * never guesses a preference the guest did not state.
 */
export function parsePreference(raw: string | null | undefined): Preference | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const upper = raw.trim().toUpperCase();
  return (PREFERENCES as readonly string[]).includes(upper) ? (upper as Preference) : null;
}
