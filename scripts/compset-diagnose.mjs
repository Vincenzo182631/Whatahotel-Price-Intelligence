#!/usr/bin/env node
/**
 * Comp-set diagnosis — why the Comp-Set Index has no competitors.
 *
 *   npm run diagnose:compset
 *   npm run diagnose:compset -- --stays 40
 *
 * The live-market model returns no score at all right now. The arithmetic is
 * not in doubt: the Comp-Set Index carries 45% of the live weight, so when it
 * is absent the remaining signals reach 0.55 coverage against a 0.60 floor and
 * `composeLiveScore` declines. What is in doubt is WHY it is absent, on hotels
 * that each have eight comparables on file.
 *
 * `findCompetitorRates` requires a competitor observation to match the subject
 * on all of: check-in, nights, adults, children, currency, comparability class,
 * availability, and an observation no older than `csi.maxCompAgeHours`. Any one
 * of those can empty the set, and the failure looks identical from outside.
 *
 * So this walks the funnel one filter at a time and reports where it collapses,
 * aggregated over many real stays rather than a single anecdote. A one-stay
 * answer would be a coincidence; the interesting question is which filter kills
 * the set MOST of the time.
 *
 * It also measures what each relaxation would recover — dropping audience from
 * the class key, then meal plan, then refundability — because the fix is a
 * different amount of work in each case:
 *
 *   · a threshold (minComps / maxCompAgeHours)   → config, minutes
 *   · the collection grid (comps lack the stay)  → more API spend, days
 *   · the comparability rule itself              → a scoring decision, and the
 *                                                  one that risks rule 5
 *
 * The relaxation numbers are DIAGNOSTIC, not a recommendation. Comparing a
 * breakfast-inclusive rate against a room-only one is exactly the merge this
 * project refuses to make. Knowing the cost of the rule is not an argument for
 * abandoning it — it is what lets the decision be made with the number in hand.
 *
 * Read-only. Issues SELECTs and writes nothing. Safe against production.
 */

import { closePool, getPool } from '../packages/data/dist/index.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const STAY_LIMIT = Math.max(1, Number(arg('stays', 30)));

// Mirrors findCompetitorRates: one more than needed so a single stale comp
// does not drop the set below the minimum.
const COMP_LIMIT = 8;
const MIN_COMPS = 3;
const MAX_COMP_AGE_HOURS = 24;

/**
 * Subject stays to diagnose.
 *
 * One per (hotel, check-in) so the sample spreads across the grid rather than
 * piling onto whichever stay happens to carry the most rows. The subject's own
 * class is the cheapest fresh available rate it has — an approximation of what
 * `loadLiveIntelligence` would choose, and close enough to ask the comp-set
 * question against.
 */
const SUBJECT_QUERY = `
  SELECT DISTINCT ON (h.id, ro.check_in)
         h.id            AS hotel_id,
         h.wah_hotel_id,
         h.name,
         ro.check_in,
         ro.nights,
         ro.adults,
         ro.children,
         ro.currency,
         ro.comparability_class
    FROM rate_observation ro
    JOIN hotel h ON h.id = ro.hotel_id
   WHERE ro.is_available
     AND ro.check_in > current_date
     AND ro.observed_at >= now() - ($1 || ' hours')::interval
     AND ro.comparability_class <> 'UNRESOLVED'
   ORDER BY h.id, ro.check_in, ro.nightly_amount_minor
   LIMIT $2
`;

/**
 * The funnel, as one query per subject stay.
 *
 * Each column is the count of DISTINCT competitor hotels surviving one more
 * filter, in the order findCompetitorRates applies them. Counting hotels
 * rather than rows is the point: three rows from one hotel is still one
 * competitor, and a median over it is one hotel wearing a statistic's clothing.
 */
