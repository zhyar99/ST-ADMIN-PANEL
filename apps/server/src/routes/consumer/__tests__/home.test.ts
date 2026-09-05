import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  ContentSearchResult,
  HomeItem,
  HomeResponse,
  HomeRowDto,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import {
  admin,
  consumer,
  createChannel,
  createHomeRow,
  createMovie,
  createSeriesWithEpisodes,
  harness,
  ownHomeRowIds,
  requireDb,
  startHarness,
  stopHarness,
} from './harness';

/**
 * Curated Home rows (Phase 10).
 *
 * The load-bearing assertions here are the ones the architecture depends on:
 * a ref to unpublished or deleted content is skipped rather than erroring, a
 * row left with nothing disappears instead of rendering as an empty heading,
 * and no stream URL reaches the response.
 *
 * Every consumer assertion filters the response through `ownHomeRowIds()`.
 * `GET /api/v1/home` returns every row in the database, and a developer's local
 * database has rows these tests did not create; without the filter the suite
 * would assert about whatever happened to be curated on that machine.
 */

const SOURCE_URL = 'https://stream.example.test/home-leak-check.m3u8';

let publishedMovieId = '';
let draftMovieId = '';
let publishedSeriesId = '';
let publishedChannelId = '';
let draftChannelId = '';

beforeAll(async () => {
  await startHarness();
  if (!harness().dbAvailable) return;

  [publishedMovieId, draftMovieId] = await Promise.all([
    createMovie({ title: 'Home Published Movie', sources: [SOURCE_URL] }),
    createMovie({ title: 'Home Draft Movie', publish: false }),
  ]);

  const seriesFixture = await createSeriesWithEpisodes();
  publishedSeriesId = seriesFixture.seriesId;

  [publishedChannelId, draftChannelId] = await Promise.all([
    createChannel({ name: 'Home Published Channel', category: 'News' }),
    createChannel({ name: 'Home Draft Channel', publish: false }),
  ]);
}, 60_000);

afterAll(async () => {
  await stopHarness();
});

/** Every key name anywhere in a payload, at any depth. */
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

/** The rows this run created, in the order the API returned them. */
async function ownRows(headers: Record<string, string> = {}) {
  const response = await consumer('/api/v1/home', { headers });
  expect(response.status).toBe(200);

  const body = (await response.json()) as HomeResponse;
  const mine = ownHomeRowIds();

  return { body, rows: body.rows.filter((row) => mine.has(row.id)) };
}

