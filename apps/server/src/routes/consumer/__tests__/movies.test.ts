import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  LiveChannelListItem,
  MovieDetail,
  MovieListItem,
  PaginatedResponse,
  SearchHit,
  SeriesDetail,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import {
  admin,
  consumer,
  createChannel,
  createGenre,
  createMovie,
  createSeriesWithEpisodes,
  harness,
  requireDb,
  startHarness,
  stopHarness,
} from './harness';

/**
 * Consumer catalogue endpoints.
 *
 * The two things worth asserting here are the two things the architecture
 * depends on: draft content never appears, and no stream URL does either. The
 * rest — localisation, pagination, joins — is ordinary correctness.
 */

const SOURCE_URL = 'https://stream.example.test/leak-check.m3u8';

let publishedMovieId = '';
let draftMovieId = '';
let unpublishedMovieId = '';
let genreId = '';
let otherGenreId = '';
let seriesFixture: Awaited<ReturnType<typeof createSeriesWithEpisodes>>;

/**
 * Every key name anywhere in a JSON payload, at any depth.
 *
 * A substring search over the stringified body would be fooled by a title that
 * happens to contain the word "url"; walking the structure asks the question
 * that actually matters — is there a *field* called this.
 */
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

/**
 * Asserts a payload carries no stream URL, by key name and by value.
 *
 * `subtitleTracks[].url` is a deliberate exception: it points at a subtitle
 * *file* (a storage asset or an operator-supplied remote URL), which is public
 * by design and unrelated to `stream_source.url`. The value check below is what
 * actually enforces the rule the key check can only approximate — it fails if
 * the real stream URL appears anywhere in the body under any name at all.
 */
function expectNoStreamUrl(body: unknown): void {
  const keys = keysDeep(body);

  for (const forbidden of ['sourceUrl', 'streamUrl', 'stream_url', 'sources', 'streamSources']) {
    expect(keys.has(forbidden), `payload must not contain a "${forbidden}" key`).toBe(false);
  }

  expect(JSON.stringify(body)).not.toContain(SOURCE_URL);
}

beforeAll(async () => {
  await startHarness();
  if (!harness().dbAvailable) return;

  genreId = await createGenre(`Consumer Genre ${randomUUID().slice(0, 6)}`);
  otherGenreId = await createGenre(`Other Genre ${randomUUID().slice(0, 6)}`);

  publishedMovieId = await createMovie({
    title: `Published Consumer Movie ${randomUUID().slice(0, 6)}`,
    genreIds: [genreId],
    sources: [SOURCE_URL],
    subtitle: 'https://subs.example.test/movie.en.vtt',
  });

  draftMovieId = await createMovie({ publish: false, sources: [SOURCE_URL] });

  unpublishedMovieId = await createMovie({ sources: [SOURCE_URL] });
  await admin(`/api/v1/admin/movies/${unpublishedMovieId}/unpublish`, { method: 'POST' });

  seriesFixture = await createSeriesWithEpisodes();
  await createChannel({ category: 'ConsumerTestNews' });
  await createChannel({ category: 'ConsumerTestSport', publish: false });
}, 60_000);

afterAll(stopHarness);

describe('GET /api/v1/movies', () => {
  it('needs no authentication', async (ctx) => {
    requireDb(ctx);

    const response = await consumer('/api/v1/movies');

    expect(response.status).toBe(200);
  });

  it('returns published movies and excludes drafts and unpublished ones', async (ctx) => {
    requireDb(ctx);

    const response = await consumer('/api/v1/movies?limit=100');
    const body = (await response.json()) as PaginatedResponse<MovieListItem>;

    const ids = body.data.map((item) => item.id);
    expect(ids).toContain(publishedMovieId);
    expect(ids).not.toContain(draftMovieId);
    expect(ids).not.toContain(unpublishedMovieId);
  });

  it('returns pagination meta', async (ctx) => {
    requireDb(ctx);

    const body = (await (await consumer('/api/v1/movies?page=1&limit=1')).json()) as
      PaginatedResponse<MovieListItem>;

    expect(body.data.length).toBeLessThanOrEqual(1);
    expect(body.meta.page).toBe(1);
    expect(body.meta.limit).toBe(1);
    expect(body.meta.total).toBeGreaterThanOrEqual(1);
  });

  it('localises copy to the Accept-Language header', async (ctx) => {
    requireDb(ctx);

    const find = async (header: string): Promise<MovieListItem | undefined> => {
      const body = (await (
        await consumer('/api/v1/movies?limit=100', { headers: { 'accept-language': header } })
      ).json()) as PaginatedResponse<MovieListItem>;
      return body.data.find((item) => item.id === publishedMovieId);
    };

    expect((await find('en'))?.title).not.toMatch(/\(ckb\)$/);
    expect((await find('ckb,ar;q=0.9'))?.title).toMatch(/\(ckb\)$/);
    expect((await find('ar'))?.title).toMatch(/\(ar\)$/);
    // Unsupported language falls back to English rather than 406ing.
    expect((await find('fr'))?.title).not.toMatch(/\((ckb|ar)\)$/);
  });

  it('filters by genre', async (ctx) => {
    requireDb(ctx);

    const matching = (await (
      await consumer(`/api/v1/movies?limit=100&genre=${genreId}`)
    ).json()) as PaginatedResponse<MovieListItem>;
    expect(matching.data.map((item) => item.id)).toContain(publishedMovieId);

    const other = (await (
      await consumer(`/api/v1/movies?limit=100&genre=${otherGenreId}`)
    ).json()) as PaginatedResponse<MovieListItem>;
    expect(other.data.map((item) => item.id)).not.toContain(publishedMovieId);
  });

  it('rejects out-of-range pagination and a malformed genre id', async (ctx) => {
    requireDb(ctx);

    expect((await consumer('/api/v1/movies?limit=1000')).status).toBe(400);
    expect((await consumer('/api/v1/movies?page=0')).status).toBe(400);
    expect((await consumer('/api/v1/movies?genre=not-a-uuid')).status).toBe(400);
  });

  it('leaks no stream URL in the list payload', async (ctx) => {
    requireDb(ctx);

    expectNoStreamUrl(await (await consumer('/api/v1/movies?limit=100')).json());
  });
});

