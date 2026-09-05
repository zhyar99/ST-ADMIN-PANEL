import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  DeviceAnalyticsOverviewDTO,
  DeviceListResponse,
  DeviceHistoryItem,
  RecommendationItem,
  RecommendationResponse,
  TrendingContentItem,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../../db/client';
import { auditLog, deviceProfile, recommendationBoost, watchEvent } from '../../../db/schema';
import { signAccessToken } from '../../../lib/tokens';
import {
  admin,
  consumer,
  createGenre,
  createMovie,
  harness,
  json,
  requireDb,
  startHarness,
  stopHarness,
} from './harness';

/**
 * The device personalization round trip (Phase 15).
 *
 * Database-backed for the same reason the rest of the consumer suites are: the
 * behaviour under test is "what does the ranking do given this history", and
 * there is no useful unit-level substitute for a history. What *is* unit
 * tested, in `services/personalization/__tests__`, is the arithmetic — the
 * weights, the decay, the diversity pass — so this suite is free to assert
 * about outcomes rather than about numbers.
 */

const VIEWER_ID = '00000000-0000-4000-8000-0000000000ff';

/** Every device this suite invents, so `afterAll` can take them away again. */
const devices = new Set<string>();

function newDevice(): string {
  const id = randomUUID();
  devices.add(id);
  return id;
}

function withDevice(deviceId: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), 'x-device-id': deviceId } };
}

/** Every key name anywhere in a payload — used to prove a field is absent. */
function keysDeep(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) keysDeep(entry, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      found.add(key);
      keysDeep(entry, found);
    }
  }
  return found;
}

let dramaGenreId = '';
let comedyGenreId = '';
/** Watched to completion by `historyDevice`; the source of its drama affinity. */
let watchedDramaId = '';
/** Never watched: the film the affinity is supposed to lift. */
let unwatchedDramaId = '';
let comedyMovieId = '';
let draftMovieId = '';
let viewerToken = '';

beforeAll(async () => {
  await startHarness();
  if (!harness().dbAvailable) return;

  viewerToken = await signAccessToken({
    adminUserId: VIEWER_ID,
    email: 'viewer@example.test',
    role: 'VIEWER',
  });

  dramaGenreId = await createGenre(`Drama ${randomUUID().slice(0, 6)}`);
  comedyGenreId = await createGenre(`Comedy ${randomUUID().slice(0, 6)}`);

  watchedDramaId = await createMovie({ title: 'Watched Drama', genreIds: [dramaGenreId] });
  unwatchedDramaId = await createMovie({ title: 'Unwatched Drama', genreIds: [dramaGenreId] });
  comedyMovieId = await createMovie({ title: 'A Comedy', genreIds: [comedyGenreId] });
  draftMovieId = await createMovie({ title: 'Still A Draft', publish: false });
}, 60_000);

afterAll(async () => {
  if (harness().dbAvailable) {
    if (devices.size > 0) {
      // Watch events, favourites and watchlist rows cascade from the profile.
      await db.delete(deviceProfile).where(inArray(deviceProfile.id, [...devices]));
    }

    await db
      .delete(recommendationBoost)
      .where(inArray(recommendationBoost.contentId, [unwatchedDramaId, comedyMovieId]));

    await db.delete(auditLog).where(eq(auditLog.adminUserId, VIEWER_ID));
  }

  await stopHarness();
});

// --- device identity -------------------------------------------------------

