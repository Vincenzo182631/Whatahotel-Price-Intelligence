#!/usr/bin/env node
/**
 * Measure which Places hotel-attribute fields are actually POPULATED for our
 * catalogue, before any of them reaches a customer surface.
 *
 *   node scripts/probe-places-fields.mjs [--limit 20] [--dump <field>]
 *
 * Why this exists rather than "read the docs and add the fields": the docs say
 * a field EXISTS, never that Google holds a value for a luxury hotel in
 * Seychelles. Two of this project's scars are exactly that gap.
 *
 *   - Rule 24. The whatahotel.com page carries schema.org starRating,
 *     priceRange and amenityFeature, and all three were byte-identical across
 *     all 12 real hotels sampled: 5 stars, "$$$$", the same five perks on a
 *     yacht collection and on an airport hotel. An SEO template that reads as
 *     a quality signal, which is worse than no signal.
 *
 *   - 2026-09-18. The amenity parser was written against a fixture invented
 *     from a list of field NAMES. Eight tests passed, and the first sweep
 *     stored nothing for 150 real hotels.
 *
 * So this reports, per field: how many hotels carry it, and how many DISTINCT
 * values it takes. One distinct value across the sample is a template, whatever
 * the field is called. Nothing downstream reads any of it.
 *
 * COST. Places (New) bills per field group, and rule 22 notes the refresh
 * interval is the entire ongoing bill (~13,200 calls/month at the 168h
 * default). This asks for a WIDER mask than the sweep uses, so it is capped
 * at a small sample and is not something to run in a loop.
 *
 * READ-ONLY. One Place Details GET per hotel, no writes. Needs DATABASE_URL to
 * read stored place ids and GOOGLE_PLACES_API_KEY to call Google; both stay in
 * the environment (rule 10).
 */
import { writeFileSync } from 'node:fs';
import { closePool, getPool } from '../packages/data/dist/index.js';

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const LIMIT = Number(value('--limit', '20'));
const DUMP = value('--dump', null);
const OUT = value('--out', null);

const KEY = process.env.GOOGLE_PLACES_API_KEY?.trim();
if (!KEY) {
  console.error('GOOGLE_PLACES_API_KEY is not set. This probe calls the real API or it does nothing.');
  process.exit(1);
}

/**
 * The fields the sweep ALREADY stores, plus every lodging-relevant attribute
 * Places (New) documents. The point of the run is to find out which of the
 * second group Google actually answers with — they are listed as candidates,
 * not as things we believe are there.
 */
const CANDIDATE_FIELDS = [
  // Already in DETAILS_MASK, included so the report shows a known-good
  // baseline next to the unknowns. If `rating` came back empty too, the
  // probe itself would be at fault rather than the fields.
  'rating',
  'userRatingCount',
  'editorialSummary',
  // Unknown coverage for hotels. Each is a guess at what might be useful,
  // and the run is what decides.
  'types',
  'primaryType',
  'primaryTypeDisplayName',
  'goodForChildren',
  'allowsDogs',
  'servesBreakfast',
  'servesBrunch',
  'servesDinner',
  'restroom',
  'parkingOptions',
  'accessibilityOptions',
  'paymentOptions',
  'priceLevel',
  'businessStatus',
];

const pool = getPool();
const { rows } = await pool.query(
  `SELECT id, name, google_place_id
     FROM hotel
    WHERE google_match_status = 'VERIFIED'
      AND google_place_id IS NOT NULL
    ORDER BY id
    LIMIT $1`,
  [LIMIT],
);

if (rows.length === 0) {
  console.log('No VERIFIED hotels with a stored place id. Run the reputation sweep first.');
  await closePool();
  process.exit(0);
}

/** path -> scalar, arrays collapsed to a sorted join. Same rule as the info probe. */
function flatten(node, prefix = '', out = {}) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    out[prefix || '.'] = node
      .map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v)))
      .sort()
      .join(' | ');
    return out;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out[prefix || '.'] = String(node);
  return out;
}

const mask = CANDIDATE_FIELDS.join(',');
const results = [];

for (const row of rows) {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(row.google_place_id)}`;
  try {
    const response = await fetch(url, {
      headers: { 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': mask },
    });
    if (!response.ok) {
      // A 400 here usually means one candidate field is not valid for this
      // API version, and the message names it. That is a finding, not a
      // crash: print it and keep the run going.
      let detail = '';
      try {
        const body = await response.json();
        detail = String(body?.error?.message ?? '').slice(0, 200);
      } catch {
        /* not JSON; status alone */
      }
      console.log(`${String(row.id).padStart(5)}  FAIL ${response.status}  ${row.name}  ${detail}`);
      results.push({ id: row.id, name: row.name, outcome: `FAIL_${response.status}`, detail });
      continue;
    }
    const payload = await response.json();
    const flat = flatten(payload);
    results.push({ id: row.id, name: row.name, outcome: 'OK', flat });
    console.log(`${String(row.id).padStart(5)}  OK   ${String(Object.keys(flat).length).padStart(3)} field(s)  ${row.name}`);
    if (DUMP && payload[DUMP] !== undefined) {
      console.log(`    ${DUMP}: ${JSON.stringify(payload[DUMP], null, 2).split('\n').slice(0, 30).join('\n    ')}`);
    }
  } catch (err) {
    console.log(`${String(row.id).padStart(5)}  ERROR  ${row.name}  (${err?.message ?? ''})`);
    results.push({ id: row.id, name: row.name, outcome: 'ERROR' });
  }
}

const ok = results.filter((r) => r.outcome === 'OK');
console.log(`\n── answered ── ${ok.length} of ${results.length}`);

if (ok.length > 0) {
  const seen = new Map();
  for (const r of ok) {
    for (const [field, v] of Object.entries(r.flat)) {
      if (!seen.has(field)) seen.set(field, new Set());
      seen.get(field).add(v);
    }
  }
  console.log(`\n── coverage across ${ok.length} hotel(s) ──`);
  console.log('  present  distinct  field');
  const report = [...seen.entries()]
    .map(([field, values]) => ({
      field,
      present: ok.filter((r) => r.flat[field] !== undefined).length,
      distinct: values.size,
    }))
    .sort((a, b) => b.present - a.present || a.field.localeCompare(b.field));

  for (const r of report) {
    const flag =
      r.present === 0
        ? '   ← ABSENT'
        : r.distinct === 1
          ? '   ← CONSTANT, carries no information about a hotel (rule 9, rule 24)'
          : '';
    console.log(
      `  ${String(r.present).padStart(7)}  ${String(r.distinct).padStart(8)}  ${r.field}${flag}`,
    );
  }

  // The fields we asked for and Google never answered with. Named explicitly,
  // because "it did not appear in the report" is easy to miss.
  const answered = new Set(report.map((r) => r.field.split('.')[0]));
  const never = CANDIDATE_FIELDS.filter((f) => !answered.has(f));
  if (never.length > 0) {
    console.log(`\n── never returned ──\n  ${never.join(', ')}`);
  }
}

if (OUT) {
  writeFileSync(OUT, JSON.stringify({ probedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nwrote ${OUT}`);
}

await closePool();