describe('GET /api/v1/home — resolution', () => {
  it('resolves a published movie ref into a full card', async (ctx) => {
    requireDb(ctx);

    const rowId = await createHomeRow({
      title: 'Resolves Movies',
      itemRefs: [{ type: 'MOVIE', id: publishedMovieId }],
    });

    const { rows } = await ownRows();
    const row = rows.find((entry) => entry.id === rowId);

    expect(row).toBeDefined();
    expect(row!.title).toBe('Resolves Movies');
    expect(row!.items).toHaveLength(1);

    const item = row!.items[0]!;
    expect(item.type).toBe('MOVIE');
    expect(item.id).toBe(publishedMovieId);
    expect(item).toMatchObject({
      title: 'Home Published Movie',
      overview: 'An overview',
      releaseYear: 2024,
      runtimeMinutes: 118,
    });
    expect(item).toHaveProperty('backdropUrl');
    // The fixture attaches a poster asset, so this must be a real URL rather
    // than the null a missing left join would produce.
    expect((item as Extract<HomeItem, { type: 'MOVIE' }>).posterUrl).toContain('/storage/');
  });

  it('resolves a live channel ref with its name, logo and category', async (ctx) => {
    requireDb(ctx);

    const rowId = await createHomeRow({
      title: 'Resolves Channels',
      itemRefs: [{ type: 'LIVE_CHANNEL', id: publishedChannelId }],
    });

    const { rows } = await ownRows();
    const item = rows.find((entry) => entry.id === rowId)!.items[0]!;

    expect(item).toEqual({
      type: 'LIVE_CHANNEL',
      id: publishedChannelId,
      name: 'Home Published Channel',
      // Channels in the fixture carry no logo asset.
      logoUrl: null,
      category: 'News',
    });
  });

  it('resolves a published series ref', async (ctx) => {
    requireDb(ctx);

    const rowId = await createHomeRow({
      title: 'Resolves Series',
      itemRefs: [{ type: 'SERIES', id: publishedSeriesId }],
    });

    const { rows } = await ownRows();
    const item = rows.find((entry) => entry.id === rowId)!.items[0]!;

    expect(item.type).toBe('SERIES');
    expect(item.id).toBe(publishedSeriesId);
  });

  it('skips draft content but keeps the rest of the row', async (ctx) => {
    requireDb(ctx);

    const rowId = await createHomeRow({
      title: 'Mixed Row',
      itemRefs: [
        { type: 'MOVIE', id: draftMovieId },
        { type: 'MOVIE', id: publishedMovieId },
        { type: 'LIVE_CHANNEL', id: draftChannelId },
      ],
    });

    const { rows } = await ownRows();
    const row = rows.find((entry) => entry.id === rowId)!;

    expect(row.items).toHaveLength(1);
    expect(row.items[0]!.id).toBe(publishedMovieId);
  });

  it('skips a ref whose content does not exist at all', async (ctx) => {
    requireDb(ctx);

    const rowId = await createHomeRow({
      title: 'Dangling Ref Row',
      itemRefs: [
        { type: 'MOVIE', id: randomUUID() },
        { type: 'MOVIE', id: publishedMovieId },
      ],
    });

    const { rows } = await ownRows();
    const row = rows.find((entry) => entry.id === rowId)!;

    expect(row.items).toHaveLength(1);
    expect(row.items[0]!.id).toBe(publishedMovieId);
  });

  it('omits a row whose every ref resolves to nothing', async (ctx) => {
    requireDb(ctx);

    const rowId = await createHomeRow({
      title: 'All Unresolvable',
      itemRefs: [
        { type: 'MOVIE', id: draftMovieId },
        { type: 'LIVE_CHANNEL', id: draftChannelId },
        { type: 'SERIES', id: randomUUID() },
      ],
    });

    const { rows } = await ownRows();

    expect(rows.some((entry) => entry.id === rowId)).toBe(false);
  });

  it('omits a row with no items at all', async (ctx) => {
    requireDb(ctx);

    const rowId = await createHomeRow({ title: 'Empty Row' });
    const { rows } = await ownRows();

    expect(rows.some((entry) => entry.id === rowId)).toBe(false);
  });

  it('unpublishing referenced content empties the row without erroring', async (ctx) => {
    requireDb(ctx);

    const movieId = await createMovie({ title: 'Soon Unpublished' });
    const rowId = await createHomeRow({
      title: 'Unpublish Row',
      itemRefs: [{ type: 'MOVIE', id: movieId }],
    });

    const before = await ownRows();
    expect(before.rows.find((entry) => entry.id === rowId)!.items).toHaveLength(1);

    const unpublished = await admin(`/api/v1/admin/movies/${movieId}/unpublish`, {
      method: 'POST',
    });
    expect(unpublished.status).toBe(200);

    const after = await ownRows();
    expect(after.rows.some((entry) => entry.id === rowId)).toBe(false);

    // The row itself survives — only its rendering changed.
    const stillThere = await admin(`/api/v1/admin/home/rows/${rowId}`);
    expect(stillThere.status).toBe(200);
  });
});

describe('GET /api/v1/home — ordering', () => {
  it('returns rows by `order` ascending and items in item_refs order', async (ctx) => {
    requireDb(ctx);

    const refs = [
      { type: 'LIVE_CHANNEL' as const, id: publishedChannelId },
      { type: 'MOVIE' as const, id: publishedMovieId },
      { type: 'SERIES' as const, id: publishedSeriesId },
    ];

    const secondId = await createHomeRow({ title: 'Ordering B', order: 900, itemRefs: refs });
    const firstId = await createHomeRow({
      title: 'Ordering A',
      order: 899,
      // Reversed relative to `refs`, so item order cannot be an artifact of the
      // order the underlying content was created in.
      itemRefs: [...refs].reverse(),
    });

    const { rows } = await ownRows();
    const positions = rows.map((row) => row.id);

    expect(positions.indexOf(firstId)).toBeLessThan(positions.indexOf(secondId));

    expect(rows.find((row) => row.id === secondId)!.items.map((item) => item.id)).toEqual([
      publishedChannelId,
      publishedMovieId,
      publishedSeriesId,
    ]);
    expect(rows.find((row) => row.id === firstId)!.items.map((item) => item.id)).toEqual([
      publishedSeriesId,
      publishedMovieId,
      publishedChannelId,
    ]);
  });
});

