import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

import argon2 from 'argon2';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  adminUser,
  auditLog,
  genre,
  mediaAsset,
  movie,
  streamSource,
  subtitleTrack,
} from '../../../db/schema';
import { app } from '../../../app';
import { db, pool } from '../../../db/client';

/**
 * Integration coverage for the Phase 5 catalogue routes.
 *
 * The recurring assertion throughout is negative: no movie, list or source
 * response may contain a `url` field. That is checked on the serialised body
 * rather than on a known key, so a URL leaking through a newly added nested
 * field fails the suite too.
 */

const ADMIN_PASSWORD = 'catalog-admin-password-1';
const VIEWER_PASSWORD = 'catalog-viewer-password-1';

const BYPASS = { 'x-test-bypass-rate-limit': '1' };

const STREAM_URL = 'https://stream.example.test/live/primary/master.m3u8';
const BACKUP_URL = 'https://stream.example.test/live/backup/master.m3u8';

let server: Server;
let baseUrl: string;
let dbAvailable = false;
let adminId = '';
let viewerId = '';
let adminToken = '';
let viewerToken = '';

/** Assets seeded once and reused; removed in afterAll. */
let posterId = '';
let backdropId = '';
let subtitleAssetId = '';

const createdMovieIds = new Set<string>();
const createdGenreIds = new Set<string>();

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

/** Inserts a media_asset row directly — uploading is Phase 4's concern. */
async function seedAsset(kind: 'POSTER' | 'BACKDROP' | 'SUBTITLE'): Promise<string> {
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

async function createGenre(name: string): Promise<string> {
  const response = await api('/api/v1/admin/genres', {
    method: 'POST',
    ...json({ name_i18n: i18n(name) }),
  });

  expect(response.status).toBe(201);
  const { genre: created } = (await response.json()) as { genre: { id: string } };
  createdGenreIds.add(created.id);
  return created.id;
}

async function createMovie(overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await api('/api/v1/admin/movies', {
    method: 'POST',
    ...json({
      title_i18n: i18n(`Movie ${randomUUID().slice(0, 6)}`),
      overview_i18n: i18n('An overview'),
      ...overrides,
    }),
  });

  expect(response.status).toBe(201);
  const { movie: created } = (await response.json()) as { movie: { id: string } };
  createdMovieIds.add(created.id);
  return created.id;
}

async function addSource(movieId: string, url: string): Promise<string> {
  const response = await api(`/api/v1/admin/movies/${movieId}/sources`, {
    method: 'POST',
    ...json({ url }),
  });

  expect(response.status).toBe(201);
  const { source } = (await response.json()) as { source: { id: string } };
  return source.id;
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
  const adminEmail = `catalog-admin-${suffix}@example.test`;
  const viewerEmail = `catalog-viewer-${suffix}@example.test`;

  const [createdAdmin] = await db
    .insert(adminUser)
    .values({
      email: adminEmail,
      name: 'Catalog Admin',
      role: 'ADMIN',
      passwordHash: await argon2.hash(ADMIN_PASSWORD),
    })
    .returning({ id: adminUser.id });

  const [createdViewer] = await db
    .insert(adminUser)
    .values({
      email: viewerEmail,
      name: 'Catalog Viewer',
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
  subtitleAssetId = await seedAsset('SUBTITLE');
});

afterAll(async () => {
  if (dbAvailable) {
    const movieIds = [...createdMovieIds];

    if (movieIds.length > 0) {
      await db.delete(streamSource).where(inArray(streamSource.ownerId, movieIds));
      await db.delete(subtitleTrack).where(inArray(subtitleTrack.ownerId, movieIds));
      await db.delete(movie).where(inArray(movie.id, movieIds));
    }

    if (createdGenreIds.size > 0) {
      await db.delete(genre).where(inArray(genre.id, [...createdGenreIds]));
    }

    const assetIds = [posterId, backdropId, subtitleAssetId].filter(Boolean);
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

describe('genre CRUD', () => {
  it('creates, lists and updates a genre', async (ctx) => {
    requireDb(ctx);

    const id = await createGenre('Thriller');

    const listResponse = await api('/api/v1/admin/genres');
    expect(listResponse.status).toBe(200);

    const { genres } = (await listResponse.json()) as {
      genres: { id: string; nameI18n: { en: string }; movieCount: number }[];
    };

    const found = genres.find((item) => item.id === id);
    expect(found?.nameI18n.en).toBe('Thriller');
    expect(found?.movieCount).toBe(0);

    const patchResponse = await api(`/api/v1/admin/genres/${id}`, {
      method: 'PATCH',
      ...json({ name_i18n: i18n('Suspense') }),
    });

    expect(patchResponse.status).toBe(200);
    expect((await patchResponse.json()) as { genre: { nameI18n: { en: string } } }).toMatchObject({
      genre: { nameI18n: { en: 'Suspense' } },
    });
  });

  it('rejects a genre missing a language', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/genres', {
      method: 'POST',
      ...json({ name_i18n: { en: 'Only English', ar: 'Arabic' } }),
    });

    expect(response.status).toBe(400);
  });

  it('rejects a genre with an empty translation', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/genres', {
      method: 'POST',
      ...json({ name_i18n: { en: 'Drama', ckb: '   ', ar: 'دراما' } }),
    });

    expect(response.status).toBe(400);
  });

  it('deletes an unused genre', async (ctx) => {
    requireDb(ctx);

    const id = await createGenre('Disposable');
    const response = await api(`/api/v1/admin/genres/${id}`, { method: 'DELETE' });

    expect(response.status).toBe(204);
    createdGenreIds.delete(id);

    expect(await db.select().from(genre).where(eq(genre.id, id))).toHaveLength(0);
  });

  it('refuses to delete a genre a movie still uses', async (ctx) => {
    requireDb(ctx);

    const genreId = await createGenre('Pinned');
    await createMovie({ genre_ids: [genreId] });

    const response = await api(`/api/v1/admin/genres/${genreId}`, { method: 'DELETE' });

    expect(response.status).toBe(409);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'GENRE_IN_USE' },
    });
  });

  it('forbids a VIEWER from writing genres but allows reading', async (ctx) => {
    requireDb(ctx);

    expect((await api('/api/v1/admin/genres', {}, viewerToken)).status).toBe(200);

    const response = await api(
      '/api/v1/admin/genres',
      { method: 'POST', ...json({ name_i18n: i18n('Nope') }) },
      viewerToken,
    );

    expect(response.status).toBe(403);
  });
});

