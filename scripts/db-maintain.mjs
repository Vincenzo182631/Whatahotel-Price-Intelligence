// Reclaim database space without touching a single scoring-relevant fact.
//
// Written for the day the Neon project hit its 512 MB ceiling and every
// write — scheduled collection, on-demand rescue, rollups — began failing
// with "could not extend file because project size limit has been
// exceeded", which surfaced to guests as NO_CURRENT_RATE on every stay.
//
// What takes the space is not the facts but the AUDIT PAYLOADS:
//   - rate_observation.raw carries the source's full room object per row,
//     needed only while the row is fresh (booking codes are read from the
//     freshest capture; older raw is diagnostics we have never once read
//     back). Nulling raw on old rows frees the bulk of the table.
//   - ingest_reject stores full raw payloads for review; reviewed or not,
//     they are re-creatable by the next run that hits the same reject.
//
// Order matters on a FULL project: TRUNCATE first — it returns whole files
// to the quota without needing to extend anything — and only then run the
// batched UPDATEs, which need headroom for new row versions.
//
//   node scripts/db-maintain.mjs             # measure only
//   node scripts/db-maintain.mjs --apply     # truncate + slim + vacuum
//   node scripts/db-maintain.mjs --squeeze   # TRUNCATE observations, migrate
//   node scripts/db-maintain.mjs --broken   # hotels whose rate lookups keep failing
//   node scripts/db-maintain.mjs --coverage # which hotel attributes actually exist,
//                                           # and how many neighbours a tighter
//                                           # competitive radius would find
//   node scripts/db-maintain.mjs --enrolment-plan
//                                           # what enrolling more hotels costs
//                                           # per hotel, and where it pays
//   node scripts/db-maintain.mjs --collection-coverage
//                                           # how much of the catalogue has
//                                           # ever actually been collected
//   node scripts/db-maintain.mjs --comp-funnel
//                                           # why a hotel has no curated peer
//                                           # set: which of the builder's
//                                           # conditions actually binds
//   node scripts/db-maintain.mjs --geo-gap  # how many hotels carry no coordinates,
//                                           # how much of that gap is worth closing,
//                                           # and the upper bound on what closing it buys
//   node scripts/db-maintain.mjs --market 6792 2026-08-30 1 2
//                                            # read-only market probe: why does
//                                            # this hotel's comp pool look the
//                                            # way it does for that stay?
//
// --squeeze is the free-tier reset (see migration 0015): the slim-and-vacuum
// ratchet cannot save a project that is already full, because on Neon only
// TRUNCATE and DROP lower the project-size counter. The squeeze truncates
// rate_observation outright — baselines, analyses and the catalogue persist;
// the observations themselves are re-collected by the next runs — then applies
// pending migrations so 0015 can replace the monthly partitions with daily
// ones while they are empty. Ongoing retention is migrate's job, driven by
// RATE_OBSERVATION_RETAIN_DAYS on every collection run.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set. This maintains a real database or nothing.');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const SQUEEZE = process.argv.includes('--squeeze');
const KEEP_DAYS = Number(process.env.RAW_KEEP_DAYS ?? 14);
const BATCH = Number(process.env.RAW_BATCH ?? 20_000);

