/**
 * The MVP API server.
 *
 * Node's built-in http rather than a framework: the MVP surface is nine
 * read-mostly endpoints, and the value in this project is the scoring engine,
 * not the request plumbing.
 *
 * The request handler lives in `app.ts`; this file only owns the socket and
 * the shutdown. That split exists because Vercel consumes the same handler as
 * a function (see `api/index.mjs` at the repo root) — one handler, two hosts,
 * no drift between what runs locally and what a guest hits.
 *
 * DEVIATION FROM SPEC (docs/mvp/09 §1) — the plan named Next.js, chosen for SSR
 * because Phase 5 is an SEO play. MVP has no SSR requirement, and this keeps the
 * service dependency-light and directly testable. When Phase 5 arrives, these
 * handlers become Next route handlers largely unchanged; the widget is already
 * framework-free and needs no migration.
 */

import { createServer } from 'node:http';

import { closePool } from '@wahpi/data';

import { handleRequest } from './app.js';

const PORT = Number(process.env.PORT ?? 3000);

const server = createServer((req, res) => void handleRequest(req, res));

server.listen(PORT, () => {
  console.log(`WhataHotel Price Intelligence API listening on http://localhost:${PORT}`);
  console.log(`Demo widget: http://localhost:${PORT}/`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received, shutting down.`);
  server.close();
  await closePool();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

export { server };