const FUNNEL_QUERY = `
  WITH comps AS (
    SELECT c.comparable_id AS hotel_id
      FROM hotel_comparable c
     WHERE c.hotel_id = $1
     ORDER BY c.rank
     LIMIT ${COMP_LIMIT}
  ),
  obs AS (
    SELECT o.hotel_id, o.comparability_class, o.is_available, o.observed_at
      FROM rate_observation o
      JOIN comps ON comps.hotel_id = o.hotel_id
     WHERE o.check_in = $2::date AND o.nights = $3
       AND o.adults = $4 AND o.children = $5 AND o.currency = $6
  ),
  fresh AS (
    SELECT * FROM obs
     WHERE is_available
       AND observed_at >= now() - ($8 || ' hours')::interval
  )
  SELECT
    (SELECT count(*) FROM comps)                                   AS comps_on_file,
    (SELECT count(DISTINCT hotel_id) FROM obs)                     AS with_any_rate,
    (SELECT count(DISTINCT hotel_id) FROM obs WHERE is_available)  AS available,
    (SELECT count(DISTINCT hotel_id) FROM fresh)                   AS fresh,
    (SELECT count(DISTINCT hotel_id) FROM fresh
      WHERE comparability_class = $7)                              AS in_class,
    -- Relaxations, each dropping one dimension of meal|refund|audience.
    (SELECT count(DISTINCT hotel_id) FROM fresh
      WHERE split_part(comparability_class,'|',1) = split_part($7,'|',1)
        AND split_part(comparability_class,'|',2) = split_part($7,'|',2))
                                                                   AS ignoring_audience,
    (SELECT count(DISTINCT hotel_id) FROM fresh
      WHERE split_part(comparability_class,'|',2) = split_part($7,'|',2)
        AND split_part(comparability_class,'|',3) = split_part($7,'|',3))
                                                                   AS ignoring_meal,
    (SELECT count(DISTINCT hotel_id) FROM fresh
      WHERE split_part(comparability_class,'|',1) = split_part($7,'|',1)
        AND split_part(comparability_class,'|',3) = split_part($7,'|',3))
                                                                   AS ignoring_refund
`;

/** How comparability classes actually distribute across the whole population. */
const CLASS_SPREAD_QUERY = `
  SELECT comparability_class,
         count(DISTINCT hotel_id)                        AS hotels,
         count(*)                                        AS observations
    FROM rate_observation
   WHERE is_available
     AND check_in > current_date
     AND observed_at >= now() - ($1 || ' hours')::interval
   GROUP BY comparability_class
   ORDER BY observations DESC
`;

const pct = (n, d) => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);

