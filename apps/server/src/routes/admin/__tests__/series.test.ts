import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';

import argon2 from 'argon2';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  adminUser,
  auditLog,
  episode,
  mediaAsset,
  season,
  series,
  streamSource,
  subtitleTrack,
} from '../../../db/schema';
import { app } from '../../../app';
import { db, pool } from '../../../db/client';

/**
 * Integration coverage for the Phase 6 series routes.
 *
 * Two themes run through this file. The first is the same negative assertion
 * the movie suite makes: no series, season or episode response may contain a
 * `url`, checked against the serialised body so a URL leaking through a newly
 * added nested field fails too. The second is scoping — an episode is addressed
 * by a three-part path, and several tests exist only to prove that mismatching
 * the parts is a 404 rather than a way into someone else's row.
 */

const ADMIN_PASSWORD = 'series-admin-password-1';
const VIEWER_PASSWORD = 'series-viewer-password-1';

const BYPASS = { 'x-test-bypass-rate-limit': '1' };

const STREAM_URL = 'https://stream.example.test/series/primary/master.m3u8';
const BACKUP_URL = 'https://stream.example.test/series/backup/master.m3u8';

/** An address outside every blocked range, so the SSRF guard lets it through. */
const PUBLIC_IP = '93.184.216.34';

let server: Server;
let baseUrl: string;
let dbAvailable = false;
let adminId = '';
let viewerId = '';
let adminToken = '';
let viewerToken = '';

let posterId = '';
let backdropId = '';
let thumbnailId = '';
let subtitleAssetId = '';

const createdSeriesIds = new Set<string>();

function requireDb(ctx: { skip: () => void }): void {
  if (!dbAvailable) ctx.skip();
}

function api(pathname: string, init: RequestInit = {}, token: string = adminToken) {
  const headers: Record<string, string> = { ...BYPASS, authorization: `Bearer ${token}` };
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  return fetch(`${baseUrl}${pathname}`, { ...init, headers: { ...headers, ...init.headers } });
}

function json(body: unknown): RequestInit {
  return { body: JSON.stringify(body) };
}

function i18n(text: string) {
  return { en: text, ckb: `${text} (ckb)`, ar: `${text} (ar)` };
}

async function seedAsset(kind: 'POSTER' | 'BACKDROP' | 'THUMBNAIL' | 'SUBTITLE'): Promise<string> {
  const name = `${randomUUID()}.bin`;

  const [row] = await db
    .insert(mediaAsset)
    .values({
      kind,
      filePath: `${kind.toLowerCase()}s/${name}`,
      fileName: name,
      mimeType: kind === 'SUBTITLE' ? 'text/vtt' : 'image/jpeg',
      sizeBytes: 1024,
      status: 'READY',
    })
    .returning({ id: mediaAsset.id });

  return row!.id;
}

async function createSeries(overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await api('/api/v1/admin/series', {
    method: 'POST',
    ...json({
      title_i18n: i18n(`Series ${randomUUID().slice(0, 6)}`),
      overview_i18n: i18n('An overview'),
      ...overrides,
    }),
  });

  expect(response.status).toBe(201);
  const { series: created } = (await response.json()) as { series: { id: string } };
  createdSeriesIds.add(created.id);
  return created.id;
}

async function createSeason(seriesId: string, number: number): Promise<string> {
  const response = await api(`/api/v1/admin/series/${seriesId}/seasons`, {
    method: 'POST',
    ...json({ number }),
  });

  expect(response.status).toBe(201);
  const { season: created } = (await response.json()) as { season: { id: string } };
  return created.id;
}

async function createEpisode(
  seriesId: string,
  seasonId: string,
  number: number,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await api(`/api/v1/admin/series/${seriesId}/seasons/${seasonId}/episodes`, {
    method: 'POST',
    ...json({ number, title_i18n: i18n(`Episode ${number}`), ...overrides }),
  });

  expect(response.status).toBe(201);
  const { episode: created } = (await response.json()) as { episode: { id: string } };
  return created.id;
}

function episodePath(seriesId: string, seasonId: string, episodeId: string): string {
  return `/api/v1/admin/series/${seriesId}/seasons/${seasonId}/episodes/${episodeId}`;
}

