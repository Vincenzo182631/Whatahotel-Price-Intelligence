/**
 * The Vercel function entry point.
 *
 * One line of substance on purpose: it re-exports the SAME handler that
 * `npm run api` and the smoke tests run locally (apps/api/src/app.ts). All
 * /api/v1/* and /internal/v1/* paths are rewritten here by vercel.json; the
 * widget's static files are served by the CDN from apps/web/public, so the
 * in-handler static fallback simply never fires on this host.
 *
 * Environment this function needs (set in the Vercel project, never here):
 *   DATABASE_URL   use the Neon POOLER hostname (`...-pooler...`) — serverless
 *                  instances each open their own connection, and the direct
 *                  endpoint's connection limit is for migrations, not traffic.
 *   CORS_ORIGIN    comma-separated allowlist, e.g.
 *                  https://www.whatahotel.com,https://whatahotel.com
 *                  Leaving it unset grants "*", which is for development only.
 */

import { handleRequest } from '../apps/api/dist/app.js';

export default handleRequest;