function bar(value, max, width = 24) {
  if (max === 0) return '';
  return '█'.repeat(Math.max(0, Math.round((value / max) * width)));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — this reads real data or it reads nothing.');
    process.exit(2);
  }

  const db = getPool();

  console.log('Comp-set diagnosis\n');
  console.log(
    `Rules in force: minComps ${MIN_COMPS}, maxCompAgeHours ${MAX_COMP_AGE_HOURS}, ` +
      `comp limit ${COMP_LIMIT}\n`,
  );

  const { rows: subjects } = await db.query(SUBJECT_QUERY, [MAX_COMP_AGE_HOURS, STAY_LIMIT]);
  if (subjects.length === 0) {
    console.error('No fresh, available, classified subject stay found — nothing to diagnose.');
    await closePool();
    process.exit(1);
  }

  const totals = {
    comps_on_file: 0,
    with_any_rate: 0,
    available: 0,
    fresh: 0,
    in_class: 0,
    ignoring_audience: 0,
    ignoring_meal: 0,
    ignoring_refund: 0,
  };
  // A stay "passes" when it would actually produce a Comp-Set Index.
  const passes = { in_class: 0, ignoring_audience: 0, ignoring_meal: 0, ignoring_refund: 0 };

  for (const s of subjects) {
    const checkIn = s.check_in.toISOString().slice(0, 10);
    const { rows } = await db.query(FUNNEL_QUERY, [
      s.hotel_id,
      checkIn,
      s.nights,
      s.adults,
      s.children,
      s.currency,
      s.comparability_class,
      MAX_COMP_AGE_HOURS,
    ]);
    const r = rows[0];
    for (const k of Object.keys(totals)) totals[k] += Number(r[k]);
    for (const k of Object.keys(passes)) if (Number(r[k]) >= MIN_COMPS) passes[k] += 1;
  }

  const n = subjects.length;
  const avg = (k) => (totals[k] / n).toFixed(1);

  console.log(`Sampled ${n} subject stay(s), one per hotel and check-in date.\n`);

  console.log('THE FUNNEL — average competitor hotels surviving each filter');
  console.log('(the production query applies these in this order)\n');
  const steps = [
    ['comparables on file', 'comps_on_file'],
    ['…with any rate for this exact stay', 'with_any_rate'],
    ['…that rate is available', 'available'],
    [`…observed within ${MAX_COMP_AGE_HOURS}h`, 'fresh'],
    ['…in the same comparability class', 'in_class'],
  ];
  const max = totals.comps_on_file / n;
  for (const [labelText, key] of steps) {
    const v = Number(avg(key));
    console.log(
      `  ${labelText.padEnd(38)} ${String(v).padStart(5)}  ${bar(v, max)}  ` +
        `${pct(totals[key], totals.comps_on_file)} of comps`,
    );
  }

  console.log(`\n  Stays that reach minComps (${MIN_COMPS}): ` +
    `${passes.in_class}/${n}  (${pct(passes.in_class, n)})\n`);

  console.log('WHAT EACH RELAXATION WOULD RECOVER');
  console.log('(diagnostic only — see the header; relaxing the class key risks rule 5)\n');
  for (const [labelText, key] of [
    ['as-is (meal | refund | audience)', 'in_class'],
    ['ignoring audience', 'ignoring_audience'],
    ['ignoring meal plan', 'ignoring_meal'],
    ['ignoring refundability', 'ignoring_refund'],
  ]) {
    console.log(
      `  ${labelText.padEnd(38)} ${avg(key).padStart(5)} comps  ` +
        `· ${String(passes[key]).padStart(3)}/${n} stays qualify (${pct(passes[key], n)})`,
    );
  }

  const { rows: spread } = await db.query(CLASS_SPREAD_QUERY, [MAX_COMP_AGE_HOURS]);
  console.log('\nCOMPARABILITY CLASSES ACROSS ALL FRESH RATES\n');
  const totalObs = spread.reduce((sum, r) => sum + Number(r.observations), 0);
  for (const r of spread.slice(0, 12)) {
    console.log(
      `  ${String(r.comparability_class).padEnd(42)} ` +
        `${String(r.hotels).padStart(3)} hotel(s)  ` +
        `${String(r.observations).padStart(6)} rate(s)  ${pct(Number(r.observations), totalObs)}`,
    );
  }
  if (spread.length > 12) console.log(`  … and ${spread.length - 12} more class(es)`);

  // ── the reading ────────────────────────────────────────────────────────
  // Name the collapsing step rather than leaving it to be eyeballed. The
  // biggest proportional drop is the one worth fixing; anything else is
  // optimizing a filter that was not the constraint.
  console.log('\nWHERE IT COLLAPSES\n');
  let prev = totals.comps_on_file;
  let worst = { label: null, lost: 0 };
  for (const [labelText, key] of steps.slice(1)) {
    const lost = prev - totals[key];
    if (lost > worst.lost) worst = { label: labelText, lost };
    prev = totals[key];
  }
  if (worst.label === null || worst.lost === 0) {
    console.log('  No single filter dominates — the set is thin from the start.');
  } else {
    console.log(
      `  Largest single loss: "${worst.label.replace(/^…/, '')}" ` +
        `— ${worst.lost} competitor-slot(s) across ${n} stay(s), ` +
        `${pct(worst.lost, totals.comps_on_file)} of all comparables on file.`,
    );
  }

  await closePool();
}

main().catch((err) => {
  // Never print the error object: a pg connection error can carry the
  // connection string, and this runs in CI where logs are retained.
  console.error(`Diagnosis failed: ${err?.message ?? err}`);
  closePool().finally(() => process.exit(1));
});