describe('movie CRUD', () => {
  it('creates a movie with artwork and a genre, and starts it as DRAFT', async (ctx) => {
    requireDb(ctx);

    const genreId = await createGenre('Documentary');

    const response = await api('/api/v1/admin/movies', {
      method: 'POST',
      ...json({
        title_i18n: i18n('The Reel'),
        overview_i18n: i18n('A film about film'),
        release_year: 2024,
        runtime_minutes: 118,
        poster_asset_id: posterId,
        backdrop_asset_id: backdropId,
        genre_ids: [genreId],
      }),
    });

    expect(response.status).toBe(201);

    const { movie: created } = (await response.json()) as {
      movie: {
        id: string;
        status: string;
        poster: { id: string };
        backdrop: { id: string };
        genres: { id: string }[];
      };
    };

    createdMovieIds.add(created.id);

    expect(created.status).toBe('DRAFT');
    expect(created.poster.id).toBe(posterId);
    expect(created.backdrop.id).toBe(backdropId);
    expect(created.genres).toHaveLength(1);
    expect(created.genres[0]!.id).toBe(genreId);
  });

  it('rejects a movie missing a required language', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/movies', {
      method: 'POST',
      ...json({
        title_i18n: { en: 'Half a title', ckb: 'x' },
        overview_i18n: i18n('An overview'),
      }),
    });

    expect(response.status).toBe(400);
  });

  it('rejects a poster id that points at a backdrop', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/movies', {
      method: 'POST',
      ...json({
        title_i18n: i18n('Wrong art'),
        overview_i18n: i18n('An overview'),
        poster_asset_id: backdropId,
      }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'ASSET_KIND_MISMATCH' },
    });
  });

  it('rejects an out-of-range release year', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/movies', {
      method: 'POST',
      ...json({
        title_i18n: i18n('Too early'),
        overview_i18n: i18n('An overview'),
        release_year: 1700,
      }),
    });

    expect(response.status).toBe(400);
  });

  it('updates metadata and replaces the genre set', async (ctx) => {
    requireDb(ctx);

    const first = await createGenre('Comedy');
    const second = await createGenre('Romance');
    const movieId = await createMovie({ genre_ids: [first] });

    const response = await api(`/api/v1/admin/movies/${movieId}`, {
      method: 'PATCH',
      ...json({ runtime_minutes: 99, genre_ids: [second] }),
    });

    expect(response.status).toBe(200);

    const { movie: updated } = (await response.json()) as {
      movie: { runtimeMinutes: number; genres: { id: string }[]; status: string };
    };

    expect(updated.runtimeMinutes).toBe(99);
    expect(updated.genres.map((item) => item.id)).toEqual([second]);
    // Editing must never move a movie out of DRAFT — publishing is Phase 8.
    expect(updated.status).toBe('DRAFT');
  });

  // Regression: the admin form renders all three tagline inputs, so an
  // untouched optional tagline arrives as three empty strings.
  it('accepts an all-blank tagline as no tagline', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/movies', {
      method: 'POST',
      ...json({
        title_i18n: i18n('No tagline'),
        overview_i18n: i18n('An overview'),
        tagline_i18n: { en: '', ckb: '', ar: '' },
      }),
    });

    expect(response.status).toBe(201);

    const { movie: created } = (await response.json()) as {
      movie: { id: string; taglineI18n: null };
    };

    createdMovieIds.add(created.id);
    expect(created.taglineI18n).toBeNull();
  });

  it('rejects a tagline filled in only one language', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/movies', {
      method: 'POST',
      ...json({
        title_i18n: i18n('Partial tagline'),
        overview_i18n: i18n('An overview'),
        tagline_i18n: { en: 'Only English', ckb: '', ar: '' },
      }),
    });

    expect(response.status).toBe(400);
  });

  it('rejects an empty PATCH body', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie();
    const response = await api(`/api/v1/admin/movies/${movieId}`, {
      method: 'PATCH',
      ...json({}),
    });

    expect(response.status).toBe(400);
  });

  it('filters and paginates the list', async (ctx) => {
    requireDb(ctx);

    await createMovie();

    const response = await api('/api/v1/admin/movies?status=DRAFT&page=1&limit=5');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      items: { status: string }[];
      page: number;
      limit: number;
    };

    expect(body.page).toBe(1);
    expect(body.limit).toBe(5);
    expect(body.items.length).toBeLessThanOrEqual(5);
    expect(body.items.every((item) => item.status === 'DRAFT')).toBe(true);
  });

  it('rejects an unknown status filter', async (ctx) => {
    requireDb(ctx);
    expect((await api('/api/v1/admin/movies?status=BANANA')).status).toBe(400);
  });

  it('lets a VIEWER read but not write', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie();

    expect((await api('/api/v1/admin/movies', {}, viewerToken)).status).toBe(200);
    expect((await api(`/api/v1/admin/movies/${movieId}`, {}, viewerToken)).status).toBe(200);

    const patch = await api(
      `/api/v1/admin/movies/${movieId}`,
      { method: 'PATCH', ...json({ runtime_minutes: 5 }) },
      viewerToken,
    );

    expect(patch.status).toBe(403);
  });

  it('deletes a draft movie together with its sources and subtitles', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie();
    await addSource(movieId, STREAM_URL);

    await api(`/api/v1/admin/movies/${movieId}/subtitles`, {
      method: 'POST',
      ...json({ language: 'en', asset_id: subtitleAssetId }),
    });

    const response = await api(`/api/v1/admin/movies/${movieId}`, { method: 'DELETE' });
    expect(response.status).toBe(204);
    createdMovieIds.delete(movieId);

    expect(await db.select().from(movie).where(eq(movie.id, movieId))).toHaveLength(0);

    // The polymorphic children have no FK, so their cleanup is code, not schema.
    const orphanSources = await db
      .select()
      .from(streamSource)
      .where(and(eq(streamSource.ownerType, 'MOVIE'), eq(streamSource.ownerId, movieId)));
    expect(orphanSources).toHaveLength(0);

    const orphanSubtitles = await db
      .select()
      .from(subtitleTrack)
      .where(and(eq(subtitleTrack.ownerType, 'MOVIE'), eq(subtitleTrack.ownerId, movieId)));
    expect(orphanSubtitles).toHaveLength(0);
  });

  it('refuses to delete a movie that is not a draft', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie();
    // Phase 8 owns publishing, so the state is set directly for this check.
    await db.update(movie).set({ status: 'PUBLISHED' }).where(eq(movie.id, movieId));

    const response = await api(`/api/v1/admin/movies/${movieId}`, { method: 'DELETE' });

    expect(response.status).toBe(409);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'MOVIE_NOT_DRAFT' },
    });

    await db.update(movie).set({ status: 'DRAFT' }).where(eq(movie.id, movieId));
  });

  it('returns 404 for an unknown id and 400 for a malformed one', async (ctx) => {
    requireDb(ctx);

    expect((await api(`/api/v1/admin/movies/${randomUUID()}`)).status).toBe(404);
    expect((await api('/api/v1/admin/movies/not-a-uuid')).status).toBe(400);
  });
});

