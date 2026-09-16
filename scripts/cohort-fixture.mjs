/**
 * The FIXED before/after cohort. One list, imported by both cohort runners
 * (compare-cohort.mjs and ops.mjs), so the sequential and concurrent variants
 * can never drift apart and a diff always compares the same hotels.
 *
 * Luxury properties across dense and sparse markets both, since a radius
 * change cuts hardest where hotels are thin on the ground and a city-only
 * cohort would flatter it.
 *
 * ── What may leave this list, and what may not ────────────────────────────
 *
 * The cohort measures COVERAGE: of the stays a guest could ask about, how
 * many can we answer. That only means something if the denominator holds
 * hotels that are capable of answering. A hotel whose rate lookups can NEVER
 * succeed — a dead upstream mapping, a property not sold for these dates —
 * is not a coverage miss we could fix; it is a hole in the source. Leaving
 * it in does not make the instrument conservative, it makes it blind: the
 * number stops moving when our own coverage moves, which is the one thing it
 * exists to detect. Measured 2026-09-16, ten of the original 32 answered
 * NOTHING on any date — 31% of the cohort was un-answerable by construction,
 * and the reading barely responded to a real improvement in the on-demand
 * path.
 *
 * So the bar for removal is **permanently unanswerable**, never "failed
 * today". During the source outage ~57% of rates calls fail at random, so a
 * single miss — or three — proves nothing about a hotel. Exclusion requires
 * ZERO answers across several well-separated stay dates, and every excluded
 * hotel stays listed below with its evidence so the decision can be re-read,
 * argued with, and reversed. `EXCLUDED` is the audit trail; deleting an id
 * outright is what this file exists to prevent.
 *
 * Replacements were picked from the catalogue by market and by our holding
 * data on them (`has_price_intelligence`), NOT by whether they answered when
 * they were auditioned — selecting on today's success would bake survivorship
 * into the instrument and read high forever. They were then put through the
 * same exclusion test as everyone else, and one (3661, Rosewood Bangkok) was
 * dropped for failing it.
 *
 * Re-check an excluded hotel with `node scripts/ops.mjs score <id>` on a few
 * dates. A hotel that answers again belongs back in COHORT: these are
 * upstream faults, and upstream faults get fixed.
 */

/** The measurable cohort: 32 hotels, dense and sparse markets, all capable of answering. */
export const COHORT = [
  // Kept from the original cohort.
  1198, 2008, 3749, 1053, 3682, 6464, 6077, 7105, 7117, 6323, 2706, 951, 6792, 1550, 4117, 2622,
  2876, 1069, 1097, 1109, 1135, 1168,
  // Added 2026-09-16, replacing the ten excluded below. Market-for-market:
  // Miami and Athens keep their depth, Doha its place, and the sparse
  // singletons (Kanai, the Red Sea, Kea, Vence) are answered by Cabo,
  // Lisbon, Bangkok, Bali and Paris.
  2625, 3494, 3466, 7088, 6203, 6554, 1018, 3099, 4936, 1452,
];

/**
 * Hotels removed from the cohort, with the evidence for each.
 *
 * `answered` is out of three probes on 2026-12-08, 2027-01-14 and
 * 2027-02-18 — three months apart, so a seasonal closure cannot masquerade
 * as an outage and one unlucky call cannot condemn a hotel. Every one of
 * these returned 409 NO_CURRENT_RATE on all three, in 3–5 seconds rather
 * than the 6–9 an answered request takes: the source is refusing fast and
 * deterministically, not failing the random coin toss the outage produces.
 *
 * `attribution` is what we can actually support. Nine of these were measured
 * failing their ENTIRE collection grid on 2026-08-27 with the source
 * reporting `amaID: "NULL"` — the dead-mapping signal WahApiError.brokenMapping
 * keys on (see rule 16 and the adapter). For the rest the API alone cannot
 * separate "mapping dead" from "not sold online" from "closed for the
 * season", and saying which would be a guess, so it says what was measured.
 */
export const EXCLUDED = [
  // Measured whole-grid failures with a dead Amadeus mapping (2026-08-27),
  // still answering nothing (2026-09-16).
  { id: 3554, name: 'EB Hotel Miami', destination: 'Miami', answered: 0, attribution: 'DEAD_MAPPING' },
  { id: 1953, name: 'The Standard, Miami', destination: 'Miami Beach', answered: 0, attribution: 'DEAD_MAPPING' },
  { id: 3094, name: 'Shangri-La Hotel, Doha', destination: 'Doha', answered: 0, attribution: 'DEAD_MAPPING' },
  { id: 6640, name: 'Grecotel The Dolli at Acropolis', destination: 'Athens', answered: 0, attribution: 'DEAD_MAPPING' },
  { id: 6652, name: 'Ritz Carlton Yacht Collection', destination: 'Athens', answered: 0, attribution: 'DEAD_MAPPING' },
  { id: 1004, name: 'Château Saint-Martin', destination: 'Vence', answered: 0, attribution: 'DEAD_MAPPING' },
  // No rate on any probed date; the reason is not ours to state.
  { id: 6100, name: 'Etereo Kanai, Auberge Collection', destination: 'Kanai', answered: 0, attribution: 'NO_RATE_ANY_DATE' },
  { id: 7115, name: 'Six Senses AMAALA', destination: 'The Red Sea', answered: 0, attribution: 'NO_RATE_ANY_DATE' },
  { id: 6539, name: 'One&Only Kea Island', destination: 'Athens', answered: 0, attribution: 'NO_RATE_ANY_DATE' },
  { id: 4000, name: 'InterContinental Doha Beach', destination: 'Doha', answered: 0, attribution: 'NO_RATE_ANY_DATE' },
  // Auditioned as a replacement and failed the same test — recorded so it is
  // not proposed again.
  { id: 3661, name: 'Rosewood Bangkok', destination: 'Bangkok', answered: 0, attribution: 'NO_RATE_ANY_DATE' },
];

/** When the exclusions above were last measured, so a stale list is visible. */
export const EXCLUSIONS_MEASURED_AT = '2026-09-16';