async function sql(query) {
  const { stdout } = await run(
    'psql',
    [DATABASE_URL, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', query],
    {
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return stdout.trim();
}

async function measure(label) {
  console.log(`\n── ${label} ──`);
  console.log(
    'database size:',
    await sql('SELECT pg_size_pretty(pg_database_size(current_database()))'),
  );
  const top = await sql(`
    SELECT relname || ' ' || pg_size_pretty(pg_total_relation_size(c.oid))
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p','i','t')
     ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 12`);
  console.log('largest relations:\n  ' + top.split('\n').join('\n  '));
  const rawStats = await sql(`
    SELECT count(*) || ' rows, ' || pg_size_pretty(COALESCE(sum(pg_column_size(raw)),0)::bigint) || ' of raw'
      FROM rate_observation
     WHERE observation_slot < now() - interval '${KEEP_DAYS} days' AND raw IS NOT NULL`);
  console.log(`raw older than ${KEEP_DAYS}d:`, rawStats);
  console.log(
    'ingest_reject:',
    await sql(
      `SELECT count(*) || ' rows, ' || pg_size_pretty(pg_total_relation_size('ingest_reject'))  FROM ingest_reject`,
    ),
  );
}

// Read-only report: hotels whose rate lookups keep failing.
//
// The collector records every fruitless attempt in collection_attempt so it
// can back off (migration 0010). That ledger is also, incidentally, the best
// evidence we have about which hotels the BOOKING SYSTEM cannot price at all:
// a hotel that fails across many different stay slots, for days, is not a
// hotel that happens to be sold out — it is a hotel whose Amadeus property
// mapping is broken, and whatahotel.com cannot sell it either.
//
// Names the candidates so the list can be handed to whoever owns the Amadeus
// mapping. The property CODE is not stored here — it comes back on the live
// rates call, which is the authoritative check anyway: a broken mapping
// answers status 500 with amadeus.amaID = "NULL" while the code itself is
// present. Read-only; verify each candidate that way before acting on it.
// Which hotel attributes actually EXIST, and how dense the map is.
//
// Written before narrowing the competitive radius, because that change rests
// on two things nobody had measured: how many hotels carry coordinates at all
// (no coordinates, no radius) and how many neighbours a 2/3/5-mile radius
// actually finds. A radius tuned against an imagined catalogue would quietly
// starve the comp set instead of sharpening it.
//
// It also answers, once, which of the attributes a comparable-qualification
// model might key on are populated and which are columns nothing ever writes.
// Read-only.
const COVERAGE = process.argv.includes('--coverage');
if (COVERAGE) {
  console.log('\n── attribute coverage across active hotels ──');
  console.log(
    await sql(`
      WITH a AS (SELECT * FROM hotel WHERE is_active)
      SELECT 'active hotels          ' || count(*) FROM a
      UNION ALL SELECT 'with coordinates       ' || count(*) || '  (' ||
             round(100.0 * count(*) / NULLIF((SELECT count(*) FROM a), 0)) || '%)'
        FROM a WHERE latitude IS NOT NULL AND longitude IS NOT NULL
      UNION ALL SELECT 'with google rating     ' || count(*) || '  (' ||
             round(100.0 * count(*) / NULLIF((SELECT count(*) FROM a), 0)) || '%)'
        FROM a WHERE google_match_status = 'VERIFIED' AND google_rating IS NOT NULL
      UNION ALL SELECT 'with city_rank         ' || count(*) FROM a WHERE city_rank IS NOT NULL
      UNION ALL SELECT 'with street_address    ' || count(*) FROM a WHERE street_address IS NOT NULL
      UNION ALL SELECT 'with star_rating       ' || count(*) FROM a WHERE star_rating IS NOT NULL
      UNION ALL SELECT 'with luxury_tier       ' || count(*) FROM a WHERE luxury_tier IS NOT NULL
      UNION ALL SELECT 'with brand             ' || count(*) FROM a WHERE brand IS NOT NULL
      UNION ALL SELECT 'with chain             ' || count(*) FROM a WHERE chain IS NOT NULL
      UNION ALL SELECT 'with any perk/benefit  ' || count(DISTINCT hotel_id) FROM hotel_benefit
      UNION ALL SELECT 'destinations           ' || count(DISTINCT destination_id) FROM a`),
  );

  // How many OTHER active hotels sit inside each candidate radius, for hotels
  // that carry coordinates. Equirectangular, the same approximation the comp
  // CTE uses, so the numbers describe the query that would actually run.
  console.log('\n── neighbours within a candidate radius (hotels with coordinates) ──');
  console.log(
    await sql(`
      WITH geo AS (
        SELECT id, latitude::float8 AS lat, longitude::float8 AS lon
          FROM hotel WHERE is_active AND latitude IS NOT NULL AND longitude IS NOT NULL
      ),
      pairs AS (
        SELECT s.id,
               sqrt(power(111.32 * (h.lat - s.lat), 2)
                  + power(111.32 * cos(radians(s.lat)) * (h.lon - s.lon), 2)) AS km
          FROM geo s JOIN geo h ON h.id <> s.id
      ),
      per AS (
        SELECT s.id,
               count(*) FILTER (WHERE p.km <= 3.219) AS within_2mi,
               count(*) FILTER (WHERE p.km <= 4.828) AS within_3mi,
               count(*) FILTER (WHERE p.km <= 8.047) AS within_5mi,
               count(*) FILTER (WHERE p.km <= 30.0)  AS within_30km
          FROM geo s LEFT JOIN pairs p ON p.id = s.id
         GROUP BY s.id
      )
      SELECT 'radius  ' || rpad(label, 8)
          || ' | median ' || lpad(med::text, 4)
          || ' | >=3 comps ' || lpad(atleast3::text, 5)
          || ' (' || lpad(round(100.0 * atleast3 / NULLIF(total, 0))::text, 3) || '%)'
          || ' | zero ' || lpad(zero::text, 5)
        FROM (
          SELECT '2 mi' AS label,
                 percentile_disc(0.5) WITHIN GROUP (ORDER BY within_2mi) AS med,
                 count(*) FILTER (WHERE within_2mi >= 3) AS atleast3,
                 count(*) FILTER (WHERE within_2mi = 0) AS zero,
                 count(*) AS total, 1 AS ord FROM per
          UNION ALL SELECT '3 mi', percentile_disc(0.5) WITHIN GROUP (ORDER BY within_3mi),
                 count(*) FILTER (WHERE within_3mi >= 3), count(*) FILTER (WHERE within_3mi = 0),
                 count(*), 2 FROM per
          UNION ALL SELECT '5 mi', percentile_disc(0.5) WITHIN GROUP (ORDER BY within_5mi),
                 count(*) FILTER (WHERE within_5mi >= 3), count(*) FILTER (WHERE within_5mi = 0),
                 count(*), 3 FROM per
          UNION ALL SELECT '30 km', percentile_disc(0.5) WITHIN GROUP (ORDER BY within_30km),
                 count(*) FILTER (WHERE within_30km >= 3), count(*) FILTER (WHERE within_30km = 0),
                 count(*), 4 FROM per
        ) t ORDER BY ord`),
  );

  process.exit(0);
}

// How big is the coordinate gap, and what would closing it actually buy?
//
// The 2/3/5-mile ladder can only see hotels that carry coordinates. A hotel
// without them is not far away, it is UNPLACEABLE, and the distance predicate
// rejects it at every rung. Hotels 1198 and 951 render Hotel Value for exactly
// this reason: their neighbours exist, but nothing knows where they are, so
// the market probe reports zero qualifying candidates at 2, 3 and 5 miles
// alike. That is the ladder being honest, not the radius being wrong.
//
// This sizes the geocoding job before anyone commits to it, and separates the
// part worth doing from the part that is not: a hotel the public page flags as
// unbookable online fails qualification even once it is placed, so geocoding
// it buys nothing.
//
// The destination-level counts are a PROXY and are labelled as one everywhere
// they appear. Without coordinates there is no way to know whether an unplaced
// hotel would land inside five miles of anything; sharing a destination is the
// strongest evidence available and it is strictly weaker than a measured
// distance. Read them as an UPPER BOUND on the payoff, never as a forecast.
//
// Read-only.
const GEO_GAP = process.argv.includes('--geo-gap');
if (GEO_GAP) {
  console.log('\n── the coordinate gap across active hotels ──');
  console.log(
    await sql(`
      WITH a AS (SELECT * FROM hotel WHERE is_active),
           u AS (SELECT * FROM a WHERE latitude IS NULL OR longitude IS NULL)
      SELECT line FROM (
        SELECT 1 AS ord, 'active hotels                     ' || count(*) AS line FROM a
        UNION ALL SELECT 2, 'placed (has coordinates)          ' || count(*) || '  (' ||
               round(100.0 * count(*) / NULLIF((SELECT count(*) FROM a), 0)) || '%)'
          FROM a WHERE latitude IS NOT NULL AND longitude IS NOT NULL
        UNION ALL SELECT 3, 'UNPLACED (no coordinates)         ' || count(*) || '  (' ||
               round(100.0 * count(*) / NULLIF((SELECT count(*) FROM a), 0)) || '%)' FROM u
        UNION ALL SELECT 4, '  unplaced AND bookable online    ' || count(*)
          FROM u WHERE bookable_online IS DISTINCT FROM false
        UNION ALL SELECT 5, '  unplaced but flagged unbookable ' || count(*)
          FROM u WHERE bookable_online IS false
      ) t ORDER BY ord`),
  );

  // Of the gap that is worth closing, how much of it can be closed with what
  // is already held? A street address is independent geographic evidence and
  // is what addressCanConfirm() needs to let a Google ask proceed; a hotel
  // with neither address nor postal code has nothing to geocode against and
  // is a different, larger job.
  // Half a position is not a position: every distance predicate in the system
  // requires BOTH coordinates, so a row carrying one and not the other is
  // already invisible to the ladder while still looking placed in a casual
  // count. Measured before migration 0018's CHECK is trusted, because the
  // constraint treats such a row as a violation and the honest question is how
  // many there are before anything is done about them.
  console.log('\n── half a position (one coordinate, not both) ──');
  console.log(
    await sql(`
      SELECT count(*) || ' active hotel(s) carry exactly one coordinate'
        FROM hotel
       WHERE is_active
         AND (latitude IS NULL) <> (longitude IS NULL)`),
  );
  console.log(
    await sql(`
      SELECT wah_hotel_id || ' | ' || rpad(left(name, 40), 40)
          || ' | lat ' || COALESCE(latitude::text, 'NULL')
          || ' | lon ' || COALESCE(longitude::text, 'NULL')
        FROM hotel
       WHERE is_active
         AND (latitude IS NULL) <> (longitude IS NULL)
       ORDER BY id
       LIMIT 40`),
  );

  console.log('\n── can the worthwhile gap be closed with what we already hold? ──');
  console.log(
    await sql(`
      WITH u AS (
        SELECT * FROM hotel
         WHERE is_active
           AND (latitude IS NULL OR longitude IS NULL)
           AND bookable_online IS DISTINCT FROM false
      )
      SELECT line FROM (
        SELECT 1 AS ord, 'unplaced and bookable             ' || count(*) AS line FROM u
        UNION ALL SELECT 2, '  with a street address           ' || count(*)
          FROM u WHERE street_address IS NOT NULL
        UNION ALL SELECT 3, '  with a postal code              ' || count(*)
          FROM u WHERE postal_code IS NOT NULL
        UNION ALL SELECT 4, '  with NEITHER                    ' || count(*)
          FROM u WHERE street_address IS NULL AND postal_code IS NULL
        UNION ALL SELECT 5, '  page never fetched              ' || count(*)
          FROM u WHERE page_fetched_at IS NULL
        UNION ALL SELECT 6, 'google status: never asked (NULL) ' || count(*)
          FROM u WHERE google_match_status IS NULL
        UNION ALL SELECT 7, 'google status: UNVERIFIED         ' || count(*)
          FROM u WHERE google_match_status = 'UNVERIFIED'
        UNION ALL SELECT 8, 'google status: NO_MATCH           ' || count(*)
          FROM u WHERE google_match_status = 'NO_MATCH'
        UNION ALL SELECT 9, 'google status: VERIFIED           ' || count(*)
          FROM u WHERE google_match_status = 'VERIFIED'
      ) t ORDER BY ord`),
  );

  // The payoff, stated as the upper bound it is. A STARVED hotel is one that
  // is placed and bookable and still finds no qualifying neighbour inside the
  // ladder's outer rung — the population that renders Hotel Value today. The
  // question worth money is how many of them share a destination with hotels
  // that are merely unplaced, because those are the ones geocoding could
  // rescue. Sharing a destination does not put a hotel within five miles, so
  // every count below is a ceiling.
  console.log('\n── upper bound on the payoff (destination proxy, NOT a forecast) ──');
  console.log(
    await sql(`
      WITH a AS (
        SELECT id, destination_id, bookable_online,
               latitude::float8 AS lat, longitude::float8 AS lon
          FROM hotel WHERE is_active
      ),
      geo AS (SELECT * FROM a WHERE lat IS NOT NULL AND lon IS NOT NULL),
      nbr AS (
        SELECT s.id, s.destination_id,
               count(h.id) AS within_5mi
          FROM geo s
          LEFT JOIN geo h
            ON h.id <> s.id
           AND h.bookable_online IS DISTINCT FROM false
           AND power(111.32 * (h.lat - s.lat), 2)
             + power(111.32 * cos(radians(s.lat)) * (h.lon - s.lon), 2) <= power(8.047, 2)
         WHERE s.bookable_online IS DISTINCT FROM false
         GROUP BY s.id, s.destination_id
      ),
      starved AS (SELECT * FROM nbr WHERE within_5mi = 0),
      gap AS (
        SELECT destination_id, count(*) AS unplaced
          FROM a
         WHERE (lat IS NULL OR lon IS NULL)
           AND bookable_online IS DISTINCT FROM false
         GROUP BY destination_id
      )
      SELECT line FROM (
        SELECT 1 AS ord, 'placed+bookable hotels            ' || count(*) AS line FROM nbr
        UNION ALL SELECT 2, 'STARVED (0 qualifying <=5 mi)     ' || count(*) FROM starved
        UNION ALL SELECT 3, '  in a destination with >=1 unplaced ' || count(*)
          FROM starved s JOIN gap g ON g.destination_id = s.destination_id
        UNION ALL SELECT 4, '  in a destination with >=3 unplaced ' || count(*)
          FROM starved s JOIN gap g ON g.destination_id = s.destination_id AND g.unplaced >= 3
        UNION ALL SELECT 5, 'unplaced hotels that could rescue one ' || COALESCE(sum(g.unplaced), 0)
          FROM gap g
         WHERE EXISTS (SELECT 1 FROM starved s WHERE s.destination_id = g.destination_id)
      ) t ORDER BY ord`),
  );

  // The work list, so the job can be started at the end that pays.
  console.log('\n── destinations where geocoding could unstarve the most hotels ──');
  console.log(
    await sql(`
      WITH a AS (
        SELECT id, destination_id, bookable_online,
               latitude::float8 AS lat, longitude::float8 AS lon
          FROM hotel WHERE is_active
      ),
      geo AS (SELECT * FROM a WHERE lat IS NOT NULL AND lon IS NOT NULL),
      nbr AS (
        SELECT s.id, s.destination_id, count(h.id) AS within_5mi
          FROM geo s
          LEFT JOIN geo h
            ON h.id <> s.id
           AND h.bookable_online IS DISTINCT FROM false
           AND power(111.32 * (h.lat - s.lat), 2)
             + power(111.32 * cos(radians(s.lat)) * (h.lon - s.lon), 2) <= power(8.047, 2)
         WHERE s.bookable_online IS DISTINCT FROM false
         GROUP BY s.id, s.destination_id
      ),
      starved AS (
        SELECT destination_id, count(*) AS n FROM nbr WHERE within_5mi = 0 GROUP BY destination_id
      ),
      gap AS (
        SELECT destination_id,
               count(*) AS unplaced,
               count(*) FILTER (WHERE street_address IS NOT NULL) AS with_address
          FROM hotel
         WHERE is_active
           AND (latitude IS NULL OR longitude IS NULL)
           AND bookable_online IS DISTINCT FROM false
         GROUP BY destination_id
      )
      SELECT rpad(COALESCE(left(d.name, 28), '?'), 28)
          || ' | starved ' || lpad(s.n::text, 4)
          || ' | unplaced ' || lpad(g.unplaced::text, 4)
          || ' | of those with an address ' || lpad(g.with_address::text, 4)
        FROM starved s
        JOIN gap g ON g.destination_id = s.destination_id
        LEFT JOIN destination d ON d.id = s.destination_id
       ORDER BY LEAST(s.n, g.unplaced) DESC, s.n DESC
       LIMIT 25`),
  );
  console.log(
    '\n(Destination is a PROXY for proximity. A hotel in the same destination may still be\n' +
      ' more than five miles away once placed, so treat every count here as a ceiling.)',
  );

  process.exit(0);
}

// Why does a hotel have no curated peer set?
//
// The rebuild on 2026-08-27 wrote 2,024 pairs and left 2,779 of 3,209 hotels
// with no comp set at all. That number invites a wrong conclusion — that the
// 5-mile bound starved the peer sets — and the builder applies five conditions,
// only one of which is distance. Guessing which one binds is exactly the kind
// of thing that gets a working rule blamed for someone else's gap.
//
// The funnel below mirrors rebuildComparables. Its ORDER is chosen for
// interpretability rather than copied from the code: a hotel excluded by two
// conditions is attributed to the first one here, so each line reads as "this
// is the first thing that stopped it". The code applies price and distance
// before the destination test (which lives inside similarityBetween, where a
// different destination scores 0 and falls under minSimilarity) — that changes
// nothing about who ends up with a comp set, only which bucket explains it.
//
// maxTierDistance and minSimilarity are deliberately absent: both are inert in
// production. The tier filter needs luxury_tier on BOTH sides and that column
// is 0/3,209. And with both tiers null, similarityBetween returns
// 0.5*price + 0.15 + 0.20, so its floor is exactly the 0.35 threshold even at
// zero price agreement. Neither can reject anything, so neither is measured.
//
// Read-only.
const COMP_FUNNEL = process.argv.includes('--comp-funnel');
if (COMP_FUNNEL) {
  console.log('\n── why a hotel has no curated peer set (first blocking condition) ──');
  console.log(
    await sql(`
      WITH a AS (
        SELECT h.id, h.destination_id,
               h.latitude::float8 AS lat, h.longitude::float8 AS lon,
               (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY b.p50_minor)
                  FROM rate_baseline b
                 WHERE b.hotel_id = h.id AND b.baseline_level = 'L3') AS typical
          FROM hotel h
         WHERE h.is_active
      ),
      f AS (
        SELECT s.id,
               (s.typical IS NOT NULL) AS has_own,
               count(o.id) FILTER (
                 WHERE s.destination_id IS NOT NULL
                   AND o.destination_id = s.destination_id
               ) AS same_dest,
               count(o.id) FILTER (
                 WHERE s.destination_id IS NOT NULL
                   AND o.destination_id = s.destination_id
                   AND o.typical IS NOT NULL
               ) AS dest_priced,
               count(o.id) FILTER (
                 WHERE s.destination_id IS NOT NULL
                   AND o.destination_id = s.destination_id
                   AND o.typical IS NOT NULL AND s.typical IS NOT NULL
                   AND GREATEST(s.typical, o.typical) / NULLIF(LEAST(s.typical, o.typical), 0) <= 2.0
               ) AS in_band,
               count(o.id) FILTER (
                 WHERE s.destination_id IS NOT NULL
                   AND o.destination_id = s.destination_id
                   AND o.typical IS NOT NULL AND s.typical IS NOT NULL
                   AND GREATEST(s.typical, o.typical) / NULLIF(LEAST(s.typical, o.typical), 0) <= 2.0
                   -- Unknown distance is kept, exactly as the builder keeps it.
                   AND (
                     s.lat IS NULL OR s.lon IS NULL OR o.lat IS NULL OR o.lon IS NULL
                     OR power(111.32 * (o.lat - s.lat), 2)
                      + power(111.32 * cos(radians(s.lat)) * (o.lon - s.lon), 2)
                        <= power(8.047, 2)
                   )
               ) AS in_range
          FROM a s
          LEFT JOIN a o ON o.id <> s.id
         GROUP BY s.id, s.typical, s.destination_id
      )
      SELECT line FROM (
        SELECT 1 AS ord, 'active hotels                          ' || count(*) AS line FROM f
        UNION ALL SELECT 2, 'no L3 baseline of its own              ' || count(*)
          FROM f WHERE NOT has_own
        UNION ALL SELECT 3, 'no other hotel in its destination      ' || count(*)
          FROM f WHERE has_own AND same_dest = 0
        UNION ALL SELECT 4, 'no destination peer with a baseline    ' || count(*)
          FROM f WHERE has_own AND same_dest > 0 AND dest_priced = 0
        UNION ALL SELECT 5, 'none inside the 2.0x price band        ' || count(*)
          FROM f WHERE has_own AND dest_priced > 0 AND in_band = 0
        UNION ALL SELECT 6, 'none within 5 mi (8.05 km)             ' || count(*)
          FROM f WHERE has_own AND in_band > 0 AND in_range = 0
        UNION ALL SELECT 7, 'HAS a peer set                         ' || count(*)
          FROM f WHERE has_own AND in_range > 0
      ) t ORDER BY ord`),
  );
  console.log(
    '\n(Attribution is to the FIRST condition in this order. A hotel with no baseline of\n' +
      ' its own would also fail later tests; it is counted once, at the top.)',
  );

  process.exit(0);
}

// How much of the catalogue has ever actually been collected?
//
// The comp-set funnel put 96.3% of hotels without a peer set behind one
// condition: no L3 baseline of their own. The rollup writes an L3 row on
// HAVING count(*) >= 1, so "no L3 baseline" is very nearly "no usable rate
// observation has ever been rolled up for this hotel". That makes peer-set
// coverage a COLLECTION question, not a qualification one, and this measures
// it directly instead of inferring it.
//
// One thing to get right before reading any of it: production retains five
// days of rate_observation (RATE_OBSERVATION_RETAIN_DAYS in collect.yml, forced
// by the 512 MB project ceiling — see migration 0015). So rate_observation
// CANNOT answer "was this hotel ever collected"; it answers "was it collected
// this week". The durable records are rate_baseline, which is a rollup and is
// never dropped by retention, and collection_attempt, which is the ledger of
// what was tried. Both are used below and each is labelled for what it is.
//
// Read-only.
const COLLECTION_COVERAGE = process.argv.includes('--collection-coverage');
if (COLLECTION_COVERAGE) {
  console.log('\n── enrolment: what the scheduler is even willing to collect ──');
  console.log(
    await sql(`
      WITH a AS (SELECT * FROM hotel WHERE is_active)
      SELECT line FROM (
        SELECT 1 AS ord, 'active hotels                     ' || count(*) AS line FROM a
        UNION ALL SELECT 2, '  tier HOT                        ' || count(*) FROM a WHERE collection_tier = 'HOT'
        UNION ALL SELECT 3, '  tier WARM                       ' || count(*) FROM a WHERE collection_tier = 'WARM'
        UNION ALL SELECT 4, '  tier COLD                       ' || count(*) FROM a WHERE collection_tier = 'COLD'
        UNION ALL SELECT 5, '  tier OFF (never scheduled)      ' || count(*) FROM a WHERE collection_tier = 'OFF'
        UNION ALL SELECT 6, 'ENROLLED (tier <> OFF)            ' || count(*) || '  (' ||
               round(100.0 * count(*) / NULLIF((SELECT count(*) FROM a), 0)) || '%)'
          FROM a WHERE collection_tier <> 'OFF'
      ) t ORDER BY ord`),
  );

  // The durable record. A baseline survives retention, so this is the closest
  // thing to "has this hotel ever yielded a usable rate".
  console.log('\n── has it ever produced a baseline? (survives the 5-day retention) ──');
  console.log(
    await sql(`
      WITH a AS (SELECT * FROM hotel WHERE is_active)
      SELECT line FROM (
        SELECT 1 AS ord, 'active hotels                     ' || count(*) AS line FROM a
        UNION ALL SELECT 2, 'with ANY rate_baseline row        ' || count(DISTINCT b.hotel_id)
          FROM rate_baseline b JOIN a ON a.id = b.hotel_id
        UNION ALL SELECT 3, '  with an L3 baseline             ' || count(DISTINCT b.hotel_id)
          FROM rate_baseline b JOIN a ON a.id = b.hotel_id WHERE b.baseline_level = 'L3'
        UNION ALL SELECT 4, 'with NO baseline of any kind      ' || count(*) || '  (' ||
               round(100.0 * count(*) / NULLIF((SELECT count(*) FROM a), 0)) || '%)'
          FROM a WHERE NOT EXISTS (SELECT 1 FROM rate_baseline b WHERE b.hotel_id = a.id)
        UNION ALL SELECT 5, 'ENROLLED but no baseline          ' || count(*)
          FROM a WHERE collection_tier <> 'OFF'
            AND NOT EXISTS (SELECT 1 FROM rate_baseline b WHERE b.hotel_id = a.id)
      ) t ORDER BY ord`),
  );

  // What was actually tried. consecutive_failures = 0 means the LAST attempt
  // on that slot succeeded; the ledger keeps no "ever succeeded" flag, so a
  // hotel whose slots are all currently failing may still have worked once.
  // Said plainly rather than papered over.
  console.log('\n── the attempt ledger: what was tried, and what came back ──');
  console.log(
    await sql(`
      WITH a AS (SELECT * FROM hotel WHERE is_active)
      SELECT line FROM (
        SELECT 1 AS ord, 'active hotels in the ledger       ' || count(DISTINCT c.hotel_id) AS line
          FROM collection_attempt c JOIN a ON a.id = c.hotel_id
        UNION ALL SELECT 2, '  with a slot succeeding now      ' || count(DISTINCT c.hotel_id)
          FROM collection_attempt c JOIN a ON a.id = c.hotel_id WHERE c.consecutive_failures = 0
        UNION ALL SELECT 3, '  every slot currently failing    ' || count(*)
          FROM (SELECT c.hotel_id FROM collection_attempt c JOIN a ON a.id = c.hotel_id
                 GROUP BY c.hotel_id HAVING min(c.consecutive_failures) > 0) x
        UNION ALL SELECT 4, 'NEVER attempted at all            ' || count(*)
          FROM a WHERE NOT EXISTS (SELECT 1 FROM collection_attempt c WHERE c.hotel_id = a.id)
        UNION ALL SELECT 5, '  of those, enrolled              ' || count(*)
          FROM a WHERE collection_tier <> 'OFF'
            AND NOT EXISTS (SELECT 1 FROM collection_attempt c WHERE c.hotel_id = a.id)
      ) t ORDER BY ord`),
  );

  console.log('\n── last outcome across every tracked slot ──');
  console.log(
    await sql(`
      SELECT rpad(COALESCE(c.last_outcome, '(none)'), 18) || lpad(count(*)::text, 7)
          || ' slot(s), ' || lpad(count(DISTINCT c.hotel_id)::text, 5) || ' hotel(s)'
        FROM collection_attempt c
        JOIN hotel h ON h.id = c.hotel_id AND h.is_active
       GROUP BY c.last_outcome
       ORDER BY count(*) DESC`),
  );

  // The window that actually exists right now, so nobody reads a five-day
  // table as a history.
  console.log('\n── the retained observation window (five days, by design) ──');
  console.log(
    await sql(`
      SELECT 'observations           ' || count(*)
          || ' over ' || count(DISTINCT observed_date) || ' day(s), '
          || COALESCE(min(observed_date)::text, 'none') || ' … '
          || COALESCE(max(observed_date)::text, 'none')
        FROM rate_observation
      UNION ALL
      SELECT 'active hotels observed ' || count(DISTINCT o.hotel_id)
        FROM rate_observation o JOIN hotel h ON h.id = o.hotel_id AND h.is_active`),
  );
  console.log(
    '\n(rate_observation is NOT a history: production drops partitions past five days.\n' +
      ' "Ever collected" is answered by rate_baseline and collection_attempt, above.)',
  );

  process.exit(0);
}

// What would enrolling more of the catalogue cost, and where would it pay?
//
// 2,964 active hotels sit at tier OFF — the ID-space sweep enrols what it finds
// at OFF by design — and that, not any qualification rule, is why 83% of the
// catalogue has no baseline. Moving hotels to WARM is the lever, and it is a
// budget decision, so it needs a per-hotel price and a ranked list of where the
// money buys the most.
//
// Cost is measured from the ledger rather than derived from the grid spec. The
// spec says 23 distinct lead times over three stay lengths, but what a hotel
// ACTUALLY costs depends on how many of its slots yield and how many fall into
// the HOT band (lead <= 30 days, refreshed every 6 hours) versus WARM (every
// 24). Counting real rows answers that; multiplying spec constants assumes it.
//
// Payoff is measured by DISTANCE, not by destination label — the same rule the
// competitive ladder uses. An OFF hotel is worth turning on when hotels that
// ALREADY have a baseline sit within the ladder's outer rung of it, because
// then it gains a comp set on its first successful collection instead of
// waiting for its neighbours to be enrolled too.
//
// Read-only.
const ENROLMENT_PLAN = process.argv.includes('--enrolment-plan');
if (ENROLMENT_PLAN) {
  console.log('\n── what one enrolled hotel actually costs (measured from the ledger) ──');
  console.log(
    await sql(`
      WITH per AS (
        SELECT c.hotel_id,
               count(*) AS slots,
               count(*) FILTER (WHERE c.lead_days <= 30) AS hot_slots,
               count(*) FILTER (WHERE c.lead_days > 30)  AS warm_slots
          FROM collection_attempt c
          JOIN hotel h ON h.id = c.hotel_id AND h.is_active AND h.collection_tier <> 'OFF'
         GROUP BY c.hotel_id
      )
      SELECT line FROM (
        SELECT 1 AS ord, 'enrolled hotels in the ledger     ' || count(*) AS line FROM per
        UNION ALL SELECT 2, 'median slots per hotel            ' ||
               percentile_disc(0.5) WITHIN GROUP (ORDER BY slots) FROM per
        UNION ALL SELECT 3, '  of those HOT (lead <= 30d)      ' ||
               percentile_disc(0.5) WITHIN GROUP (ORDER BY hot_slots) FROM per
        UNION ALL SELECT 4, '  of those WARM (lead > 30d)      ' ||
               percentile_disc(0.5) WITHIN GROUP (ORDER BY warm_slots) FROM per
        -- HOT refreshes every 6h (one per cycle); WARM every 24h (one in four
        -- cycles). This is the steady-state price, not the cold-fill price:
        -- a newly enrolled hotel pays its whole grid once, up front.
        UNION ALL SELECT 5, 'calls per hotel per 6h cycle      ~' ||
               round(percentile_disc(0.5) WITHIN GROUP (ORDER BY hot_slots)
                   + percentile_disc(0.5) WITHIN GROUP (ORDER BY warm_slots) / 4.0)
          FROM per
        UNION ALL SELECT 6, 'calls per hotel per DAY           ~' ||
               round(percentile_disc(0.5) WITHIN GROUP (ORDER BY hot_slots) * 4
                   + percentile_disc(0.5) WITHIN GROUP (ORDER BY warm_slots))
          FROM per
        UNION ALL SELECT 7, 'cold fill, one-off per hotel      ~' ||
               percentile_disc(0.5) WITHIN GROUP (ORDER BY slots) FROM per
      ) t ORDER BY ord`),
  );

  console.log('\n── where enrolling pays: OFF hotels by baselined neighbours within 5 mi ──');
  console.log(
    await sql(`
      WITH based AS (
        SELECT h.id, h.latitude::float8 AS lat, h.longitude::float8 AS lon
          FROM hotel h
         WHERE h.is_active
           AND h.latitude IS NOT NULL AND h.longitude IS NOT NULL
           AND h.bookable_online IS DISTINCT FROM false
           AND EXISTS (SELECT 1 FROM rate_baseline b
                        WHERE b.hotel_id = h.id AND b.baseline_level = 'L3')
      ),
      off_h AS (
        SELECT h.id, h.destination_id,
               h.latitude::float8 AS lat, h.longitude::float8 AS lon
          FROM hotel h
         WHERE h.is_active AND h.collection_tier = 'OFF'
           AND h.bookable_online IS DISTINCT FROM false
           AND h.latitude IS NOT NULL AND h.longitude IS NOT NULL
      ),
      n AS (
        SELECT o.id, o.destination_id, count(b.id) AS near
          FROM off_h o
          LEFT JOIN based b
            ON power(111.32 * (b.lat - o.lat), 2)
             + power(111.32 * cos(radians(o.lat)) * (b.lon - o.lon), 2) <= power(8.047, 2)
         GROUP BY o.id, o.destination_id
      )
      SELECT line FROM (
        SELECT 1 AS ord, 'OFF, bookable, placed             ' || count(*) AS line FROM n
        UNION ALL SELECT 2, '  >=3 baselined within 5 mi       ' || count(*) FROM n WHERE near >= 3
        UNION ALL SELECT 3, '  1-2 baselined within 5 mi       ' || count(*) FROM n WHERE near BETWEEN 1 AND 2
        UNION ALL SELECT 4, '  none within 5 mi                ' || count(*) FROM n WHERE near = 0
      ) t ORDER BY ord`),
  );

  console.log('\n── the shortlist: OFF hotels that would gain a comp set immediately ──');
  console.log(
    await sql(`
      WITH based AS (
        SELECT h.id, h.latitude::float8 AS lat, h.longitude::float8 AS lon
          FROM hotel h
         WHERE h.is_active
           AND h.latitude IS NOT NULL AND h.longitude IS NOT NULL
           AND h.bookable_online IS DISTINCT FROM false
           AND EXISTS (SELECT 1 FROM rate_baseline b
                        WHERE b.hotel_id = h.id AND b.baseline_level = 'L3')
      ),
      off_h AS (
        SELECT h.id, h.destination_id,
               h.latitude::float8 AS lat, h.longitude::float8 AS lon
          FROM hotel h
         WHERE h.is_active AND h.collection_tier = 'OFF'
           AND h.bookable_online IS DISTINCT FROM false
           AND h.latitude IS NOT NULL AND h.longitude IS NOT NULL
      ),
      n AS (
        SELECT o.id, o.destination_id, count(b.id) AS near
          FROM off_h o
          LEFT JOIN based b
            ON power(111.32 * (b.lat - o.lat), 2)
             + power(111.32 * cos(radians(o.lat)) * (b.lon - o.lon), 2) <= power(8.047, 2)
         GROUP BY o.id, o.destination_id
      )
      SELECT rpad(COALESCE(left(d.name, 30), '?'), 30)
          || ' | would-gain ' || lpad(count(*) FILTER (WHERE n.near >= 3)::text, 4)
          || ' | OFF here ' || lpad(count(*)::text, 4)
        FROM n LEFT JOIN destination d ON d.id = n.destination_id
       GROUP BY d.name
      HAVING count(*) FILTER (WHERE n.near >= 3) > 0
       ORDER BY count(*) FILTER (WHERE n.near >= 3) DESC
       LIMIT 25`),
  );
  console.log(
    '\n("would-gain" means >=3 already-baselined hotels sit within five miles, so the hotel\n' +
      ' gets a comp set on its FIRST successful collection. It is a lower bound on the\n' +
      ' payoff: enrolling a cluster together also lets its members comp each other.)',
  );

  process.exit(0);
}

const BROKEN = process.argv.includes('--broken');
if (BROKEN) {
  console.log('\n── hotels whose rate lookups keep failing ──');
  console.log(
    await sql(`
      SELECT h.wah_hotel_id || ' | ' || rpad(left(h.name, 38), 38)
          || ' | ' || rpad(COALESCE(left(d.name, 20), '?'), 20)
          || ' | failing slots=' || lpad(count(*)::text, 3)
          || ' | worst streak=' || lpad(max(a.consecutive_failures)::text, 3)
          || ' | last tried ' || to_char(max(a.last_attempt_at) AT TIME ZONE 'UTC', 'Mon DD HH24:MI')
        FROM collection_attempt a
        JOIN hotel h ON h.id = a.hotel_id
        LEFT JOIN destination d ON d.id = h.destination_id
       WHERE a.last_outcome = 'ERROR'
         AND a.consecutive_failures >= 2
       GROUP BY h.wah_hotel_id, h.name, d.name
      HAVING count(*) >= 2
       ORDER BY count(*) DESC, max(a.consecutive_failures) DESC
       LIMIT 80`),
  );
  console.log(
    '\n(A hotel failing across MANY slots is a broken mapping; one or two slots is ordinary sold-out noise.)',
  );
  process.exit(0);
}

// Read-only market probe. Answers, from the database itself, the question the
// API cannot: which hotels the comp-set CTE can even SEE around a subject, and
// what each of them holds for one stay. Exists because diagnosing this through
// the public API means guessing — comps_used says how many survived, never who
// was excluded or why.
const MARKET = process.argv.indexOf('--market');
if (MARKET !== -1) {
  const [wahId, checkIn, nights, adults] = process.argv.slice(MARKET + 1, MARKET + 5);
  if (!wahId || !checkIn || !nights || !adults) {
    console.error('usage: --market <wahHotelId> <checkIn> <nights> <adults>');
    process.exit(1);
  }
  console.log(`\n── market probe: hotel ${wahId}, ${checkIn} × ${nights}n × ${adults}a ──`);
  console.log(
    await sql(`
      SELECT 'subject: id=' || h.id || ' active=' || h.is_active || ' tier=' || h.collection_tier
          || ' dest_id=' || COALESCE(h.destination_id::text, 'NULL')
          || ' dest=' || COALESCE(d.slug, 'NULL')
          || ' lat=' || COALESCE(h.latitude::text, 'NULL')
          || ' lng=' || COALESCE(h.longitude::text, 'NULL')
          || ' curated_comps=' || (SELECT count(*) FROM hotel_comparable c WHERE c.hotel_id = h.id)
        FROM hotel h LEFT JOIN destination d ON d.id = h.destination_id
       WHERE h.wah_hotel_id = '${wahId.replace(/'/g, '')}'`),
  );
  // Which ring each candidate falls in, and — for the ones that do not make
  // the set — WHY. "Nearby hotels we found" was never the question; the
  // question is whether the comparison is against realistic alternatives, and
  // that is answered by the rejections as much as by the survivors.
  const RUNGS = [2, 3, 5];
  const KM = 1.609344;
  const q = (v) => String(v).replace(/'/g, '');
  const subj = `'${q(wahId)}'`;
  const stay = `o.check_in = '${q(checkIn)}'::date AND o.nights = ${Number(nights)} AND o.adults = ${Number(adults)}`;

  console.log(`\nradius ladder: primary ${RUNGS[0]} mi, then ${RUNGS.slice(1).join(' mi, ')} mi`);
  console.log('candidates, nearest first — ring, then why each is in or out:');
  console.log(
    await sql(`
      WITH s AS (
        SELECT id, destination_id, latitude, longitude FROM hotel WHERE wah_hotel_id = ${subj}
      ),
      cand AS (
        SELECT h.id, h.wah_hotel_id, h.name, h.is_active, h.bookable_online,
               h.google_rating, h.google_user_rating_count, h.city_rank,
               d.slug AS dest,
               CASE WHEN h.latitude IS NULL OR s.latitude IS NULL THEN NULL
                    ELSE sqrt(power(111.32 * (h.latitude - s.latitude)::float8, 2)
                            + power(111.32 * cos(radians(s.latitude::float8))
                                * (h.longitude - s.longitude)::float8, 2)) END AS km,
               (SELECT count(*) FROM rate_observation o
                 WHERE o.hotel_id = h.id AND ${stay}
                   AND o.observed_at >= now() - interval '24 hours') AS fresh,
               (SELECT o.is_available FROM rate_observation o
                 WHERE o.hotel_id = h.id AND ${stay}
                 ORDER BY o.observed_at DESC LIMIT 1) AS avail
          FROM hotel h JOIN s ON h.id <> s.id
          LEFT JOIN destination d ON d.id = h.destination_id
      )
      SELECT rpad(COALESCE(
               CASE WHEN km IS NULL THEN 'no-geo'
                    WHEN km <= ${RUNGS[0]} * ${KM} THEN '${RUNGS[0]}mi'
                    WHEN km <= ${RUNGS[1]} * ${KM} THEN '${RUNGS[1]}mi'
                    WHEN km <= ${RUNGS[2]} * ${KM} THEN '${RUNGS[2]}mi'
                    ELSE 'outside' END, '?'), 8)
          || rpad(wah_hotel_id, 7) || rpad(left(name, 30), 32)
          || rpad(COALESCE(round(km::numeric, 2)::text || 'km', '—'), 10)
          || rpad(CASE
               WHEN NOT is_active                 THEN 'OUT inactive'
               WHEN bookable_online IS false      THEN 'OUT not bookable online'
               WHEN km IS NULL                    THEN 'OUT no coordinates'
               WHEN km > ${RUNGS[2]} * ${KM}      THEN 'OUT beyond final rung'
               WHEN fresh = 0                     THEN 'OUT no rate inside 24h'
               WHEN avail IS NOT TRUE             THEN 'OUT rate not available'
               ELSE 'in  qualifies' END, 26)
          -- Context we HOLD, shown so the operator can judge the set. None of
          -- it selects or scores: filtering comparables on rating or price
          -- would raise the median and so raise the Deal Score by choosing
          -- the comparison. See tests/unit/competitive-radius.test.ts.
          || 'ctx rating=' || COALESCE(google_rating::text, '—')
          || '/' || COALESCE(google_user_rating_count::text, '—')
          || ' rank=' || COALESCE(city_rank::text, '—')
          || ' dest=' || COALESCE(dest, '—')
        FROM cand
       ORDER BY (km IS NULL), km, wah_hotel_id`),
  );

  console.log('\nring summary (qualifying candidates only):');
  console.log(
    await sql(`
      WITH s AS (
        SELECT id, latitude, longitude FROM hotel WHERE wah_hotel_id = ${subj}
      ),
      cand AS (
        SELECT CASE WHEN h.latitude IS NULL OR s.latitude IS NULL THEN NULL
                    ELSE sqrt(power(111.32 * (h.latitude - s.latitude)::float8, 2)
                            + power(111.32 * cos(radians(s.latitude::float8))
                                * (h.longitude - s.longitude)::float8, 2)) END AS km
          FROM hotel h JOIN s ON h.id <> s.id
         WHERE h.is_active AND h.bookable_online IS DISTINCT FROM false
           AND (SELECT count(*) FROM rate_observation o
                 WHERE o.hotel_id = h.id AND ${stay}
                   AND o.observed_at >= now() - interval '24 hours') > 0
           AND (SELECT o.is_available FROM rate_observation o
                 WHERE o.hotel_id = h.id AND ${stay}
                 ORDER BY o.observed_at DESC LIMIT 1) IS TRUE
      )
      SELECT 'within ' || rpad(label, 6) || lpad(n::text, 3) || ' qualified'
          || CASE WHEN n >= 3 THEN '   <- ladder stops here' ELSE '' END
        FROM (
          SELECT '${RUNGS[0]} mi' AS label, count(*) FILTER (WHERE km <= ${RUNGS[0]} * ${KM}) AS n, 1 AS o FROM cand
          UNION ALL SELECT '${RUNGS[1]} mi', count(*) FILTER (WHERE km <= ${RUNGS[1]} * ${KM}), 2 FROM cand
          UNION ALL SELECT '${RUNGS[2]} mi', count(*) FILTER (WHERE km <= ${RUNGS[2]} * ${KM}), 3 FROM cand
        ) t ORDER BY o`),
  );

  process.exit(0);
}

await measure('before');

if (SQUEEZE) {
  // Whole files back to the quota. TRUNCATE needs no free space, which is the
  // point: this works on a project where every INSERT and UPDATE fails.
  console.log('\nTRUNCATE rate_observation (baselines, analyses and the catalogue persist) …');
  await sql('TRUNCATE rate_observation');
  console.log('TRUNCATE ingest_reject …');
  await sql('TRUNCATE ingest_reject');

  // Apply pending migrations while the partitions are empty — 0015 swaps the
  // monthly partitions for daily ones, and refuses to run over data.
  console.log('Applying migrations (node scripts/migrate.mjs) …');
  const { stdout } = await run('node', ['scripts/migrate.mjs'], {
    maxBuffer: 16 * 1024 * 1024,
  });
  console.log(stdout.trim());

  await measure('after');
  console.log(
    '\nSqueeze done. Dispatch the collection workflow now — the grid refills ' +
      'over the next cycles, and on-demand scoring works as soon as a guest asks.',
  );
  process.exit(0);
}

if (!APPLY) {
  console.log('\nMeasure-only run. Re-run with --apply to reclaim.');
  process.exit(0);
}

// 1. Whole files back to the quota, no extension needed even when full.
console.log('\nTRUNCATE ingest_reject …');
await sql('TRUNCATE ingest_reject');

// 2. Old audit payloads — as a RATCHET, because on a genuinely full
// project even a modest UPDATE cannot extend a file. An UPDATE only adds
// new tuple versions; the space comes back when VACUUM reclaims the old
// ones and their TOASTed raw values. So: small batch, VACUUM the
// partition, grow the batch as headroom accumulates; on a size-limit
// error, halve and vacuum again. The first batches squeeze into whatever
// TRUNCATE just freed, and each round makes the next one roomier.
console.log(`Slimming raw older than ${KEEP_DAYS} days (adaptive batches, target ${BATCH}) …`);
const partitions = (
  await sql(`
    SELECT c.relname FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid
     WHERE i.inhparent = 'rate_observation'::regclass ORDER BY c.relname`)
)
  .split('\n')
  .filter(Boolean);

let total = 0;
let batch = 500;
let failures = 0;
for (;;) {
  let n = 0;
  try {
    const out = await sql(`
      WITH victims AS (
        SELECT id, observation_slot FROM rate_observation
         WHERE observation_slot < now() - interval '${KEEP_DAYS} days' AND raw IS NOT NULL
         LIMIT ${batch})
      UPDATE rate_observation o SET raw = NULL
        FROM victims v
       WHERE o.id = v.id AND o.observation_slot = v.observation_slot
      RETURNING 1`);
    n = out === '' ? 0 : out.split('\n').length;
  } catch (err) {
    if (String(err).includes('size limit')) {
      failures += 1;
      batch = Math.max(50, Math.floor(batch / 2));
      console.log(`  size limit hit — batch down to ${batch}, vacuuming …`);
      for (const part of partitions) await sql(`VACUUM ${part}`).catch(() => {});
      if (failures > 12)
        throw new Error('cannot reclaim: repeated size-limit failures at minimum batch');
      continue;
    }
    throw err;
  }
  total += n;
  console.log(`  batch of ${batch}: ${n} slimmed (total ${total})`);
  if (n === 0) break;
  // The ratchet: reclaim what this batch freed, then try a bigger bite.
  for (const part of partitions) await sql(`VACUUM ${part}`).catch(() => {});
  batch = Math.min(BATCH, batch * 2);
}

// 3. A final pass with ANALYZE so the planner sees the new shape.
console.log('VACUUM ANALYZE rate_observation …');
await sql('VACUUM ANALYZE rate_observation');

await measure('after');
console.log(
  '\nDone. Note: freed pages are reused by new writes; the project size figure itself shrinks only as files are truncated or rewritten.',
);