describe('stream source URL confidentiality', () => {
  it('never includes a url in the movie list or detail response', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie();
    await addSource(movieId, STREAM_URL);

    const listBody = await (await api('/api/v1/admin/movies?limit=100')).text();
    expect(listBody).not.toContain('"url"');
    expect(listBody).not.toContain(STREAM_URL);

    const detailBody = await (await api(`/api/v1/admin/movies/${movieId}`)).text();
    expect(detailBody).not.toContain(STREAM_URL);
  });

  it('never includes a url in the sources list', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie();
    await addSource(movieId, STREAM_URL);

    const response = await api(`/api/v1/admin/movies/${movieId}/sources`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).not.toContain('"url"');
    expect(body).not.toContain(STREAM_URL);

    const { sources } = JSON.parse(body) as { sources: Record<string, unknown>[] };
    expect(sources).toHaveLength(1);
    expect(Object.keys(sources[0]!)).not.toContain('url');
  });

  it('stores the URL as plain text in the database', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie();
    const sourceId = await addSource(movieId, STREAM_URL);

    const [row] = await db
      .select({ url: streamSource.url })
      .from(streamSource)
      .where(eq(streamSource.id, sourceId));

    expect(row?.url).toBe(STREAM_URL);
  });

  it('returns the url to an ADMIN and writes a STREAM_SOURCE_VIEWED audit row', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie();
    const sourceId = await addSource(movieId, STREAM_URL);

    const response = await api(`/api/v1/admin/movies/${movieId}/sources/${sourceId}/url`);
    expect(response.status).toBe(200);
    expect((await response.json()) as { url: string }).toEqual({ url: STREAM_URL });

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'STREAM_SOURCE_VIEWED'), eq(auditLog.entityId, sourceId)));

    expect(audits).toHaveLength(1);
    expect(audits[0]!.adminUserId).toBe(adminId);
  });

  it('forbids a VIEWER from reading a url or listing sources', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie();
    const sourceId = await addSource(movieId, STREAM_URL);

    expect(
      (await api(`/api/v1/admin/movies/${movieId}/sources/${sourceId}/url`, {}, viewerToken)).status,
    ).toBe(403);

    expect((await api(`/api/v1/admin/movies/${movieId}/sources`, {}, viewerToken)).status).toBe(403);
  });

  it('does not leak a source belonging to another movie', async (ctx) => {
    requireDb(ctx);

    const [movieA, movieB] = [await createMovie(), await createMovie()];
    const sourceId = await addSource(movieA, STREAM_URL);

    const response = await api(`/api/v1/admin/movies/${movieB}/sources/${sourceId}/url`);
    expect(response.status).toBe(404);
  });
});

