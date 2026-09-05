import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { config } from './config';
import { logger } from './logger';
import { errorHandler } from './middleware/errorHandler';
import { apiRateLimit } from './middleware/rateLimit';
import { requestId } from './middleware/requestId';
import { apiRouter } from './routes/api';
import { pool } from './db/client';
import { STORAGE_SUBDIRECTORIES } from './storage/ensureStorage';

/** Matches /admin and anything below it, for the SPA history fallback. */
const ADMIN_SPA_ROUTE = /^\/admin(?:\/.*)?$/;

/**
 * The origin `STORAGE_URL_PREFIX` points at, or nothing when it is same-origin.
 *
 * Storage is same-origin in the single-process deployment this phase targets,
 * but the prefix exists so it can become a CDN — and a CSP that only ever said
 * `'self'` would silently blank every poster the day someone did that.
 */
function storageOrigin(): string[] {
  try {
    return [new URL(config.STORAGE_URL_PREFIX).origin];
  } catch {
    // A relative prefix (e.g. "/storage") is same-origin, so 'self' covers it.
    return [];
  }
}

/**
 * Content-Security-Policy for the Admin SPA and the API.
 *
 * Production is the strict case and the one that matters: scripts come from
 * this origin only, with no `'unsafe-inline'` — the Vite build emits a single
 * module bundle and no inline script, so nothing needs it. `'unsafe-inline'`
 * does stay in `style-src`: dnd-kit writes drag transforms to the `style`
 * attribute, and the CSP3 directive that would allow only that
 * (`style-src-attr`) is not yet safe to rely on across the browsers this panel
 * supports.
 *
 * Development adds inline and eval script sources plus websocket connections,
 * which is what Vite's HMR client needs. It is gated on NODE_ENV, so a
 * production process cannot serve the relaxed policy.
 */
function contentSecurityPolicy() {
  const storage = storageOrigin();
  const development = config.NODE_ENV === 'development';

  return {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'base-uri': ["'self'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
      'object-src': ["'none'"],
      'script-src': development ? ["'self'", "'unsafe-inline'", "'unsafe-eval'"] : ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'blob:', ...storage],
      'media-src': ["'self'", 'blob:', ...storage],
      'font-src': ["'self'", 'data:'],
      'worker-src': ["'self'", 'blob:'],
      'connect-src': development
        ? ["'self'", 'ws:', 'wss:']
        : ["'self'", 'https://*.sentry.io', ...storage],
      ...(config.isProduction ? { 'upgrade-insecure-requests': [] } : {}),
    },
  };
}

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  /**
   * Trust the platform's edge proxy so `req.ip` is the client, not the proxy.
   *
   * Every rate limiter in this app is keyed on the address Express reports, so
   * getting this wrong is not cosmetic: with a proxy in front and no trust
   * setting, all traffic shares one bucket and one busy client locks everyone
   * out. Express also refuses to read `X-Forwarded-Proto` without it, which is
   * what tells the app a request arrived over TLS.
   */
  app.set('trust proxy', config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: contentSecurityPolicy(),
      // The SPA and its assets are same-origin; storage files must stay loadable
      // by the player/app running on another origin.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      frameguard: { action: 'deny' },
      noSniff: true,
      xssFilter: true,
      // Only meaningful over TLS, and asserting it from a plain-HTTP dev server
      // would pin a developer's browser to https://localhost for a year.
      hsts: config.isProduction
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
        : false,
    }),
  );
  // Deliberately small: every JSON endpoint in this API takes a form's worth of
  // fields, and files arrive as multipart through multer rather than here.
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: true, limit: '64kb' }));
  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as Request).id ?? 'unknown',
    }),
  );

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  /**
   * Readiness probe.
   *
   * Reports *which* dependency is unhealthy and nothing more — no connection
   * string, no filesystem path, no driver message. A probe is reachable from
   * wherever the load balancer is, so its failure body is a public one.
   */
  app.get('/ready', async (_req: Request, res: Response) => {
    const details: string[] = [];

    try {
      await pool.query('SELECT 1');
    } catch (error) {
      logger.error({ err: error }, 'Readiness check failed: database');
      details.push('database');
    }

    const directories = ['', ...STORAGE_SUBDIRECTORIES];

    await Promise.all(
      directories.map(async (directory) => {
        try {
          await fs.access(path.join(config.storageDir, directory), fsConstants.W_OK);
        } catch (error) {
          logger.error({ err: error, directory }, 'Readiness check failed: storage');
          details.push(directory === '' ? 'storage' : `storage/${directory}`);
        }
      }),
    );

    if (details.length === 0) {
      res.json({ status: 'ready' });
      return;
    }

    res.status(503).json({ status: 'not_ready', details: details.sort() });
  });

  // Uploaded media — content-addressed filenames, so cache hard.
  app.use(
    '/storage',
    express.static(config.storageDir, {
      index: false,
      maxAge: '1y',
      immutable: true,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }),
  );

  app.use('/api/v1', apiRateLimit);
  app.use('/api/v1', apiRouter);

  // Built Admin SPA (only present after `pnpm build`).
  app.use('/admin', express.static(config.adminDir, { index: 'index.html' }));
  app.get(ADMIN_SPA_ROUTE, (_req: Request, res: Response) => {
    res.sendFile(path.join(config.adminDir, 'index.html'));
  });

  app.use(errorHandler);

  return app;
}

export const app = createApp();