describe('GET /api/v1/home — localisation', () => {
  it('honours Accept-Language for row titles and item copy', async (ctx) => {
    requireDb(ctx);

    const rowId = await createHomeRow({
      title: 'Localised Row',
      itemRefs: [{ type: 'MOVIE', id: publishedMovieId }],
    });

    for (const [header, suffix] of [
      ['ckb', ' (ckb)'],
      ['ar', ' (ar)'],
    ] as const) {
      const { rows } = await ownRows({ 'accept-language': header });
      const row = rows.find((entry) => entry.id === rowId)!;

      expect(row.title).toBe(`Localised Row${suffix}`);
      expect(row.items[0]!).toMatchObject({ title: `Home Published Movie${suffix}` });
    }
  });

  it('falls back to English for an unsupported language', async (ctx) => {
    requireDb(ctx);

    const rowId = await createHomeRow({
      title: 'Fallback Row',
      itemRefs: [{ type: 'MOVIE', id: publishedMovieId }],
    });

    const { rows } = await ownRows({ 'accept-language': 'fr-FR,fr;q=0.9' });

    expect(rows.find((entry) => entry.id === rowId)!.title).toBe('Fallback Row');
  });
});

describe('GET /api/v1/home — stream URL containment', () => {
  it('never exposes a stream source URL', async (ctx) => {
    requireDb(ctx);

    await createHomeRow({
      title: 'Leak Check',
      itemRefs: [
        { type: 'MOVIE', id: publishedMovieId },
        { type: 'LIVE_CHANNEL', id: publishedChannelId },
        { type: 'SERIES', id: publishedSeriesId },
      ],
    });

    const { body } = await ownRows();
    const keys = keysDeep(body);

    for (const forbidden of ['url', 'sourceUrl', 'streamUrl', 'stream_url', 'sources']) {
      expect(keys.has(forbidden), `payload must not contain a "${forbidden}" key`).toBe(false);
    }

    expect(JSON.stringify(body)).not.toContain(SOURCE_URL);
  });

  it('requires no authentication', async (ctx) => {
    requireDb(ctx);

    // `consumer()` sends no Authorization header at all.
    expect((await consumer('/api/v1/home')).status).toBe(200);
  });
});

