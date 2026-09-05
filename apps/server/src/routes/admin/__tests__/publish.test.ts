import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

import argon2 from 'argon2';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  adminUser,
  auditLog,
  episode,
  liveChannel,
  mediaAsset,
  movie,
  series,
  streamSource,
} from '../../../db/schema';
import { app } from '../../../app';
import { db, pool } from '../../../db/client';
import { validateForPublish } from '../../../services/content/publishService';

/**
 * Integration coverage for the Phase 8 publishing workflow.
 *
 * Several tests write straight to the database to build states the API refuses
 * to produce — a movie with a blank Arabic title, for instance, cannot be
 * created through the routes because `requiredLocalizedText` rejects it. Those
 * rows are exactly what the publish gate exists to catch, since nothing stops
 * them arriving from a seed script or a manual fix in psql.
 */

const ADMIN_PASSWORD = 'publish-admin-password-1';
const VIEWER_PASSWORD = 'publish-viewer-password-1';

const BYPASS = { 'x-test-bypass-rate-limit': '1' };

const STREAM_URL = 'https://stream.example.test/publish/master.m3u8';

let server: Server;
let baseUrl: string;
let dbAvailable = false;
let adminId = '';
let viewerId = '';
let adminToken = '';
let viewerToken = '';
let posterId = '';

const createdMovieIds = new Set<string>();
const createdSeriesIds = new Set<string>();
const createdEpisodeIds = new Set<string>();
const createdChannelIds = new Set<string>();

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

interface ErrorBody {
  error: { code: string; message: string; reasons?: string[] };
}

async function seedPoster(): Promise<string> {
  const name = `${randomUUID()}.jpg`;

  const [row] = await db
    .insert(mediaAsset)
    .values({
      kind: 'POSTER',
      filePath: `posters/${name}`,
      fileName: name,
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
      status: 'READY',
    })
    .returning({ id: mediaAsset.id });

  return row!.id;
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

// --- builders --------------------------------------------------------------

/** Creates a movie. `poster` defaults on, since most tests want a publishable one. */
async function createMovie({ poster = true }: { poster?: boolean } = {}): Promise<string> {
  const response = await api('/api/v1/admin/movies', {
    method: 'POST',
    ...json({
      title_i18n: i18n(`Movie ${randomUUID().slice(0, 6)}`),
      overview_i18n: i18n('An overview'),
      ...(poster ? { poster_asset_id: posterId } : {}),
    }),
  });

  expect(response.status).toBe(201);
  const { movie: created } = (await response.json()) as { movie: { id: string } };
  createdMovieIds.add(created.id);
  return created.id;
}

async function addMovieSource(movieId: string): Promise<void> {
  const response = await api(`/api/v1/admin/movies/${movieId}/sources`, {
    method: 'POST',
    ...json({ url: STREAM_URL }),
  });

  expect(response.status).toBe(201);
}

/** A movie that satisfies every publish rule. */
async function createPublishableMovie(): Promise<string> {
  const id = await createMovie();
  await addMovieSource(id);
  return id;
}

async function createSeries({ poster = true }: { poster?: boolean } = {}): Promise<string> {
  const response = await api('/api/v1/admin/series', {
    method: 'POST',
    ...json({
      title_i18n: i18n(`Series ${randomUUID().slice(0, 6)}`),
      overview_i18n: i18n('An overview'),
      ...(poster ? { poster_asset_id: posterId } : {}),
    }),
  });

  expect(response.status).toBe(201);
  const { series: created } = (await response.json()) as { series: { id: string } };
  createdSeriesIds.add(created.id);
  return created.id;
}

interface EpisodeRef {
  seriesId: string;
  seasonId: string;
  episodeId: string;
}

async function createEpisode(): Promise<EpisodeRef> {
  const seriesId = await createSeries();

  const seasonResponse = await api(`/api/v1/admin/series/${seriesId}/seasons`, {
    method: 'POST',
    ...json({ number: 1 }),
  });
  expect(seasonResponse.status).toBe(201);
  const { season } = (await seasonResponse.json()) as { season: { id: string } };

  const episodeResponse = await api(
    `/api/v1/admin/series/${seriesId}/seasons/${season.id}/episodes`,
    { method: 'POST', ...json({ number: 1, title_i18n: i18n('An episode') }) },
  );
  expect(episodeResponse.status).toBe(201);
  const { episode: created } = (await episodeResponse.json()) as { episode: { id: string } };
  createdEpisodeIds.add(created.id);

  return { seriesId, seasonId: season.id, episodeId: created.id };
}

function episodePath(ref: EpisodeRef): string {
  return `/api/v1/admin/series/${ref.seriesId}/seasons/${ref.seasonId}/episodes/${ref.episodeId}`;
}

async function createChannel(): Promise<string> {
  const response = await api('/api/v1/admin/live-channels', {
    method: 'POST',
    ...json({ name_i18n: i18n(`Channel ${randomUUID().slice(0, 6)}`), category: 'News' }),
  });

  expect(response.status).toBe(201);
  const { channel } = (await response.json()) as { channel: { id: string } };
  createdChannelIds.add(channel.id);
  return channel.id;
}

/** Counts audit rows for one action against one entity. */
async function auditCount(action: 'PUBLISH' | 'UNPUBLISH', entityId: string): Promise<number> {
  const rows = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));

  return rows.length;
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
  const adminEmail = `publish-admin-${suffix}@example.test`;
  const viewerEmail = `publish-viewer-${suffix}@example.test`;

  const [createdAdmin] = await db
    .insert(adminUser)
    .values({
      email: adminEmail,
      name: 'Publish Admin',
      role: 'ADMIN',
      passwordHash: await argon2.hash(ADMIN_PASSWORD),
    })
    .returning({ id: adminUser.id });

  const [createdViewer] = await db
    .insert(adminUser)
    .values({
      email: viewerEmail,
      name: 'Publish Viewer',
      role: 'VIEWER',
      passwordHash: await argon2.hash(VIEWER_PASSWORD),
    })
    .returning({ id: adminUser.id });

  adminId = createdAdmin!.id;
  viewerId = createdViewer!.id;

  adminToken = await login(adminEmail, ADMIN_PASSWORD);
  viewerToken = await login(viewerEmail, VIEWER_PASSWORD);

  posterId = await seedPoster();
});

