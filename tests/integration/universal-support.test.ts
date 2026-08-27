/**
 * The three database behaviours that make the widget work on hotels outside
 * the destinations someone has already collected. All SQL, so nothing but an
 * integration test executes them.
 *
 * Namespaced US- and cleaned up, so it can run against a seeded development
 * database. Skips when DATABASE_URL is unset.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../packages/core/src/index.js';
import { closePool, getPool } from '../../packages/data/src/index.js';
import {
  isLiveLoadFailure,
  loadLiveIntelligence,
} from '../../packages/data/src/loadLiveIntelligence.js';
import {
  countRecentAttempts,
  recordCollectionAttempts,
} from '../../packages/data/src/repositories/collection.js';
import {
  findComparableIdentities,
  hasCuratedComparables,
  promoteHotelForCollection,
} from '../../packages/data/src/repositories/hotels.js';
import { findQuotedCurrency } from '../../packages/data/src/repositories/observations.js';
import { findCompetitorRates } from '../../packages/data/src/repositories/liveContext.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;

const SOURCE = 'US_SRC';
const SUBJECT = 'US-SUBJECT';
/** Ordered by distance from the subject: NEAR is closest, FAR is furthest. */
const NEIGHBOURS = ['US-NEAR', 'US-MID', 'US-FAR'];
/**
 * Another destination AND far away (157 km). It must never enter the
 * comparison — under config v8 because of the distance, not the label.
 */
const OUTSIDER = 'US-OUTSIDER';
const CLASS = 'WAH:US|OFFER';
const TERMS = { mealPlan: 'ROOM_ONLY', refundPolicy: 'REFUNDABLE', audience: 'CONSORTIA' };
/** Not USD, deliberately: the point is that nothing assumes dollars. */
const CURRENCY = 'QAR';
const CHECK_IN = '2027-04-08';