describe('device identity', () => {
  it('creates a profile on the first request carrying a device id', async (ctx) => {
    requireDb(ctx);
    const deviceId = newDevice();

    const response = await consumer('/api/v1/devices/recommendations', withDevice(deviceId));
    expect(response.status).toBe(200);

    const [profile] = await db
      .select()
      .from(deviceProfile)
      .where(eq(deviceProfile.id, deviceId));

    expect(profile).toBeDefined();
    expect(profile!.genreAffinity).toEqual({});
  });

  it('upserts rather than duplicating on the second request', async (ctx) => {
    requireDb(ctx);
    const deviceId = newDevice();

    await consumer('/api/v1/devices/recommendations', withDevice(deviceId));
    const [first] = await db.select().from(deviceProfile).where(eq(deviceProfile.id, deviceId));

    await consumer('/api/v1/devices/history', withDevice(deviceId));
    const rows = await db.select().from(deviceProfile).where(eq(deviceProfile.id, deviceId));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(first!.lastSeenAt.getTime());
    expect(rows[0]!.firstSeenAt.getTime()).toBe(first!.firstSeenAt.getTime());
  });

  it('rejects a malformed device id with INVALID_DEVICE_ID', async (ctx) => {
    requireDb(ctx);

    const response = await consumer('/api/v1/devices/recommendations', withDevice('abc123'));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_DEVICE_ID');
  });

  it('serves an anonymous request with no device header at all', async (ctx) => {
    requireDb(ctx);

    const response = await consumer('/api/v1/devices/recommendations');
    expect(response.status).toBe(200);

    const body = (await response.json()) as RecommendationResponse;
    expect(Array.isArray(body.items)).toBe(true);
  });

  it('returns empty personal lists for an anonymous request rather than 401', async (ctx) => {
    requireDb(ctx);

    for (const path of ['/favorites', '/watchlist', '/history']) {
      const response = await consumer(`/api/v1/devices${path}`);
      expect(response.status).toBe(200);
      expect(((await response.json()) as DeviceListResponse<unknown>).items).toEqual([]);
    }
  });
});

// --- ingestion -------------------------------------------------------------

describe('watch event ingestion', () => {
  const watch = (deviceId: string, body: Record<string, unknown>) =>
    consumer('/api/v1/devices/watch', withDevice(deviceId, { method: 'POST', ...json(body) }));

  it('accepts an event for published content', async (ctx) => {
    requireDb(ctx);
    const deviceId = newDevice();

    const response = await watch(deviceId, {
      content_type: 'MOVIE',
      content_id: watchedDramaId,
      watch_seconds: 30,
      content_seconds: 60,
    });

    expect(response.status).toBe(204);
  });

  it('refuses an event for unpublished content', async (ctx) => {
    requireDb(ctx);
    const deviceId = newDevice();

    const response = await watch(deviceId, {
      content_type: 'MOVIE',
      content_id: draftMovieId,
      watch_seconds: 30,
      content_seconds: 60,
    });

    expect(response.status).toBe(404);
  });

  it('caps watch_seconds at the runtime, so completion tops out at 1.0', async (ctx) => {
    requireDb(ctx);
    const deviceId = newDevice();

    await watch(deviceId, {
      content_type: 'MOVIE',
      content_id: watchedDramaId,
      watch_seconds: 900,
      content_seconds: 600,
    });

    const [event] = await db.select().from(watchEvent).where(eq(watchEvent.deviceId, deviceId));

    expect(event!.watchSeconds).toBe(600);
    expect(Number(event!.completionRate)).toBe(1);
  });

  it('collapses two identical events posted within sixty seconds', async (ctx) => {
    requireDb(ctx);
    const deviceId = newDevice();
    const startedAt = new Date().toISOString();

    const body = {
      content_type: 'MOVIE',
      content_id: watchedDramaId,
      content_seconds: 600,
      started_at: startedAt,
    };

    await watch(deviceId, { ...body, watch_seconds: 100 });
    await watch(deviceId, { ...body, watch_seconds: 240 });

    const rows = await db.select().from(watchEvent).where(eq(watchEvent.deviceId, deviceId));

    expect(rows).toHaveLength(1);
    // The later report knows more than the earlier one.
    expect(rows[0]!.watchSeconds).toBe(240);
  });

  it('records an unknown runtime without dividing by zero', async (ctx) => {
    requireDb(ctx);
    const deviceId = newDevice();

    const response = await watch(deviceId, {
      content_type: 'MOVIE',
      content_id: watchedDramaId,
      watch_seconds: 120,
      content_seconds: 0,
    });

    expect(response.status).toBe(204);

    const [event] = await db.select().from(watchEvent).where(eq(watchEvent.deviceId, deviceId));
    expect(Number(event!.completionRate)).toBe(0);
  });

  it('builds a genre affinity from a completed viewing', async (ctx) => {
    requireDb(ctx);
    const deviceId = newDevice();

    await watch(deviceId, {
      content_type: 'MOVIE',
      content_id: watchedDramaId,
      watch_seconds: 600,
      content_seconds: 600,
    });

    const [profile] = await db
      .select()
      .from(deviceProfile)
      .where(eq(deviceProfile.id, deviceId));

    expect(profile!.genreAffinity[dramaGenreId]).toBeGreaterThan(0);
    expect(profile!.topContentTypes).toEqual(['MOVIE']);
    expect(Number(profile!.totalWatchSeconds)).toBe(600);
  });

  it('ranks a much-watched genre above a barely-watched one', async (ctx) => {
    requireDb(ctx);
    const deviceId = newDevice();

    // Five separate sessions of drama — started far enough apart that the
    // 60-second de-duplication window does not merge them.
    for (let index = 0; index < 5; index += 1) {
      await watch(deviceId, {
        content_type: 'MOVIE',
        content_id: watchedDramaId,
        watch_seconds: 600,
        content_seconds: 600,
        started_at: new Date(Date.now() - index * 3_600_000).toISOString(),
      });
    }

    // ...and one comedy the viewer gave up on early.
    await watch(deviceId, {
      content_type: 'MOVIE',
      content_id: comedyMovieId,
      watch_seconds: 90,
      content_seconds: 600,
    });

    const [profile] = await db
      .select()
      .from(deviceProfile)
      .where(eq(deviceProfile.id, deviceId));

    const affinity = profile!.genreAffinity;
    expect(affinity[dramaGenreId]).toBe(1);
    expect(affinity[comedyGenreId]!).toBeLessThan(affinity[dramaGenreId]!);
  });
});

