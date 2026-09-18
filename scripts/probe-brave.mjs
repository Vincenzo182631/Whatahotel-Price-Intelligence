#!/usr/bin/env node
/**
 * Measure what Brave Search actually returns for our hotels, before anything
 * parses it.
 *
 *   node scripts/probe-brave.mjs [--limit 5] [--dump web.results]
 *
 * This is the fourth probe in this codebase and the reason is the same every
 * time: a documented field is not a populated one (rule 30), and a parser
 * written against a guessed shape passes its own tests while storing nothing
 * (rule 29's closing paragraph — 150 hotels, 0 rows, 8 green tests).
 *
 * Three questions, and none is answerable by reading Brave's docs:
 *
 *   1. WHAT SHAPE. --dump prints one branch verbatim so the parser is
 *      written against bytes rather than expectations.
 *   2. HOW USEFUL. For each motivator query it reports how many results came
 *      back and how many carry a description, because a result with a URL
 *      and no text is a link, not evidence.
 *   3. WHOSE PAGE. It prints the hostnames, since a claim sourced from the
 *      hotel's own site is different evidence from one sourced from an
 *      aggregator, and the guest will see the domain.
 *
 * READ-ONLY and DATABASE-FREE where possible: hotel names come from our own
 * public API. Needs BRAVE_API_KEY, which stays in the environment and is
 * redacted from every line this prints (rule 10).
 *
 * COST AND RATE. Brave's free tier is about one request per second, so the
 * probe paces itself and stays small. A sweep that ignores the limit looks
 * exactly like a broken key.
 */
import { writeFileSync } from 'node:fs';
import { BraveClient, redactBrave } from '../packages/ingest/dist/index.js';

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = value('--base', 'https://whatahotel-price-intelligence-api.vercel.app');
const LIMIT = Number(value('--limit', '5'));
const DUMP = value('--dump', null);
const OUT = value('--out', null);
const IDS = value('--ids', '2008,3046,19,1198,1550')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter(Boolean)
  .slice(0, LIMIT);

const client = BraveClient.fromEnv();
if (!client) {
  console.error('BRAVE_API_KEY is not set. This probe calls the real API or it does nothing.');
  process.exit(1);
}
const KEY = process.env.BRAVE_API_KEY ?? '';

/**
 * One query per motivator, phrased as the evidence we are looking for rather
 * than as the conclusion. "beachfront pool beach club" finds pages that
 * mention those things; "is this a good beach hotel" finds opinions.
 */
const MOTIVATOR_QUERIES = {
  BEACH_RESORT: 'beachfront pool beach club water sports',
  FAMILY: 'family kids club connecting rooms children',
  BUSINESS_TRAVEL: 'business center meeting rooms conference wifi',
  QUIET_RELAXATION: 'spa wellness adults quiet retreat',
  NIGHTLIFE: 'bar lounge nightlife rooftop',
  LOCATION: 'location neighborhood walk distance downtown',
  AMENITIES: 'hotel amenities facilities services',
  LUXURY_EXPERIENCE: 'suites service butler fine dining',
};

async function hotelMeta(id) {
  const res = await fetch(`${BASE}/api/v1/hotels/${id}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) return null;
  const body = await res.json();
  const h = body.hotel ?? body;
  return h?.name ? { id, name: h.name, city: h.destination ?? null } : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
let dumped = false;

for (const id of IDS) {
  const meta = await hotelMeta(id);
  if (!meta) {
    console.log(`${String(id).padStart(5)}  NO_META`);
    continue;
  }
  console.log(`\n${meta.name}${meta.city ? ' — ' + meta.city : ''}`);

  for (const [motivator, terms] of Object.entries(MOTIVATOR_QUERIES)) {
    const q = `${meta.name} ${meta.city ?? ''} ${terms}`.replace(/\s+/g, ' ').trim();
    try {
      const payload = await client.search(q, 5);

      if (DUMP && !dumped) {
        let node = payload;
        for (const key of DUMP.split('.')) node = node?.[key];
        console.log(`\n  --dump ${DUMP}:`);
        console.log(
          JSON.stringify(node, null, 2)
            .split('\n')
            .slice(0, 50)
            .map((l) => '    ' + l)
            .join('\n'),
        );
        console.log();
        dumped = true;
      }

      // Deliberately shallow: the point is to learn the shape, not to assume
      // one. If `web.results` is not where results live, this reports zero
      // and the dump above shows where they actually are.
      const results = payload?.web?.results ?? [];
      const described = results.filter((r) => (r?.description ?? '').trim().length > 0);
      const hosts = [
        ...new Set(
          results
            .map((r) => {
              try {
                return new URL(r.url).hostname.replace(/^www\./, '');
              } catch {
                return null;
              }
            })
            .filter(Boolean),
        ),
      ];
      rows.push({ id, motivator, results: results.length, described: described.length, hosts });
      console.log(
        `  ${motivator.padEnd(18)} ${String(results.length).padStart(2)} result(s), ` +
          `${String(described.length).padStart(2)} with text   ${hosts.slice(0, 3).join(', ')}`,
      );
    } catch (err) {
      const msg = redactBrave(String(err?.message ?? err), KEY);
      console.log(`  ${motivator.padEnd(18)} FAIL  ${msg.slice(0, 120)}`);
      rows.push({ id, motivator, results: 0, described: 0, error: msg.slice(0, 200) });
    }
    // Brave's free tier is roughly one request a second.
    await sleep(1100);
  }
}

const ok = rows.filter((r) => !r.error);
const withText = rows.filter((r) => r.described > 0);
console.log(`\n── ${ok.length} of ${rows.length} queries answered ──`);
console.log(`   ${withText.length} returned at least one result carrying description text`);

const hostCount = new Map();
for (const r of ok) for (const h of r.hosts ?? []) hostCount.set(h, (hostCount.get(h) ?? 0) + 1);
const top = [...hostCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
if (top.length > 0) {
  console.log('\n── which sites answer ──');
  for (const [host, n] of top) console.log(`  ${String(n).padStart(3)}  ${host}`);
}

if (OUT) {
  writeFileSync(OUT, JSON.stringify({ probedAt: new Date().toISOString(), rows }, null, 2));
  console.log(`\nwrote ${OUT}`);
}