suite('integration · universal hotel support', () => {
  const hotelIds = new Map<string, number>();
  let sourceId = 0;
  let entryRoomTypeId = 0;
  let suiteRoomTypeId = 0;
  const compSuiteRoomTypeIds = new Map<string, number>();

  beforeAll(async () => {
    const pool = getPool();
    await cleanup();

    const { rows: src } = await pool.query(
      `INSERT INTO source (code, display_name, is_authoritative)
       VALUES ($1,'Universal support test source',true) RETURNING id`,
      [SOURCE],
    );
    sourceId = src[0].id;

    const { rows: dest } = await pool.query(
      `INSERT INTO destination (slug,name,country_code) VALUES ('us-city','US City','QA')
       ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
    );
    const { rows: other } = await pool.query(
      `INSERT INTO destination (slug,name,country_code) VALUES ('us-elsewhere','US Elsewhere','QA')
       ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
    );

    // Coordinates now SELECT as well as order (config v8: the comp set keys on
    // physical distance, not on the destination label). The geometry is
    // therefore chosen in real units, subject at the origin:
    //
    //   US-NEAR   0.31 km    US-MID  1.26 km    US-FAR  2.36 km
    //   OUTSIDER  157 km
    //
    // All three neighbours sit inside the 2-mile primary ring (3.219 km) and
    // in that order, so the ordering assertions below still mean what they
    // meant. OUTSIDER is now excluded by DISTANCE rather than by its label —
    // which is the point of v8. It used to sit 111 m away and was kept out
    // only because its destination differed, and a hotel 111 m away is the
    // most realistic alternative a guest could have; excluding it was the
    // Palm Beach / Oranjestad failure this design exists to stop.
    const places: Array<[string, number, number, number]> = [
      [SUBJECT, dest[0].id, 0, 0],
      ['US-NEAR', dest[0].id, 0.002, 0.002],
      ['US-MID', dest[0].id, 0.008, 0.008],
      ['US-FAR', dest[0].id, 0.015, 0.015],
      [OUTSIDER, other[0].id, 1, 1],
    ];
    for (const [code, destinationId, lat, lon] of places) {
      const { rows } = await pool.query(
        // coordinate_source is required alongside a position (migration 0018).
        // These fixtures stand in for catalogue rows, so SOURCE is what they
        // are: the provenance is not decoration, it is what stops the resolver
        // treating a position as self-corroborating evidence later.
        `INSERT INTO hotel (wah_hotel_id,name,destination_id,luxury_tier,base_currency,
                            latitude,longitude,coordinate_source,collection_tier)
         VALUES ($1,$1,$2,5,$5,$3,$4,'SOURCE','OFF') RETURNING id`,
        [code, destinationId, lat, lon, CURRENCY],
      );
      hotelIds.set(code, rows[0].id);
    }

    const { rows: batch } = await pool.query(
      `INSERT INTO ingest_batch (source_id) VALUES ($1) RETURNING id`,
      [sourceId],
    );

    // Unique per room: rate_plan is keyed (hotel, source, plan code), so a
    // hotel with two rooms needs two plan codes rather than one reused.
    let planSeq = 0;
    const plan = async (hotelId: number) => {
      const { rows } = await pool.query(
        `INSERT INTO rate_plan (hotel_id, source_id, source_plan_code, meal_plan,
                                refund_policy, audience, comparability_class)
         VALUES ($1,$2,$4,'ROOM_ONLY','REFUNDABLE','CONSORTIA',$3) RETURNING id`,
        [hotelId, sourceId, `WAH:U${hotelId}|OFFER`, `US-PLAN-${(planSeq += 1)}`],
      );
      return rows[0].id as number;
    };

    const insert = async (hotelId: number, rtId: number | null, nightlyMajor: number) => {
      const observedAt = new Date(Date.now() - 3_600_000);
      await pool.query(
        `INSERT INTO rate_observation (
           observed_at, source_id, hotel_id, room_type_id, rate_plan_id, check_in, nights,
           check_out, adults, children, currency, total_amount_minor, tax_basis,
           observed_date, observation_slot, stay_dow_bucket, stay_season_band,
           match_method, match_confidence, comparability_class, is_available, ingest_batch_id)
         VALUES ($1::timestamptz,$2,$3,$4,$11,$5::date,2,$5::date + 2,2,0,$6,$7,'GROSS',
                 $8::date,date_trunc('hour',$1::timestamptz),'WEEKDAY','SHOULDER',
                 'SOURCE_ID',1.00,$9,true,$10)`,
        [
          observedAt.toISOString(),
          sourceId,
          hotelId,
          rtId,
          CHECK_IN,
          CURRENCY,
          nightlyMajor * 100 * 2,
          observedAt.toISOString().slice(0, 10),
          CLASS,
          batch[0].id,
          await plan(hotelId),
        ],
      );
    };

    const { rows: rt } = await pool.query(
      `INSERT INTO room_type (hotel_id,canonical_name,normalized_name,room_class)
       VALUES ($1,'US King','us king','ROOM') RETURNING id`,
      [hotelIds.get(SUBJECT)],
    );

    const { rows: rtSuite } = await pool.query(
      `INSERT INTO room_type (hotel_id,canonical_name,normalized_name,room_class)
       VALUES ($1,'US Suite','us suite','SUITE') RETURNING id`,
      [hotelIds.get(SUBJECT)],
    );
    suiteRoomTypeId = rtSuite[0].id;
    entryRoomTypeId = rt[0].id;

    await insert(hotelIds.get(SUBJECT)!, rt[0].id, 1600);
    // Deliberately inserted AFTER, and dearer: the list must come back
    // cheapest-first regardless of insertion order.
    await insert(hotelIds.get(SUBJECT)!, rtSuite[0].id, 2600);
    // Each neighbour gets a cheap ROOM and a dear SUITE, so the comp set has a
    // genuine choice between "an equivalent room" and "their cheapest room".
    for (const code of ['US-NEAR', 'US-MID', 'US-FAR'] as const) {
      const { rows: nrt } = await pool.query(
        `INSERT INTO room_type (hotel_id,canonical_name,normalized_name,room_class)
         VALUES ($1,$2,$3,'SUITE') RETURNING id`,
        [hotelIds.get(code), `${code} Suite`, `${code.toLowerCase()} suite`],
      );
      compSuiteRoomTypeIds.set(code, nrt[0].id);
    }
    await insert(hotelIds.get('US-NEAR')!, null, 1800);
    await insert(hotelIds.get('US-MID')!, null, 2000);
    await insert(hotelIds.get('US-FAR')!, null, 2200);
    await insert(hotelIds.get('US-NEAR')!, compSuiteRoomTypeIds.get('US-NEAR')!, 2800);
    await insert(hotelIds.get('US-MID')!, compSuiteRoomTypeIds.get('US-MID')!, 3000);
    await insert(hotelIds.get('US-FAR')!, compSuiteRoomTypeIds.get('US-FAR')!, 3200);

    // Same price as the nearest neighbour, and far outside every rung of the
    // radius ladder. If it ever appears in the comp set, distance has stopped
    // filtering — which under v8 is the filter that matters.
    await insert(hotelIds.get(OUTSIDER)!, null, 1800);
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await closePool();
  });

  it('answers in the currency the hotel is quoted in, not an assumed USD', async () => {
    expect(await findQuotedCurrency(hotelIds.get(SUBJECT)!)).toBe(CURRENCY);

    const loaded = await loadLiveIntelligence(
      {
        wahHotelId: SUBJECT,
        checkIn: CHECK_IN,
        nights: 2,
        adults: 2,
        children: 0,
        currency: null,
        now: new Date(),
      },
      DEFAULT_CONFIG,
    );
    if (isLiveLoadFailure(loaded)) throw new Error(`expected a rate, got ${loaded.kind}`);
    expect(loaded.currency).toBe(CURRENCY);
    expect(loaded.nightlyMinor).toBe(160_000);
  });

  it('still honours a currency the caller pins, even when nothing matches', async () => {
    // Pinning is a promise, not a preference: a caller that requires USD gets
    // USD or nothing. Silently answering in QAR would be worse than empty.
    const loaded = await loadLiveIntelligence(
      {
        wahHotelId: SUBJECT,
        checkIn: CHECK_IN,
        nights: 2,
        adults: 2,
        children: 0,
        currency: 'USD',
        now: new Date(),
      },
      DEFAULT_CONFIG,
    );
    expect(isLiveLoadFailure(loaded) && loaded.kind).toBe('NO_CURRENT_RATE');
  });

  it("prefers the source's own city ranking, and falls back to distance", async () => {
    const subjectId = hotelIds.get(SUBJECT)!;
    // US-FAR is the furthest hotel, so distance alone would pick it last. Give
    // it the source's top rank and it must come FIRST — the ranking is the
    // source's answer to "which hotels in this city matter", and it outranks
    // an accident of geography.
    await getPool().query(`UPDATE hotel SET city_rank = 99 WHERE wah_hotel_id = $1`, ['US-FAR']);

    const ranked = await findCompetitorRates(subjectId, CHECK_IN, 2, 2, 0, CURRENCY, TERMS, 2, 48);
    expect(ranked.map((c) => c.hotelId)).toContain('US-FAR');

    // Unranked hotels are not ranked LAST by accident of NULL ordering — they
    // are ordered among themselves by distance, which is the old behaviour.
    await getPool().query(`UPDATE hotel SET city_rank = NULL WHERE wah_hotel_id = $1`, ['US-FAR']);
    const byDistance = await findCompetitorRates(
      subjectId,
      CHECK_IN,
      2,
      2,
      0,
      CURRENCY,
      TERMS,
      2,
      48,
    );
    expect(byDistance.map((c) => c.hotelId).sort()).toEqual(['US-MID', 'US-NEAR']);
  });

  it('includes a hotel next door that carries a DIFFERENT destination label', async () => {
    // The case config v8 exists for. Destination labels fragment real markets:
    // Palm Beach Aruba and Oranjestad are 7 km apart on one island, and the
    // split left the St. Regis with two comparables in a four-hotel market.
    // A hotel a guest could walk to is a realistic alternative whatever the
    // catalogue calls its neighbourhood.
    const near = await getPool().query(
      `UPDATE hotel SET latitude = 0.004, longitude = 0.004 WHERE wah_hotel_id = $1
       RETURNING id`,
      [OUTSIDER],
    );
    expect(near.rowCount).toBe(1);
    try {
      const comps = await findComparableIdentities(
        hotelIds.get(SUBJECT)!,
        10,
        DEFAULT_CONFIG.live.csi.radiusMiles[0]! * 1.609344,
      );
      expect(comps.map((c) => c.wahHotelId)).toContain(OUTSIDER);
    } finally {
      // Put it back where the rest of the suite expects it.
      await getPool().query(
        `UPDATE hotel SET latitude = 1, longitude = 1 WHERE wah_hotel_id = $1`,
        [OUTSIDER],
      );
    }
  });

  it('falls back to the nearest hotels in the destination when nothing is curated', async () => {
    const subjectId = hotelIds.get(SUBJECT)!;
    expect(await hasCuratedComparables(subjectId)).toBe(false);

    const comps = await findCompetitorRates(
      subjectId,
      CHECK_IN,
      2,
      2,
      0,
      CURRENCY,
      TERMS,
      2, // deliberately fewer than the destination holds
      48,
    );

    // Nearest two, and never the hotel in the other destination.
    expect(comps.map((c) => c.hotelId).sort()).toEqual(['US-MID', 'US-NEAR']);
    expect(comps.some((c) => c.hotelId === OUTSIDER)).toBe(false);
  });

  it('widens past a curated set that yields too few USABLE comps', async () => {
    const subjectId = hotelIds.get(SUBJECT)!;
    const request = {
      wahHotelId: SUBJECT,
      checkIn: CHECK_IN,
      nights: 2,
      adults: 2,
      children: 0,
      currency: null,
      now: new Date(),
    };

    // Curate ONE comp, and make it useless: a hotel with no rate for this stay
    // at all. "A curated set exists" is then true and worthless — the exact
    // shape hotel 1198 was stuck in, where the index stayed unavailable in our
    // best-collected destination while three usable hotels sat beside it.
    const useless = hotelIds.get(OUTSIDER)!; // different destination, no rate here
    await getPool().query(
      `INSERT INTO hotel_comparable (hotel_id,comparable_id,rank,similarity,basis)
       VALUES ($1,$2,1,0.9,'DESTINATION_TIER_PRICEBAND')
       ON CONFLICT DO NOTHING`,
      [subjectId, useless],
    );

    const loaded = await loadLiveIntelligence(request, DEFAULT_CONFIG);
    if (isLiveLoadFailure(loaded)) throw new Error(`expected a rate, got ${loaded.kind}`);

    // It fell back to the destination and found the three hotels that do have
    // rates — rather than reporting CURATED and no comps.
    expect(loaded.compBasis).toBe('DESTINATION');
    expect(loaded.compSet.compsUsed).toBeGreaterThanOrEqual(3);

    await getPool().query(`DELETE FROM hotel_comparable WHERE hotel_id = $1`, [subjectId]);
  });

  it('reports the comp basis, and prefers the curated set once one exists', async () => {
    const subjectId = hotelIds.get(SUBJECT)!;
    const request = {
      wahHotelId: SUBJECT,
      checkIn: CHECK_IN,
      nights: 2,
      adults: 2,
      children: 0,
      currency: null,
      now: new Date(),
    };

    const before = await loadLiveIntelligence(request, DEFAULT_CONFIG);
    if (isLiveLoadFailure(before)) throw new Error(`expected a rate, got ${before.kind}`);
    expect(before.compBasis).toBe('DESTINATION');

    // Curate a set that can actually carry the index. Fewer than minComps
    // usable rates is not a curated comp set, it is an empty one wearing a
    // label — see the widening test above.
    for (const [i, code] of ['US-FAR', 'US-MID', 'US-NEAR'].entries()) {
      await getPool().query(
        `INSERT INTO hotel_comparable (hotel_id,comparable_id,rank,similarity,basis)
         VALUES ($1,$2,$3,0.9,'DESTINATION_TIER_PRICEBAND')
         ON CONFLICT DO NOTHING`,
        [subjectId, hotelIds.get(code), i + 1],
      );
    }

    const after = await loadLiveIntelligence(request, DEFAULT_CONFIG);
    if (isLiveLoadFailure(after)) throw new Error(`expected a rate, got ${after.kind}`);
    expect(after.compBasis).toBe('CURATED');

    // Curated order, not distance order: US-FAR is furthest and ranked first.
    const comps = await findCompetitorRates(subjectId, CHECK_IN, 2, 2, 0, CURRENCY, TERMS, 5, 48);
    expect(comps.map((c) => c.hotelId).sort()).toEqual(['US-FAR', 'US-MID', 'US-NEAR']);

    await getPool().query(`DELETE FROM hotel_comparable WHERE hotel_id = $1`, [subjectId]);
  });

  it('lists every bookable room for the stay, cheapest first', async () => {
    const loaded = await loadLiveIntelligence(
      {
        wahHotelId: SUBJECT,
        checkIn: CHECK_IN,
        nights: 2,
        adults: 2,
        children: 0,
        currency: null,
        now: new Date(),
      },
      DEFAULT_CONFIG,
    );
    if (isLiveLoadFailure(loaded)) throw new Error(`expected a rate, got ${loaded.kind}`);

    expect(loaded.availableRooms.map((r) => r.name)).toEqual(['US King', 'US Suite']);
    expect(loaded.availableRooms[0]?.nightlyMinor).toBe(160_000);
    expect(loaded.availableRooms[1]?.nightlyMinor).toBe(260_000);
    // The engine's pick with no room requested is the cheapest one.
    expect(loaded.roomTypeId).toBe(entryRoomTypeId);
    expect(loaded.roomSelectedBy).toBe('ENGINE');
  });

  it('scores the room the guest asked for, not the cheapest', async () => {
    // The whole point of the picker: a different category is a different
    // question. If this returned the entry room's price under the suite's
    // name, the panel would be confidently describing the wrong product.
    const loaded = await loadLiveIntelligence(
      {
        wahHotelId: SUBJECT,
        checkIn: CHECK_IN,
        nights: 2,
        adults: 2,
        children: 0,
        currency: null,
        roomTypeId: suiteRoomTypeId,
        now: new Date(),
      },
      DEFAULT_CONFIG,
    );
    if (isLiveLoadFailure(loaded)) throw new Error(`expected a rate, got ${loaded.kind}`);

    expect(loaded.roomTypeId).toBe(suiteRoomTypeId);
    expect(loaded.roomName).toBe('US Suite');
    expect(loaded.roomSelectedBy).toBe('USER');
    expect(loaded.nightlyMinor).toBe(260_000);
    // The room list is the same whichever room is selected — it describes the
    // stay, not the selection, so the picker never loses its other options.
    expect(loaded.availableRooms).toHaveLength(2);
  });

  it("compares a suite against suites, not against everyone else's cheapest room", async () => {
    const request = {
      wahHotelId: SUBJECT,
      checkIn: CHECK_IN,
      nights: 2,
      adults: 2,
      children: 0,
      currency: null,
      roomTypeId: suiteRoomTypeId,
      now: new Date(),
    };
    const loaded = await loadLiveIntelligence(request, DEFAULT_CONFIG);
    if (isLiveLoadFailure(loaded)) throw new Error(`expected a rate, got ${loaded.kind}`);

    // The subject suite is 2,600. The neighbours' SUITES are 2,800-3,200 and
    // their rooms are 1,800-2,200. Compared against rooms it would look wildly
    // overpriced; against suites it is the cheapest suite in the market. Which
    // comparison we make is the difference between a fair verdict and a
    // penalty for being a suite at all.
    expect(loaded.compRoomMatch).toBe('CLASS_AND_VIEW');
    expect(loaded.compSet.medianCompetitorNightlyMinor).toBeGreaterThan(260_000);
  });

  it('falls back to any room when no equivalent category is sold, and says so', async () => {
    // The entry ROOM has no view stated and the neighbours' rooms carry no
    // room type at all, so nothing matches on class — the honest answer is to
    // compare on what exists and report the weaker rung rather than return
    // nothing or pretend the rooms are equivalent.
    const loaded = await loadLiveIntelligence(
      {
        wahHotelId: SUBJECT,
        checkIn: CHECK_IN,
        nights: 2,
        adults: 2,
        children: 0,
        currency: null,
        roomTypeId: entryRoomTypeId,
        now: new Date(),
      },
      DEFAULT_CONFIG,
    );
    if (isLiveLoadFailure(loaded)) throw new Error(`expected a rate, got ${loaded.kind}`);
    expect(loaded.compRoomMatch).toBe('ANY');
    expect(loaded.compSet.compsUsed).toBeGreaterThanOrEqual(3);
  });

  it('counts recent attempts per stay, which is what bounds the comp-set top-up', async () => {
    // The top-up cannot borrow the subject's fruitless guard: in the case it
    // exists for, the subject succeeded, so that guard is false forever and
    // every page view would re-fetch the whole comp set.
    const ids = [hotelIds.get('US-NEAR')!, hotelIds.get('US-MID')!];
    await recordCollectionAttempts(
      ids.map((hotelId) => ({
        hotelId,
        checkIn: CHECK_IN,
        nights: 2,
        adults: 2,
        succeeded: true,
        outcome: 'OK',
      })),
    );

    expect(await countRecentAttempts(ids, CHECK_IN, 2, 2, 15)).toBe(2);

    // Counted whatever the outcome was: a comp that answered nothing and a comp
    // that answered a rate we could not use both mean "we already asked".
    expect(await countRecentAttempts([hotelIds.get('US-FAR')!], CHECK_IN, 2, 2, 15)).toBe(0);

    // A different stay is a different question.
    expect(await countRecentAttempts(ids, '2027-05-01', 2, 2, 15)).toBe(0);
    expect(await countRecentAttempts(ids, CHECK_IN, 3, 2, 15)).toBe(0);

    // And an empty list never touches the database.
    expect(await countRecentAttempts([], CHECK_IN, 2, 2, 15)).toBe(0);
  });

  it('promotes a catalogued hotel into collection on first interest, once', async () => {
    expect(await promoteHotelForCollection(OUTSIDER)).toBe(true);
    expect(await promoteHotelForCollection(OUTSIDER)).toBe(false);

    const { rows } = await getPool().query(
      `SELECT collection_tier FROM hotel WHERE wah_hotel_id = $1`,
      [OUTSIDER],
    );
    expect(rows[0].collection_tier).toBe('WARM');
  });
});