describe('stream source management', () => {
  it('appends new sources as backups and reorders them', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie();
    const primary = await addSource(movieId, STREAM_URL);
    const backup = await addSource(movieId, BACKUP_URL);

    const before = (await (await api(`/api/v1/admin/movies/${movieId}/sources`)).json()) as {
      sources: { id: string; priority: number }[];
    };

    expect(before.sources.map((item) => item.id)).toEqual([primary, backup]);
    expect(before.sources.map((item) => item.priority)).toEqual([0, 1]);

    const response = await api(`/api/v1/admin/movies/${movieId}/sources/reorder`, {
      method: 'POST',
      ...json({ orderedIds: [backup, primary] }),
    });

    expect(response.status).toBe(200);

    const { sources } = (await response.json()) as { sources: { id: string; priority: number }[] };
    expect(sources.map((item) => item.id)).toEqual([backup, primary]);
    expect(sources.map((item) => item.priority)).toEqual([0, 1]);
  });

  it('rejects a partial reorder', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie();
    const primary = await addSource(movieId, STREAM_URL);
    await addSource(movieId, BACKUP_URL);

    const response = await api(`/api/v1/admin/movies/${movieId}/sources/reorder`, {
      method: 'POST',
      ...json({ orderedIds: [primary] }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'INCOMPLETE_ORDER' },
    });
  });

  it('rejects a non-http URL', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie();

    for (const url of ['file:///etc/passwd', 'not-a-url', 'ftp://example.com/a.m3u8']) {
      const response = await api(`/api/v1/admin/movies/${movieId}/sources`, {
        method: 'POST',
        ...json({ url }),
      });

      expect(response.status, url).toBe(400);
    }
  });

  it('clears the stale health result when the url changes', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie();
    const sourceId = await addSource(movieId, STREAM_URL);

    await db
      .update(streamSource)
      .set({ lastTestResult: 'OK', lastTestedAt: new Date() })
      .where(eq(streamSource.id, sourceId));

    const response = await api(`/api/v1/admin/movies/${movieId}/sources/${sourceId}`, {
      method: 'PATCH',
      ...json({ url: BACKUP_URL }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as { source: { lastTestResult: null } }).toMatchObject({
      source: { lastTestResult: null, lastTestedAt: null },
    });
  });

  it('deletes a source', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie();
    const sourceId = await addSource(movieId, STREAM_URL);

    expect(
      (await api(`/api/v1/admin/movies/${movieId}/sources/${sourceId}`, { method: 'DELETE' }))
        .status,
    ).toBe(204);

    expect(
      await db.select().from(streamSource).where(eq(streamSource.id, sourceId)),
    ).toHaveLength(0);
  });
});

