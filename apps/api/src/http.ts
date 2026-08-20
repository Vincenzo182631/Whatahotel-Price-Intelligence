/**
 * HTTP plumbing: routing, the error envelope, validation and caching headers.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export type ErrorCode =
  | 'INVALID_PARAMETER'
  | 'HOTEL_NOT_FOUND'
  | 'ROOM_TYPE_NOT_FOUND'
  | 'NO_CURRENT_RATE'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

const STATUS_FOR: Record<ErrorCode, number> = {
  INVALID_PARAMETER: 400,
  HOTEL_NOT_FOUND: 404,
  ROOM_TYPE_NOT_FOUND: 404,
  NO_CURRENT_RATE: 409,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 503,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return STATUS_FOR[this.code];
  }
}

export interface RequestContext {
  readonly requestId: string;
  readonly url: URL;
  readonly params: Record<string, string>;
}

export function newRequestId(): string {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  let out = '';
  for (let i = 0; i < 16; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `req_${out}`;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, error: ApiError, requestId: string): void {
  sendJson(res, error.status, {
    error: { code: error.code, message: error.message, details: error.details },
    request_id: requestId,
  });
}

// ── Validation ────────────────────────────────────────────────────────────
// Reject rather than coerce, and say which parameter was wrong. A silently
// defaulted date produces a confidently wrong answer about the wrong stay.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function requireString(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value.trim() === '') {
    throw new ApiError('INVALID_PARAMETER', `Missing required parameter: ${name}`, {
      parameter: name,
    });
  }
  return value.trim();
}

export function requireDate(url: URL, name: string): string {
  const value = requireString(url, name);
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ApiError('INVALID_PARAMETER', `${name} must be a date in YYYY-MM-DD form`, {
      parameter: name,
      value,
    });
  }
  return value;
}

export function optionalInt(
  url: URL,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(
      'INVALID_PARAMETER',
      `${name} must be an integer between ${min} and ${max}`,
      {
        parameter: name,
        value: raw,
      },
    );
  }
  return value;
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  const nights = Math.round(
    (Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000,
  );
  if (nights < 1) {
    throw new ApiError('INVALID_PARAMETER', 'check_out must be after check_in', {
      check_in: checkIn,
      check_out: checkOut,
    });
  }
  if (nights > 30) {
    throw new ApiError('INVALID_PARAMETER', 'Stays longer than 30 nights are not supported', {
      nights,
    });
  }
  return nights;
}

// ── Routing ───────────────────────────────────────────────────────────────

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
) => Promise<void> | void;

interface Route {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  get(pattern: string, handler: Handler): this {
    this.routes.push({
      method: 'GET',
      segments: pattern.split('/').filter(Boolean),
      handler,
    });
    return this;
  }

  match(
    method: string,
    pathname: string,
  ): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;

      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const segment = route.segments[i]!;
        const part = parts[i]!;
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(part);
        } else if (segment !== part) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return null;
  }
}

export function cacheHeaders(ttlSeconds: number, staleSeconds: number): Record<string, string> {
  return {
    // s-maxage is what lets the CDN in front of the serverless function cache
    // the response: two guests asking about the same hotel and dates within
    // the TTL cost one function invocation and zero database reads for the
    // second. The URL is the cache key, so distinct stays never collide.
    'cache-control': `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}, stale-while-revalidate=${staleSeconds}`,
  };
}

export function money(amountMinor: number | null, currency: string): unknown {
  return amountMinor === null ? null : { amount_minor: amountMinor, currency };
}