describe('admin home row CRUD', () => {
  it('rejects unauthenticated access', async (ctx) => {
    requireDb(ctx);

    const response = await consumer('/api/v1/admin/home/rows');
    expect(response.status).toBe(401);
  });

  it('creates, reads, updates and deletes a row', async (ctx) => {
    requireDb(ctx);

    const rowId = await createHomeRow({ title: 'CRUD Row' });

    const read = await admin(`/api/v1/admin/home/rows/${rowId}`);
    const { row } = (await read.json()) as { row: HomeRowDto };
    expect(row.titleI18n.en).toBe('CRUD Row');
    expect(row.itemRefs).toEqual([]);

    const patched = await admin(`/api/v1/admin/home/rows/${rowId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title_i18n: { en: 'Renamed', ckb: 'Renamed (ckb)', ar: 'Renamed (ar)' },
        item_refs: [{ type: 'MOVIE', id: publishedMovieId }],
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(patched.status).toBe(200);
    const { row: updated } = (await patched.json()) as { row: HomeRowDto };
    expect(updated.titleI18n.en).toBe('Renamed');
    expect(updated.itemRefs).toEqual([{ type: 'MOVIE', id: publishedMovieId }]);

    expect((await admin(`/api/v1/admin/home/rows/${rowId}`, { method: 'DELETE' })).status).toBe(
      204,
    );
    expect((await admin(`/api/v1/admin/home/rows/${rowId}`)).status).toBe(404);
  });

  it('deleting a row leaves the content it referenced untouched', async (ctx) => {
    requireDb(ctx);

    const rowId = await createHomeRow({
      title: 'Delete Me',
      itemRefs: [{ type: 'MOVIE', id: publishedMovieId }],
    });

    await admin(`/api/v1/admin/home/rows/${rowId}`, { method: 'DELETE' });

    const movie = await admin(`/api/v1/admin/movies/${publishedMovieId}`);
    expect(movie.status).toBe(200);
  });

  it('lists rows ordered by `order` ascending', async (ctx) => {
    requireDb(ctx);

    const later = await createHomeRow({ title: 'List B', order: 5000 });
    const earlier = await createHomeRow({ title: 'List A', order: 4999 });

    const response = await admin('/api/v1/admin/home/rows');
    const { rows } = (await response.json()) as { rows: HomeRowDto[] };
    const ids = rows.map((row) => row.id);

    expect(ids.indexOf(earlier)).toBeLessThan(ids.indexOf(later));
    expect([...rows].sort((a, b) => a.order - b.order).map((row) => row.id)).toEqual(ids);
  });

  it('rejects a malformed item ref', async (ctx) => {
    requireDb(ctx);

    const response = await admin('/api/v1/admin/home/rows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title_i18n: { en: 'Bad', ckb: 'Bad', ar: 'Bad' },
        item_refs: [{ type: 'PODCAST', id: publishedMovieId }],
      }),
    });

    expect(response.status).toBe(400);
  });

  it('rejects a title missing a language', async (ctx) => {
    requireDb(ctx);

    const response = await admin('/api/v1/admin/home/rows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title_i18n: { en: 'Only English' } }),
    });

    expect(response.status).toBe(400);
  });

  it('rejects an item ref carrying extra fields', async (ctx) => {
    requireDb(ctx);

    // The column is written back verbatim, so anything accepted here is
    // persisted — a smuggled `url` must not survive validation.
    const response = await admin('/api/v1/admin/home/rows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title_i18n: { en: 'Smuggle', ckb: 'Smuggle', ar: 'Smuggle' },
        item_refs: [
          { type: 'MOVIE', id: publishedMovieId, url: 'https://evil.example.test/x.m3u8' },
        ],
      }),
    });

    expect(response.status).toBe(400);
  });
});

describe('PUT /api/v1/admin/home/rows/reorder', () => {
  it('rewrites the order column to match the supplied sequence', async (ctx) => {
    requireDb(ctx);

    const a = await createHomeRow({ title: 'Reorder A' });
    const b = await createHomeRow({ title: 'Reorder B' });
    const c = await createHomeRow({ title: 'Reorder C' });

    // The endpoint requires every row, which is what the UI sends: it holds the
    // full list and PUTs it back rearranged.
    const listed = await admin('/api/v1/admin/home/rows');
    const all = ((await listed.json()) as { rows: HomeRowDto[] }).rows.map((row) => row.id);

    const others = all.filter((id) => ![a, b, c].includes(id));
    const desired = [...others, c, a, b];

    const response = await admin('/api/v1/admin/home/rows/reorder', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: desired }),
    });

    expect(response.status).toBe(200);
    const { rows } = (await response.json()) as { rows: HomeRowDto[] };
    expect(rows.map((row) => row.id)).toEqual(desired);

    // Positions are dense 0..n-1, not merely sorted.
    expect(rows.map((row) => row.order)).toEqual(desired.map((_, index) => index));

    // ...and it persisted.
    const reread = await admin('/api/v1/admin/home/rows');
    const persisted = ((await reread.json()) as { rows: HomeRowDto[] }).rows.map((row) => row.id);
    expect(persisted).toEqual(desired);
  });

  it('rejects an unknown id without changing any order', async (ctx) => {
    requireDb(ctx);

    const before = await admin('/api/v1/admin/home/rows');
    const ids = ((await before.json()) as { rows: HomeRowDto[] }).rows.map((row) => row.id);

    const response = await admin('/api/v1/admin/home/rows/reorder', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [...ids].reverse().concat(randomUUID()) }),
    });

    expect(response.status).toBe(404);

    const after = await admin('/api/v1/admin/home/rows');
    expect(((await after.json()) as { rows: HomeRowDto[] }).rows.map((row) => row.id)).toEqual(ids);
  });

  it('rejects duplicate ids', async (ctx) => {
    requireDb(ctx);

    const rowId = await createHomeRow({ title: 'Dupe' });

    const response = await admin('/api/v1/admin/home/rows/reorder', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [rowId, rowId] }),
    });

    expect(response.status).toBe(400);
  });
});

describe('GET /api/v1/admin/home/content-search', () => {
  it('returns published content with its type badge', async (ctx) => {
    requireDb(ctx);

    const response = await admin('/api/v1/admin/home/content-search?q=Home%20Published%20Movie');
    expect(response.status).toBe(200);

    const { results } = (await response.json()) as { results: ContentSearchResult[] };
    const hit = results.find((result) => result.id === publishedMovieId);

    expect(hit).toBeDefined();
    expect(hit!.type).toBe('MOVIE');
    expect(hit!.title).toBe('Home Published Movie');
  });

  it('never returns draft content', async (ctx) => {
    requireDb(ctx);

    const response = await admin('/api/v1/admin/home/content-search?q=Home%20Draft');
    const { results } = (await response.json()) as { results: ContentSearchResult[] };

    expect(results.map((result) => result.id)).not.toContain(draftMovieId);
    expect(results.map((result) => result.id)).not.toContain(draftChannelId);
  });

  it('filters by type', async (ctx) => {
    requireDb(ctx);

    const response = await admin('/api/v1/admin/home/content-search?type=LIVE_CHANNEL');
    const { results } = (await response.json()) as { results: ContentSearchResult[] };

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.type === 'LIVE_CHANNEL')).toBe(true);
  });

  it('treats a wildcard as a literal, not a pattern', async (ctx) => {
    requireDb(ctx);

    const response = await admin('/api/v1/admin/home/content-search?q=%25');
    const { results } = (await response.json()) as { results: ContentSearchResult[] };

    // A bare "%" would match the entire catalogue if it reached ILIKE unescaped.
    expect(results).toHaveLength(0);
  });

  it('bounds the result count', async (ctx) => {
    requireDb(ctx);

    const response = await admin('/api/v1/admin/home/content-search?limit=999');
    expect(response.status).toBe(400);
  });

  it('never exposes a stream URL', async (ctx) => {
    requireDb(ctx);

    const response = await admin('/api/v1/admin/home/content-search');
    const body = await response.json();

    expect(JSON.stringify(body)).not.toContain(SOURCE_URL);
  });
});

describe('GET /api/v1/admin/home/content-lookup', () => {
  it('resolves the refs a row holds', async (ctx) => {
    requireDb(ctx);

    const refs = `MOVIE:${publishedMovieId},LIVE_CHANNEL:${publishedChannelId}`;
    const response = await admin(`/api/v1/admin/home/content-lookup?refs=${refs}`);

    expect(response.status).toBe(200);
    const { results } = (await response.json()) as { results: ContentSearchResult[] };

    expect(results).toHaveLength(2);
    expect(results.find((result) => result.id === publishedMovieId)!.title).toBe(
      'Home Published Movie',
    );
    expect(results.find((result) => result.id === publishedChannelId)!.type).toBe('LIVE_CHANNEL');
  });

  it('omits refs that are unpublished or missing', async (ctx) => {
    requireDb(ctx);

    const refs = [
      `MOVIE:${publishedMovieId}`,
      `MOVIE:${draftMovieId}`,
      `SERIES:${randomUUID()}`,
    ].join(',');

    const response = await admin(`/api/v1/admin/home/content-lookup?refs=${refs}`);
    const { results } = (await response.json()) as { results: ContentSearchResult[] };

    expect(results.map((result) => result.id)).toEqual([publishedMovieId]);
  });

  it('rejects a malformed ref', async (ctx) => {
    requireDb(ctx);

    const response = await admin('/api/v1/admin/home/content-lookup?refs=MOVIE:not-a-uuid');
    expect(response.status).toBe(400);
  });

  it('rejects an unknown ref type', async (ctx) => {
    requireDb(ctx);

    const response = await admin(
      `/api/v1/admin/home/content-lookup?refs=PODCAST:${publishedMovieId}`,
    );
    expect(response.status).toBe(400);
  });
});
