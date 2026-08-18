#!/usr/bin/env node
/**
 * Real-data probe — exercise the whole chain against production rates.
 *
 *   npm run probe                      # against http://localhost:3000
 *   PROBE_BASE=... npm run probe
 *   npm run probe -- --targets 5
 *
 * Not a smoke test. `npm run smoke` asserts the HTTP contract the widget
 * depends on and runs happily against the synthetic seed; this asks a
 * different question, and only real data can answer it: given rates that were
 * actually collected from WhataHotel, does the system produce an answer a
 * customer could be shown?
 *
 * It picks its own targets from the database rather than taking them as
 * arguments, because the interesting cases are the ones nobody would think to
 * ask for — the hotel with no comp set, the date whose only rate is stale, the
 * room type that matched at 0.7. A hand-picked hotel proves the happy path and
 * nothing else.
 *
 * WHAT IT ASSERTS, in descending order of how much a failure matters:
 *
 *   1. No rendered explanation contains predictive language (invariant P11, a
 *      release blocker). The property suite already proves this over generated
 *      inputs; this proves it over the sentences real data actually produces.
 *   2. No score is ever 0 where it should be null (invariant P2) — a zero
 *      renders to a customer as "terrible deal".
 *   3. Absent signals report a reason and are excluded, never substituted with
 *      a neutral value.
 *   4. Nothing 5xxs.
 *
 * INSUFFICIENT_DATA is NOT a failure here and is reported as normal. With one
 * day of collection the history model is expected to decline; that is the
 * design working, and it is exactly why the live model exists.
 *
 * Read-only: it issues SELECTs and GETs and writes nothing. Safe against
 * production.
 */

import { containsPredictiveLanguage, findPredictiveLanguage } from '../packages/core/dist/index.js';
// The same pool the API uses, deliberately: its type parsers and TLS handling
// are part of what this probe is checking, and a second connection path here
// would be a second thing that can be configured wrong.
import { closePool, getPool } from '../packages/data/dist/index.js';

const BASE = process.env.PROBE_BASE ?? 'http://localhost:3000';
const DATABASE_URL = process.env.DATABASE_URL;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const TARGET_COUNT = Math.max(1, Number(arg('targets', 4)));

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`  ✗ ${message}`);
};