afterAll(async () => {
  if (dbAvailable) {
    const movieIds = [...createdMovieIds];
    const seriesIds = [...createdSeriesIds];
    const channelIds = [...createdChannelIds];

    // `stream_source.owner_id` is polymorphic, so no cascade reaches it — every
    // owner's sources have to be cleared explicitly, episodes included (their
    // rows cascade away with the series but their sources would not).
    const ownerIds = [...movieIds, ...createdEpisodeIds, ...channelIds];
    if (ownerIds.length > 0) {
      await db.delete(streamSource).where(inArray(streamSource.ownerId, ownerIds));
    }

    if (movieIds.length > 0) await db.delete(movie).where(inArray(movie.id, movieIds));
    // Seasons and episodes cascade from the series row.
    if (seriesIds.length > 0) await db.delete(series).where(inArray(series.id, seriesIds));
    if (channelIds.length > 0) {
      await db.delete(liveChannel).where(inArray(liveChannel.id, channelIds));
    }

    if (posterId) await db.delete(mediaAsset).where(eq(mediaAsset.id, posterId));

    for (const id of [adminId, viewerId].filter(Boolean)) {
      await db.delete(auditLog).where(eq(auditLog.adminUserId, id));
      await db.delete(adminUser).where(eq(adminUser.id, id));
    }
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('validateForPublish', () => {
  it('names the language a movie title is missing', async (ctx) => {
    requireDb(ctx);

    const id = await createPublishableMovie();

    // Blank one language directly: the create route would never allow it.
    await db
      .update(movie)
      .set({ titleI18n: { en: 'Complete', ckb: 'Complete (ckb)', ar: '' } })
      .where(eq(movie.id, id));

    const result = await validateForPublish('movie', id);

    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(['Title is missing its Arabic translation']);
  });

  it('treats a whitespace-only translation as missing', async (ctx) => {
    requireDb(ctx);

    const id = await createPublishableMovie();

    await db
      .update(movie)
      .set({ titleI18n: { en: 'Complete', ckb: '   ', ar: 'Complete (ar)' } })
      .where(eq(movie.id, id));

    const result = await validateForPublish('movie', id);

    expect(result.reasons).toEqual(['Title is missing its Kurdish Sorani translation']);
  });

  it('reports a missing poster', async (ctx) => {
    requireDb(ctx);

    const id = await createMovie({ poster: false });
    await addMovieSource(id);

    const result = await validateForPublish('movie', id);

    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(['A poster image is required']);
  });

  it('reports a missing stream source', async (ctx) => {
    requireDb(ctx);

    const id = await createMovie();

    const result = await validateForPublish('movie', id);

    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(['At least one stream source is required']);
  });

  it('reports every unmet requirement at once', async (ctx) => {
    requireDb(ctx);

    const id = await createMovie({ poster: false });
    await db
      .update(movie)
      .set({ titleI18n: { en: '', ckb: '', ar: '' } })
      .where(eq(movie.id, id));

    const result = await validateForPublish('movie', id);

    expect(result.reasons).toHaveLength(5);
    expect(result.reasons).toContain('Title is missing its English translation');
    expect(result.reasons).toContain('A poster image is required');
    expect(result.reasons).toContain('At least one stream source is required');
  });

  it('passes a complete movie', async (ctx) => {
    requireDb(ctx);

    const result = await validateForPublish('movie', await createPublishableMovie());

    expect(result).toEqual({ valid: true, reasons: [] });
  });

  it('does not require episodes to publish a series', async (ctx) => {
    requireDb(ctx);

    const result = await validateForPublish('series', await createSeries());

    expect(result.valid).toBe(true);
  });

  it('404s on an entity that does not exist', async (ctx) => {
    requireDb(ctx);

    await expect(validateForPublish('movie', randomUUID())).rejects.toMatchObject({ status: 404 });
  });
});

describe('movie publish endpoints', () => {
  it('rejects an incomplete movie with 422 and a reasons list', async (ctx) => {
    requireDb(ctx);

    const id = await createPublishableMovie();
    await db
      .update(movie)
      .set({ titleI18n: { en: 'Complete', ckb: 'Complete (ckb)', ar: '' } })
      .where(eq(movie.id, id));

    const response = await api(`/api/v1/admin/movies/${id}/publish`, { method: 'POST' });

    expect(response.status).toBe(422);

    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe('PUBLISH_VALIDATION_FAILED');
    expect(body.error.reasons).toEqual(['Title is missing its Arabic translation']);

    // The status must not have moved.
    const [row] = await db.select({ status: movie.status }).from(movie).where(eq(movie.id, id));
    expect(row!.status).toBe('DRAFT');
  });

  it('publishes a complete movie and audits it', async (ctx) => {
    requireDb(ctx);

    const id = await createPublishableMovie();

    const response = await api(`/api/v1/admin/movies/${id}/publish`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id, status: 'PUBLISHED' });

    const [row] = await db.select({ status: movie.status }).from(movie).where(eq(movie.id, id));
    expect(row!.status).toBe('PUBLISHED');

    expect(await auditCount('PUBLISH', id)).toBe(1);
  });

  it('unpublishes a published movie and audits it', async (ctx) => {
    requireDb(ctx);

    const id = await createPublishableMovie();
    await api(`/api/v1/admin/movies/${id}/publish`, { method: 'POST' });

    const response = await api(`/api/v1/admin/movies/${id}/unpublish`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id, status: 'UNPUBLISHED' });

    const [row] = await db.select({ status: movie.status }).from(movie).where(eq(movie.id, id));
    expect(row!.status).toBe('UNPUBLISHED');

    expect(await auditCount('UNPUBLISH', id)).toBe(1);
  });

  it('unpublishes without re-running the publish checks', async (ctx) => {
    requireDb(ctx);

    // Published first, then broken. Unpublishing must still work — it is the
    // escape hatch for exactly this situation.
    const id = await createPublishableMovie();
    await api(`/api/v1/admin/movies/${id}/publish`, { method: 'POST' });
    await db.delete(streamSource).where(eq(streamSource.ownerId, id));

    const response = await api(`/api/v1/admin/movies/${id}/unpublish`, { method: 'POST' });

    expect(response.status).toBe(200);
  });

  it('404s on an unknown movie id', async (ctx) => {
    requireDb(ctx);

    const response = await api(`/api/v1/admin/movies/${randomUUID()}/publish`, { method: 'POST' });

    expect(response.status).toBe(404);
  });

  it('400s on a malformed movie id', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/movies/not-a-uuid/publish', { method: 'POST' });

    expect(response.status).toBe(400);
  });

  it('refuses a VIEWER token with 403', async (ctx) => {
    requireDb(ctx);

    const id = await createPublishableMovie();

    const publish = await api(
      `/api/v1/admin/movies/${id}/publish`,
      { method: 'POST' },
      viewerToken,
    );
    expect(publish.status).toBe(403);

    const unpublish = await api(
      `/api/v1/admin/movies/${id}/unpublish`,
      { method: 'POST' },
      viewerToken,
    );
    expect(unpublish.status).toBe(403);

    const [row] = await db.select({ status: movie.status }).from(movie).where(eq(movie.id, id));
    expect(row!.status).toBe('DRAFT');
  });
});