describe('subtitle tracks', () => {
  it('attaches a track by asset_id and another by external_url', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie();

    const byAsset = await api(`/api/v1/admin/movies/${movieId}/subtitles`, {
      method: 'POST',
      ...json({ language: 'en', asset_id: subtitleAssetId }),
    });

    expect(byAsset.status).toBe(201);
    expect((await byAsset.json()) as { subtitle: { asset: { id: string } } }).toMatchObject({
      subtitle: { language: 'en', asset: { id: subtitleAssetId }, externalUrl: null },
    });

    const byUrl = await api(`/api/v1/admin/movies/${movieId}/subtitles`, {
      method: 'POST',
      ...json({ language: 'ar', external_url: 'https://subs.example.test/ar.vtt' }),
    });

    expect(byUrl.status).toBe(201);
    expect((await byUrl.json()) as { subtitle: { externalUrl: string } }).toMatchObject({
      subtitle: { language: 'ar', asset: null, externalUrl: 'https://subs.example.test/ar.vtt' },
    });

    const list = (await (await api(`/api/v1/admin/movies/${movieId}/subtitles`)).json()) as {
      subtitles: unknown[];
    };

    expect(list.subtitles).toHaveLength(2);
  });

  it('rejects a second track for the same language', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie();

    await api(`/api/v1/admin/movies/${movieId}/subtitles`, {
      method: 'POST',
      ...json({ language: 'ckb', asset_id: subtitleAssetId }),
    });

    const duplicate = await api(`/api/v1/admin/movies/${movieId}/subtitles`, {
      method: 'POST',
      ...json({ language: 'ckb', external_url: 'https://subs.example.test/ckb.vtt' }),
    });

    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'SUBTITLE_LANGUAGE_TAKEN' },
    });
  });

  it('rejects a track with both an asset and an external url', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie();

    const response = await api(`/api/v1/admin/movies/${movieId}/subtitles`, {
      method: 'POST',
      ...json({
        language: 'en',
        asset_id: subtitleAssetId,
        external_url: 'https://subs.example.test/en.vtt',
      }),
    });

    expect(response.status).toBe(400);
  });

  it('rejects a track with neither an asset nor an external url', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie();

    const response = await api(`/api/v1/admin/movies/${movieId}/subtitles`, {
      method: 'POST',
      ...json({ language: 'en' }),
    });

    expect(response.status).toBe(400);
  });

  it('rejects an asset that is not a subtitle', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie();

    const response = await api(`/api/v1/admin/movies/${movieId}/subtitles`, {
      method: 'POST',
      ...json({ language: 'en', asset_id: posterId }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'ASSET_KIND_MISMATCH' },
    });
  });

  it('lets a VIEWER list tracks but not add one', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie();

    expect((await api(`/api/v1/admin/movies/${movieId}/subtitles`, {}, viewerToken)).status).toBe(
      200,
    );

    const response = await api(
      `/api/v1/admin/movies/${movieId}/subtitles`,
      { method: 'POST', ...json({ language: 'en', asset_id: subtitleAssetId }) },
      viewerToken,
    );

    expect(response.status).toBe(403);
  });

  it('deletes a track without touching the underlying asset', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie();

    const created = await api(`/api/v1/admin/movies/${movieId}/subtitles`, {
      method: 'POST',
      ...json({ language: 'en', asset_id: subtitleAssetId }),
    });

    const { subtitle } = (await created.json()) as { subtitle: { id: string } };

    expect(
      (await api(`/api/v1/admin/movies/${movieId}/subtitles/${subtitle.id}`, { method: 'DELETE' }))
        .status,
    ).toBe(204);

    expect(
      await db.select().from(mediaAsset).where(eq(mediaAsset.id, subtitleAssetId)),
    ).toHaveLength(1);
  });
});
