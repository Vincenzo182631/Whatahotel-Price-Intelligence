#!/usr/bin/env node
/**
 * Comp-set key study — could a cross-hotel comparability key exist at all?
 *
 *   npm run diagnose:keys
 *
 * `npm run diagnose:compset` established WHERE the Comp-Set Index dies: every
 * competitor survives to the comparability-class filter and none survives it,
 * on 40 of 40 stays. The cause is structural rather than a threshold — the
 * class in production is `WAH:<rateCode>|<offer text>`, the source's own plan
 * identity, which is hotel-specific by construction. A rate code cannot match
 * across hotels, so a key built on it cannot either.
 *
 * That key was a deliberate choice (see adapters/whatahotel/parse.ts): the
 * payload states cancellation terms for only some offers, so the semantic class
 * would resolve to UNRESOLVED for the rest and doc 01 §4 excludes unresolved
 * rates from every baseline. Within a hotel the choice is sound and baselines
 * work. The Comp-Set Index is the one consumer that needs the key to match
 * ACROSS hotels, and for it the key is not strict — it is impossible.
 *
 * So the question this answers is not "should we relax the rule" but "is there
 * any key that both means something and actually matches across hotels?" It
 * measures four candidates against real data, from most to least conservative:
 *
 *   1. CURRENT   — `WAH:code|offer`, the baseline for comparison.
 *   2. STORED    — meal × refund × audience from the columns already ingested.
 *                  Costs nothing; the terms are in `rate_plan` today.
 *   3. ENRICHED  — the same, but reading breakfast and prepay tokens out of the
 *                  offer text the parser currently discards. A parser change.
 *   4. TOLERANT  — ENRICHED, but an UNKNOWN dimension matches other UNKNOWNs
 *                  instead of poisoning the key to UNRESOLVED.
 *
 * (4) is the one to think hardest about. Comparing two rates whose
 * refundability is equally unknown is NOT the same error as comparing a known
 * refundable rate to a known non-refundable one: the first is honest about its
 * own uncertainty, the second is a false equivalence. It is still weaker than a
 * resolved match, and anything built on it should carry lower confidence rather
 * than pretend otherwise. This script measures it; it does not endorse it.
 *
 * Read-only. SELECTs only. Safe against production.
 */

import { closePool, getPool } from '../packages/data/dist/index.js';

const MIN_COMPS = 3;
const MAX_COMP_AGE_HOURS = 24;
const COMP_LIMIT = 8;

/**
 * Fresh, bookable rates with the terms the pipeline stored and the offer text
 * it classified from. `display_name` is the prose the source used; the current
 * class is built from it, so whatever meaning it carries is already on hand.
 */
const ROWS_QUERY = `
  SELECT o.hotel_id,
         to_char(o.check_in,'YYYY-MM-DD') AS check_in,
         o.nights, o.adults, o.children, o.currency,
         o.comparability_class,
         rp.display_name,
         rp.meal_plan,
         rp.refund_policy,
         rp.audience,
         rp.is_prepaid
    FROM rate_observation o
    JOIN rate_plan rp ON rp.id = o.rate_plan_id
   WHERE o.is_available
     AND o.check_in > current_date
     AND o.observed_at >= now() - ($1 || ' hours')::interval
`;

const COMPS_QUERY = `
  SELECT hotel_id, comparable_id, rank FROM hotel_comparable ORDER BY hotel_id, rank
`;

// ── key builders ─────────────────────────────────────────────────────────
// Tokens are matched against the offer text the source itself wrote. They are
// deliberately narrow: a term is read only where the text states it. Absence of
// a token means "not stated", never "not included" — the same distinction rule 9
// makes for unmeasurable factors.

const BREAKFAST = /\b(BKFST|BREAKFAST|B_?FAST|W_BKFST|INCL_BKFST)\b/;
const NON_REFUNDABLE =
  /\b(NON_?REFUNDABLE|NONREF|NON_?CHANGEABLE|PREPAY_IN_FULL|ADVANCE_PURCHASE|PREPAY)\b/;
const REFUNDABLE = /\b(FLEXIBLE|FULLY_?REFUNDABLE|FREE_?CANCEL\w*)\b/;

function storedKey(r) {
  return `${r.meal_plan}|${r.refund_policy}|${r.audience}`;
}

function enrichedTerms(r) {
  const text = `${r.display_name ?? ''} ${r.comparability_class ?? ''}`.toUpperCase();
  const meal = BREAKFAST.test(text) ? 'BREAKFAST' : r.meal_plan === 'UNKNOWN' ? 'UNKNOWN' : 'ROOM_ONLY';
  let refund = r.refund_policy;
  if (refund === 'UNKNOWN') {
    if (NON_REFUNDABLE.test(text)) refund = 'NON_REFUNDABLE';
    else if (REFUNDABLE.test(text)) refund = 'REFUNDABLE';
  }
  if (refund === 'UNKNOWN' && r.is_prepaid === true) refund = 'NON_REFUNDABLE';
  return { meal, refund, audience: r.audience };
}

function enrichedKey(r) {
  const t = enrichedTerms(r);
  // Strict: an unresolved dimension poisons the key, matching current policy.
  if (t.meal === 'UNKNOWN' || t.refund === 'UNKNOWN' || t.audience === 'UNKNOWN') return null;
  return `${t.meal}|${t.refund}|${t.audience}`;
}

