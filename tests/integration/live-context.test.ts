/**
 * The live-market queries against a real PostgreSQL.
 *
 * These are pure SQL, so nothing but an integration test executes them — the
 * same gap that let a broken `planCollection` ship. Runs only when DATABASE_URL
 * is set; skips otherwise so `npm test` works without a database.
 *
 * Everything is namespaced LC- and cleaned up, so it can run against a seeded
 * development database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../packages/core/src/index.js';
import { closePool, getPool } from '../../packages/data/src/index.js';
import {
  isLiveLoadFailure,
  loadLiveIntelligence,
} from '../../packages/data/src/loadLiveIntelligence.js';
import {
  findCompetitorRates,
  findMarketCompression,
  findNearbyDateRates,
} from '../../packages/data/src/repositories/liveContext.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;

const SOURCE = 'LC_SRC';
const SUBJECT = 'LC-SUBJECT';
const COMPS = ['LC-COMP-1', 'LC-COMP-2', 'LC-COMP-3', 'LC-COMP-4'];
const CLASS = 'WAH:TEST|OFFER';
// What the comp set actually matches on. The class above is deliberately
// hotel-specific — a competitor never shares it — so terms are the only thing
// that can cross a hotel boundary.
const SUBJECT_TERMS = {
  mealPlan: 'ROOM_ONLY',
  refundPolicy: 'REFUNDABLE',
  audience: 'CONSORTIA',
};
const CURRENCY = 'USD';

/** A Thursday, so weekday matching can be exercised deliberately. */
const SUBJECT_CHECK_IN = '2027-03-04';

