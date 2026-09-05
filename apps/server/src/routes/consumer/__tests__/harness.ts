import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

import argon2 from 'argon2';
import { eq, inArray } from 'drizzle-orm';

import {
  adminUser,
  auditLog,
  homeRow,
  liveChannel,
  mediaAsset,
  movie,
  series,
  streamSource,
  subtitleTrack,
} from '../../../db/schema';
import { app } from '../../../app';
import { db, pool } from '../../../db/client';

/**
 * Shared fixture harness for the consumer route tests.
 *
 * The consumer API only shows published content, so every one of these tests
 * needs real rows in a real database — there is no useful unit-level substitute
 * for "does the WHERE clause exclude drafts". Content is built through the
 * admin API rather than by direct insert, so the fixtures exercise the same
 * publish gate an operator does and cannot accidentally produce a state the
 * product could never reach.
 *
 * Without a reachable database the suites skip rather than fail, matching
 * `publish.test.ts`.
 */

const ADMIN_PASSWORD = 'consumer-fixture-password-1';

/** Integration tests hit the API far harder than a real client would. */
const BYPASS = { 'x-test-bypass-rate-limit': '1' };

export interface Harness {
  baseUrl: string;
  dbAvailable: boolean;
}

const state = {
  server: undefined as Server | undefined,
  baseUrl: '',
  dbAvailable: false,
  adminId: '',
  token: '',
  posterId: '',
};

const created = {
  movies: new Set<string>(),
  series: new Set<string>(),
  episodes: new Set<string>(),
  channels: new Set<string>(),
  genres: new Set<string>(),
  homeRows: new Set<string>(),
};

export function harness(): Harness {
  return { baseUrl: state.baseUrl, dbAvailable: state.dbAvailable };
}

/** Skips the current test when there is no database to talk to. */
export function requireDb(ctx: { skip: () => void }): void {
  if (!state.dbAvailable) ctx.skip();
}

export function json(body: unknown): RequestInit {
  return { body: JSON.stringify(body) };
}

export function i18n(text: string) {
  return { en: text, ckb: `${text} (ckb)`, ar: `${text} (ar)` };
}

/** Authenticated admin request, for building fixtures. */
export function admin(pathname: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...BYPASS, authorization: `Bearer ${state.token}` };
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  return fetch(`${state.baseUrl}${pathname}`, { ...init, headers: { ...headers, ...init.headers } });
}

/** Unauthenticated request, the way a real consumer client calls the API. */
export function consumer(pathname: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...BYPASS };
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  return fetch(`${state.baseUrl}${pathname}`, { ...init, headers: { ...headers, ...init.headers } });
}

export async function startHarness(): Promise<void> {
  await new Promise<void>((resolve) => {
    state.server = app.listen(0, () => resolve());
  });
  state.baseUrl = `http://127.0.0.1:${(state.server!.address() as AddressInfo).port}`;

  try {
    await pool.query('SELECT 1');
    state.dbAvailable = true;
  } catch {
    return;
  }

  const email = `consumer-admin-${randomUUID().slice(0, 8)}@example.test`;

  const [row] = await db
    .insert(adminUser)
    .values({
      email,
      name: 'Consumer Fixture Admin',
      role: 'ADMIN',
      passwordHash: await argon2.hash(ADMIN_PASSWORD),
    })
    .returning({ id: adminUser.id });

  state.adminId = row!.id;

  const login = await fetch(`${state.baseUrl}/api/v1/admin/auth/login`, {
    method: 'POST',
    headers: { ...BYPASS, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: ADMIN_PASSWORD }),
  });

  state.token = ((await login.json()) as { accessToken: string }).accessToken;
  state.posterId = await seedPoster();
}

