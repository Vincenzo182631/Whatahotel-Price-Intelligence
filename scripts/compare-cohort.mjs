#!/usr/bin/env node
/**
 * Score a FIXED cohort of hotels against a running API, for before/after.
 *
 *   COHORT_BASE=https://… node scripts/compare-cohort.mjs --out before.json
 *   COHORT_BASE=https://… node scripts/compare-cohort.mjs --out after.json
 *   node scripts/compare-cohort.mjs --diff before.json after.json
 *
 * Why fixed rather than sampled: a change to comparable selection can only be
 * judged by asking the SAME hotels on the SAME dates before and after. The
 * existing probe picks its own targets deliberately — that is the right design
 * for "does anything break", and the wrong one for "did this change help".
 *
 * Read-only against the API. Writes nothing but the report file.
 *
 * The cohort is luxury properties across dense and sparse markets both, since
 * a radius change cuts hardest where hotels are thin on the ground and a
 * city-only cohort would flatter it.
 */

import { COHORT } from './cohort-fixture.mjs';
const CHECK_IN = process.env.COHORT_CHECK_IN ?? '2026-09-15';
const CHECK_OUT = process.env.COHORT_CHECK_OUT ?? '2026-09-17';
const ADULTS = process.env.COHORT_ADULTS ?? '2';

const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const fmt = (n, w) => String(n ?? '—').padStart(w);

/** One row per hotel: what the response said, flattened. */
function summarise(id, body) {
  const cs = body?.signals?.comp_set ?? {};
  return {
    hotel: id,
    mode: body?.intelligence_mode ?? null,
    score: body?.verdict?.out_of_ten ?? null,
    band: body?.verdict?.band ?? null,
    confidence: body?.verdict?.confidence ?? body?.confidence ?? null,
    comps: cs.comps_used ?? null,
    basis: cs.basis ?? null,
    roomMatch: cs.room_match ?? null,
    termsBasis: cs.terms_basis ?? null,
    // Absent on any build before config v8 — that absence is itself the
    // marker that a report came from the old selection.
    radiusMiles: cs.competitive_radius_miles ?? null,
    radiusExpanded: cs.radius_expanded ?? null,
    csi: cs.index ?? null,
  };
}

async function collect(base) {
  const rows = [];
  for (const id of COHORT) {
    const url =
      `${base}/api/v1/live-intelligence?hotel_id=${id}` +
      `&check_in=${CHECK_IN}&check_out=${CHECK_OUT}&adults=${ADULTS}`;
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        rows.push({ hotel: id, mode: `HTTP_${res.status}`, error: body?.error?.code ?? null });
        continue;
      }
      rows.push(summarise(id, body));
    } catch (err) {
      rows.push({ hotel: id, mode: 'FETCH_FAILED', error: String(err).slice(0, 60) });
    }
  }
  return rows;
}

function tally(rows) {
  const t = { scored: 0, hotelValue: 0, LOW: 0, MEDIUM: 0, HIGH: 0, expanded: 0, errors: 0 };
  for (const r of rows) {
    if (r.mode?.startsWith('HTTP') || r.mode === 'FETCH_FAILED') t.errors += 1;
    else if (r.score != null) t.scored += 1;
    if (r.mode === 'HOTEL_VALUE') t.hotelValue += 1;
    if (r.confidence && t[r.confidence] !== undefined) t[r.confidence] += 1;
    if (r.radiusExpanded) t.expanded += 1;
  }
  return t;
}

function printRows(rows) {
  console.log(
    `${'hotel'.padStart(6)} ${'mode'.padEnd(12)} ${'score'.padStart(5)} ` +
      `${'conf'.padEnd(6)} ${'comps'.padStart(5)} ${'radius'.padStart(6)} ` +
      `${'terms'.padEnd(11)} ${'room'.padEnd(15)} basis`,
  );
  for (const r of rows) {
    console.log(
      `${fmt(r.hotel, 6)} ${(r.mode ?? '—').padEnd(12)} ${fmt(r.score, 5)} ` +
        `${(r.confidence ?? '—').padEnd(6)} ${fmt(r.comps, 5)} ` +
        `${fmt(r.radiusMiles == null ? '—' : `${r.radiusMiles}mi${r.radiusExpanded ? '+' : ''}`, 6)} ` +
        `${(r.termsBasis ?? '—').padEnd(11)} ${(r.roomMatch ?? '—').padEnd(15)} ${r.basis ?? '—'}`,
    );
  }
}

// ── diff mode ─────────────────────────────────────────────────────────────
const diffA = value('--diff');
if (diffA) {
  const { readFileSync } = await import('node:fs');
  const before = JSON.parse(readFileSync(diffA, 'utf8'));
  const after = JSON.parse(readFileSync(args[args.indexOf('--diff') + 2], 'utf8'));
  const byId = new Map(after.rows.map((r) => [r.hotel, r]));

  console.log('\n── per hotel ──');
  console.log(
    `${'hotel'.padStart(6)} ${'score'.padEnd(13)} ${'conf'.padEnd(17)} ` +
      `${'comps'.padEnd(11)} radius`,
  );
  let moved = 0;
  let lost = 0;
  let gained = 0;
  for (const b of before.rows) {
    const a = byId.get(b.hotel);
    if (!a) continue;
    const scoreMoved = b.score !== a.score;
    if (scoreMoved) moved += 1;
    if (b.score != null && a.score == null) lost += 1;
    if (b.score == null && a.score != null) gained += 1;
    console.log(
      `${fmt(b.hotel, 6)} ${`${b.score ?? '—'} → ${a.score ?? '—'}`.padEnd(13)} ` +
        `${`${b.confidence ?? '—'} → ${a.confidence ?? '—'}`.padEnd(17)} ` +
        `${`${b.comps ?? '—'} → ${a.comps ?? '—'}`.padEnd(11)} ` +
        `${a.radiusMiles == null ? '—' : `${a.radiusMiles}mi${a.radiusExpanded ? ' (expanded)' : ''}`}`,
    );
  }

  const tb = tally(before.rows);
  const ta = tally(after.rows);
  console.log('\n── totals ──');
  for (const k of ['scored', 'hotelValue', 'HIGH', 'MEDIUM', 'LOW', 'expanded', 'errors']) {
    console.log(`  ${k.padEnd(11)} ${fmt(tb[k], 4)} → ${fmt(ta[k], 4)}`);
  }
  console.log(`\n  scores changed: ${moved}   lost a score: ${lost}   gained a score: ${gained}`);
  process.exit(0);
}

// ── collect mode ──────────────────────────────────────────────────────────
const base = process.env.COHORT_BASE ?? 'http://localhost:3000';
console.log(`cohort of ${COHORT.length} against ${base}`);
console.log(`stay ${CHECK_IN} → ${CHECK_OUT}, ${ADULTS} adults\n`);
const rows = await collect(base);
printRows(rows);
console.log('\n── totals ──', JSON.stringify(tally(rows)));

const out = value('--out');
if (out) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    out,
    JSON.stringify({ base, checkIn: CHECK_IN, checkOut: CHECK_OUT, adults: ADULTS, rows }, null, 2),
  );
  console.log(`\nwrote ${out}`);
}