async function addSource(
  seriesId: string,
  seasonId: string,
  episodeId: string,
  url: string,
): Promise<string> {
  const response = await api(`${episodePath(seriesId, seasonId, episodeId)}/sources`, {
    method: 'POST',
    ...json({ url }),
  });

  expect(response.status).toBe(201);
  const { source } = (await response.json()) as { source: { id: string } };
  return source.id;
}

/**
 * Forces an episode to PUBLISHED.
 *
 * There is no publish endpoint yet — that is Phase 8 — but the season-delete
 * guard is a Phase 6 rule and has to be tested now, so the row is moved
 * directly. This is the only place the suite writes state it cannot reach
 * through the API.
 */
async function publishEpisode(episodeId: string): Promise<void> {
  await db.update(episode).set({ status: 'PUBLISHED' }).where(eq(episode.id, episodeId));
}

async function login(email: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/admin/auth/login`, {
    method: 'POST',
    headers: { ...BYPASS, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  const body = (await response.json()) as { accessToken: string };
  return body.accessToken;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    await pool.query('SELECT 1');
    dbAvailable = true;
  } catch {
    return;
  }

  const suffix = randomUUID().slice(0, 8);
  const adminEmail = `series-admin-${suffix}@example.test`;
  const viewerEmail = `series-viewer-${suffix}@example.test`;

  const [createdAdmin] = await db
    .insert(adminUser)
    .values({
      email: adminEmail,
      name: 'Series Admin',
      role: 'ADMIN',
      passwordHash: await argon2.hash(ADMIN_PASSWORD),
    })
    .returning({ id: adminUser.id });

  const [createdViewer] = await db
    .insert(adminUser)
    .values({
      email: viewerEmail,
      name: 'Series Viewer',
      role: 'VIEWER',
      passwordHash: await argon2.hash(VIEWER_PASSWORD),
    })
    .returning({ id: adminUser.id });

  adminId = createdAdmin!.id;
  viewerId = createdViewer!.id;

  adminToken = await login(adminEmail, ADMIN_PASSWORD);
  viewerToken = await login(viewerEmail, VIEWER_PASSWORD);

  posterId = await seedAsset('POSTER');
  backdropId = await seedAsset('BACKDROP');
  thumbnailId = await seedAsset('THUMBNAIL');
  subtitleAssetId = await seedAsset('SUBTITLE');
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (dbAvailable) {
    const seriesIds = [...createdSeriesIds];

    if (seriesIds.length > 0) {
      // stream_source and subtitle_track are polymorphic, so they are cleared
      // by episode id before the cascade removes the episodes themselves.
      const episodeRows = await db
        .select({ id: episode.id })
        .from(episode)
        .innerJoin(season, eq(season.id, episode.seasonId))
        .where(inArray(season.seriesId, seriesIds));

      const episodeIds = episodeRows.map((row) => row.id);
      if (episodeIds.length > 0) {
        await db.delete(streamSource).where(inArray(streamSource.ownerId, episodeIds));
        await db.delete(subtitleTrack).where(inArray(subtitleTrack.ownerId, episodeIds));
      }

      await db.delete(series).where(inArray(series.id, seriesIds));
    }

    const assetIds = [posterId, backdropId, thumbnailId, subtitleAssetId].filter(Boolean);
    if (assetIds.length > 0) {
      await db.delete(mediaAsset).where(inArray(mediaAsset.id, assetIds));
    }

    for (const id of [adminId, viewerId].filter(Boolean)) {
      await db.delete(auditLog).where(eq(auditLog.adminUserId, id));
      await db.delete(adminUser).where(eq(adminUser.id, id));
    }
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('series CRUD', () => {
  it('creates a series with artwork and starts it as DRAFT', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/series', {
      method: 'POST',
      ...json({
        title_i18n: i18n('The Kurdistan Chronicles'),
        overview_i18n: i18n('A sweeping drama'),
        poster_asset_id: posterId,
        backdrop_asset_id: backdropId,
      }),
    });

    expect(response.status).toBe(201);
    const { series: created } = (await response.json()) as {
      series: {
        id: string;
        status: string;
        titleI18n: Record<string, string>;
        poster: { id: string } | null;
        backdrop: { id: string } | null;
        seasons: unknown[];
      };
    };
    createdSeriesIds.add(created.id);

    expect(created.status).toBe('DRAFT');
    expect(created.titleI18n.ckb).toBe('The Kurdistan Chronicles (ckb)');
    expect(created.poster?.id).toBe(posterId);
    expect(created.backdrop?.id).toBe(backdropId);
    expect(created.seasons).toEqual([]);
  });

  it('rejects a series missing a required language', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/series', {
      method: 'POST',
      ...json({
        title_i18n: { en: 'Only English', ar: 'Arabic' },
        overview_i18n: i18n('An overview'),
      }),
    });

    expect(response.status).toBe(400);
  });

  it('rejects a series with an empty translation', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/series', {
      method: 'POST',
      ...json({
        title_i18n: { en: 'Present', ckb: '   ', ar: 'Present' },
        overview_i18n: i18n('An overview'),
      }),
    });

    expect(response.status).toBe(400);
  });

  it('rejects a poster id that points at a backdrop', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/series', {
      method: 'POST',
      ...json({
        title_i18n: i18n('Wrong artwork'),
        overview_i18n: i18n('An overview'),
        poster_asset_id: backdropId,
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ASSET_KIND_MISMATCH');
  });

  it('updates metadata and clears artwork', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries({ poster_asset_id: posterId });

    const response = await api(`/api/v1/admin/series/${seriesId}`, {
      method: 'PATCH',
      ...json({ title_i18n: i18n('Renamed'), poster_asset_id: null }),
    });

    expect(response.status).toBe(200);
    const { series: updated } = (await response.json()) as {
      series: { titleI18n: Record<string, string>; poster: unknown };
    };

    expect(updated.titleI18n.en).toBe('Renamed');
    expect(updated.poster).toBeNull();
  });

  it('rejects an empty PATCH body', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const response = await api(`/api/v1/admin/series/${seriesId}`, { method: 'PATCH', ...json({}) });

    expect(response.status).toBe(400);
  });

  it('filters and paginates the list, reporting season counts', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    await createSeason(seriesId, 1);
    await createSeason(seriesId, 2);

    const response = await api('/api/v1/admin/series?status=DRAFT&page=1&limit=100');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      items: { id: string; seasonCount: number }[];
      total: number;
      page: number;
    };

    const found = body.items.find((item) => item.id === seriesId);
    expect(found?.seasonCount).toBe(2);
    expect(body.page).toBe(1);
  });

  it('rejects an unknown status filter and an oversized limit', async (ctx) => {
    requireDb(ctx);

    expect((await api('/api/v1/admin/series?status=ARCHIVED')).status).toBe(400);
    expect((await api('/api/v1/admin/series?limit=5000')).status).toBe(400);
  });

  it('deletes an empty draft series', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();

    expect((await api(`/api/v1/admin/series/${seriesId}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api(`/api/v1/admin/series/${seriesId}`)).status).toBe(404);

    createdSeriesIds.delete(seriesId);
  });

  it('refuses to delete a series that still has seasons', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    await createSeason(seriesId, 1);

    const response = await api(`/api/v1/admin/series/${seriesId}`, { method: 'DELETE' });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SERIES_HAS_SEASONS');
  });

  it('returns 404 for an unknown id and 400 for a malformed one', async (ctx) => {
    requireDb(ctx);

    expect((await api(`/api/v1/admin/series/${randomUUID()}`)).status).toBe(404);
    expect((await api('/api/v1/admin/series/not-a-uuid')).status).toBe(400);
  });
});