function tolerantKey(r) {
  const t = enrichedTerms(r);
  // Tolerant: UNKNOWN is a bucket, not a poison. Two equally-unknown rates
  // match each other; a known one never matches an unknown one.
  return `${t.meal}|${t.refund}|${t.audience}`;
}

const KEYS = [
  ['CURRENT   (WAH:code|offer)', (r) => r.comparability_class],
  ['STORED    (meal|refund|audience)', (r) => (storedKey(r).includes('UNKNOWN') ? null : storedKey(r))],
  ['ENRICHED  (+ offer-text tokens)', enrichedKey],
  ['TOLERANT  (UNKNOWN matches UNKNOWN)', tolerantKey],
];

const pct = (n, d) => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);
const stayId = (r) => `${r.check_in}|${r.nights}|${r.adults}|${r.children}|${r.currency}`;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — this reads real data or it reads nothing.');
    process.exit(2);
  }

  const db = getPool();
  const [{ rows }, { rows: compRows }] = await Promise.all([
    db.query(ROWS_QUERY, [MAX_COMP_AGE_HOURS]),
    db.query(COMPS_QUERY),
  ]);

  console.log('Comp-set key study\n');
  console.log(`${rows.length} fresh bookable rate(s) across ${new Set(rows.map((r) => r.hotel_id)).size} hotel(s)\n`);

  if (rows.length === 0) {
    console.error('No fresh bookable rates — nothing to study.');
    await closePool();
    process.exit(1);
  }

  // Comparable hotels, capped exactly as findCompetitorRates caps them.
  const comps = new Map();
  for (const c of compRows) {
    const list = comps.get(c.hotel_id) ?? [];
    if (list.length < COMP_LIMIT) list.push(c.comparable_id);
    comps.set(c.hotel_id, list);
  }

  for (const [label, keyOf] of KEYS) {
    // stay → key → set of hotels offering it
    const index = new Map();
    for (const r of rows) {
      const key = keyOf(r);
      if (key === null || key === undefined || key === 'UNRESOLVED') continue;
      const s = stayId(r);
      if (!index.has(s)) index.set(s, new Map());
      const byKey = index.get(s);
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key).add(r.hotel_id);
    }

    // One subject per (hotel, stay) that actually has a rate under this key.
    let subjects = 0;
    let qualified = 0;
    let compTotal = 0;
    const distinctKeys = new Set();

    for (const byKey of index.values()) {
      for (const [key, hotels] of byKey) {
        distinctKeys.add(key);
        for (const subject of hotels) {
          const allowed = comps.get(subject);
          if (!allowed || allowed.length === 0) continue;
          subjects += 1;
          // Competitors are hotels on the subject's comp list that offer the
          // same key for the same stay. Distinct hotels, never rows.
          const n = allowed.filter((c) => c !== subject && hotels.has(c)).length;
          compTotal += n;
          if (n >= MIN_COMPS) qualified += 1;
        }
      }
    }

    console.log(`${label}`);
    console.log(
      `    ${String(distinctKeys.size).padStart(4)} distinct key(s) · ` +
        `${(compTotal / Math.max(1, subjects)).toFixed(1)} competitor(s) per subject · ` +
        `${qualified}/${subjects} reach minComps ${MIN_COMPS} (${pct(qualified, subjects)})`,
    );
  }

  // ── what the offer text actually yields ────────────────────────────────
  console.log('\nWHAT THE OFFER TEXT YIELDS (per distinct rate plan)\n');
  const seen = new Map();
  for (const r of rows) {
    const k = `${r.hotel_id}|${r.display_name}|${r.comparability_class}`;
    if (!seen.has(k)) seen.set(k, r);
  }
  const plans = [...seen.values()];
  const tally = { breakfastStated: 0, refundStated: 0, bothStated: 0, neither: 0 };
  for (const r of plans) {
    const t = enrichedTerms(r);
    const b = t.meal === 'BREAKFAST';
    const f = t.refund !== 'UNKNOWN';
    if (b) tally.breakfastStated += 1;
    if (f) tally.refundStated += 1;
    if (b && f) tally.bothStated += 1;
    if (!b && !f) tally.neither += 1;
  }
  console.log(`  ${plans.length} distinct rate plan(s) examined`);
  console.log(`    breakfast stated in the text   ${String(tally.breakfastStated).padStart(4)}  ${pct(tally.breakfastStated, plans.length)}`);
  console.log(`    refundability stated           ${String(tally.refundStated).padStart(4)}  ${pct(tally.refundStated, plans.length)}`);
  console.log(`    both                           ${String(tally.bothStated).padStart(4)}  ${pct(tally.bothStated, plans.length)}`);
  console.log(`    neither                        ${String(tally.neither).padStart(4)}  ${pct(tally.neither, plans.length)}`);

  console.log('\nSTORED TERM DISTRIBUTION (what the pipeline ingested)\n');
  const storedTally = new Map();
  for (const r of plans) {
    const k = storedKey(r);
    storedTally.set(k, (storedTally.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...storedTally].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(46)} ${String(n).padStart(4)} plan(s)  ${pct(n, plans.length)}`);
  }

  await closePool();
}

main().catch((err) => {
  console.error(`Key study failed: ${err?.message ?? err}`);
  closePool().finally(() => process.exit(1));
});
