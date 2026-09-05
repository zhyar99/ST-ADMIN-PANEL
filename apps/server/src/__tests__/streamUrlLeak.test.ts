import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { app } from '../app';
import { SERVER_ROOT } from '../paths';

/**
 * The invariant this suite defends: `stream_source.url` reaches exactly one
 * consumer response — the playback session — and no other.
 *
 * It runs without Postgres. `db/client` is replaced by a fake query builder
 * that answers every `select()` with one synthetic row, projected from the
 * column list the caller asked for. `stream_source.url` is filled with a value
 * no other column can produce, so the secret reaches a response body if and
 * only if some code path carried that column into a DTO — which is the
 * invariant, rather than the narrower "did anyone join the table". A
 * catalogue endpoint that started returning a source URL fails here on the
 * first run, with no fixture to seed and no database to reset.
 */

const SECRET_STREAM_URL = 'http://secret.internal/stream.m3u8';
const CONTENT_ID = '11111111-1111-4111-8111-111111111111';

vi.mock('../db/client', async () => {
  const { getTableName } = await import('drizzle-orm');

  /**
   * The shape of a Drizzle column this fake needs, structurally.
   *
   * Declared here rather than imported: the schema modules pull `drizzle-orm`
   * in import mode and this factory resolves it in require mode, which are two
   * distinct nominal types for the same runtime object.
   */
  interface FakeColumn {
    name: string;
    dataType: string;
    columnType: string;
    table: object;
  }

  const tableNameOf = (table: object): string =>
    getTableName(table as Parameters<typeof getTableName>[0]);

  const SECRET = 'http://secret.internal/stream.m3u8';
  const ID = '11111111-1111-4111-8111-111111111111';
  const LOCALIZED = { en: 'Fixture Title', ckb: 'Fixture Title (ckb)', ar: 'Fixture Title (ar)' };

  /** Aliased tables keep their own name, so map them back to the real one. */
  const ALIASES: Record<string, string> = {
    poster_asset: 'media_asset',
    backdrop_asset: 'media_asset',
    logo_asset: 'media_asset',
  };

  const isColumn = (value: unknown): value is FakeColumn =>
    typeof value === 'object' && value !== null && 'name' in value && 'table' in value;

  /**
   * A plausible value for one selected column.
   *
   * Keyed on the column's own name rather than on a per-table fixture object:
   * a column added to `movie` tomorrow gets a value automatically, and the one
   * column whose value matters — `stream_source.url` — is special-cased.
   */
  const valueFor = (column: FakeColumn): unknown => {
    const table = tableNameOf(column.table);
    const name = column.name;

    if ((ALIASES[table] ?? table) === 'stream_source' && name === 'url') return SECRET;

    if (name.endsWith('_i18n')) return { ...LOCALIZED };
    if (name === 'item_refs') return [{ type: 'MOVIE', id: ID }];
    if (name === 'file_path') return 'posters/fixture.jpg';
    if (name === 'status') return 'PUBLISHED';
    if (name === 'language') return 'en';
    if (name === 'category') return 'News';
    if (name === 'last_test_result' || name === 'external_url') return null;

    switch (column.dataType) {
      case 'date':
        return new Date('2026-01-01T00:00:00.000Z');
      case 'number':
        return 1;
      case 'boolean':
        return true;
      case 'json':
        return {};
      default:
        return column.columnType === 'PgUUID' ? ID : 'fixture';
    }
  };

  /**
   * A chainable stand-in for a Drizzle select.
   *
   * Filters, joins and ordering are accepted and discarded — this suite asks
   * "which columns did the query ask for", never "which rows would Postgres
   * return". The `PUBLISHED`-only and pagination behaviour is covered by the
   * database-backed consumer suites.
   */
  class FakeSelect implements PromiseLike<Record<string, unknown>[]> {
    constructor(private readonly fields: Record<string, unknown>) {}

    from(): this {
      return this;
    }
    leftJoin(): this {
      return this;
    }
    innerJoin(): this {
      return this;
    }
    where(): this {
      return this;
    }
    orderBy(): this {
      return this;
    }
    groupBy(): this {
      return this;
    }
    limit(): this {
      return this;
    }
    offset(): this {
      return this;
    }

    private row(): Record<string, unknown> {
      const row: Record<string, unknown> = {};
      for (const [alias, expression] of Object.entries(this.fields)) {
        // Anything that is not a column is an aggregate or raw SQL — count().
        row[alias] = isColumn(expression) ? valueFor(expression) : 1;
      }
      return row;
    }

    then<TResult1 = Record<string, unknown>[], TResult2 = never>(
      onfulfilled?: ((value: Record<string, unknown>[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve([this.row()]).then(onfulfilled, onrejected);
    }
  }

  const chainable = () => {
    const self: Record<string, unknown> = {};
    for (const method of [
      'values',
      'set',
      'where',
      'returning',
      'onConflictDoNothing',
      'onConflictDoUpdate',
    ]) {
      self[method] = () => self;
    }
    self.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
    return self;
  };

  return {
    db: {
      select: (fields: Record<string, unknown> = {}) => new FakeSelect(fields),
      insert: chainable,
      update: chainable,
      delete: chainable,
      // Phase 15's recommendation query is a single hand-written CTE, which
      // reaches the driver through `execute` rather than the query builder.
      // An empty result is the right stand-in: this suite asks whether a
      // response can carry a stream URL, and a scoring query that selects no
      // stream column cannot, at any row count.
      execute: () => Promise.resolve({ rows: [] }),
    },
    pool: { query: () => Promise.resolve({ rows: [] }), end: () => Promise.resolve() },
  };
});

let server: Server;
let baseUrl: string;

async function get(
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { 'x-test-bypass-rate-limit': '1', ...headers },
  });
  return { status: response.status, body: await response.text() };
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Every consumer read. If a new one appears it belongs in this list. */
const CATALOGUE_ENDPOINTS: readonly string[] = [
  '/api/v1/movies',
  `/api/v1/movies/${CONTENT_ID}`,
  '/api/v1/series',
  `/api/v1/series/${CONTENT_ID}`,
  '/api/v1/live-channels',
  '/api/v1/home',
  '/api/v1/search?q=Fixture',
  // Phase 15. Called with a device header so the personalized paths actually
  // run rather than short-circuiting on an anonymous request.
  '/api/v1/devices/recommendations',
  '/api/v1/devices/favorites',
  '/api/v1/devices/watchlist',
  '/api/v1/devices/history',
];

/** A syntactically valid device id, so `deviceIdentity` admits the request. */
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';

const CONSUMER_HEADERS = { 'x-device-id': DEVICE_ID };

describe('the consumer catalogue never carries a stream URL', () => {
  it.each(CATALOGUE_ENDPOINTS)('GET %s answers without querying stream_source', async (endpoint) => {
    const { status, body } = await get(endpoint, CONSUMER_HEADERS);

    expect(status, `${endpoint} -> ${body}`).toBe(200);
    // The fake returns a row for every table, so an empty payload would make
    // the assertion below vacuous.
    expect(body.length).toBeGreaterThan(2);
    expect(body).not.toContain(SECRET_STREAM_URL);
    expect(body).not.toContain('secret.internal');
  });

  it.each(CATALOGUE_ENDPOINTS)('GET %s exposes no stream-source shaped field', async (endpoint) => {
    const { body } = await get(endpoint, CONSUMER_HEADERS);
    const payload: unknown = JSON.parse(body);

    // Walks the structure rather than grepping the text: a field called
    // `sourceUrl` nested three objects deep is exactly the accident this is
    // looking for. `subtitleTracks[].url` is a deliberate exception — it points
    // at a caption file, which is public, and the value check above is what
    // proves it is not a stream URL.
    const offenders: string[] = [];

    const walk = (node: unknown, trail: string): void => {
      if (Array.isArray(node)) {
        node.forEach((entry, index) => walk(entry, `${trail}[${index}]`));
        return;
      }
      if (node === null || typeof node !== 'object') return;

      for (const [name, value] of Object.entries(node)) {
        const here = trail ? `${trail}.${name}` : name;
        if (['sourceUrl', 'streamUrl', 'stream_url', 'sources', 'streamSources'].includes(name)) {
          offenders.push(here);
        }
        walk(value, here);
      }
    };

    walk(payload, '');
    expect(offenders, `${endpoint} exposed ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('the playback session is the one authorised path', () => {
  it('POST /api/v1/playback/session returns the stream URL', async () => {
    const response = await fetch(`${baseUrl}/api/v1/playback/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-bypass-rate-limit': '1' },
      body: JSON.stringify({ contentType: 'movie', contentId: CONTENT_ID }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { sourceUrl: string };
    expect(body.sourceUrl).toBe(SECRET_STREAM_URL);
  });

  it('returns the stream URL for a live channel too', async () => {
    const response = await fetch(`${baseUrl}/api/v1/playback/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-bypass-rate-limit': '1' },
      body: JSON.stringify({ contentType: 'live_channel', contentId: CONTENT_ID }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { sourceUrl: string };
    expect(body.sourceUrl).toBe(SECRET_STREAM_URL);
  });
});

describe('static check on the consumer routes', () => {
  it('no consumer route file mentions stream_source outside a comment', () => {
    const directory = path.join(SERVER_ROOT, 'src/routes/consumer');
    const offenders: string[] = [];

    const inspect = (target: string): void => {
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        const full = path.join(target, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') inspect(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;

        fs.readFileSync(full, 'utf8')
          .split('\n')
          .forEach((line, index) => {
            const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
            if (/stream_source|streamSource/.test(code) && /\burl\b/i.test(code)) {
              offenders.push(`${path.relative(SERVER_ROOT, full)}:${index + 1}`);
            }
          });
      }
    };

    inspect(directory);
    expect(offenders, `stream source URL referenced in: ${offenders.join(', ')}`).toEqual([]);
  });
});