describe('series, episode and live channel publish endpoints', () => {
  it('publishes and unpublishes a series', async (ctx) => {
    requireDb(ctx);

    const id = await createSeries();

    const published = await api(`/api/v1/admin/series/${id}/publish`, { method: 'POST' });
    expect(published.status).toBe(200);
    expect(await published.json()).toEqual({ id, status: 'PUBLISHED' });

    const unpublished = await api(`/api/v1/admin/series/${id}/unpublish`, { method: 'POST' });
    expect(unpublished.status).toBe(200);

    const [row] = await db.select({ status: series.status }).from(series).where(eq(series.id, id));
    expect(row!.status).toBe('UNPUBLISHED');
  });

  it('blocks publishing a series with no poster', async (ctx) => {
    requireDb(ctx);

    const id = await createSeries({ poster: false });

    const response = await api(`/api/v1/admin/series/${id}/publish`, { method: 'POST' });

    expect(response.status).toBe(422);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.reasons).toEqual(['A poster image is required']);
  });

  it('blocks publishing an episode with no stream source, then allows it', async (ctx) => {
    requireDb(ctx);

    const ref = await createEpisode();

    const blocked = await api(`${episodePath(ref)}/publish`, { method: 'POST' });
    expect(blocked.status).toBe(422);
    const body = (await blocked.json()) as ErrorBody;
    expect(body.error.reasons).toEqual(['At least one stream source is required']);

    const sourceResponse = await api(`${episodePath(ref)}/sources`, {
      method: 'POST',
      ...json({ url: STREAM_URL }),
    });
    expect(sourceResponse.status).toBe(201);

    const published = await api(`${episodePath(ref)}/publish`, { method: 'POST' });
    expect(published.status).toBe(200);
    expect(await published.json()).toEqual({ id: ref.episodeId, status: 'PUBLISHED' });

    const [row] = await db
      .select({ status: episode.status })
      .from(episode)
      .where(eq(episode.id, ref.episodeId));
    expect(row!.status).toBe('PUBLISHED');

    expect(await auditCount('PUBLISH', ref.episodeId)).toBe(1);
  });

  it('404s on an episode that is not in the named season', async (ctx) => {
    requireDb(ctx);

    const ref = await createEpisode();
    const other = await createEpisode();

    // Real episode id, wrong season — must be indistinguishable from missing.
    const response = await api(
      `${episodePath({ ...ref, episodeId: other.episodeId })}/publish`,
      { method: 'POST' },
    );

    expect(response.status).toBe(404);
  });

  it('blocks publishing a live channel with no stream source, then allows it', async (ctx) => {
    requireDb(ctx);

    const id = await createChannel();

    const blocked = await api(`/api/v1/admin/live-channels/${id}/publish`, { method: 'POST' });
    expect(blocked.status).toBe(422);
    const body = (await blocked.json()) as ErrorBody;
    expect(body.error.reasons).toEqual(['At least one stream source is required']);

    const sourceResponse = await api(`/api/v1/admin/live-channels/${id}/sources`, {
      method: 'POST',
      ...json({ url: STREAM_URL }),
    });
    expect(sourceResponse.status).toBe(201);

    const published = await api(`/api/v1/admin/live-channels/${id}/publish`, { method: 'POST' });
    expect(published.status).toBe(200);

    const [row] = await db
      .select({ status: liveChannel.status })
      .from(liveChannel)
      .where(eq(liveChannel.id, id));
    expect(row!.status).toBe('PUBLISHED');

    expect(await auditCount('PUBLISH', id)).toBe(1);
  });
});

