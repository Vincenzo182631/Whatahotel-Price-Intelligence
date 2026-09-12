/**
 * On-demand collection: the pure planning and guard logic.
 *
 * The I/O runner (collectStayOnDemand) is exercised against the deployed API,
 * where a real fetch is the point; these tests pin the parts that decide
 * WHETHER and WHAT it fetches, because a wrong fan-out multiplies real API
 * spend on every guest search.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ON_DEMAND_OPTIONS,
  GUEST_UPSTREAM,
  leadDaysOf,
  planOnDemandQueries,
} from '../../packages/ingest/src/pipeline/onDemand.js';

const STAY = {
  hotelId: 1,
  wahHotelId: '1198',
  checkIn: '2026-10-30',
  nights: 3,
  adults: 2,
  children: 0,
};

describe('on-demand query planning', () => {
  const comps = [
    { hotelId: 2, wahHotelId: '2708' },
    { hotelId: 3, wahHotelId: '3554' },
    { hotelId: 4, wahHotelId: '1326' },
  ];

  it('queries the subject first, then the same stay at each comparable', () => {
    const { queries } = planOnDemandQueries(STAY, comps, 6);
    expect(queries.map((q) => q.wahHotelId)).toEqual(['1198', '2708', '3554', '1326']);
    // Every query is the SAME stay — a comp priced for different dates would
    // not be a comparison at all.
    for (const q of queries) {
      expect([q.checkIn, q.nights, q.adults]).toEqual([STAY.checkIn, STAY.nights, STAY.adults]);
    }
  });

  it('caps the comparables fetched, and the cap counts comps only', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      hotelId: 10 + i,
      wahHotelId: `C${i}`,
    }));
    const { queries } = planOnDemandQueries(STAY, many, 6);
    expect(queries.length).toBe(1 + 6);
  });

  it('never queries the same hotel twice', () => {
    const withDup = [{ hotelId: 1, wahHotelId: '1198' }, ...comps];
    const { queries, hotelIdByWahId } = planOnDemandQueries(STAY, withDup, 6);
    expect(queries.length).toBe(1 + comps.length);
    expect(hotelIdByWahId.get('1198')).toBe(1);
  });

  it('maps every queried wah id back to its numeric id, for the attempt ledger', () => {
    const { queries, hotelIdByWahId } = planOnDemandQueries(STAY, comps, 6);
    for (const q of queries) {
      expect(hotelIdByWahId.get(q.wahHotelId)).toBeTypeOf('number');
    }
  });
});

describe('the lead-time guard', () => {
  const now = new Date('2026-08-20T15:30:00Z');

  it('computes lead days in UTC, ignoring the time of day', () => {
    expect(leadDaysOf('2026-08-20', now)).toBe(0);
    expect(leadDaysOf('2026-08-21', now)).toBe(1);
    expect(leadDaysOf('2026-08-19', now)).toBe(-1);
  });

  it('keeps the default window inside the horizon the source is verified for', () => {
    // The source is verified ~7 months out (U2 in the adapter header). The
    // smoke suite relies on stays in 2031 being OUTSIDE this window so its
    // no-rate checks stay deterministic and free.
    expect(DEFAULT_ON_DEMAND_OPTIONS.maxLeadDays).toBeLessThanOrEqual(330);
    expect(leadDaysOf('2031-06-01', now)).toBeGreaterThan(DEFAULT_ON_DEMAND_OPTIONS.maxLeadDays);
  });
});

describe('the guest upstream budget', () => {
  it('keeps the worst-case request under the 60s serverless ceiling', () => {
    // A guest request can stack three sequential upstream phases (destination
    // depth, city discovery, the rates wave). Each phase's worst case is every
    // attempt hanging to the timeout, plus the retry backoffs (0.5s * 2^(n-1)).
    // Measured 2026-09-12: the source began hanging instead of fast-failing,
    // and at the collector's 30s/3-retries settings every on-demand page view
    // died at Vercel's 60s kill as a 504 — rendered by the widget as NOTHING,
    // when the honest degraded answer existed. This pins the arithmetic so a
    // future bump of either knob cannot silently reintroduce that.
    const { timeoutMs, maxRetries } = GUEST_UPSTREAM;
    let backoffs = 0;
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      backoffs += 500 * 2 ** (attempt - 1);
    }
    const phaseWorstMs = timeoutMs * (maxRetries + 1) + backoffs;
    const requestWorstMs = phaseWorstMs * 3;
    // 30s, not 60: ingest, scoring and the response need their seconds, and a
    // budget that merely fits the ceiling has no slack for a phase this
    // arithmetic missed — at one retry (~50s worst) the 504s persisted.
    expect(requestWorstMs).toBeLessThanOrEqual(30_000);
  });
});
