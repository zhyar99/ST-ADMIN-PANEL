import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Must come before any module that creates a router: importing it installs the
// mount-path recorder that `routesUnder` reads. See the module's own note.
import { restoreRouterPrototype, routesUnder, type DiscoveredRoute } from './support/routerRecorder';

import { apiRouter } from '../routes/api';
import { app } from '../app';
import { signAccessToken } from '../lib/tokens';

/**
 * Route-coverage guard.
 *
 * Every route under `/api/v1` is enumerated from the live Express router — not
 * from a list maintained by hand — and each one has to be classified below.
 * Adding a route without classifying it fails this suite, which is the point:
 * the failure mode this guards against is a new admin endpoint that nobody
 * remembered to put behind `adminAuth` or `requireRole`.
 *
 * No database. Every assertion here is about a request that is rejected in
 * middleware, so no handler runs; `db/client` is mocked so that a route which
 * *did* reach its handler would fail loudly instead of quietly querying
 * Postgres.
 */

vi.mock('../db/client', () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error('A route reached the database before authentication');
      },
    },
  ),
  pool: {
    query: () => Promise.reject(new Error('A route reached the database before authentication')),
    end: () => Promise.resolve(),
  },
}));

restoreRouterPrototype();

// `/api/v1` is the one prefix the recorder cannot capture: it is mounted on the
// Express application, not on a Router.
const discovered = routesUnder(apiRouter as unknown as object, '/api/v1');

const key = (route: DiscoveredRoute): string => `${route.method} ${route.path}`;

// --- classification --------------------------------------------------------

/**
 * PUBLIC     — reachable with no credentials, by design.
 * ANY_ROLE   — requires a valid token; ADMIN and VIEWER may both call it.
 * ADMIN_ONLY — requires a valid token whose role is ADMIN.
 */
type Access = 'PUBLIC' | 'ANY_ROLE' | 'ADMIN_ONLY';

