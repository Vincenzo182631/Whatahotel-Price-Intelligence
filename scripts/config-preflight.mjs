#!/usr/bin/env node
/**
 * Can the code in this checkout actually run against the config the database
 * is serving RIGHT NOW?
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * 2026-09-17: config v10 added `live.csi.outlierRatio`, and the engine read it
 * unconditionally. `loadActiveConfig` reads `scoring_config` and CASTS the row
 * to ScoringConfig, so the object reaching the engine at runtime is whatever
 * shape was SEEDED — and production's active row was still v9, which has no
 * such field. Every stay carrying a rate answered 500 for twenty minutes. A
 * stay with no rate never reaches the comp set, which is why HOTEL_ONLY kept
 * working and hid how wide the damage was.
 *
 * Nothing caught it, and nothing could have. The unit tests run against
 * DEFAULT_CONFIG, which by definition has every field the code just added.
 * CI has no database. The schema checks assert the SCHEMA, not whether the
 * engine can read the row. The gap is structural: code ships the moment it
 * merges, the seed is applied by a separate human decision (rule 8), and
 * between those two moments production runs new code against an old config.
 *
 * ── Why a database BRANCH does not catch this ─────────────────────────────
 *
 * Worth stating plainly, because it is the obvious idea and it is wrong.
 * Applying the migration and the seed to a branch produces a branch holding
 * the NEW config, which is precisely the state production was not in. The
 * branch comes back green and says nothing. What catches the fault is running
 * the new code against production AS IT IS, unmigrated — which is what this
 * does. Branching is still worth having for schema changes; it is just not
 * the tool for this.
 *
 * ── What it does ──────────────────────────────────────────────────────────
 *
 * READ-ONLY. One SELECT for the active config, then every live signal is
 * exercised in memory against fixture rates. It writes nothing and is safe to
 * point at production at any time — that is the point, since production's
 * config is the one that matters.
 *
 *   DATABASE_URL=… node scripts/config-preflight.mjs
 *
 * Exits non-zero when the engine cannot run on the stored config, and names
 * the field. Run it BEFORE deploying, and after seeding a new config version.
 */
import { closePool, loadActiveConfig } from '../packages/data/dist/index.js';
import {
  assessLiveConfidence,
  composeLiveScore,
  computeCalendarDelta,
  computeCompSetIndex,
  computeCompression,
  computePremiumJustification,
} from '../packages/core/dist/index.js';

const NOW = new Date();
const iso = new Date(NOW.getTime() - 3_600_000).toISOString();

/** Deliberately ordinary: a subject with real comparables on matched terms. */
const COMPETITORS = [
  { hotelId: '1', name: 'A', nightlyMinor: 85_000, observedAt: iso, isAvailable: true },
  { hotelId: '2', name: 'B', nightlyMinor: 92_000, observedAt: iso, isAvailable: true },
  { hotelId: '3', name: 'C', nightlyMinor: 79_000, observedAt: iso, isAvailable: true },
];
const NEARBY = [
  { checkIn: '2026-10-01', nightlyMinor: 86_000 },
  { checkIn: '2026-10-02', nightlyMinor: 88_000 },
  { checkIn: '2026-10-03', nightlyMinor: 91_000 },
];
const SUBJECT = 88_900;

const failures = [];
function step(name, fn) {
  try {
    const out = fn();
    console.log(`  ok    ${name}`);
    return out;
  } catch (err) {
    // The message names the missing field, which is the whole point:
    // "Cannot read properties of undefined (reading 'min')".
    console.log(`  FAIL  ${name}: ${err?.message ?? err}`);
    failures.push({ step: name, message: String(err?.message ?? err) });
    return null;
  }
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. This checks the config the DATABASE is serving, so it needs one.');
  process.exit(2);
}

let config;
let fromDatabase;
try {
  ({ config, fromDatabase } = await loadActiveConfig());
} catch (err) {
  // err.message ONLY. A pg connection error can carry the connection string
  // in its payload, and this runs in Actions where logs are readable by
  // anyone with repo access (rule 10, same reason live-probe does this).
  console.error(`Could not read the active config: ${err?.message ?? 'unknown error'}`);
  process.exit(2);
}

console.log(
  `Active config: version ${config?.version ?? '?'} (${fromDatabase ? 'from database' : 'FALLBACK to code defaults'})\n`,
);

if (!fromDatabase) {
  // Not a failure by itself, but it means this run proves nothing about
  // production: it just tested the code against its own defaults.
  console.log('  note  no active row found, so this exercised DEFAULT_CONFIG and not the stored one.\n');
}

const compSet = step('S1 comp-set index', () =>
  computeCompSetIndex(SUBJECT, COMPETITORS, config, NOW, {
    strength: 'RESOLVED',
    unknown: [],
    roomMatch: 'CLASS',
  }),
);
const calendar = step('S2 calendar delta', () =>
  computeCalendarDelta(SUBJECT, NEARBY, config),
);
const compression = step('S3 market compression', () =>
  computeCompression({ checked: 8, soldOut: 2 }, config),
);
step('premium justification', () =>
  computePremiumJustification(SUBJECT, null, COMPETITORS, config),
);
if (compSet && calendar && compression) {
  step('live confidence', () =>
    assessLiveConfidence(compSet, calendar, compression, 1, config),
  );
  step('compose live score', () =>
    composeLiveScore(compSet, calendar, compression, 1, config),
  );
}

await closePool();

console.log('');
if (failures.length === 0) {
  console.log(`PASS — the engine runs on config version ${config?.version}.`);
  process.exit(0);
}
console.log(`FAIL — ${failures.length} signal(s) cannot run on the stored config.`);
console.log(
  'This is the deploy-ordering fault: the code expects a config field the active version does not carry.',
);
console.log('Either seed the newer config version, or make the field safe to be absent.');
process.exit(1);
