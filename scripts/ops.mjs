#!/usr/bin/env node
/**
 * Operations CLI for the daily health checkpoint. Wraps the read-and-compute
 * side of the runbook so a checkpoint is a handful of one-liners instead of
 * ad-hoc jq and regex each morning.
 *
 *   npm run ops -- runs <actions-list.json> [--since ISO] [--gap-hours 2.5] [--cadence-hours 2]
 *   npm run ops -- log <collect.log | collect-log-*.zip | https://…zip>
 *   npm run ops -- score <hotel_id> [--stay 2026-09-15:2026-09-18] [--adults 2] [--base URL]
 *   npm run ops -- cohort [--out file.json] [--diff baseline.json] [--stay A:B] [--adults 2] [--conc 6] [--base URL]
 *
 * What each does:
 *   runs    Delivery report from a GitHub actions list result (the JSON the
 *           API returns for workflow runs). Counts schedule vs dispatch,
 *           computes the gap between consecutive starts, flags failures and
 *           an over-threshold current gap ("dispatch now" signal).
 *   log     Summarises a collect run's log: capacity line, backlog, upstream
 *           500 count, ingest/baselines/comparables, DB-limit failures.
 *           Accepts the raw log, the run's artifact zip, or the artifact's
 *           download URL.
 *   score   One live-intelligence probe, printed as a cohort row.
 *   cohort  The fixed 32-hotel cohort, fetched CONCURRENTLY with a 90s
 *           per-request abort — the sequential compare-cohort.mjs times out
 *           when the upstream hangs (mass-500 outages); this one does not.
 *           --diff prints per-hotel movement against a previous --out file.
 *
 * Read-only against the API and the filesystem paths it is given. Workflow
 * DISPATCH is deliberately not here: this container holds no GitHub token,
 * and the collect/db-maintain workflows are triggered through the GitHub
 * tooling that does the authentication.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { COHORT } from './cohort-fixture.mjs';

const args = process.argv.slice(2);
const cmd = args.shift();
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const fmt = (n, w) => String(n ?? '—').padStart(w);

const BASE = value(
  '--base',
  process.env.COHORT_BASE ?? 'https://whatahotel-price-intelligence-api.vercel.app',
);
const stay = (value('--stay', '2026-09-15:2026-09-18') ?? '').split(':');
const CHECK_IN = process.env.COHORT_CHECK_IN ?? stay[0];
const CHECK_OUT = process.env.COHORT_CHECK_OUT ?? stay[1];
const ADULTS = value('--adults', process.env.COHORT_ADULTS ?? '2');

// ── shared: one live-intelligence row ─────────────────────────────────────

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
    radiusMiles: cs.competitive_radius_miles ?? null,
    radiusExpanded: cs.radius_expanded ?? null,
    csi: cs.index ?? null,
  };
}

async function probe(id) {
  const url =
    `${BASE}/api/v1/live-intelligence?hotel_id=${id}` +
    `&check_in=${CHECK_IN}&check_out=${CHECK_OUT}&adults=${ADULTS}`;
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(90_000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { hotel: id, mode: `HTTP_${res.status}`, error: body?.error?.code ?? null };
    return summarise(id, body);
  } catch (err) {
    return { hotel: id, mode: 'FETCH_FAILED', error: String(err).slice(0, 60) };
  }
}

function printRows(rows) {
  console.log(`\n hotel mode         score conf   comps radius terms       room            basis`);
  for (const r of rows) {
    console.log(
      `${fmt(r.hotel, 6)} ${(r.mode ?? '—').padEnd(15)} ${fmt(r.score, 5)} ` +
        `${(r.confidence ?? '—').padEnd(6)} ${fmt(r.comps, 5)} ` +
        `${fmt(r.radiusMiles == null ? '—' : `${r.radiusMiles}mi${r.radiusExpanded ? '+' : ''}`, 6)} ` +
        `${(r.termsBasis ?? '—').padEnd(11)} ${(r.roomMatch ?? '—').padEnd(15)} ${r.basis ?? '—'}`,
    );
  }
}

function tally(rows) {
  const t = { scored: 0, hotelValue: 0, LOW: 0, MEDIUM: 0, HIGH: 0, expanded: 0, errors: 0 };
  for (const r of rows) {
    if (r.score != null) t.scored += 1;
    if (r.mode === 'HOTEL_VALUE') t.hotelValue += 1;
    if (r.confidence && t[r.confidence] != null) t[r.confidence] += 1;
    if (r.radiusExpanded) t.expanded += 1;
    if (r.mode?.startsWith('HTTP_') || r.mode === 'FETCH_FAILED') t.errors += 1;
  }
  return t;
}

// ── runs: delivery report from an actions list result ─────────────────────

export function deliveryReport(
  listing,
  { since, gapHours = 2.5, cadenceHours = 2, now = new Date() } = {},
) {
  const runs = (listing.workflow_runs ?? [])
    .filter((r) => !since || r.run_started_at >= since)
    .sort((a, b) => a.run_started_at.localeCompare(b.run_started_at));
  const rows = [];
  let prev = null;
  for (const r of runs) {
    const started = new Date(r.run_started_at);
    const gapH = prev ? (started - prev) / 3_600_000 : null;
    rows.push({
      started: r.run_started_at,
      event: r.event,
      conclusion: r.status === 'completed' ? r.conclusion : r.status,
      id: r.id,
      gapH: gapH == null ? null : Number(gapH.toFixed(1)),
    });
    prev = started;
  }
  const schedule = rows.filter((r) => r.event === 'schedule').length;
  const dispatch = rows.filter((r) => r.event === 'workflow_dispatch').length;
  const failed = rows.filter((r) => r.conclusion !== 'success' && r.conclusion !== 'in_progress');
  const windowH = rows.length && (now - new Date(rows[0].started)) / 3_600_000;
  const expected = windowH ? Math.round(windowH / cadenceHours) : null;
  const currentGapH = prev ? Number(((now - prev) / 3_600_000).toFixed(1)) : null;
  return {
    rows,
    schedule,
    dispatch,
    failed,
    expected,
    currentGapH,
    stale: currentGapH != null && currentGapH > gapHours,
  };
}

function cmdRuns() {
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) throw new Error('usage: ops runs <actions-list.json> [--since ISO]');
  const listing = JSON.parse(readFileSync(file, 'utf8'));
  const r = deliveryReport(listing, {
    since: value('--since'),
    gapHours: Number(value('--gap-hours', '2.5')),
    cadenceHours: Number(value('--cadence-hours', '2')),
  });
  console.log('\n started               event              outcome     gap    id');
  for (const row of r.rows) {
    console.log(
      ` ${row.started}  ${row.event.padEnd(17)}  ${String(row.conclusion).padEnd(10)} ${fmt(row.gapH == null ? '—' : `${row.gapH}h`, 6)}  ${row.id}`,
    );
  }
  console.log(
    `\n schedule ${r.schedule}${r.expected ? ` of ~${r.expected} expected` : ''}, dispatch ${r.dispatch}, failed ${r.failed.length}` +
      (r.failed.length ? ` (${r.failed.map((f) => f.id).join(', ')})` : ''),
  );
  if (r.currentGapH != null) {
    console.log(
      ` current gap ${r.currentGapH}h — ${r.stale ? 'OVER threshold: dispatch collect' : 'within threshold'}`,
    );
  }
}

// ── log: collect.log summary ──────────────────────────────────────────────

export function parseCollectLog(text) {
  const line = (re) => text.match(re)?.[0] ?? null;
  const num = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) : null;
  };
  const shown500s = (text.match(/WhataHotel API 500 on rates/g) ?? []).length;
  const more = num(/… and (\d+) more failures/) ?? 0;
  return {
    plan: line(/• Plan: .*/),
    capacity: line(/• Capacity: .*/),
    cannotDrain: line(/!! BACKLOG CANNOT DRAIN: .*/),
    backlog: num(/backlog (\d+)/),
    fetched: line(/• Fetching .*/),
    soldOut: num(/(\d+) stay\(s\) sold out/),
    invalidJson: num(/(\d+) response\(s\) were invalid JSON/),
    upstream500s: shown500s + more,
    ingest: line(/• Ingest: .*/),
    fruitless: num(/(\d+) stay\(s\) yielded no usable rates/),
    baselines: line(/• Baselines: .*/),
    baselineMs: num(/• Baselines: .* in (\d+)ms/),
    comparables: line(/• Comparables: .*/),
    retention: line(/Retention.*/),
    doneSeconds: num(/✓ Done in ([\d.]+)s/),
    dbLimitHit: /project size limit/.test(text),
  };
}