function iso(base: string, offsetDays: number): string {
  return new Date(Date.parse(`${base}T00:00:00Z`) + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

suite('integration · live-market context queries', () => {
  let subjectId = 0;
  let roomTypeId = 0;
  const hotelIds = new Map<string, number>();

  beforeAll(async () => {
    const pool = getPool();
    await cleanup();

    const { rows: src } = await pool.query(
      `INSERT INTO source (code, display_name, is_authoritative)
       VALUES ($1,'Live context test source',true) RETURNING id`,
      [SOURCE],
    );
    const sourceId = src[0].id;

    const { rows: dest } = await pool.query(
      `INSERT INTO destination (slug,name,country_code) VALUES ('lc-town','LC Town','US')
       ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
    );

    for (const code of [SUBJECT, ...COMPS]) {
      const { rows } = await pool.query(
        `INSERT INTO hotel (wah_hotel_id,name,destination_id,luxury_tier,base_currency)
         VALUES ($1,$1,$2,5,'USD') RETURNING id`,
        [code, dest[0].id],
      );
      hotelIds.set(code, rows[0].id);
    }
    subjectId = hotelIds.get(SUBJECT)!;

    // Comp set, ranked.
    for (const [i, code] of COMPS.entries()) {
      await pool.query(
        `INSERT INTO hotel_comparable (hotel_id,comparable_id,rank,similarity,basis)
         VALUES ($1,$2,$3,0.9,'DESTINATION_TIER_PRICEBAND')`,
        [subjectId, hotelIds.get(code), i + 1],
      );
    }

    const { rows: rt } = await pool.query(
      `INSERT INTO room_type (hotel_id,canonical_name,normalized_name,room_class)
       VALUES ($1,'LC King','lc king','ROOM') RETURNING id`,
      [subjectId],
    );
    roomTypeId = rt[0].id;

    // The subject's observations need a rate plan: findCurrentRate inner-joins
    // it to read the refund policy, so an observation without one is invisible
    // to the loader. Competitors need one too, now that the comp set matches on
    // rate TERMS rather than the hotel-specific comparability class — an
    // observation with no plan has no terms and cannot be compared to anything.
    const { rows: rp } = await pool.query(
      `INSERT INTO rate_plan (hotel_id, source_id, source_plan_code, meal_plan,
                              refund_policy, audience, comparability_class)
       VALUES ($1,$2,'LC-PLAN','ROOM_ONLY','REFUNDABLE','CONSORTIA',$3) RETURNING id`,
      [subjectId, sourceId, CLASS],
    );
    const ratePlanId = rp[0].id;

    const { rows: batch } = await pool.query(
      `INSERT INTO ingest_batch (source_id) VALUES ($1) RETURNING id`,
      [sourceId],
    );

    const insert = async (
      hotelId: number,
      rtId: number | null,
      checkIn: string,
      nightlyMajor: number,
      opts: { available?: boolean; ageHours?: number; nights?: number; planId?: number } = {},
    ) => {
      const nights = opts.nights ?? 3;
      const observedAt = new Date(Date.now() - (opts.ageHours ?? 1) * 3_600_000);
      const total = nightlyMajor * 100 * nights;
      // Every parameter gets exactly one deduced type. Reusing one placeholder
      // as both timestamptz and date makes Postgres refuse the statement with
      // "inconsistent types deduced for parameter" — the same ambiguity that
      // broke planCollection's `CURRENT_DATE + $1`.
      await pool.query(
        `INSERT INTO rate_observation (
           observed_at, source_id, hotel_id, room_type_id, rate_plan_id, check_in, nights,
           check_out, adults, children, currency, total_amount_minor, tax_basis,
           observed_date, observation_slot, stay_dow_bucket, stay_season_band,
           match_method, match_confidence, comparability_class, is_available, ingest_batch_id)
         VALUES ($1::timestamptz,$2,$3,$4,$13,$5::date,$6::int,$5::date + $6::int,2,0,$7,$8,'GROSS',
                 $9::date,date_trunc('hour',$1::timestamptz),'WEEKDAY','SHOULDER',
                 'SOURCE_ID',1.00,$10,$11,$12)`,
        [
          observedAt.toISOString(),
          sourceId,
          hotelId,
          rtId,
          checkIn,
          nights,
          CURRENCY,
          total,
          observedAt.toISOString().slice(0, 10),
          CLASS,
          opts.available ?? true,
          batch[0].id,
          opts.planId ?? null,
        ],
      );
    };

    // ── subject: the stay under analysis, plus neighbours ──
    await insert(subjectId, roomTypeId, SUBJECT_CHECK_IN, 650, { planId: ratePlanId });

    // Same-weekday neighbours (±7, ±14) — expensive, so the subject looks cheap.
    for (const off of [-14, -7, 7, 14]) {
      await insert(subjectId, roomTypeId, iso(SUBJECT_CHECK_IN, off), 940, { planId: ratePlanId });
    }
    // Different-weekday neighbours — deliberately very cheap. If these leak
    // into the comparison the delta flips sign, which is the bug being guarded.
    for (const off of [-3, -2, 2, 3]) {
      await insert(subjectId, roomTypeId, iso(SUBJECT_CHECK_IN, off), 300, { planId: ratePlanId });
    }
    // Outside the window, and in the past — neither may be used.
    await insert(subjectId, roomTypeId, iso(SUBJECT_CHECK_IN, 60), 100, { planId: ratePlanId });

    // ── competitors, for the subject's exact stay ──
    // Each carries its own plan with the SAME terms as the subject. Their
    // comparability classes stay hotel-specific, which is the point: the comp
    // set must find them on terms alone.
    const compPlan = async (hotelId: number, terms = "'ROOM_ONLY','REFUNDABLE','CONSORTIA'") => {
      const { rows } = await pool.query(
        `INSERT INTO rate_plan (hotel_id, source_id, source_plan_code, meal_plan,
                                refund_policy, audience, comparability_class)
         VALUES ($1,$2,'LC-COMP-PLAN',${terms},$3) RETURNING id`,
        [hotelId, sourceId, `WAH:C${hotelId}|OFFER`],
      );
      return rows[0].id as number;
    };

    for (const [code, nightly] of [
      ['LC-COMP-1', 850],
      ['LC-COMP-2', 900],
      ['LC-COMP-3', 800],
    ] as const) {
      const hid = hotelIds.get(code)!;
      await insert(hid, null, SUBJECT_CHECK_IN, nightly, { planId: await compPlan(hid) });
    }
    // Stale — must be excluded by the freshness bound.
    const comp4 = hotelIds.get('LC-COMP-4')!;
    await insert(comp4, null, SUBJECT_CHECK_IN, 875, {
      ageHours: 72,
      planId: await compPlan(comp4),
    });

    // COMP-4 was also asked and reported sold out.
    await pool.query(
      `INSERT INTO collection_attempt
         (hotel_id,check_in,nights,adults,attempts,consecutive_failures,last_outcome)
       VALUES ($1,$2::date,3,2,1,1,'NO_AVAILABILITY')`,
      [hotelIds.get('LC-COMP-4'), SUBJECT_CHECK_IN],
    );
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await closePool();
  });

  async function cleanup(): Promise<void> {
    const pool = getPool();
    const ids = `SELECT id FROM hotel WHERE wah_hotel_id LIKE 'LC-%'`;
    await pool.query(`DELETE FROM rate_observation WHERE hotel_id IN (${ids})`);
    await pool.query(`DELETE FROM collection_attempt WHERE hotel_id IN (${ids})`);
    await pool.query(`DELETE FROM hotel_comparable WHERE hotel_id IN (${ids})`);
    await pool.query(`DELETE FROM rate_plan WHERE hotel_id IN (${ids})`);
    await pool.query(`DELETE FROM room_type WHERE hotel_id IN (${ids})`);
    await pool.query(`DELETE FROM hotel WHERE wah_hotel_id LIKE 'LC-%'`);
    await pool.query(`DELETE FROM destination WHERE slug = 'lc-town'`);
    await pool.query(
      `DELETE FROM ingest_batch WHERE source_id IN (SELECT id FROM source WHERE code=$1)`,
      [SOURCE],
    );
    await pool.query(`DELETE FROM source WHERE code = $1`, [SOURCE]);
  }

  // ── competitors ──────────────────────────────────────────────────────────

  it('returns live competitor rates for the exact same stay', async () => {
    const comps = await findCompetitorRates(
      subjectId,
      SUBJECT_CHECK_IN,
      3,
      2,
      0,
      CURRENCY,
      SUBJECT_TERMS,
      8,
      24,
    );
    expect(comps.map((c) => c.nightlyMinor)).toEqual([800_00, 850_00, 900_00]);
    expect(comps.every((c) => c.isAvailable)).toBe(true);
  });

  it('excludes a stale competitor rather than ageing it into the answer', async () => {
    // COMP-4's rate is 72h old. It must not appear at a 24h bound...
    const fresh = await findCompetitorRates(
      subjectId,
      SUBJECT_CHECK_IN,
      3,
      2,
      0,
      CURRENCY,
      SUBJECT_TERMS,
      8,
      24,
    );
    expect(fresh.map((c) => c.hotelId)).not.toContain('LC-COMP-4');

    // ...and the exclusion is the freshness bound doing it, not the row missing.
    const loose = await findCompetitorRates(
      subjectId,
      SUBJECT_CHECK_IN,
      3,
      2,
      0,
      CURRENCY,
      SUBJECT_TERMS,
      8,
      240,
    );
    expect(loose.map((c) => c.hotelId)).toContain('LC-COMP-4');
  });

  it('does not return competitors for a different stay', async () => {
    const comps = await findCompetitorRates(
      subjectId,
      iso(SUBJECT_CHECK_IN, 7),
      3,
      2,
      0,
      CURRENCY,
      SUBJECT_TERMS,
      8,
      24,
    );
    expect(comps).toHaveLength(0);
  });

  // ── nearby dates ─────────────────────────────────────────────────────────

  it('finds nearby dates and marks which share the subject weekday', async () => {
    const near = await findNearbyDateRates(
      subjectId,
      roomTypeId,
      CLASS,
      SUBJECT_CHECK_IN,
      3,
      2,
      0,
      CURRENCY,
      21,
      24,
    );

    // The subject's own date is never a neighbour of itself.
    expect(near.map((n) => n.checkIn)).not.toContain(SUBJECT_CHECK_IN);

    const sameDow = near.filter((n) => n.sameDow);
    expect(sameDow).toHaveLength(4);
    expect(sameDow.every((n) => n.nightlyMinor === 940_00)).toBe(true);

    // The cheap midweek stays are present but correctly flagged as a different
    // weekday, so the engine can exclude them.
    const otherDow = near.filter((n) => !n.sameDow);
    expect(otherDow).toHaveLength(4);
    expect(otherDow.every((n) => n.nightlyMinor === 300_00)).toBe(true);
  });

  it('excludes dates outside the window', async () => {
    const near = await findNearbyDateRates(
      subjectId,
      roomTypeId,
      CLASS,
      SUBJECT_CHECK_IN,
      3,
      2,
      0,
      CURRENCY,
      21,
      24,
    );
    // The +60 day stay at $100 would dominate the median if it leaked in.
    expect(near.map((n) => n.checkIn)).not.toContain(iso(SUBJECT_CHECK_IN, 60));
    expect(near.every((n) => n.nightlyMinor >= 300_00)).toBe(true);
  });

  it('matches length of stay — a 1-night rate is not a neighbour of a 3-night stay', async () => {
    const near = await findNearbyDateRates(
      subjectId,
      roomTypeId,
      CLASS,
      SUBJECT_CHECK_IN,
      1,
      2,
      0,
      CURRENCY,
      21,
      24,
    );
    expect(near).toHaveLength(0);
  });

  // ── compression ──────────────────────────────────────────────────────────

  it('counts only comps that were actually asked', async () => {
    const c = await findMarketCompression(subjectId, SUBJECT_CHECK_IN, 3, 2, 8, 24);
    // Three priced + one recorded sold out = four checked. The comp set has
    // four members, so nothing here is inferred from silence.
    //
    // COMP-4 counts as SOLD OUT, not available: its only rate is 72h stale and
    // the sold-out record is newer. Using the stale rate would also put the two
    // signals in disagreement, since the comp-set query drops it for age.
    expect(c).toEqual({ checked: 4, soldOut: 1 });
  });

  it('reports nothing for a stay nobody was asked about', async () => {
    // Absence of a rate is not evidence of a sold-out hotel.
    const c = await findMarketCompression(subjectId, iso(SUBJECT_CHECK_IN, 45), 3, 2, 8, 24);
    expect(c).toBeNull();
  });

  // ── end to end ───────────────────────────────────────────────────────────

  it('turns stored observations into a scored live verdict', async () => {
    const loaded = await loadLiveIntelligence(
      {
        wahHotelId: SUBJECT,
        checkIn: SUBJECT_CHECK_IN,
        nights: 3,
        adults: 2,
        children: 0,
        currency: CURRENCY,
      },
      DEFAULT_CONFIG,
    );
    if (isLiveLoadFailure(loaded)) throw new Error(`load failed: ${loaded.kind}`);

    // $650 against a $850 competitor median → CSI ~76, materially cheaper.
    expect(loaded.compSet.signal.available).toBe(true);
    expect(loaded.compSet.compsUsed).toBe(3);
    expect(loaded.compSet.csi!).toBeCloseTo((650 / 850) * 100, 0);
    expect(loaded.compSet.band).toBe('STRONG_VALUE');

    // Same-weekday neighbours only: $940, NOT the $300 midweek stays. If those
    // leaked in the delta would be strongly positive instead of negative.
    expect(loaded.calendar.sameDowOnly).toBe(true);
    expect(loaded.calendar.medianNearbyNightlyMinor).toBe(940_00);
    expect(loaded.calendar.deltaPct!).toBeLessThan(-25);
    expect(loaded.calendar.band).toBe('DIP');

    // One of four comps sold out.
    expect(loaded.compression.signal.available).toBe(true);
    expect(loaded.compression.checked).toBe(4);
    expect(loaded.compression.soldOut).toBe(1);

    expect(loaded.result.score).not.toBeNull();
    expect(loaded.result.band === 'EXCEPTIONAL' || loaded.result.band === 'STRONG').toBe(true);
    expect(loaded.result.verdict).toBe('BOOK_NOW');
    expect(loaded.result.reasons.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it('reports a missing hotel and a stay with no rate distinctly', async () => {
    const req = {
      checkIn: SUBJECT_CHECK_IN,
      nights: 3,
      adults: 2,
      children: 0,
      currency: CURRENCY,
    };
    const missing = await loadLiveIntelligence(
      { ...req, wahHotelId: 'LC-DOES-NOT-EXIST' },
      DEFAULT_CONFIG,
    );
    expect(isLiveLoadFailure(missing) && missing.kind).toBe('HOTEL_NOT_FOUND');

    const noRate = await loadLiveIntelligence(
      { ...req, wahHotelId: SUBJECT, checkIn: iso(SUBJECT_CHECK_IN, 200) },
      DEFAULT_CONFIG,
    );
    expect(isLiveLoadFailure(noRate) && noRate.kind).toBe('NO_CURRENT_RATE');
  }, 30_000);
});
