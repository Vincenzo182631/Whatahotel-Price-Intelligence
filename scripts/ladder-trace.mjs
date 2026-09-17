#!/usr/bin/env node
/**
 * Print the radius ladder's decisions for one stay.
 *
 * The ladder chooses which comparison a customer sees, and none of its
 * reasoning reaches the response: a rung that declined and a rung that was
 * never reached both surface as "0 comparables at 2mi". On 2026-09-17 that
 * cost an evening on Four Seasons Oahu at Ko Olina — six candidate
 * explanations eliminated from outside the system before it was clear the
 * answer was only visible from inside it.
 *
 * READ-ONLY. It calls loadLiveIntelligence, which issues SELECTs and nothing
 * else, with WAHPI_LADDER_TRACE=1 so the ladder narrates itself.
 *
 *   DATABASE_URL=… node scripts/ladder-trace.mjs <wahHotelId> <checkIn> <nights> [adults]
 */
import { closePool, loadActiveConfig, loadLiveIntelligence } from '../packages/data/dist/index.js';

const [wahHotelId, checkIn, nightsArg, adultsArg] = process.argv.slice(2);
if (!wahHotelId || !checkIn || !nightsArg) {
  console.error('usage: ladder-trace.mjs <wahHotelId> <checkIn> <nights> [adults]');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. This reads a real database or nothing.');
  process.exit(2);
}

process.env.WAHPI_LADDER_TRACE = '1';

const nights = Number(nightsArg);
const adults = Number(adultsArg ?? '2');

let config;
try {
  ({ config } = await loadActiveConfig());
} catch (err) {
  // err.message only: a pg connection error can carry the connection string.
  console.error(`Could not read the active config: ${err?.message ?? 'unknown error'}`);
  process.exit(2);
}

console.log(`config version ${config?.version}`);
console.log(`stay: hotel ${wahHotelId}, ${checkIn} × ${nights}n × ${adults}a\n`);

let loaded;
try {
  loaded = await loadLiveIntelligence(
    { wahHotelId, checkIn, nights, adults, children: 0, currency: null },
    config,
  );
} catch (err) {
  console.error(`\nloadLiveIntelligence threw: ${err?.message ?? 'unknown error'}`);
  await closePool();
  process.exit(1);
}

console.log('');
if (loaded && 'kind' in loaded) {
  console.log(`outcome: ${loaded.kind}`);
} else {
  const cs = loaded.compSet;
  console.log(
    `outcome: radius ${loaded.competitiveRadiusMiles}mi · expanded ${loaded.radiusExpanded} · ` +
      `isolated ${loaded.isolatedMarket} · basis ${loaded.compBasis} · room ${loaded.compRoomMatch}`,
  );
  console.log(
    `comp set: comps ${cs?.compsUsed ?? '—'} · index ${cs?.csi ?? '—'} · ` +
      `reason ${cs?.signal?.unavailableReason ?? 'available'}`,
  );
}

await closePool();
