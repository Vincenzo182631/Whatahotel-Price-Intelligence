/**
 * The cohort is a measuring instrument, so its list is worth pinning.
 *
 * Nothing here judges WHICH hotels belong — that is a measured decision
 * recorded in the fixture. What these pin is that the list stays coherent:
 * an id cannot be in both halves (which would double-count it or, worse,
 * make a diff compare a hotel against its own exclusion), and a duplicate
 * inside COHORT would silently weight one hotel twice in every tally.
 *
 * Moving a hotel back into COHORT is a deliberate act: delete its EXCLUDED
 * row and add the id. That is exactly the edit these tests force you to make
 * rather than letting an excluded id drift back in unnoticed.
 */

import { describe, expect, it } from 'vitest';

// @ts-expect-error — a plain .mjs ops script, deliberately not part of a package build.
import { COHORT, EXCLUDED, EXCLUSIONS_MEASURED_AT } from '../../scripts/cohort-fixture.mjs';

const cohort = COHORT as number[];
const excluded = EXCLUDED as ReadonlyArray<{
  id: number;
  name: string;
  destination: string;
  answered: number;
  attribution: string;
}>;

describe('the cohort fixture', () => {
  it('holds each hotel exactly once', () => {
    expect(new Set(cohort).size).toBe(cohort.length);
  });

  it('never lists a hotel as both measured and excluded', () => {
    const inCohort = new Set(cohort);
    const both = excluded.filter((e) => inCohort.has(e.id)).map((e) => e.id);
    expect(both).toEqual([]);
  });

  it('records evidence for every exclusion, and only zero-answer evidence', () => {
    // The bar is "permanently unanswerable", never "failed today" — during
    // the source outage ~57% of calls fail at random, so a hotel that
    // answered even once is a coverage miss we own, not a hole in the
    // source. An exclusion with answered > 0 is the instrument being
    // flattered, which is the failure this file exists to prevent.
    for (const e of excluded) {
      expect(e.answered, `${e.id} ${e.name}`).toBe(0);
      expect(e.name.length, `${e.id} has no name`).toBeGreaterThan(0);
      expect(['DEAD_MAPPING', 'NO_RATE_ANY_DATE']).toContain(e.attribution);
    }
  });

  it('dates the exclusions, so a stale list is visible rather than assumed', () => {
    expect(EXCLUSIONS_MEASURED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('keeps enough hotels for a diff to mean anything', () => {
    expect(cohort.length).toBeGreaterThanOrEqual(24);
  });
});