const ROUTE_ACCESS: Readonly<Record<string, Access>> = {
  // --- auth ---------------------------------------------------------------
  'POST /api/v1/admin/auth/login': 'PUBLIC',
  'POST /api/v1/admin/auth/refresh': 'PUBLIC',
  'POST /api/v1/admin/auth/logout': 'ANY_ROLE',
  'GET /api/v1/admin/auth/me': 'ANY_ROLE',

  // --- users --------------------------------------------------------------
  'GET /api/v1/admin/users': 'ADMIN_ONLY',
  'POST /api/v1/admin/users': 'ADMIN_ONLY',
  'PATCH /api/v1/admin/users/:id': 'ADMIN_ONLY',
  'DELETE /api/v1/admin/users/:id': 'ADMIN_ONLY',

  // --- media library ------------------------------------------------------
  // Uploading is open to any authenticated admin (a VIEWER preparing artwork);
  // removing a file from the library is not.
  'POST /api/v1/admin/assets/upload/:kind': 'ANY_ROLE',
  'GET /api/v1/admin/assets': 'ANY_ROLE',
  'GET /api/v1/admin/assets/:id': 'ANY_ROLE',
  'DELETE /api/v1/admin/assets/:id': 'ADMIN_ONLY',

  // --- genres -------------------------------------------------------------
  'GET /api/v1/admin/genres': 'ANY_ROLE',
  'POST /api/v1/admin/genres': 'ADMIN_ONLY',
  'PATCH /api/v1/admin/genres/:id': 'ADMIN_ONLY',
  'DELETE /api/v1/admin/genres/:id': 'ADMIN_ONLY',

  // --- movies -------------------------------------------------------------
  'GET /api/v1/admin/movies': 'ANY_ROLE',
  'POST /api/v1/admin/movies': 'ADMIN_ONLY',
  'GET /api/v1/admin/movies/:id': 'ANY_ROLE',
  'PATCH /api/v1/admin/movies/:id': 'ADMIN_ONLY',
  'DELETE /api/v1/admin/movies/:id': 'ADMIN_ONLY',
  'POST /api/v1/admin/movies/:id/publish': 'ADMIN_ONLY',
  'POST /api/v1/admin/movies/:id/unpublish': 'ADMIN_ONLY',

  // Stream sources are the sensitive surface: the whole subtree is ADMIN-only,
  // including every read, because a source row carries the playable URL.
  'GET /api/v1/admin/movies/:movieId/sources': 'ADMIN_ONLY',
  'POST /api/v1/admin/movies/:movieId/sources': 'ADMIN_ONLY',
  'POST /api/v1/admin/movies/:movieId/sources/reorder': 'ADMIN_ONLY',
  'PATCH /api/v1/admin/movies/:movieId/sources/:sourceId': 'ADMIN_ONLY',
  'DELETE /api/v1/admin/movies/:movieId/sources/:sourceId': 'ADMIN_ONLY',
  'GET /api/v1/admin/movies/:movieId/sources/:sourceId/url': 'ADMIN_ONLY',
  'POST /api/v1/admin/movies/:movieId/sources/:sourceId/test': 'ADMIN_ONLY',

  'GET /api/v1/admin/movies/:movieId/subtitles': 'ANY_ROLE',
  'POST /api/v1/admin/movies/:movieId/subtitles': 'ADMIN_ONLY',
  'DELETE /api/v1/admin/movies/:movieId/subtitles/:subtitleId': 'ADMIN_ONLY',

  // --- series -------------------------------------------------------------
  'GET /api/v1/admin/series': 'ANY_ROLE',
  'POST /api/v1/admin/series': 'ADMIN_ONLY',
  'GET /api/v1/admin/series/:seriesId': 'ANY_ROLE',
  'PATCH /api/v1/admin/series/:seriesId': 'ADMIN_ONLY',
  'DELETE /api/v1/admin/series/:seriesId': 'ADMIN_ONLY',
  'POST /api/v1/admin/series/:seriesId/publish': 'ADMIN_ONLY',
  'POST /api/v1/admin/series/:seriesId/unpublish': 'ADMIN_ONLY',
  'GET /api/v1/admin/series/:seriesId/seasons': 'ANY_ROLE',
  'POST /api/v1/admin/series/:seriesId/seasons': 'ADMIN_ONLY',
  'DELETE /api/v1/admin/series/:seriesId/seasons/:seasonId': 'ADMIN_ONLY',
  'GET /api/v1/admin/series/:seriesId/seasons/:seasonId/episodes': 'ANY_ROLE',
  'POST /api/v1/admin/series/:seriesId/seasons/:seasonId/episodes': 'ADMIN_ONLY',
  'GET /api/v1/admin/series/:seriesId/seasons/:seasonId/episodes/:episodeId': 'ANY_ROLE',
  'PATCH /api/v1/admin/series/:seriesId/seasons/:seasonId/episodes/:episodeId': 'ADMIN_ONLY',
  'DELETE /api/v1/admin/series/:seriesId/seasons/:seasonId/episodes/:episodeId': 'ADMIN_ONLY',
  'POST /api/v1/admin/series/:seriesId/seasons/:seasonId/episodes/:episodeId/publish':
    'ADMIN_ONLY',
  'POST /api/v1/admin/series/:seriesId/seasons/:seasonId/episodes/:episodeId/unpublish':
    'ADMIN_ONLY',
  'GET /api/v1/admin/series/:seriesId/seasons/:seasonId/episodes/:episodeId/sources':
    'ADMIN_ONLY',
  'POST /api/v1/admin/series/:seriesId/seasons/:seasonId/episodes/:episodeId/sources':
    'ADMIN_ONLY',
  'POST /api/v1/admin/series/:seriesId/seasons/:seasonId/episodes/:episodeId/sources/reorder':
    'ADMIN_ONLY',
  'PATCH /api/v1/admin/series/:seriesId/seasons/:seasonId/episodes/:episodeId/sources/:sourceId':
    'ADMIN_ONLY',
  'DELETE /api/v1/admin/series/:seriesId/seasons/:seasonId/episodes/:episodeId/sources/:sourceId':
    'ADMIN_ONLY',
  'GET /api/v1/admin/series/:seriesId/seasons/:seasonId/episodes/:episodeId/sources/:sourceId/url':
    'ADMIN_ONLY',
  'POST /api/v1/admin/series/:seriesId/seasons/:seasonId/episodes/:episodeId/sources/:sourceId/test':
    'ADMIN_ONLY',
  'GET /api/v1/admin/series/:seriesId/seasons/:seasonId/episodes/:episodeId/subtitles': 'ANY_ROLE',
  'POST /api/v1/admin/series/:seriesId/seasons/:seasonId/episodes/:episodeId/subtitles':
    'ADMIN_ONLY',
  'DELETE /api/v1/admin/series/:seriesId/seasons/:seasonId/episodes/:episodeId/subtitles/:subtitleId':
    'ADMIN_ONLY',

  // --- live channels ------------------------------------------------------
  'GET /api/v1/admin/live-channels': 'ANY_ROLE',
  'GET /api/v1/admin/live-channels/categories': 'ANY_ROLE',
  'POST /api/v1/admin/live-channels': 'ADMIN_ONLY',
  'GET /api/v1/admin/live-channels/:id': 'ANY_ROLE',
  'PATCH /api/v1/admin/live-channels/:id': 'ADMIN_ONLY',
  'DELETE /api/v1/admin/live-channels/:id': 'ADMIN_ONLY',
  'POST /api/v1/admin/live-channels/:id/publish': 'ADMIN_ONLY',
  'POST /api/v1/admin/live-channels/:id/unpublish': 'ADMIN_ONLY',
  'GET /api/v1/admin/live-channels/:channelId/sources': 'ADMIN_ONLY',
  'POST /api/v1/admin/live-channels/:channelId/sources': 'ADMIN_ONLY',
  'POST /api/v1/admin/live-channels/:channelId/sources/reorder': 'ADMIN_ONLY',
  'PATCH /api/v1/admin/live-channels/:channelId/sources/:sourceId': 'ADMIN_ONLY',
  'DELETE /api/v1/admin/live-channels/:channelId/sources/:sourceId': 'ADMIN_ONLY',
  'GET /api/v1/admin/live-channels/:channelId/sources/:sourceId/url': 'ADMIN_ONLY',
  'POST /api/v1/admin/live-channels/:channelId/sources/:sourceId/test': 'ADMIN_ONLY',

  // --- stream source health ----------------------------------------------
  'GET /api/v1/admin/stream-sources/:sourceId/health-history': 'ADMIN_ONLY',

  // --- home curation ------------------------------------------------------
  'GET /api/v1/admin/home/content-search': 'ANY_ROLE',
  'GET /api/v1/admin/home/content-lookup': 'ANY_ROLE',
  'GET /api/v1/admin/home/rows': 'ANY_ROLE',
  'POST /api/v1/admin/home/rows': 'ADMIN_ONLY',
  'PUT /api/v1/admin/home/rows/reorder': 'ADMIN_ONLY',
  'GET /api/v1/admin/home/rows/:id': 'ANY_ROLE',
  'PATCH /api/v1/admin/home/rows/:id': 'ADMIN_ONLY',
  'DELETE /api/v1/admin/home/rows/:id': 'ADMIN_ONLY',

  // --- advertising --------------------------------------------------------
  'GET /api/v1/admin/advertising/config': 'ANY_ROLE',
  'PUT /api/v1/admin/advertising/config': 'ADMIN_ONLY',
  'GET /api/v1/admin/advertising/creatives': 'ANY_ROLE',
  'POST /api/v1/admin/advertising/creatives': 'ADMIN_ONLY',
  'PATCH /api/v1/admin/advertising/creatives/:id': 'ADMIN_ONLY',
  'DELETE /api/v1/admin/advertising/creatives/:id': 'ADMIN_ONLY',

  // --- playlist import ----------------------------------------------------
  // Reads are open to any authenticated admin so a VIEWER can watch an import
  // land; the entry list omits `raw_url` for them. Everything that writes to
  // the catalogue, and the link-target search that only the approve flow uses,
  // is ADMIN-only.
  'POST /api/v1/admin/import/jobs': 'ADMIN_ONLY',
  'GET /api/v1/admin/import/jobs': 'ANY_ROLE',
  'GET /api/v1/admin/import/link-targets': 'ADMIN_ONLY',
  'GET /api/v1/admin/import/jobs/:jobId': 'ANY_ROLE',
  'GET /api/v1/admin/import/jobs/:jobId/entries': 'ANY_ROLE',
  'PATCH /api/v1/admin/import/jobs/:jobId/entries/:entryId/approve': 'ADMIN_ONLY',
  'PATCH /api/v1/admin/import/jobs/:jobId/entries/:entryId/reject': 'ADMIN_ONLY',
  'POST /api/v1/admin/import/jobs/:jobId/bulk-approve': 'ADMIN_ONLY',
  'DELETE /api/v1/admin/import/jobs/:jobId': 'ADMIN_ONLY',

  // --- device analytics (Phase 15) ----------------------------------------
  // Platform-wide aggregates are readable by a VIEWER; everything addressed to
  // one device is ADMIN-only, because a single device's data is one
  // household's viewing history.
  'GET /api/v1/admin/analytics/devices': 'ANY_ROLE',
  'GET /api/v1/admin/analytics/trending': 'ANY_ROLE',
  'GET /api/v1/admin/analytics/devices/:device_id': 'ADMIN_ONLY',
  'GET /api/v1/admin/analytics/devices/:device_id/recommendations': 'ADMIN_ONLY',
  'PATCH /api/v1/admin/analytics/devices/:device_id/block': 'ADMIN_ONLY',

  'GET /api/v1/admin/recommendation-boosts': 'ANY_ROLE',
  'POST /api/v1/admin/recommendation-boosts': 'ADMIN_ONLY',
  'DELETE /api/v1/admin/recommendation-boosts/:id': 'ADMIN_ONLY',

  // --- consumer surface ---------------------------------------------------
  // Unauthenticated by design (Phase 9): consumer accounts are deferred.
  'GET /api/v1/movies': 'PUBLIC',
  'GET /api/v1/movies/:id': 'PUBLIC',
  'GET /api/v1/series': 'PUBLIC',
  'GET /api/v1/series/:id': 'PUBLIC',
  'GET /api/v1/live-channels': 'PUBLIC',
  'GET /api/v1/home': 'PUBLIC',
  'GET /api/v1/search': 'PUBLIC',
  // The one consumer *write*. It creates no persistent state — it reads a
  // source and returns it — and it is POST rather than GET precisely so the
  // stream URL never lands in a cache, a proxy log or browser history.
  'POST /api/v1/playback/session': 'PUBLIC',

  // Device personalization (Phase 15). Public in the same sense the rest of
  // the consumer surface is: there is no account to authenticate. What scopes
  // these is the `X-Device-ID` header, which every handler reads from the
  // request and never from a body or a query — see `routes/consumer/devices.ts`.
  'POST /api/v1/devices/watch': 'PUBLIC',
  'GET /api/v1/devices/recommendations': 'PUBLIC',
  'POST /api/v1/devices/favorites': 'PUBLIC',
  'GET /api/v1/devices/favorites': 'PUBLIC',
  'DELETE /api/v1/devices/favorites/:content_type/:content_id': 'PUBLIC',
  'POST /api/v1/devices/watchlist': 'PUBLIC',
  'GET /api/v1/devices/watchlist': 'PUBLIC',
  'DELETE /api/v1/devices/watchlist/:content_type/:content_id': 'PUBLIC',
  'GET /api/v1/devices/history': 'PUBLIC',
};