describe('status filtering after a publish', () => {
  it('moves a movie between the DRAFT and PUBLISHED filters', async (ctx) => {
    requireDb(ctx);

    const id = await createPublishableMovie();

    const inDraft = async () => {
      const body = (await (await api('/api/v1/admin/movies?status=DRAFT&limit=100')).json()) as {
        items: { id: string }[];
      };
      return body.items.some((item) => item.id === id);
    };

    const inPublished = async () => {
      const body = (await (
        await api('/api/v1/admin/movies?status=PUBLISHED&limit=100')
      ).json()) as { items: { id: string }[] };
      return body.items.some((item) => item.id === id);
    };

    expect(await inDraft()).toBe(true);
    expect(await inPublished()).toBe(false);

    await api(`/api/v1/admin/movies/${id}/publish`, { method: 'POST' });

    expect(await inDraft()).toBe(false);
    expect(await inPublished()).toBe(true);

    await api(`/api/v1/admin/movies/${id}/unpublish`, { method: 'POST' });

    // Unpublished is its own bucket — it must not fall back into DRAFT.
    expect(await inPublished()).toBe(false);
    expect(await inDraft()).toBe(false);

    const unpublished = (await (
      await api('/api/v1/admin/movies?status=UNPUBLISHED&limit=100')
    ).json()) as { items: { id: string }[] };
    expect(unpublished.items.some((item) => item.id === id)).toBe(true);
  });

  it('rejects a status the enum does not define', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/movies?status=ARCHIVED');

    expect(response.status).toBe(400);
  });
});
