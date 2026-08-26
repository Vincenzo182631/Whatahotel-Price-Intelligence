/**
 * Prose for the review-theme keys.
 *
 * Its own module because BOTH the hotel-value section and the premium
 * assessment now read it — hotelValue.ts imports a type from assessment.ts,
 * so a shared constant living in either one would close an import cycle.
 * The themes themselves are measured at sweep time over positive reviews
 * only (see the reputation sweep); this file is nothing but their wording.
 */
export const THEME_PROSE: Readonly<Record<string, string>> = {
  service: 'service',
  location: 'the location',
  beach: 'the beach',
  pool: 'the pool',
  spa: 'the spa',
  rooms: 'the rooms',
  dining: 'dining',
  views: 'the views',
  cleanliness: 'cleanliness',
  quiet: 'the quiet atmosphere',
  family: 'family stays',
  grounds: 'the grounds',
};