export async function stopHarness(): Promise<void> {
  if (state.dbAvailable) {
    // Home rows first: they reference content by id with no foreign key, so
    // nothing else cleans them up and a leftover row would join the *next*
    // run's GET /api/v1/home response.
    if (created.homeRows.size > 0) {
      await db.delete(homeRow).where(inArray(homeRow.id, [...created.homeRows]));
    }

    // `stream_source` and `subtitle_track` are polymorphic — no foreign key
    // cascades reach them — so every owner's rows go first, episodes included:
    // their own rows vanish with the series, but these would not.
    const owners = [...created.movies, ...created.episodes, ...created.channels];
    if (owners.length > 0) {
      await db.delete(streamSource).where(inArray(streamSource.ownerId, owners));
      await db.delete(subtitleTrack).where(inArray(subtitleTrack.ownerId, owners));
    }

    if (created.movies.size > 0) {
      await db.delete(movie).where(inArray(movie.id, [...created.movies]));
    }
    // Seasons and episodes cascade from the series row.
    if (created.series.size > 0) {
      await db.delete(series).where(inArray(series.id, [...created.series]));
    }
    if (created.channels.size > 0) {
      await db.delete(liveChannel).where(inArray(liveChannel.id, [...created.channels]));
    }
    // Genres go through the API so the in-use guard still applies — by now the
    // movies that referenced them are gone, so it should never fire.
    for (const genreId of created.genres) {
      await admin(`/api/v1/admin/genres/${genreId}`, { method: 'DELETE' });
    }

    if (state.posterId) await db.delete(mediaAsset).where(eq(mediaAsset.id, state.posterId));

    if (state.adminId) {
      await db.delete(auditLog).where(eq(auditLog.adminUserId, state.adminId));
      await db.delete(adminUser).where(eq(adminUser.id, state.adminId));
    }
  }

  await new Promise<void>((resolve) => state.server?.close(() => resolve()));
  await pool.end();
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

export function posterId(): string {
  return state.posterId;
}

// --- builders --------------------------------------------------------------

export async function createGenre(name: string): Promise<string> {
  const response = await admin('/api/v1/admin/genres', {
    method: 'POST',
    ...json({ name_i18n: i18n(name) }),
  });

  const { genre } = (await response.json()) as { genre: { id: string } };
  created.genres.add(genre.id);
  return genre.id;
}

export interface CreateMovieOptions {
  title?: string;
  genreIds?: string[];
  publish?: boolean;
  sources?: string[];
  subtitle?: string;
}

/** Creates a movie, optionally with sources, a subtitle track and a publish. */
export async function createMovie(options: CreateMovieOptions = {}): Promise<string> {
  const title = options.title ?? `Movie ${randomUUID().slice(0, 6)}`;

  const response = await admin('/api/v1/admin/movies', {
    method: 'POST',
    ...json({
      title_i18n: i18n(title),
      overview_i18n: i18n('An overview'),
      tagline_i18n: i18n('A tagline'),
      release_year: 2024,
      runtime_minutes: 118,
      poster_asset_id: state.posterId,
      ...(options.genreIds ? { genre_ids: options.genreIds } : {}),
    }),
  });

  const { movie: row } = (await response.json()) as { movie: { id: string } };
  created.movies.add(row.id);

  for (const url of options.sources ?? ['https://stream.example.test/primary.m3u8']) {
    await admin(`/api/v1/admin/movies/${row.id}/sources`, { method: 'POST', ...json({ url }) });
  }

  if (options.subtitle) {
    await admin(`/api/v1/admin/movies/${row.id}/subtitles`, {
      method: 'POST',
      ...json({ language: 'en', external_url: options.subtitle }),
    });
  }

  if (options.publish !== false) {
    await admin(`/api/v1/admin/movies/${row.id}/publish`, { method: 'POST' });
  }

  return row.id;
}

export interface SeriesFixture {
  seriesId: string;
  seasonId: string;
  publishedEpisodeId: string;
  draftEpisodeId: string;
}

/** A published series with one published and one draft episode in season 1. */
export async function createSeriesWithEpisodes(): Promise<SeriesFixture> {
  const response = await admin('/api/v1/admin/series', {
    method: 'POST',
    ...json({
      title_i18n: i18n(`Series ${randomUUID().slice(0, 6)}`),
      overview_i18n: i18n('A series overview'),
      poster_asset_id: state.posterId,
    }),
  });

  const { series: row } = (await response.json()) as { series: { id: string } };
  created.series.add(row.id);

  const seasonResponse = await admin(`/api/v1/admin/series/${row.id}/seasons`, {
    method: 'POST',
    ...json({ number: 1 }),
  });
  const { season } = (await seasonResponse.json()) as { season: { id: string } };

  const episodeId = async (number: number): Promise<string> => {
    const created_ = await admin(
      `/api/v1/admin/series/${row.id}/seasons/${season.id}/episodes`,
      { method: 'POST', ...json({ number, title_i18n: i18n(`Episode ${number}`) }) },
    );
    const { episode } = (await created_.json()) as { episode: { id: string } };
    created.episodes.add(episode.id);
    return episode.id;
  };

  const publishedEpisodeId = await episodeId(1);
  const draftEpisodeId = await episodeId(2);

  const episodePath = (id: string) =>
    `/api/v1/admin/series/${row.id}/seasons/${season.id}/episodes/${id}`;

  await admin(`${episodePath(publishedEpisodeId)}/sources`, {
    method: 'POST',
    ...json({ url: 'https://stream.example.test/episode.m3u8' }),
  });
  await admin(`${episodePath(publishedEpisodeId)}/subtitles`, {
    method: 'POST',
    ...json({ language: 'ar', external_url: 'https://subs.example.test/ep1.ar.vtt' }),
  });
  await admin(`${episodePath(publishedEpisodeId)}/publish`, { method: 'POST' });

  await admin(`/api/v1/admin/series/${row.id}/publish`, { method: 'POST' });

  return { seriesId: row.id, seasonId: season.id, publishedEpisodeId, draftEpisodeId };
}

export interface CreateChannelOptions {
  category?: string;
  publish?: boolean;
  name?: string;
}

export async function createChannel(options: CreateChannelOptions = {}): Promise<string> {
  const response = await admin('/api/v1/admin/live-channels', {
    method: 'POST',
    ...json({
      name_i18n: i18n(options.name ?? `Channel ${randomUUID().slice(0, 6)}`),
      category: options.category ?? 'News',
    }),
  });

  const { channel } = (await response.json()) as { channel: { id: string } };
  created.channels.add(channel.id);

  await admin(`/api/v1/admin/live-channels/${channel.id}/sources`, {
    method: 'POST',
    ...json({ url: 'https://stream.example.test/channel.m3u8' }),
  });

  if (options.publish !== false) {
    await admin(`/api/v1/admin/live-channels/${channel.id}/publish`, { method: 'POST' });
  }

  return channel.id;
}

export interface HomeItemRefFixture {
  type: 'MOVIE' | 'SERIES' | 'LIVE_CHANNEL';
  id: string;
}

export interface CreateHomeRowOptions {
  title?: string;
  order?: number;
  itemRefs?: HomeItemRefFixture[];
}

/**
 * Creates a curated Home row through the admin API.
 *
 * Built through the API rather than by direct insert for the same reason the
 * content builders are: the fixture then cannot express a row the product
 * could not produce — a malformed ref, or a title missing a language.
 */
export async function createHomeRow(options: CreateHomeRowOptions = {}): Promise<string> {
  const response = await admin('/api/v1/admin/home/rows', {
    method: 'POST',
    ...json({
      title_i18n: i18n(options.title ?? `Row ${randomUUID().slice(0, 6)}`),
      ...(options.order !== undefined ? { order: options.order } : {}),
      item_refs: options.itemRefs ?? [],
    }),
  });

  const { row } = (await response.json()) as { row: { id: string } };
  created.homeRows.add(row.id);
  return row.id;
}

/**
 * Every Home row this run created, in `order`.
 *
 * The consumer endpoint returns all rows in the database, and a developer's
 * local database has rows this test did not create. Suites filter the response
 * through this list so they assert about their own fixtures rather than about
 * whatever happens to be curated locally.
 */
export function ownHomeRowIds(): Set<string> {
  return new Set(created.homeRows);
}
