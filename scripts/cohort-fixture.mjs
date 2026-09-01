/**
 * The FIXED before/after cohort. One list, imported by both cohort runners
 * (compare-cohort.mjs and ops.mjs), so the sequential and concurrent variants
 * can never drift apart and a diff always compares the same hotels.
 *
 * Luxury properties across dense and sparse markets both, since a radius
 * change cuts hardest where hotels are thin on the ground and a city-only
 * cohort would flatter it.
 */
export const COHORT = [
  1198, 2008, 3094, 3554, 1953, 3749, 6640, 6652, 1053, 6100, 7115, 3682, 6464, 6077, 7105, 7117,
  6323, 6539, 2706, 951, 6792, 4000, 1550, 4117, 2622, 2876, 1004, 1069, 1097, 1109, 1135, 1168,
];