async function cmdLog() {
  const src = args.find((a) => !a.startsWith('--'));
  if (!src) throw new Error('usage: ops log <collect.log | zip | url>');
  let text;
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = `/tmp/ops-collect-log-${process.pid}.zip`;
    writeFileSync(tmp, buf);
    text = execFileSync('unzip', ['-p', tmp, 'collect.log'], { encoding: 'utf8' });
  } else if (src.endsWith('.zip')) {
    text = execFileSync('unzip', ['-p', src, 'collect.log'], { encoding: 'utf8' });
  } else {
    text = readFileSync(src, 'utf8');
  }
  const s = parseCollectLog(text);
  for (const k of [
    'plan',
    'capacity',
    'cannotDrain',
    'fetched',
    'ingest',
    'baselines',
    'comparables',
    'retention',
  ]) {
    if (s[k]) console.log(s[k]);
  }
  console.log(
    `\n backlog ${s.backlog ?? '—'} · upstream 500s ${s.upstream500s} · sold out ${s.soldOut ?? '—'} · ` +
      `invalid JSON ${s.invalidJson ?? '—'} · fruitless ${s.fruitless ?? '—'} · done in ${s.doneSeconds ?? '—'}s`,
  );
  if (s.dbLimitHit)
    console.log(
      '\n !! DATABASE HIT THE 512 MB PROJECT LIMIT — measure and drop the oldest eligible partition NOW',
    );
}