/** The routes the phase brief names explicitly, mapped onto this API's paths. */
const REQUIRED_ADMIN_ROUTES: readonly string[] = [
  'POST /api/v1/admin/movies',
  'PATCH /api/v1/admin/movies/:id',
  'DELETE /api/v1/admin/movies/:id',
  'POST /api/v1/admin/movies/:id/publish',
  'POST /api/v1/admin/movies/:id/unpublish',
  'GET /api/v1/admin/movies/:movieId/sources',
  'POST /api/v1/admin/series',
  'PATCH /api/v1/admin/series/:seriesId',
  'DELETE /api/v1/admin/series/:seriesId',
  'POST /api/v1/admin/live-channels',
  'PATCH /api/v1/admin/live-channels/:id',
  'DELETE /api/v1/admin/live-channels/:id',
  'POST /api/v1/admin/assets/upload/:kind',
  'DELETE /api/v1/admin/assets/:id',
  'GET /api/v1/admin/users',
  'POST /api/v1/admin/users',
  'DELETE /api/v1/admin/users/:id',
  'PUT /api/v1/admin/advertising/config',
  'POST /api/v1/admin/import/jobs',
  'POST /api/v1/admin/import/jobs/:jobId/bulk-approve',
  'DELETE /api/v1/admin/import/jobs/:jobId',
  'GET /api/v1/admin/analytics/devices/:device_id',
  'PATCH /api/v1/admin/analytics/devices/:device_id/block',
  'POST /api/v1/admin/recommendation-boosts',
  'DELETE /api/v1/admin/recommendation-boosts/:id',
];

