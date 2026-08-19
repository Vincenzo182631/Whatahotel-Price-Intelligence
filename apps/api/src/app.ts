/**
 * The request handler, separated from the server that listens.
 *
 * Two deployment shapes consume this one handler:
 *
 *   - `server.ts` wraps it in `createServer().listen()` for local development
 *     and any container host.
 *   - `api/index.mjs` (repo root) exports it as a Vercel function, where the
 *     platform owns the socket and the widget's static files are served by the
 *     CDN rather than `serveStatic` below.
 *
 * Keeping one handler is the point: the routing, CORS and error behaviour a
 * guest hits in production is byte-for-byte what `npm run api` and the smoke
 * tests exercise locally. A second "production" handler would drift, and the
 * drifted one is the one nobody runs on their machine.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiError, Router, newRequestId, sendError, sendJson } from './http.js';
import { liveIntelligenceHandler } from './routes/liveIntelligence.js';
import { priceIntelligenceHandler } from './routes/priceIntelligence.js';
import {
  analysisDebugHandler,
  comparablesHandler,
  healthHandler,
  hotelDetailHandler,
  metaConfigHandler,
  priceHistoryHandler,
  roomTypesHandler,
  searchHotelsHandler,
} from './routes/supporting.js';

const WEB_ROOT = fileURLToPath(new URL('../../web/public', import.meta.url));

const router = new Router()
  .get('/api/v1/health', healthHandler)
  .get('/api/v1/hotels', searchHotelsHandler)
  .get('/api/v1/hotels/:hotel_id', hotelDetailHandler)
  .get('/api/v1/hotels/:hotel_id/room-types', roomTypesHandler)
  .get('/api/v1/hotels/:hotel_id/price-history', priceHistoryHandler)
  .get('/api/v1/hotels/:hotel_id/comparables', comparablesHandler)
  .get('/api/v1/price-intelligence', priceIntelligenceHandler)
  .get('/api/v1/live-intelligence', liveIntelligenceHandler)
  .get('/api/v1/meta/config', metaConfigHandler)
  .get('/internal/v1/analyses/:public_id', analysisDebugHandler);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  const relative = pathname === '/' ? '/index.html' : pathname;
  // Contain the path inside WEB_ROOT — a `..` in the URL must not escape it.
  const resolved = join(WEB_ROOT, normalize(relative).replace(/^(\.\.[/\\])+/, ''));
  if (!resolved.startsWith(WEB_ROOT)) return false;

  try {
    const info = await stat(resolved);
    if (!info.isFile()) return false;
    res.writeHead(200, {
      'content-type': MIME[extname(resolved)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'public, max-age=60',
    });
    createReadStream(resolved).pipe(res);
    return true;
  } catch {
    return false;
  }
}

/**
 * The CORS origin to grant this request, or null for none.
 *
 * `CORS_ORIGIN` is a comma-separated allowlist ("https://www.whatahotel.com,
 * https://whatahotel.com"), compared case-insensitively against the request's
 * Origin. Unset or "*" grants everyone — right for development, wrong for
 * production, and the deploy runbook says so.
 *
 * An origin off the list gets NO header rather than a reflected one: reflecting
 * whatever arrives is how an allowlist quietly becomes "everyone". Same-origin
 * requests carry no Origin header and need no grant.
 */
export function corsOriginFor(requestOrigin: string | undefined): string | null {
  const configured = (process.env.CORS_ORIGIN ?? '*').trim();
  if (configured === '' || configured === '*') return '*';

  if (!requestOrigin) return null;
  const allowed = configured.split(',').map((o) => o.trim().toLowerCase());
  return allowed.includes(requestOrigin.toLowerCase()) ? requestOrigin : null;
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = newRequestId();
  const started = Date.now();
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  const grant = corsOriginFor(req.headers.origin);
  if (grant !== null) res.setHeader('access-control-allow-origin', grant);
  res.setHeader('vary', 'origin');
  res.setHeader('x-request-id', requestId);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-methods': 'GET,OPTIONS' });
    res.end();
    return;
  }

  try {
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204, { 'cache-control': 'public, max-age=86400' });
      res.end();
      return;
    }

    const route = router.match(req.method ?? 'GET', url.pathname);
    if (route) {
      await route.handler(req, res, { requestId, url, params: route.params });
    } else if (req.method === 'GET' && (await serveStatic(url.pathname, res))) {
      // served
    } else {
      throw new ApiError('NOT_FOUND', `No route for ${req.method} ${url.pathname}`);
    }
  } catch (err) {
    if (err instanceof ApiError) {
      sendError(res, err, requestId);
    } else {
      console.error(`[${requestId}] unhandled error:`, err);
      sendJson(res, 500, {
        error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.', details: {} },
        request_id: requestId,
      });
    }
  } finally {
    const ms = Date.now() - started;
    if (process.env.LOG_REQUESTS !== '0') {
      console.log(
        `${req.method} ${url.pathname}${url.search} → ${res.statusCode} ${ms}ms ${requestId}`,
      );
    }
  }
}
