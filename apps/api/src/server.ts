/**
 * The MVP API server.
 *
 * Node's built-in http rather than a framework: the MVP surface is nine
 * read-mostly endpoints, and the value in this project is the scoring engine,
 * not the request plumbing.
 *
 * DEVIATION FROM SPEC (docs/mvp/09 §1) — the plan named Next.js, chosen for SSR
 * because Phase 5 is an SEO play. MVP has no SSR requirement, and this keeps the
 * service dependency-light and directly testable. When Phase 5 arrives, these
 * handlers become Next route handlers largely unchanged; the widget is already
 * framework-free and needs no migration.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePool } from '@wahpi/data';

import { ApiError, Router, newRequestId, sendError, sendJson } from './http.js';
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

const PORT = Number(process.env.PORT ?? 3000);
const WEB_ROOT = fileURLToPath(new URL('../../web/public', import.meta.url));

const router = new Router()
  .get('/api/v1/health', healthHandler)
  .get('/api/v1/hotels', searchHotelsHandler)
  .get('/api/v1/hotels/:hotel_id', hotelDetailHandler)
  .get('/api/v1/hotels/:hotel_id/room-types', roomTypesHandler)
  .get('/api/v1/hotels/:hotel_id/price-history', priceHistoryHandler)
  .get('/api/v1/hotels/:hotel_id/comparables', comparablesHandler)
  .get('/api/v1/price-intelligence', priceIntelligenceHandler)
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

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const requestId = newRequestId();
  const started = Date.now();
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // CORS: the widget is embedded on whatahotel.com (U18). Origins should be
  // allowlisted in production rather than reflected.
  const allowedOrigin = process.env.CORS_ORIGIN ?? '*';
  res.setHeader('access-control-allow-origin', allowedOrigin);
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
});

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
