#!/usr/bin/env node
/**
 * Measure what `method=info` actually returns, before anything reads it.
 *
 * Matt reported the method fixed on 2026-09-17 (it had answered 500 for our
 * key since the start, which is why rule 21 says this source exposes no
 * amenity data). Two questions have to be answered before a single field of
 * it reaches a customer surface, and neither is answerable by reading one
 * response:
 *
 *   1. DOES IT VARY? The hotel PAGE already taught us this lesson the
 *      expensive way: its schema.org block carries starRating, priceRange and
 *      amenityFeature, and all three were byte-identical across all 12 real
 *      hotels sampled — 5 stars, "$$$$", and the same five perks on a yacht
 *      collection and on an airport hotel. That is an SEO template, not a
 *      measurement, and `parseHotelPage` refuses to return any of it (rule 24).
 *      A constant that reads as a quality signal is worse than no signal,
 *      because it looks like evidence. So this probe reports the DISTINCT
 *      value count per field across the sample. A field with one distinct
 *      value across twenty hotels is a template, whatever it is called.
 *
 *   2. IS IT THE HOTEL WE ASKED FOR? `info` keys on hotelName + hotelCity,
 *      not on the id the rest of the catalogue uses. Name matching is exactly
 *      the failure mode rule 22 exists to prevent: "Four Seasons Hotel Miami"
 *      and "Four Seasons Resort Palm Beach" share most of their words, and
 *      only geography separates them.
 *
 *      Measured 2026-09-17 over 20 hotels: the response carries NO hotel name
 *      at all, so it cannot be checked by name — the first version of this
 *      probe matched `session.sessionName` (the constant string "Guest") and
 *      reported MISMATCH on all 18 answers, which was the probe's fault and
 *      not the source's. What the response DOES carry is `amadeus.codes`, one
 *      per hotel and distinct across all 18. That is a better identity signal
 *      than a name anyway: it encodes chain and city (RZMIAKBZ for
 *      Ritz-Carlton Miami Key Biscayne, MCAUAARM for Marriott Aruba), and it
 *      is the same namespace the rates method reports as `amaID`. So this
 *      REPORTS the code and leaves the judgement to a reader, rather than
 *      asserting a match it cannot establish.
 *
 * READ-ONLY and DATABASE-FREE. Hotel names come from our own public API, so
 * this needs no connection string — only WAH_API_KEY, which stays in the
 * environment and is redacted from every line this prints (rule 10).
 *
 *   node scripts/probe-info.mjs [--limit 20] [--ids 1198,2008] [--base URL] [--out file.json]
 */
import { writeFileSync } from 'node:fs';
import { createWhataHotelAdapter } from '../packages/ingest/dist/index.js';
import { COHORT } from './cohort-fixture.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const BASE = value('--base', 'https://whatahotel-price-intelligence-api.vercel.app');
const LIMIT = Number(value('--limit', '20'));
const OUT = value('--out', null);
const IDS = value('--ids', null)
  ? String(value('--ids')).split(',').map((s) => Number(s.trim()))
  : COHORT.slice(0, LIMIT);

