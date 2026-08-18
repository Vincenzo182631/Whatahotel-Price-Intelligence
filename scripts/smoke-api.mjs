#!/usr/bin/env node
/**
 * API smoke test — asserts the contract the widget depends on, against a
 * running server with development data seeded.
 *
 * Deliberately not a unit test: it catches the class of failure that only
 * appears when SQL, the engine and the HTTP layer are wired together — an
 * untyped bind parameter, a NULL join, a response field the UI reads but the
 * handler never sets.
 */

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000';

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function get(path) {
  const res = await fetch(BASE + path, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, body };
}

function isoDaysFromNow(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function main() {
  console.log(`Smoke testing ${BASE}\n`);

  // ── health ────────────────────────────────────────────────────────────
  const health = await get('/api/v1/health');
  check('health returns 200', health.status === 200, `got ${health.status}`);
  check('health reports the config source', health.body?.config_source === 'database');
  check('health reports observations', (health.body?.data?.observations ?? 0) > 0);

  // Provenance is a safety label, so it is asserted rather than trusted. The
  // harness banner is rendered from it; before this existed the banner was
  // hardcoded and went on claiming "synthetic" while showing live rates.
  const provenance = health.body?.data?.provenance;
  const sources = health.body?.data?.sources ?? [];
  check(
    'health reports data provenance',
    ['REAL', 'SYNTHETIC', 'MIXED', 'EMPTY'].includes(provenance),
    String(provenance),
  );
  check(
    'every source declares whether it is synthetic',
    sources.length > 0 && sources.every((s) => typeof s.is_synthetic === 'boolean'),
  );
  // CI runs this against the synthetic seed. If that is ever labelled anything
  // but SYNTHETIC, the label has stopped tracking the data — which is the whole
  // failure this check exists to catch.
  if (sources.some((s) => s.code === 'SYNTHETIC_DEV')) {
    check(
      'a database seeded with synthetic data is labelled synthetic',
      provenance === 'SYNTHETIC' || provenance === 'MIXED',
      provenance,
    );
    check(
      'the synthetic source is flagged is_synthetic',
      sources.find((s) => s.code === 'SYNTHETIC_DEV')?.is_synthetic === true,
    );
  }

  // ── hotels ────────────────────────────────────────────────────────────
  const list = await get('/api/v1/hotels?limit=50');
  check('hotel listing returns 200', list.status === 200);
  const hotels = list.body?.hotels ?? [];
  check('hotel listing is non-empty', hotels.length > 0);
  check(
    'hotel listing flags price-intelligence coverage',
    hotels.every((h) => typeof h.has_price_intelligence === 'boolean'),
  );

  const search = await get('/api/v1/hotels?q=azure');
  check('hotel search returns 200', search.status === 200);
  check('hotel search narrows results', (search.body?.hotels ?? []).length < hotels.length);

  const shortQuery = await get('/api/v1/hotels?q=a');
  check('single-character query is rejected', shortQuery.status === 400);
  check(
    'errors carry a code and a request id',
    shortQuery.body?.error?.code === 'INVALID_PARAMETER' && Boolean(shortQuery.body?.request_id),
  );

  // ── find a stay that actually has data ────────────────────────────────
  //
  // Probed across hotels, not just the first one. Against the synthetic seed
  // every hotel has data so hotels[0] always worked; against a real collection
  // only the hotels covered so far do, and the smoke run failed on a database
  // that was perfectly healthy. Hotels reporting coverage are tried first, and
  // both stay lengths the collector captures are probed.
  const ordered = [...hotels].sort(
    (a, b) => Number(b.has_price_intelligence) - Number(a.has_price_intelligence),
  );

  let hotelId = null;
  let stay = null;
  outer: for (const hotel of ordered.slice(0, 12)) {
    for (let offset = 6; offset <= 60; offset += 1) {
      for (const nights of [3, 1]) {
        const checkIn = isoDaysFromNow(offset);
        const checkOut = isoDaysFromNow(offset + nights);
        const probe = await get(
          `/api/v1/hotels/${hotel.hotel_id}/room-types?check_in=${checkIn}&check_out=${checkOut}`,
        );
        if (probe.status === 200 && (probe.body?.room_types ?? []).length > 0) {
          hotelId = hotel.hotel_id;
          stay = { checkIn, checkOut, rooms: probe.body.room_types };
          break outer;
        }
      }
    }
  }
  check('found a stay with available rooms', stay !== null);
  if (stay === null) return;
  console.log(`  ..   using hotel ${hotelId}, ${stay.checkIn} → ${stay.checkOut}`);

  check(
    'room types carry price, class and observation count',
    stay.rooms.every(
      (r) =>
        r.nightly?.amount_minor > 0 &&
        typeof r.room_class === 'string' &&
        typeof r.n_observations === 'number',
    ),
  );

  // ── the main endpoint ─────────────────────────────────────────────────
  const q = `hotel_id=${hotelId}&check_in=${stay.checkIn}&check_out=${stay.checkOut}&adults=2`;
  const pi = await get(`/api/v1/price-intelligence?${q}&include=explanation,history,comparables`);
  check('price-intelligence returns 200', pi.status === 200, `got ${pi.status}`);

  const d = pi.body ?? {};
  const v = d.verdict ?? {};

  check('response carries an analysis id', typeof d.analysis_id === 'string');
  check(
    'recommendation is one of the three states',
    ['BOOK_NOW', 'CONSIDER', 'INSUFFICIENT_DATA'].includes(v.recommendation),
    v.recommendation,
  );
  check('confidence is always present', typeof v.confidence === 'number');
  check('gate is reported', typeof v.gate_fired === 'string');

  // The invariants, verified through HTTP rather than on fixtures.
  check(
    'INSUFFICIENT_DATA implies a null score, never 0',
    v.recommendation !== 'INSUFFICIENT_DATA' || v.deal_score === null,
    `score=${v.deal_score}`,
  );
  check(
    'WAIT is never returned — it was retired in config v4',
    v.recommendation !== 'WAIT',
    v.recommendation,
  );
  check(
    'a scored response always carries a band',
    v.deal_score === null || typeof v.deal_score_band === 'string',
  );

  check('all five scoring factors are reported', (d.factors ?? []).length === 5);
  check(
    'unavailable factors state a reason',
    (d.factors ?? []).every((f) => f.available || typeof f.unavailable_reason === 'string'),
  );
  check(
    'applied weights sum to 1 when scored',
    v.deal_score === null ||
      Math.abs((d.factors ?? []).reduce((s, f) => s + f.weight_applied, 0) - 1) < 1e-6,
  );

  check(
    'price is in minor units with a currency',
    d.price?.nightly?.amount_minor > 0 && d.price?.nightly?.currency,
  );
  check('tax basis is explicit', typeof d.price?.tax_basis === 'string');
  check('data_as_of is present', typeof d.data_as_of === 'string');
  check(
    'config and engine versions are reported',
    d.config_version >= 1 && Boolean(d.engine_version),
  );

  check('history series returned', (d.history?.series ?? []).length > 0);
  check('history gaps are explicit', Array.isArray(d.history?.gaps));
  check(
    'explanation rendered',
    typeof d.explanation?.text === 'string' && d.explanation.text.length > 20,
  );
  check(
    'explanation generator is declared',
    ['MODEL', 'TEMPLATE'].includes(d.explanation?.generator),
  );

  check('responses are cacheable', /max-age=\d+/.test(pi.headers.get('cache-control') ?? ''));

  // ── the live-market model ─────────────────────────────────────────────
  //
  // Scores the same stay against today's market rather than against accrued
  // history. Its contract is checked separately because the widget renders the
  // 0-10 figure from it, and because the never-predict rule has to hold on
  // every field a customer can see.
  const live = await get(`/api/v1/live-intelligence?${q}`);
  check('live-intelligence returns 200', live.status === 200, `got ${live.status}`);
  const l = live.body ?? {};
  const lv = l.verdict ?? {};

  check('live model is declared', l.model === 'LIVE_MARKET');
  check(
    'verdict is one of the four live states',
    ['BOOK_NOW', 'BOOK_CONSIDER', 'CONSIDER_ALTERNATIVES', 'NOT_ENOUGH_DATA'].includes(lv.verdict),
    lv.verdict,
  );
  check(
    'no live verdict tells the customer to wait',
    !/wait/i.test(`${lv.verdict} ${lv.verdict_label} ${(lv.reasons ?? []).join(' ')}`),
    `${lv.verdict_label}`,
  );
  check(
    'no reason predicts a future price',
    !(lv.reasons ?? []).some((r) =>
      /\b(will|going to|expect|predict|forecast|rise|rises|fall|falls|soften|before it|soon)\b/i.test(r),
    ),
    (lv.reasons ?? []).join(' | '),
  );
  check(
    'confidence is a word, not a number',
    ['HIGH', 'MEDIUM', 'LOW'].includes(lv.confidence),
    String(lv.confidence),
  );
  check(
    'an absent live score is null, never 0',
    lv.verdict !== 'NOT_ENOUGH_DATA' || (lv.score === null && lv.out_of_ten === null),
    `score=${lv.score}`,
  );
  check(
    'the 0-10 figure matches the 0-100 score',
    lv.score === null || Math.abs(lv.out_of_ten - lv.score / 10) < 1e-9,
    `${lv.out_of_ten} vs ${lv.score}`,
  );

  const ls = l.signals ?? {};
  const liveSignals = [ls.comp_set, ls.calendar, ls.compression];
  check('all three live signals are reported', liveSignals.every(Boolean));
  check(
    'an unavailable signal states why, and carries no sub-score',
    liveSignals.every(
      (sig) =>
        sig.available ||
        (typeof sig.unavailable_reason === 'string' && sig.sub_score === null),
    ),
  );
  // The renormalization is the whole reason a missing signal does not drag the
  // score down. If it silently reported zero the score would look unweighted.
  check(
    'available signal weights renormalize to 1',
    lv.score === null ||
      Math.abs(liveSignals.reduce((sum, sig) => sum + sig.weight_applied, 0) - 1) < 1e-3,
    liveSignals.map((sig) => sig.weight_applied).join(' + '),
  );
  check(
    'every competitor counted was live-validated',
    !ls.comp_set.available || ls.comp_set.comps_used >= 1,
  );
  check(
    'the calendar signal declares whether it held weekday fixed',
    !ls.calendar.available || typeof ls.calendar.same_weekday_only === 'boolean',
  );
  check(
    'live responses are cacheable',
    /max-age=\d+/.test(live.headers.get('cache-control') ?? ''),
  );

  // ── the debug endpoint reproduces the decision ────────────────────────
  const debug = await get(`/internal/v1/analyses/${d.analysis_id}`);
  check('stored analysis is retrievable', debug.status === 200);
  check('stored analysis carries the decision trace', Boolean(debug.body?.decision_trace));
  check('stored analysis carries the factor breakdown', (debug.body?.factors ?? []).length === 5);

  // ── error paths ───────────────────────────────────────────────────────
  const missing = await get(
    '/api/v1/price-intelligence?hotel_id=NOPE&check_in=2030-01-01&check_out=2030-01-04',
  );
  check('unknown hotel returns 404', missing.status === 404, `got ${missing.status}`);

  const backwards = await get(
    `/api/v1/price-intelligence?hotel_id=${hotelId}&check_in=2030-01-05&check_out=2030-01-01`,
  );
  check('inverted date range returns 400', backwards.status === 400);

  const noRate = await get(
    `/api/v1/price-intelligence?hotel_id=${hotelId}&check_in=2031-06-01&check_out=2031-06-04`,
  );
  check('a stay with no stored rate returns 409', noRate.status === 409, `got ${noRate.status}`);

  const liveMissing = await get(
    '/api/v1/live-intelligence?hotel_id=NOPE&check_in=2030-01-01&check_out=2030-01-04',
  );
  check('live-intelligence 404s on an unknown hotel', liveMissing.status === 404);

  const liveNoRate = await get(
    `/api/v1/live-intelligence?hotel_id=${hotelId}&check_in=2031-06-01&check_out=2031-06-04`,
  );
  check(
    'live-intelligence 409s rather than scoring a stay it has no rate for',
    liveNoRate.status === 409,
    `got ${liveNoRate.status}`,
  );

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