// --- fixtures --------------------------------------------------------------

const SAMPLE_UUID = '00000000-0000-4000-8000-000000000000';

/** Turns `/admin/movies/:id/publish` into a path a router will actually match. */
function concretePath(routePath: string): string {
  return routePath
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment;
      return segment === ':kind' ? 'poster' : SAMPLE_UUID;
    })
    .join('/');
}

const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

let server: Server;
let baseUrl: string;
let viewerToken: string;

async function call(route: DiscoveredRoute, token?: string): Promise<Response> {
  return fetch(`${baseUrl}${concretePath(route.path)}`, {
    method: route.method,
    headers: {
      'x-test-bypass-rate-limit': '1',
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(WRITE_METHODS.has(route.method) ? { body: '{}' } : {}),
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  viewerToken = await signAccessToken({
    adminUserId: SAMPLE_UUID,
    email: 'viewer@example.test',
    role: 'VIEWER',
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// --- suites ----------------------------------------------------------------

describe('route inventory', () => {
  it('discovers the mounted API routes', () => {
    expect(discovered.length).toBeGreaterThan(50);
    expect(new Set(discovered.map(key)).size).toBe(discovered.length);
  });

  it('classifies every registered route, and classifies no route that is gone', () => {
    const registered = new Set(discovered.map(key));
    const classified = new Set(Object.keys(ROUTE_ACCESS));

    const unclassified = [...registered].filter((route) => !classified.has(route)).sort();
    const stale = [...classified].filter((route) => !registered.has(route)).sort();

    expect(unclassified, `unclassified routes:\n${unclassified.join('\n')}`).toEqual([]);
    expect(stale, `classified routes that no longer exist:\n${stale.join('\n')}`).toEqual([]);
  });

  it('still exposes every route the phase brief requires, as ADMIN-gated', () => {
    for (const route of REQUIRED_ADMIN_ROUTES) {
      expect(ROUTE_ACCESS[route], `${route} is missing from the API`).toBeDefined();
      expect(ROUTE_ACCESS[route], `${route} must not be public`).not.toBe('PUBLIC');
    }
  });
});

describe('authentication', () => {
  const protectedRoutes = discovered.filter((route) => ROUTE_ACCESS[key(route)] !== 'PUBLIC');

  it('covers every admin route and every admin write', () => {
    const uncovered = discovered.filter(
      (route) =>
        ROUTE_ACCESS[key(route)] === 'PUBLIC' &&
        route.path.startsWith('/api/v1/admin/') &&
        !key(route).startsWith('POST /api/v1/admin/auth/'),
    );

    expect(uncovered.map(key)).toEqual([]);
    expect(protectedRoutes.length).toBeGreaterThan(50);
  });

  it.each(protectedRoutes.map((route) => [key(route), route] as const))(
    '%s rejects a request with no Authorization header',
    async (_label, route) => {
      const response = await call(route);

      // 401 specifically: a 404 would mean the path no longer exists, and a 403
      // would mean the role guard ran before authentication did.
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
    },
  );

  it.each(protectedRoutes.map((route) => [key(route), route] as const))(
    '%s rejects a malformed bearer token',
    async (_label, route) => {
      const response = await call(route, 'not-a-real-token');
      expect(response.status).toBe(401);
    },
  );
});

describe('role enforcement', () => {
  const adminOnly = discovered.filter((route) => ROUTE_ACCESS[key(route)] === 'ADMIN_ONLY');

  it.each(adminOnly.map((route) => [key(route), route] as const))(
    '%s rejects a valid VIEWER token with 403',
    async (_label, route) => {
      const response = await call(route, viewerToken);

      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('FORBIDDEN');
    },
  );
});
