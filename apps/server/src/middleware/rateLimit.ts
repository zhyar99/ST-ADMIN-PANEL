import type { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';

import { config } from '../config';

/**
 * Integration tests need to hit the auth endpoints far more than a real client
 * would, so they opt out with this header. It is honoured only under
 * NODE_ENV=test — in development and production the limiter always applies.
 */
const TEST_BYPASS_HEADER = 'x-test-bypass-rate-limit';

function bypassedByTest(req: Request): boolean {
  return config.NODE_ENV === 'test' && req.get(TEST_BYPASS_HEADER) === '1';
}

/** Every budget below is spent over the same 15-minute window. */
const WINDOW_MS = 15 * 60_000;

const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function limiter(limit: number, windowMs: number, message: string): RateLimitRequestHandler {
  return rateLimit({
    windowMs,
    limit,
    // draft-7 rather than `standardHeaders: true` (draft-6): it emits
    // `RateLimit-Policy` plus a combined `RateLimit` header, and `Retry-After`
    // on a 429, which is what the clients built in earlier phases already read.
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: bypassedByTest,
    message: { error: { code: 'TOO_MANY_REQUESTS', message } },
  });
}

/**
 * Credential endpoints: 10 attempts per IP per 15 minutes.
 *
 * Successful logins still count — the limit is on attempts from an IP, not on
 * failures, so a stolen credential list cannot be walked quickly.
 */
export const authLimiter: RateLimitRequestHandler = limiter(
  10,
  WINDOW_MS,
  'Too many attempts. Try again later.',
);

/** Phase 13: writes under /api/v1/admin — 200 per IP per 15 minutes. */
export const adminWriteLimiter: RateLimitRequestHandler = limiter(
  200,
  WINDOW_MS,
  'Too many write requests. Slow down.',
);

/** Phase 13: consumer reads under /api/v1 — 300 per IP per 15 minutes. */
export const consumerReadLimiter: RateLimitRequestHandler = limiter(
  300,
  WINDOW_MS,
  'Too many requests. Slow down.',
);

/** Phase 13: media uploads — 30 per IP per 15 minutes. */
export const uploadLimiter: RateLimitRequestHandler = limiter(
  30,
  WINDOW_MS,
  'Too many uploads. Try again later.',
);

/**
 * Watch-event ingestion: 60 events per *device* per minute (Phase 15).
 *
 * Keyed on the device id rather than the IP, which is the only key that means
 * anything on this route: an entire household — or an entire hotel — shares one
 * NAT address, and an IP budget would throttle the fiftieth room because of the
 * first. A device posting more than one event per second is retrying, not
 * watching.
 *
 * A request with no device header falls back to the IP, so the limiter cannot
 * be escaped by simply omitting the header. The key is a raw device id, and
 * express-rate-limit keeps it in memory only — it is never logged.
 */
export const deviceWatchLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: bypassedByTest,
  keyGenerator: (req: Request) => req.get('x-device-id') ?? req.ip ?? 'unknown',
  message: {
    error: { code: 'TOO_MANY_REQUESTS', message: 'Too many watch events. Slow down.' },
  },
});

/**
 * Fallback limiter: 200 requests per IP per minute.
 *
 * Deliberately *not* folded into the 15-minute budgets above. It covers admin
 * reads, which a single operator generates in bursts — one Movies page opening
 * fires a list, a genre lookup and a poster fetch per row — and several
 * operators commonly share one office IP. A 300-per-15-minutes cap would make
 * the panel unusable for them, so admin reads keep the per-minute burst budget
 * that Phases 1-12 shipped with, and the tighter 15-minute budgets apply where
 * the prompt asks for them: credentials, admin writes, uploads and the
 * unauthenticated consumer surface.
 */
export const apiLimiter: RateLimitRequestHandler = limiter(
  200,
  60_000,
  'Too many requests. Slow down.',
);

/**
 * Picks the limiter for a request under `/api/v1`.
 *
 * Mounted once, at the prefix, rather than sprinkled over the routers: the
 * choice is a property of the method and the path, so keeping it in one
 * function means a new route inherits the right budget instead of inheriting
 * whichever limiter its author remembered to attach.
 */
export const apiRateLimit: RequestHandler = function apiRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const isAdmin = req.path === '/admin' || req.path.startsWith('/admin/');

  if (isAdmin) {
    const handler = WRITE_METHODS.has(req.method) ? adminWriteLimiter : apiLimiter;
    handler(req, res, next);
    return;
  }

  const handler =
    req.method === 'GET' || req.method === 'HEAD' ? consumerReadLimiter : apiLimiter;
  handler(req, res, next);
};