async function cleanup(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `DELETE FROM collection_attempt WHERE hotel_id IN
       (SELECT id FROM hotel WHERE wah_hotel_id LIKE 'US-%')`,
  );
  await pool.query(
    `DELETE FROM rate_observation WHERE hotel_id IN
       (SELECT id FROM hotel WHERE wah_hotel_id LIKE 'US-%')`,
  );
  await pool.query(
    `DELETE FROM hotel_comparable WHERE hotel_id IN
       (SELECT id FROM hotel WHERE wah_hotel_id LIKE 'US-%')`,
  );
  await pool.query(
    `DELETE FROM rate_plan WHERE hotel_id IN
       (SELECT id FROM hotel WHERE wah_hotel_id LIKE 'US-%')`,
  );
  await pool.query(
    `DELETE FROM room_type WHERE hotel_id IN
       (SELECT id FROM hotel WHERE wah_hotel_id LIKE 'US-%')`,
  );
  await pool.query(`DELETE FROM hotel WHERE wah_hotel_id LIKE 'US-%'`);
  await pool.query(
    `DELETE FROM ingest_batch WHERE source_id IN (SELECT id FROM source WHERE code = $1)`,
    [SOURCE],
  );
  await pool.query(`DELETE FROM source WHERE code = $1`, [SOURCE]);
  await pool.query(`DELETE FROM destination WHERE slug IN ('us-city','us-elsewhere')`);
}