describe('GET /api/v1/movies/:id', () => {
  it('returns the full detail for a published movie', async (ctx) => {
    requireDb(ctx);

    const response = await consumer(`/api/v1/movies/${publishedMovieId}`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as MovieDetail;

    expect(body.id).toBe(publishedMovieId);
    expect(body.releaseYear).toBe(2024);
    expect(body.runtimeMinutes).toBe(118);
    expect(body.tagline).toBeTruthy();
    expect(body.genres.map((genre) => genre.id)).toContain(genreId);
    expect(body.posterUrl).toMatch(/^https?:\/\//);
    expect(body.subtitleTracks).toEqual([
      { language: 'en', url: 'https://subs.example.test/movie.en.vtt' },
    ]);
  });

  it('carries no stream URL at any depth', async (ctx) => {
    requireDb(ctx);

    expectNoStreamUrl(await (await consumer(`/api/v1/movies/${publishedMovieId}`)).json());
  });

  it('404s a draft, an unpublished movie and an unknown id alike', async (ctx) => {
    requireDb(ctx);

    expect((await consumer(`/api/v1/movies/${draftMovieId}`)).status).toBe(404);
    expect((await consumer(`/api/v1/movies/${unpublishedMovieId}`)).status).toBe(404);
    expect((await consumer(`/api/v1/movies/${randomUUID()}`)).status).toBe(404);
  });

  it('400s a malformed id', async (ctx) => {
    requireDb(ctx);

    expect((await consumer('/api/v1/movies/not-a-uuid')).status).toBe(400);
  });
});

describe('GET /api/v1/series/:id', () => {
  it('nests published episodes under their season and hides drafts', async (ctx) => {
    requireDb(ctx);

    const response = await consumer(`/api/v1/series/${seriesFixture.seriesId}`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as SeriesDetail;

    expect(body.seasons).toHaveLength(1);

    const [season] = body.seasons;
    expect(season!.number).toBe(1);

    const episodeIds = season!.episodes.map((episode) => episode.id);
    expect(episodeIds).toEqual([seriesFixture.publishedEpisodeId]);
    expect(episodeIds).not.toContain(seriesFixture.draftEpisodeId);

    expect(season!.episodes[0]!.subtitleTracks).toEqual([
      { language: 'ar', url: 'https://subs.example.test/ep1.ar.vtt' },
    ]);
  });

  it('carries no stream URL at any depth', async (ctx) => {
    requireDb(ctx);

    expectNoStreamUrl(await (await consumer(`/api/v1/series/${seriesFixture.seriesId}`)).json());
  });
});

describe('GET /api/v1/live-channels', () => {
  it('filters by category and excludes unpublished channels', async (ctx) => {
    requireDb(ctx);

    const news = (await (
      await consumer('/api/v1/live-channels?limit=100&category=ConsumerTestNews')
    ).json()) as PaginatedResponse<LiveChannelListItem>;

    expect(news.data.length).toBeGreaterThanOrEqual(1);
    expect(news.data.every((item) => item.category === 'ConsumerTestNews')).toBe(true);

    const draftCategory = (await (
      await consumer('/api/v1/live-channels?limit=100&category=ConsumerTestSport')
    ).json()) as PaginatedResponse<LiveChannelListItem>;

    expect(draftCategory.data).toHaveLength(0);
  });

  it('returns every published channel when no filter is given', async (ctx) => {
    requireDb(ctx);

    const body = (await (await consumer('/api/v1/live-channels?limit=100')).json()) as
      PaginatedResponse<LiveChannelListItem>;

    expect(body.data.some((item) => item.category === 'ConsumerTestNews')).toBe(true);
    expect(body.data.some((item) => item.category === 'ConsumerTestSport')).toBe(false);
    expectNoStreamUrl(body);
  });
});

describe('GET /api/v1/search', () => {
  it('finds a published movie by a substring of its title', async (ctx) => {
    requireDb(ctx);

    const body = (await (
      await consumer('/api/v1/search?q=Published%20Consumer%20Movie&limit=50')
    ).json()) as { data: SearchHit[] };

    const hit = body.data.find((entry) => entry.id === publishedMovieId);
    expect(hit?.type).toBe('movie');
    expect(hit?.title).toContain('Published Consumer Movie');
    expectNoStreamUrl(body);
  });

  it('does not treat the term as a LIKE pattern', async (ctx) => {
    requireDb(ctx);

    // An unescaped "%" would match every title in the catalogue.
    const body = (await (await consumer('/api/v1/search?q=%25&limit=50')).json()) as {
      data: SearchHit[];
    };

    expect(body.data.some((entry) => entry.id === publishedMovieId)).toBe(false);
  });

  it('rejects a blank term and an unsupported language', async (ctx) => {
    requireDb(ctx);

    expect((await consumer('/api/v1/search?q=')).status).toBe(400);
    expect((await consumer('/api/v1/search?q=test&lang=fr')).status).toBe(400);
  });
});