// --- recommendations -------------------------------------------------------

describe('recommendations', () => {
  const watch = (deviceId: string, body: Record<string, unknown>) =>
    consumer('/api/v1/devices/watch', withDevice(deviceId, { method: 'POST', ...json(body) }));

  const recommend = async (
    deviceId: string | null,
    query = '',
  ): Promise<RecommendationResponse> => {
    const init = deviceId ? withDevice(deviceId) : {};
    const response = await consumer(`/api/v1/devices/recommendations?limit=50${query}`, init);
    expect(response.status).toBe(200);
    return (await response.json()) as RecommendationResponse;
  };

  const rank = (items: RecommendationItem[], contentId: string): number =>
    items.findIndex((item) => item.content_id === contentId);

  it('answers a device with no history at all', async (ctx) => {
    requireDb(ctx);

    const body = await recommend(newDevice());

    expect(body.total_available).toBeGreaterThan(0);
    expect(body.items.length).toBeGreaterThan(0);
  });

  it('carries no numeric score to the consumer', async (ctx) => {
    requireDb(ctx);

    const body = await recommend(newDevice());
    const keys = keysDeep(body);

    expect(keys.has('score')).toBe(false);
    expect(keys.has('signals')).toBe(false);
  });

  it('carries no stream URL', async (ctx) => {
    requireDb(ctx);

    const body = await recommend(newDevice());
    const keys = keysDeep(body);

    expect(keys.has('sourceUrl')).toBe(false);
    expect(keys.has('sources')).toBe(false);
    expect(JSON.stringify(body)).not.toContain('stream.example.test');
  });

  it('lifts an unwatched title of a liked genre above one of a genre the device ignored', async (ctx) => {
    requireDb(ctx);
    const deviceId = newDevice();

    await watch(deviceId, {
      content_type: 'MOVIE',
      content_id: watchedDramaId,
      watch_seconds: 600,
      content_seconds: 600,
    });

    const body = await recommend(deviceId);

    expect(rank(body.items, unwatchedDramaId)).toBeGreaterThanOrEqual(0);
    expect(rank(body.items, unwatchedDramaId)).toBeLessThan(rank(body.items, comedyMovieId));
  });

  it('excludes a completed title and keeps an in-progress one', async (ctx) => {
    requireDb(ctx);
    const deviceId = newDevice();

    await watch(deviceId, {
      content_type: 'MOVIE',
      content_id: watchedDramaId,
      watch_seconds: 600,
      content_seconds: 600,
    });
    await watch(deviceId, {
      content_type: 'MOVIE',
      content_id: comedyMovieId,
      watch_seconds: 300,
      content_seconds: 600,
    });

    const body = await recommend(deviceId);

    expect(rank(body.items, watchedDramaId)).toBe(-1);

    const inProgress = body.items.find((item) => item.content_id === comedyMovieId);
    expect(inProgress).toBeDefined();
    expect(inProgress!.reason).toBe('continue_watching');
    expect(inProgress!.in_progress).toEqual({
      watch_seconds: 300,
      content_seconds: 600,
      completion_rate: 0.5,
    });
  });

  it('returns a completed title again when exclude_watched is off', async (ctx) => {
    requireDb(ctx);
    const deviceId = newDevice();

    await watch(deviceId, {
      content_type: 'MOVIE',
      content_id: watchedDramaId,
      watch_seconds: 600,
      content_seconds: 600,
    });

    const body = await recommend(deviceId, '&exclude_watched=false');
    expect(rank(body.items, watchedDramaId)).toBeGreaterThanOrEqual(0);
  });

  it('filters by content type', async (ctx) => {
    requireDb(ctx);

    const body = await recommend(newDevice(), '&content_types=MOVIE');
    expect(body.items.every((item) => item.content_type === 'MOVIE')).toBe(true);
  });

  it('localises titles for Accept-Language: ckb', async (ctx) => {
    requireDb(ctx);

    const response = await consumer(
      '/api/v1/devices/recommendations?limit=50',
      withDevice(newDevice(), { headers: { 'accept-language': 'ckb' } }),
    );

    const body = (await response.json()) as RecommendationResponse;
    const drama = body.items.find((item) => item.content_id === unwatchedDramaId);

    expect(drama?.title).toContain('(ckb)');
  });

  it('scores a blocked device as if it had no history', async (ctx) => {
    requireDb(ctx);
    const deviceId = newDevice();

    await watch(deviceId, {
      content_type: 'MOVIE',
      content_id: watchedDramaId,
      watch_seconds: 600,
      content_seconds: 600,
    });

    const before = await recommend(deviceId);
    // The affinity is doing real work while the device is unblocked.
    expect(rank(before.items, unwatchedDramaId)).toBeLessThan(rank(before.items, comedyMovieId));

    await db.update(deviceProfile).set({ isBlocked: true }).where(eq(deviceProfile.id, deviceId));

    const after = await recommend(deviceId);
    const item = after.items.find((entry) => entry.content_id === unwatchedDramaId);

    // Cold-start reasons only: nothing genre-derived survives the block.
    expect(item!.reason.startsWith('because_you_like')).toBe(false);
    // ...and the block itself is invisible to the device.
    expect(keysDeep(after).has('is_blocked')).toBe(false);
  });
});