// ── score / cohort ────────────────────────────────────────────────────────

async function cmdScore() {
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) throw new Error('usage: ops score <hotel_id>');
  const row = await probe(Number(id));
  printRows([row]);
  if (row.error) console.log(`\n error: ${row.error}`);
}

async function cmdCohort() {
  console.log(`cohort of ${COHORT.length} against ${BASE}`);
  console.log(`stay ${CHECK_IN} → ${CHECK_OUT}, ${ADULTS} adults`);
  const conc = Number(value('--conc', '6'));
  const results = new Array(COHORT.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (next < COHORT.length) {
        const i = next++;
        results[i] = await probe(COHORT[i]);
        process.stderr.write(`done ${COHORT[i]} (${results[i].mode})\n`);
      }
    }),
  );
  printRows(results);
  console.log('\n── totals ──', JSON.stringify(tally(results)));

  const diffPath = value('--diff');
  if (diffPath) {
    const before = JSON.parse(readFileSync(diffPath, 'utf8'));
    const byId = new Map(results.map((r) => [r.hotel, r]));
    console.log('\n── vs baseline ──');
    for (const b of before.rows) {
      const a = byId.get(b.hotel);
      if (!a) continue;
      const moved =
        b.score !== a.score ||
        b.confidence !== a.confidence ||
        b.termsBasis !== a.termsBasis ||
        b.mode !== a.mode;
      if (!moved) continue;
      console.log(
        `${fmt(b.hotel, 6)} ${`${b.mode ?? '—'} → ${a.mode ?? '—'}`.padEnd(28)} ` +
          `${`${b.score ?? '—'} → ${a.score ?? '—'}`.padEnd(12)} ` +
          `${`${b.confidence ?? '—'} → ${a.confidence ?? '—'}`.padEnd(16)} ` +
          `${b.termsBasis ?? '—'} → ${a.termsBasis ?? '—'}`,
      );
    }
    const tb = tally(before.rows);
    const ta = tally(results);
    console.log('');
    for (const k of Object.keys(tb))
      console.log(`  ${k.padEnd(11)} ${fmt(tb[k], 4)} → ${fmt(ta[k], 4)}`);
  }

  const out = value('--out');
  if (out) {
    writeFileSync(
      out,
      JSON.stringify(
        { base: BASE, checkIn: CHECK_IN, checkOut: CHECK_OUT, adults: ADULTS, rows: results },
        null,
        2,
      ),
    );
    console.log(`\nwrote ${out}`);
  }
}

// ── dispatch ──────────────────────────────────────────────────────────────

const commands = { runs: cmdRuns, log: cmdLog, score: cmdScore, cohort: cmdCohort };
if (import.meta.url === `file://${process.argv[1]}`) {
  const run = commands[cmd];
  if (!run) {
    console.error('usage: ops <runs|log|score|cohort> …  (see the header of scripts/ops.mjs)');
    process.exit(2);
  }
  try {
    await run();
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exit(1);
  }
}