async function get(path) {
  const res = await fetch(BASE + path, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

const fmt = (money) => (money ? `${money.currency} ${(money.amount_minor / 100).toFixed(2)}` : '—');

/**
 * Pick targets spread across hotels, not the top N rows.
 *
 * DISTINCT ON gives one stay per hotel; ordering by observation count within
 * each hotel picks a stay with enough behind it to be worth asking about. The
 * comp-set count comes along because it predicts which signals can even be
 * computed — a hotel with no comparables cannot produce a Comp-Set Index, and
 * seeing that stated as an absence rather than a zero is half the point of
 * this probe.
 */
const TARGET_QUERY = `
  SELECT DISTINCT ON (h.wah_hotel_id)
         h.wah_hotel_id,
         h.name,
         ro.check_in,
         ro.nights,
         count(*) OVER (PARTITION BY h.wah_hotel_id, ro.check_in) AS rates_for_stay,
         (SELECT count(*) FROM hotel_comparable hc WHERE hc.hotel_id = h.id) AS comp_count
    FROM rate_observation ro
    JOIN hotel h ON h.id = ro.hotel_id
   WHERE ro.is_available
     AND ro.check_in > current_date
     AND ro.observed_at > now() - interval '48 hours'
   ORDER BY h.wah_hotel_id, rates_for_stay DESC, ro.check_in
`;

async function pickTargets(client, limit) {
  const { rows } = await client.query(TARGET_QUERY);
  // Probe hotels WITH and WITHOUT a comp set. Taking the top N by rate count
  // would return only well-covered hotels and quietly skip the degraded path,
  // which is the one more likely to be broken.
  const withComps = rows.filter((r) => Number(r.comp_count) > 0);
  const without = rows.filter((r) => Number(r.comp_count) === 0);
  const picked = [];
  for (let i = 0; picked.length < limit && (i < withComps.length || i < without.length); i += 1) {
    if (i < withComps.length && picked.length < limit) picked.push(withComps[i]);
    if (i < without.length && picked.length < limit) picked.push(without[i]);
  }
  return picked;
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function reportSignal(name, signal) {
  if (signal.available) {
    console.log(
      `      ${name.padEnd(12)} sub-score ${String(signal.sub_score).padStart(6)}` +
        `  weight ${signal.weight} → applied ${signal.weight_applied}`,
    );
    return;
  }
  // Rule 9 and invariant P2: unmeasurable is excluded with a reason, never
  // scored well and never scored zero.
  console.log(`      ${name.padEnd(12)} ABSENT — ${signal.unavailable_reason ?? '(no reason!)'}`);
  if (!signal.unavailable_reason) fail(`${name}: absent with no reason given`);
  if (signal.sub_score !== null) {
    fail(`${name}: absent but carries sub_score ${signal.sub_score} (should be null)`);
  }
  if (signal.weight_applied !== 0) {
    fail(`${name}: absent but weight_applied is ${signal.weight_applied} (should be 0)`);
  }
}

function checkExplanation(where, text) {
  if (typeof text !== 'string' || text.length === 0) return;
  if (containsPredictiveLanguage(text)) {
    fail(
      `P11 RELEASE BLOCKER — ${where} predicts a future price ` +
        `(${findPredictiveLanguage(text).join(', ')}): ${JSON.stringify(text)}`,
    );
  }
}

async function probeTarget(target) {
  const checkIn = target.check_in.toISOString().slice(0, 10);
  const nights = Number(target.nights) || 1;
  const checkOut = addDays(checkIn, nights);
  const comps = Number(target.comp_count);

  console.log(`\n─ ${target.name} (${target.wah_hotel_id})`);
  console.log(
    `  ${checkIn} → ${checkOut} · ${nights} night(s) · ` +
      `${target.rates_for_stay} rate(s) on file · ${comps} comparable hotel(s)`,
  );

  const query =
    `hotel_id=${encodeURIComponent(target.wah_hotel_id)}` +
    `&check_in=${checkIn}&check_out=${checkOut}&adults=2`;

  // ── the live-market model ───────────────────────────────────────────────
  const live = await get(`/api/v1/live-intelligence?${query}`);
  if (live.status >= 500) {
    fail(`live-intelligence returned ${live.status}: ${JSON.stringify(live.body)}`);
  } else if (live.status !== 200) {
    // A 4xx is a real answer — NO_CURRENT_RATE for a stay whose rates have
    // aged out is correct behaviour, not a fault.
    console.log(`    live:    ${live.status} ${live.body?.error?.code} — ${live.body?.error?.message}`);
  } else {
    const v = live.body.verdict;
    console.log(
      `    live:    ${v.verdict_label} · ${v.out_of_ten ?? '—'}/10 ` +
        `${v.band_label ? `· ${v.band_label} ` : ''}· confidence ${v.confidence} ` +
        `· coverage ${v.weight_coverage}`,
    );
    console.log(`    price:   ${fmt(live.body.price.nightly)}/night, ${fmt(live.body.price.total)} total`);
    reportSignal('comp-set', live.body.signals.comp_set);
    reportSignal('calendar', live.body.signals.calendar);
    reportSignal('compression', live.body.signals.compression);
    for (const reason of v.reasons ?? []) {
      console.log(`      · ${reason}`);
      checkExplanation('a live reason', typeof reason === 'string' ? reason : reason.text);
    }
    if (v.score === 0) fail('live score is 0 — an absent score must be null (P2)');
    if (comps === 0 && live.body.signals.comp_set.available) {
      fail('hotel has no comparables but the comp-set signal claims to be available');
    }
  }

  // ── the history model ───────────────────────────────────────────────────
  const hist = await get(`/api/v1/price-intelligence?${query}&include=explanation`);
  if (hist.status >= 500) {
    fail(`price-intelligence returned ${hist.status}: ${JSON.stringify(hist.body)}`);
  } else if (hist.status !== 200) {
    console.log(`    history: ${hist.status} ${hist.body?.error?.code} — ${hist.body?.error?.message}`);
  } else {
    const v = hist.body.verdict;
    const score = v.deal_score;
    console.log(
      `    history: ${v.recommendation_label ?? v.recommendation} · score ${score ?? 'null'}` +
        `${v.deal_score_band ? ` (${v.deal_score_band})` : ''} · confidence ${v.confidence}` +
        ` ${v.confidence_band} · gate ${v.gate_fired}`,
    );
    const bl = hist.body.baseline ?? {};
    console.log(
      `      baseline ${bl.level} · ${bl.n_observations} observation(s) over ${bl.lookback_days}d`,
    );
    if (score === 0) fail('deal score is 0 — an absent score must be null (P2)');
    const text = hist.body.explanation?.text;
    if (text) {
      console.log(`      "${text}"`);
      checkExplanation('the rendered explanation', text);
    }
    for (const r of hist.body.reasons ?? []) checkExplanation('a reason', r.text);
    for (const c of hist.body.caveats ?? []) checkExplanation('a caveat', c.text);
  }
}

async function main() {
  if (!DATABASE_URL) {
    console.error('DATABASE_URL is not set — this probe reads real data or it reads nothing.');
    process.exit(2);
  }

  console.log(`Probing ${BASE} against live collected data\n`);

  const health = await get('/api/v1/health');
  if (health.status !== 200) {
    console.error(`Server is not healthy: ${health.status}`);
    process.exit(1);
  }
  const data = health.body?.data ?? {};
  console.log(
    `Server: ${data.observations ?? '?'} observation(s), ` +
      `${data.baselines ?? '?'} baseline(s), provenance ${data.provenance ?? '?'}, ` +
      `config v${health.body?.config_version ?? '?'} from ${health.body?.config_source ?? '?'}`,
  );
  // The provenance label exists so nobody mistakes a synthetic run for a real
  // one. If it says synthetic, this probe is measuring fabricated numbers and
  // its conclusions are worthless — say so rather than printing them.
  //
  // PROBE_ALLOW_SYNTHETIC=1 exercises the harness itself against the dev seed,
  // the same bargain as ALLOW_SYNTHETIC_SEED: an explicit opt-in, and a banner
  // on every line of output so no one quotes a fabricated number as a result.
  const synthetic = String(data.provenance ?? '').toUpperCase().includes('SYNTHETIC');
  if (synthetic && process.env.PROBE_ALLOW_SYNTHETIC !== '1') {
    console.error('\nDatabase reports SYNTHETIC provenance — this probe proves nothing here.');
    console.error('Set PROBE_ALLOW_SYNTHETIC=1 to run it anyway, to exercise the harness.');
    process.exit(2);
  }
  if (synthetic) {
    console.log('\n*** SYNTHETIC DATA — every number below is fabricated. ***');
    console.log('*** This run exercises the probe, and proves nothing about the product. ***');
  }

  let targets;
  try {
    targets = await pickTargets(getPool(), TARGET_COUNT);
  } finally {
    await closePool();
  }

  if (targets.length === 0) {
    console.error('\nNo bookable stay observed in the last 48 hours — nothing to probe.');
    process.exit(1);
  }

  for (const target of targets) await probeTarget(target);

  console.log(
    `\n${targets.length} target(s) probed · ` +
      (failures === 0 ? 'no invariant violations' : `${failures} FAILURE(S)`),
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  // Never print the error object wholesale: a pg connection error can carry
  // the connection string, and this runs in CI where stdout is retained.
  console.error(`Probe failed: ${err?.message ?? err}`);
  process.exit(1);
});