describe('watch event rate limiting', () => {
  /**
   * Deliberately *without* the test bypass header every other request in this
   * file carries: the budget is the thing under test, so it has to be spent for
   * real. Keyed on the device id rather than the IP, which is what makes this
   * assertion meaningful at all — every request here comes from one address.
   */
  it('cuts a device off after sixty events in a minute', async (ctx) => {
    requireDb(ctx);
    const deviceId = newDevice();

    const post = (index: number) =>
      fetch(`${harness().baseUrl}/api/v1/devices/watch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-device-id': deviceId },
        body: JSON.stringify({
          content_type: 'MOVIE',
          content_id: watchedDramaId,
          watch_seconds: 10,
          content_seconds: 600,
          started_at: new Date(Date.now() - index * 120_000).toISOString(),
        }),
      });

    let limited = 0;

    for (let index = 0; index < 65; index += 1) {
      const response = await post(index);
      if (response.status === 429) limited += 1;
      await response.text();
    }

    expect(limited).toBeGreaterThan(0);
  }, 60_000);
});

// --- personal lists --------------------------------------------------------

describe('favourites, watchlist and history', () => {
  it('round-trips a favourite', async (ctx) => {
    requireDb(ctx);
    const deviceId = newDevice();

    const created = await consumer(
      '/api/v1/devices/favorites',
      withDevice(deviceId, {
        method: 'POST',
        ...json({ content_type: 'MOVIE', content_id: comedyMovieId }),
      }),
    );
    expect(created.status).toBe(201);

    const listed = await consumer('/api/v1/devices/favorites', withDevice(deviceId));
    const body = (await listed.json()) as DeviceListResponse<{ content_id: string }>;
    expect(body.items.map((item) => item.content_id)).toEqual([comedyMovieId]);

    const removed = await consumer(
      `/api/v1/devices/favorites/MOVIE/${comedyMovieId}`,
      withDevice(deviceId, { method: 'DELETE' }),
    );
    expect(removed.status).toBe(204);

    const empty = await consumer('/api/v1/devices/favorites', withDevice(deviceId));
    expect(((await empty.json()) as DeviceListResponse<unknown>).items).toEqual([]);
  });

  it('round-trips a watchlist entry', async (ctx) => {
    requireDb(ctx);
    const deviceId = newDevice();

    await consumer(
      '/api/v1/devices/watchlist',
      withDevice(deviceId, {
        method: 'POST',
        ...json({ content_type: 'MOVIE', content_id: unwatchedDramaId }),
      }),
    );

    const listed = await consumer('/api/v1/devices/watchlist', withDevice(deviceId));
    const body = (await listed.json()) as DeviceListResponse<{ content_id: string }>;
    expect(body.items.map((item) => item.content_id)).toEqual([unwatchedDramaId]);

    await consumer(
      `/api/v1/devices/watchlist/MOVIE/${unwatchedDramaId}`,
      withDevice(deviceId, { method: 'DELETE' }),
    );

    const empty = await consumer('/api/v1/devices/watchlist', withDevice(deviceId));
    expect(((await empty.json()) as DeviceListResponse<unknown>).items).toEqual([]);
  });

  it('returns history newest first, with no stream URL', async (ctx) => {
    requireDb(ctx);
    const deviceId = newDevice();

    for (const [index, contentId] of [watchedDramaId, comedyMovieId].entries()) {
      await consumer(
        '/api/v1/devices/watch',
        withDevice(deviceId, {
          method: 'POST',
          ...json({
            content_type: 'MOVIE',
            content_id: contentId,
            watch_seconds: 300,
            content_seconds: 600,
            started_at: new Date(Date.now() - index * 3_600_000).toISOString(),
          }),
        }),
      );
    }

    const response = await consumer('/api/v1/devices/history', withDevice(deviceId));
    const body = (await response.json()) as DeviceListResponse<DeviceHistoryItem>;

    expect(body.items.map((item) => item.content_id)).toEqual([watchedDramaId, comedyMovieId]);
    expect(body.items[0]!.completion_rate).toBe(0.5);
    expect(JSON.stringify(body)).not.toContain('stream.example.test');
  });
});

// --- admin surface ---------------------------------------------------------

describe('admin analytics', () => {
  const asViewer = (path: string, init: RequestInit = {}) =>
    consumer(path, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${viewerToken}` },
    });

  it('reports platform-wide device activity', async (ctx) => {
    requireDb(ctx);

    const response = await admin('/api/v1/admin/analytics/devices?period_days=30');
    expect(response.status).toBe(200);

    const body = (await response.json()) as DeviceAnalyticsOverviewDTO;
    expect(body.total_devices).toBeGreaterThan(0);
    expect(body.active_devices_in_period).toBeGreaterThan(0);
    expect(body.top_genres.some((entry) => entry.genre_id === dramaGenreId)).toBe(true);
    // Names, not raw ids — the chart is unreadable otherwise.
    expect(body.top_genres.every((entry) => entry.genre_name.length > 0)).toBe(true);
  });

  it('ranks trending content with a completion rate', async (ctx) => {
    requireDb(ctx);

    const response = await admin('/api/v1/admin/analytics/trending?period_days=7&limit=50');
    const body = (await response.json()) as { items: TrendingContentItem[] };

    const drama = body.items.find((item) => item.content_id === watchedDramaId);
    expect(drama).toBeDefined();
    expect(drama!.watch_count).toBeGreaterThan(0);
    expect(drama!.unique_devices).toBeGreaterThan(0);
    expect(drama!.avg_completion_rate).toBeGreaterThan(0);
    expect(drama!.avg_completion_rate).toBeLessThanOrEqual(1);
  });

  it('serves a single device profile to an ADMIN and refuses a VIEWER', async (ctx) => {
    requireDb(ctx);
    const deviceId = newDevice();

    await consumer(
      '/api/v1/devices/watch',
      withDevice(deviceId, {
        method: 'POST',
        ...json({
          content_type: 'MOVIE',
          content_id: watchedDramaId,
          watch_seconds: 600,
          content_seconds: 600,
        }),
      }),
    );

    const allowed = await admin(`/api/v1/admin/analytics/devices/${deviceId}`);
    expect(allowed.status).toBe(200);

    const { device } = (await allowed.json()) as {
      device: { genre_affinity: Array<{ genre_id: string; genre_name: string }> };
    };
    expect(device.genre_affinity[0]!.genre_id).toBe(dramaGenreId);
    expect(device.genre_affinity[0]!.genre_name).not.toBe(dramaGenreId);

    const refused = await asViewer(`/api/v1/admin/analytics/devices/${deviceId}`);
    expect(refused.status).toBe(403);
  });

  it('exposes the scoring on the admin recommendation preview', async (ctx) => {
    requireDb(ctx);
    const deviceId = newDevice();
    await consumer('/api/v1/devices/recommendations', withDevice(deviceId));

    const response = await admin(
      `/api/v1/admin/analytics/devices/${deviceId}/recommendations?limit=10`,
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as { items: Array<{ score: number }> };
    expect(body.items.length).toBeGreaterThan(0);
    expect(typeof body.items[0]!.score).toBe('number');
  });

  it('audits a device block and neutralises its personalization', async (ctx) => {
    requireDb(ctx);
    const deviceId = newDevice();
    await consumer('/api/v1/devices/recommendations', withDevice(deviceId));

    const response = await admin(`/api/v1/admin/analytics/devices/${deviceId}/block`, {
      method: 'PATCH',
      ...json({ is_blocked: true }),
    });
    expect(response.status).toBe(200);

    const [profile] = await db
      .select()
      .from(deviceProfile)
      .where(eq(deviceProfile.id, deviceId));
    expect(profile!.isBlocked).toBe(true);

    const entries = await db
      .select({ action: auditLog.action, entityId: auditLog.entityId })
      .from(auditLog)
      .where(eq(auditLog.entityId, deviceId));

    expect(entries.map((entry) => entry.action)).toContain('DEVICE_BLOCK');
  });
});

describe('recommendation boosts', () => {
  it('rejects a boost outside the ±1.0 range', async (ctx) => {
    requireDb(ctx);

    const response = await admin('/api/v1/admin/recommendation-boosts', {
      method: 'POST',
      ...json({ content_type: 'MOVIE', content_id: comedyMovieId, boost_score: 1.5 }),
    });

    expect(response.status).toBe(400);
  });

  it('pins a boosted title above an unboosted one and audits the write', async (ctx) => {
    requireDb(ctx);
    const deviceId = newDevice();

    const created = await admin('/api/v1/admin/recommendation-boosts', {
      method: 'POST',
      ...json({
        content_type: 'MOVIE',
        content_id: comedyMovieId,
        boost_score: 1,
        reason: 'Sponsored',
      }),
    });
    expect(created.status).toBe(201);
    const { boost } = (await created.json()) as { boost: { id: string } };

    const audited = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.entityId, boost.id));
    expect(audited.map((entry) => entry.action)).toContain('RECOMMENDATION_BOOST_SET');

    const response = await consumer(
      '/api/v1/devices/recommendations?limit=50',
      withDevice(deviceId),
    );
    const body = (await response.json()) as RecommendationResponse;
    expect(body.items[0]!.content_id).toBe(comedyMovieId);

    // ...and buried content sinks to the bottom.
    await admin('/api/v1/admin/recommendation-boosts', {
      method: 'POST',
      ...json({ content_type: 'MOVIE', content_id: comedyMovieId, boost_score: -1 }),
    });

    const buried = (await (
      await consumer('/api/v1/devices/recommendations?limit=50', withDevice(newDevice()))
    ).json()) as RecommendationResponse;
    expect(buried.items.at(-1)!.content_id).toBe(comedyMovieId);

    const removed = await admin(`/api/v1/admin/recommendation-boosts/${boost.id}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(204);

    const listed = await admin('/api/v1/admin/recommendation-boosts');
    const { boosts } = (await listed.json()) as { boosts: Array<{ id: string; active: boolean }> };
    expect(boosts.find((entry) => entry.id === boost.id)!.active).toBe(false);
  });
});