describe('season uniqueness and deletion', () => {
  it('rejects a duplicate season number within a series', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    await createSeason(seriesId, 1);

    const response = await api(`/api/v1/admin/series/${seriesId}/seasons`, {
      method: 'POST',
      ...json({ number: 1 }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SEASON_EXISTS');
  });

  it('allows the same season number under a different series', async (ctx) => {
    requireDb(ctx);

    const first = await createSeries();
    const second = await createSeries();

    await createSeason(first, 1);

    const response = await api(`/api/v1/admin/series/${second}/seasons`, {
      method: 'POST',
      ...json({ number: 1 }),
    });

    expect(response.status).toBe(201);
  });

  it('rejects an out-of-range season number', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();

    const response = await api(`/api/v1/admin/series/${seriesId}/seasons`, {
      method: 'POST',
      ...json({ number: -1 }),
    });

    expect(response.status).toBe(400);
  });

  it('cascades a draft season delete to its episodes, sources and subtitles', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);
    const episodeId = await createEpisode(seriesId, seasonId, 1);
    await addSource(seriesId, seasonId, episodeId, STREAM_URL);

    await api(`${episodePath(seriesId, seasonId, episodeId)}/subtitles`, {
      method: 'POST',
      ...json({ language: 'en', asset_id: subtitleAssetId }),
    });

    const response = await api(`/api/v1/admin/series/${seriesId}/seasons/${seasonId}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(204);

    // The episode row and both polymorphic attachments must be gone — no FK can
    // reach the latter, so this is the assertion that catches a missed cleanup.
    expect(await db.select().from(episode).where(eq(episode.id, episodeId))).toHaveLength(0);
    expect(
      await db.select().from(streamSource).where(eq(streamSource.ownerId, episodeId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(subtitleTrack).where(eq(subtitleTrack.ownerId, episodeId)),
    ).toHaveLength(0);
  });

  it('blocks deleting a season that holds a published episode', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);
    const episodeId = await createEpisode(seriesId, seasonId, 1);
    await publishEpisode(episodeId);

    const response = await api(`/api/v1/admin/series/${seriesId}/seasons/${seasonId}`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('SEASON_HAS_PUBLISHED_EPISODES');
    expect(body.error.message).toContain('1 published episode');

    // Still there.
    expect(await db.select().from(episode).where(eq(episode.id, episodeId))).toHaveLength(1);
  });

  it('does not reach a season belonging to another series', async (ctx) => {
    requireDb(ctx);

    const owner = await createSeries();
    const other = await createSeries();
    const seasonId = await createSeason(owner, 1);

    const response = await api(`/api/v1/admin/series/${other}/seasons/${seasonId}`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(404);
  });
});

describe('episode CRUD', () => {
  it('creates an episode with a thumbnail and starts it as DRAFT', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);

    const response = await api(`/api/v1/admin/series/${seriesId}/seasons/${seasonId}/episodes`, {
      method: 'POST',
      ...json({
        number: 1,
        title_i18n: i18n('Pilot'),
        overview_i18n: i18n('Where it begins'),
        thumbnail_asset_id: thumbnailId,
      }),
    });

    expect(response.status).toBe(201);
    const { episode: created } = (await response.json()) as {
      episode: {
        status: string;
        seasonNumber: number;
        seriesId: string;
        thumbnail: { id: string } | null;
        overviewI18n: Record<string, string> | null;
      };
    };

    expect(created.status).toBe('DRAFT');
    expect(created.seasonNumber).toBe(1);
    expect(created.seriesId).toBe(seriesId);
    expect(created.thumbnail?.id).toBe(thumbnailId);
    expect(created.overviewI18n?.ar).toBe('Where it begins (ar)');
  });

  it('rejects a duplicate episode number within a season', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);
    await createEpisode(seriesId, seasonId, 1);

    const response = await api(`/api/v1/admin/series/${seriesId}/seasons/${seasonId}/episodes`, {
      method: 'POST',
      ...json({ number: 1, title_i18n: i18n('Duplicate') }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('EPISODE_EXISTS');
  });

  it('allows the same episode number in a different season', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const first = await createSeason(seriesId, 1);
    const second = await createSeason(seriesId, 2);

    await createEpisode(seriesId, first, 1);

    const response = await api(`/api/v1/admin/series/${seriesId}/seasons/${second}/episodes`, {
      method: 'POST',
      ...json({ number: 1, title_i18n: i18n('Season two opener') }),
    });

    expect(response.status).toBe(201);
  });

  it('accepts an episode with no overview at all', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);

    const response = await api(`/api/v1/admin/series/${seriesId}/seasons/${seasonId}/episodes`, {
      method: 'POST',
      ...json({
        number: 1,
        title_i18n: i18n('No synopsis'),
        overview_i18n: { en: '', ckb: '', ar: '' },
      }),
    });

    expect(response.status).toBe(201);
    const { episode: created } = (await response.json()) as {
      episode: { overviewI18n: unknown };
    };
    expect(created.overviewI18n).toBeNull();
  });

  it('rejects an overview filled in only one language', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);

    const response = await api(`/api/v1/admin/series/${seriesId}/seasons/${seasonId}/episodes`, {
      method: 'POST',
      ...json({
        number: 1,
        title_i18n: i18n('Partial'),
        overview_i18n: { en: 'Only English', ckb: '', ar: '' },
      }),
    });

    expect(response.status).toBe(400);
  });

  it('renumbering onto an occupied slot is refused', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);
    await createEpisode(seriesId, seasonId, 1);
    const second = await createEpisode(seriesId, seasonId, 2);

    const response = await api(episodePath(seriesId, seasonId, second), {
      method: 'PATCH',
      ...json({ number: 1 }),
    });

    expect(response.status).toBe(409);
  });

  it('lists episodes in ascending number order', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);
    await createEpisode(seriesId, seasonId, 3);
    await createEpisode(seriesId, seasonId, 1);
    await createEpisode(seriesId, seasonId, 2);

    const response = await api(`/api/v1/admin/series/${seriesId}/seasons/${seasonId}/episodes`);
    const { episodes } = (await response.json()) as { episodes: { number: number }[] };

    expect(episodes.map((item) => item.number)).toEqual([1, 2, 3]);
  });

  it('deletes a draft episode but not a published one', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);
    const draft = await createEpisode(seriesId, seasonId, 1);
    const published = await createEpisode(seriesId, seasonId, 2);
    await publishEpisode(published);

    expect((await api(episodePath(seriesId, seasonId, draft), { method: 'DELETE' })).status).toBe(
      204,
    );

    const refused = await api(episodePath(seriesId, seasonId, published), { method: 'DELETE' });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: { code: string } };
    expect(body.error.code).toBe('EPISODE_NOT_DRAFT');
  });

  it('does not reach an episode through the wrong season', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const first = await createSeason(seriesId, 1);
    const second = await createSeason(seriesId, 2);
    const episodeId = await createEpisode(seriesId, first, 1);

    expect((await api(episodePath(seriesId, second, episodeId))).status).toBe(404);
  });
});

describe('stream source URL confidentiality', () => {
  it('never includes a url in the series list or detail response', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);
    const episodeId = await createEpisode(seriesId, seasonId, 1);
    await addSource(seriesId, seasonId, episodeId, STREAM_URL);

    const detail = await (await api(`/api/v1/admin/series/${seriesId}`)).text();
    const list = await (await api('/api/v1/admin/series?limit=100')).text();

    // Asserted on the raw body rather than a known key, so a URL surfacing
    // through some newly added nested field fails this too.
    expect(detail).not.toContain(STREAM_URL);
    expect(detail).not.toContain('"url"');
    expect(list).not.toContain(STREAM_URL);
  });

  it('never includes a url in the episode detail or sources list', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);
    const episodeId = await createEpisode(seriesId, seasonId, 1);
    await addSource(seriesId, seasonId, episodeId, STREAM_URL);

    const detail = await (await api(episodePath(seriesId, seasonId, episodeId))).text();
    expect(detail).not.toContain(STREAM_URL);
    expect(detail).not.toContain('"url"');

    const sources = await (
      await api(`${episodePath(seriesId, seasonId, episodeId)}/sources`)
    ).text();
    expect(sources).not.toContain(STREAM_URL);
    expect(sources).not.toContain('"url"');
  });

  it('stores the URL as plain text and returns it only through the url endpoint', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);
    const episodeId = await createEpisode(seriesId, seasonId, 1);
    const sourceId = await addSource(seriesId, seasonId, episodeId, STREAM_URL);

    const [row] = await db
      .select({ url: streamSource.url, ownerType: streamSource.ownerType })
      .from(streamSource)
      .where(eq(streamSource.id, sourceId));

    expect(row?.url).toBe(STREAM_URL);
    expect(row?.ownerType).toBe('EPISODE');

    const response = await api(
      `${episodePath(seriesId, seasonId, episodeId)}/sources/${sourceId}/url`,
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { url: string }).url).toBe(STREAM_URL);

    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.entityId, sourceId));
    expect(audits.map((entry) => entry.action)).toContain('STREAM_SOURCE_VIEWED');
  });

  it('does not leak a source belonging to an episode of another series', async (ctx) => {
    requireDb(ctx);

    const owner = await createSeries();
    const ownerSeason = await createSeason(owner, 1);
    const ownerEpisode = await createEpisode(owner, ownerSeason, 1);
    const sourceId = await addSource(owner, ownerSeason, ownerEpisode, STREAM_URL);

    const other = await createSeries();
    const otherSeason = await createSeason(other, 1);
    const otherEpisode = await createEpisode(other, otherSeason, 1);

    const response = await api(
      `${episodePath(other, otherSeason, otherEpisode)}/sources/${sourceId}/url`,
    );

    expect(response.status).toBe(404);
  });
});

describe('episode stream sources', () => {
  it('appends a backup source and reorders it to primary', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);
    const episodeId = await createEpisode(seriesId, seasonId, 1);

    const primary = await addSource(seriesId, seasonId, episodeId, STREAM_URL);
    const backup = await addSource(seriesId, seasonId, episodeId, BACKUP_URL);

    const listed = await (
      await api(`${episodePath(seriesId, seasonId, episodeId)}/sources`)
    ).json();
    expect((listed as { sources: { id: string }[] }).sources.map((s) => s.id)).toEqual([
      primary,
      backup,
    ]);

    const response = await api(`${episodePath(seriesId, seasonId, episodeId)}/sources/reorder`, {
      method: 'POST',
      ...json({ orderedIds: [backup, primary] }),
    });

    expect(response.status).toBe(200);
    const { sources } = (await response.json()) as { sources: { id: string; priority: number }[] };
    expect(sources[0]?.id).toBe(backup);
    expect(sources[0]?.priority).toBe(0);
  });

  it('rejects a non-http URL', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);
    const episodeId = await createEpisode(seriesId, seasonId, 1);

    const response = await api(`${episodePath(seriesId, seasonId, episodeId)}/sources`, {
      method: 'POST',
      ...json({ url: 'file:///etc/passwd' }),
    });

    expect(response.status).toBe(400);
  });

  /**
   * "Test Source" is the Phase 5 service reused unchanged, so what this proves
   * is the wiring: an EPISODE-owned source reaches it and the outcome is
   * written back. `fetch` and DNS are stubbed — `.test` never resolves, and the
   * SSRF guard would reject before fetch was ever called.
   */
  it('tests an episode source and records the outcome', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);
    const episodeId = await createEpisode(seriesId, seasonId, 1);
    const sourceId = await addSource(seriesId, seasonId, episodeId, STREAM_URL);

    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: PUBLIC_IP, family: 4 },
    ] as unknown as never);

    // The stub has to pass through to the local server: this test drives the
    // API over `fetch` as well, so a blanket mock would swallow its own request
    // and the probe alike.
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const target = typeof input === 'string' ? input : String((input as Request).url ?? input);
      if (target.startsWith(baseUrl)) return realFetch(input, init);
      return new Response(null, { status: 200 });
    });

    const response = await api(
      `${episodePath(seriesId, seasonId, episodeId)}/sources/${sourceId}/test`,
      { method: 'POST' },
    );

    expect(response.status).toBe(200);
    const outcome = (await response.json()) as { result: string; reason: string };
    expect(outcome.result).toBe('OK');
    // The reason string is shown in the UI and logged, so it must never carry
    // the URL it was derived from.
    expect(outcome.reason).not.toContain(STREAM_URL);

    const [row] = await db
      .select({ result: streamSource.lastTestResult, testedAt: streamSource.lastTestedAt })
      .from(streamSource)
      .where(eq(streamSource.id, sourceId));

    expect(row?.result).toBe('OK');
    expect(row?.testedAt).not.toBeNull();
  });
});

describe('episode subtitle tracks', () => {
  it('attaches EN, CKB and AR tracks from the library and a remote URL', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);
    const episodeId = await createEpisode(seriesId, seasonId, 1);
    const base = `${episodePath(seriesId, seasonId, episodeId)}/subtitles`;

    expect(
      (await api(base, { method: 'POST', ...json({ language: 'en', asset_id: subtitleAssetId }) }))
        .status,
    ).toBe(201);

    expect(
      (
        await api(base, {
          method: 'POST',
          ...json({ language: 'ckb', external_url: 'https://subs.example.test/ckb.vtt' }),
        })
      ).status,
    ).toBe(201);

    expect(
      (
        await api(base, {
          method: 'POST',
          ...json({ language: 'ar', external_url: 'https://subs.example.test/ar.vtt' }),
        })
      ).status,
    ).toBe(201);

    const { subtitles } = (await (await api(base)).json()) as {
      subtitles: { language: string }[];
    };
    expect(subtitles.map((track) => track.language).sort()).toEqual(['ar', 'ckb', 'en']);
  });

  it('rejects a second track for the same language', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);
    const episodeId = await createEpisode(seriesId, seasonId, 1);
    const base = `${episodePath(seriesId, seasonId, episodeId)}/subtitles`;

    await api(base, { method: 'POST', ...json({ language: 'en', asset_id: subtitleAssetId }) });

    const response = await api(base, {
      method: 'POST',
      ...json({ language: 'en', external_url: 'https://subs.example.test/en.vtt' }),
    });

    expect(response.status).toBe(409);
  });

  it('rejects a track with both an asset and an external url', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);
    const episodeId = await createEpisode(seriesId, seasonId, 1);

    const response = await api(`${episodePath(seriesId, seasonId, episodeId)}/subtitles`, {
      method: 'POST',
      ...json({
        language: 'en',
        asset_id: subtitleAssetId,
        external_url: 'https://subs.example.test/en.vtt',
      }),
    });

    expect(response.status).toBe(400);
  });
});

describe('RBAC', () => {
  it('lets a VIEWER read series, seasons and episodes', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);
    const episodeId = await createEpisode(seriesId, seasonId, 1);

    const paths = [
      '/api/v1/admin/series',
      `/api/v1/admin/series/${seriesId}`,
      `/api/v1/admin/series/${seriesId}/seasons`,
      `/api/v1/admin/series/${seriesId}/seasons/${seasonId}/episodes`,
      episodePath(seriesId, seasonId, episodeId),
    ];

    for (const path of paths) {
      expect((await api(path, {}, viewerToken)).status).toBe(200);
    }
  });

  it('forbids a VIEWER from creating, updating or deleting anything', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);
    const episodeId = await createEpisode(seriesId, seasonId, 1);

    const attempts: [string, RequestInit][] = [
      [
        '/api/v1/admin/series',
        { method: 'POST', ...json({ title_i18n: i18n('Nope'), overview_i18n: i18n('Nope') }) },
      ],
      [`/api/v1/admin/series/${seriesId}`, { method: 'PATCH', ...json({ title_i18n: i18n('X') }) }],
      [`/api/v1/admin/series/${seriesId}`, { method: 'DELETE' }],
      [`/api/v1/admin/series/${seriesId}/seasons`, { method: 'POST', ...json({ number: 9 }) }],
      [`/api/v1/admin/series/${seriesId}/seasons/${seasonId}`, { method: 'DELETE' }],
      [
        `/api/v1/admin/series/${seriesId}/seasons/${seasonId}/episodes`,
        { method: 'POST', ...json({ number: 9, title_i18n: i18n('Nope') }) },
      ],
      [episodePath(seriesId, seasonId, episodeId), { method: 'PATCH', ...json({ number: 5 }) }],
      [episodePath(seriesId, seasonId, episodeId), { method: 'DELETE' }],
    ];

    for (const [path, init] of attempts) {
      expect((await api(path, init, viewerToken)).status).toBe(403);
    }
  });

  it('forbids a VIEWER from listing or revealing episode stream sources', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);
    const episodeId = await createEpisode(seriesId, seasonId, 1);
    const sourceId = await addSource(seriesId, seasonId, episodeId, STREAM_URL);
    const base = `${episodePath(seriesId, seasonId, episodeId)}/sources`;

    expect((await api(base, {}, viewerToken)).status).toBe(403);
    expect((await api(`${base}/${sourceId}/url`, {}, viewerToken)).status).toBe(403);
  });

  it('lets a VIEWER list subtitle tracks but not add one', async (ctx) => {
    requireDb(ctx);

    const seriesId = await createSeries();
    const seasonId = await createSeason(seriesId, 1);
    const episodeId = await createEpisode(seriesId, seasonId, 1);
    const base = `${episodePath(seriesId, seasonId, episodeId)}/subtitles`;

    expect((await api(base, {}, viewerToken)).status).toBe(200);
    expect(
      (
        await api(
          base,
          { method: 'POST', ...json({ language: 'en', asset_id: subtitleAssetId }) },
          viewerToken,
        )
      ).status,
    ).toBe(403);
  });

  it('rejects an unauthenticated request', async (ctx) => {
    requireDb(ctx);

    const response = await fetch(`${baseUrl}/api/v1/admin/series`, { headers: BYPASS });
    expect(response.status).toBe(401);
  });
});