/** Our own catalogue: the id, the name and the city `info` will be asked for. */
async function hotelMeta(id) {
  const res = await fetch(`${BASE}/api/v1/hotels/${id}`, { headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  const body = await res.json();
  const h = body.hotel ?? body;
  return h?.name ? { id, name: h.name, city: h.destination ?? null } : null;
}

/**
 * Flatten one response to `path -> scalar` so distinct-value counting works on
 * nested objects too. Arrays collapse to a sorted, joined string: what matters
 * is whether two hotels carry the same SET of amenities, not the order the
 * source happened to list them in.
 */
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

/**
 * The only identity signal the response carries: the Amadeus property code.
 *
 * Deliberately NOT a verdict. Nothing here can prove the source answered about
 * the hotel we meant, so this reports what it returned and says plainly when
 * it returned nothing. A probe that manufactures a verdict it cannot support
 * is the same mistake as a scorer that manufactures a signal it cannot
 * measure.
 */
function amadeusCode(payload) {
  const flat = flatten(payload);
  const entry = Object.entries(flat).find(([k]) => /amadeus\.codes$/i.test(k));
  const code = entry?.[1];
  return code && String(code).trim() ? String(code).trim() : null;
}

const adapter = createWhataHotelAdapter({ concurrency: 2, maxRetries: 1 });
const rows = [];

for (const id of IDS) {
  const meta = await hotelMeta(id).catch(() => null);
  if (!meta) {
    rows.push({ id, outcome: 'NOT_IN_CATALOGUE' });
    console.log(`${String(id).padStart(5)}  NOT_IN_CATALOGUE`);
    continue;
  }
  if (!meta.city) {
    rows.push({ id, name: meta.name, outcome: 'NO_CITY' });
    console.log(`${String(id).padStart(5)}  NO_CITY  ${meta.name}`);
    continue;
  }

  const started = Date.now();
  try {
    const data = await adapter.client.call('info', {
      hotelName: meta.name,
      hotelCity: meta.city,
    });
    const flat = flatten(data);
    const code = amadeusCode(data);
    rows.push({
      id,
      name: meta.name,
      city: meta.city,
      outcome: 'OK',
      ms: Date.now() - started,
      fields: Object.keys(flat).length,
      amadeusCode: code,
      flat,
    });
    console.log(
      `${String(id).padStart(5)}  OK  ${String(Object.keys(flat).length).padStart(3)} field(s)  ` +
        `ama=${(code ?? 'NONE').padEnd(12)} ${meta.name}`,
    );
  } catch (err) {
    // err.message only. The client redacts the key from URLs it reports, and
    // nothing here prints the error object, which can carry request details.
    const code = err?.status?.code ?? err?.code ?? 'ERROR';
    rows.push({ id, name: meta.name, city: meta.city, outcome: `FAIL_${code}`, ms: Date.now() - started });
    console.log(`${String(id).padStart(5)}  FAIL ${code}  ${meta.name}  (${err?.message ?? ''})`);
  }
}

// ── the two questions ─────────────────────────────────────────────────────

const ok = rows.filter((r) => r.outcome === 'OK');
console.log(`\n── answered ── ${ok.length} of ${rows.length}`);

if (ok.length === 0) {
  console.log('No responses to analyse. `info` is not usable for this sample.');
} else {
  const withCode = ok.filter((r) => r.amadeusCode);
  const distinctCodes = new Set(withCode.map((r) => r.amadeusCode)).size;
  console.log(
    `── amadeus code ── ${withCode.length} of ${ok.length} answered with one, ${distinctCodes} distinct`,
  );
  for (const r of ok) {
    console.log(`     ${(r.amadeusCode ?? 'NONE').padEnd(12)} ${r.name}`);
  }
  if (withCode.length < ok.length) {
    console.log(
      '   NONE means info holds no Amadeus code for that hotel either, which is the same gap the rates method reports as amaID NULL.',
    );
  }

  const keys = [...new Set(ok.flatMap((r) => Object.keys(r.flat)))].sort();
  console.log(`\n── variance across ${ok.length} hotels ── (1 distinct value = template, not a measurement)\n`);
  console.log('  distinct  present  field');
  const constants = [];
  for (const key of keys) {
    const values = ok.map((r) => r.flat[key]).filter((v) => v !== undefined);
    const distinct = new Set(values).size;
    if (distinct === 1 && values.length > 1) constants.push(key);
    console.log(
      `  ${String(distinct).padStart(8)}  ${String(values.length).padStart(7)}  ${key}` +
        (distinct === 1 && values.length > 1 ? '   ← CONSTANT' : ''),
    );
  }
  console.log(
    `\n${constants.length} of ${keys.length} field(s) are constant across the sample.` +
      (constants.length ? ' A constant field carries no information about a hotel (rule 9, rule 24).' : ''),
  );
}

if (OUT) {
  writeFileSync(OUT, JSON.stringify({ probedAt: new Date().toISOString(), rows }, null, 2));
  console.log(`\nwrote ${OUT}`);
}
