import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';

import { desc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { db, pool } from '../../db/client';
import { healthCheckLog, streamSource } from '../../db/schema';
import { listHealthHistory, testSource } from './streamHealthService';

/**
 * `testSource` is exercised against real rows with `fetch` and DNS stubbed, so
 * the assertions cover the part that matters — what gets written back to
 * `last_test_result` — without depending on a reachable origin or on the
 * machine running the suite having working name resolution.
 */

const PUBLIC_URL = 'https://stream.example.test/live/master.m3u8';

/** An address outside every blocked range, so the SSRF guard lets it through. */
const PUBLIC_IP = '93.184.216.34';

let dbAvailable = false;
const createdIds = new Set<string>();

function requireDb(ctx: { skip: () => void }): void {
  if (!dbAvailable) ctx.skip();
}

/** Inserts a source with no movie behind it — testSource only needs the row. */
async function seedSource(url: string): Promise<string> {
  const [row] = await db
    .insert(streamSource)
    .values({ ownerType: 'MOVIE', ownerId: randomUUID(), url, priority: 0 })
    .returning({ id: streamSource.id });

  createdIds.add(row!.id);
  return row!.id;
}

function stubFetch(responder: (input: unknown, init?: RequestInit) => Response) {
  // `.test` is a reserved TLD and never resolves, so the guard's DNS check has
  // to be stubbed as well or it would reject before fetch is ever reached.
  vi.spyOn(dns, 'lookup').mockResolvedValue([
    { address: PUBLIC_IP, family: 4 },
  ] as unknown as never);

  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => responder(input, init));
}

beforeAll(async () => {
  try {
    await pool.query('SELECT 1');
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (dbAvailable && createdIds.size > 0) {
    // health_check_log rows go with them: the FK is ON DELETE CASCADE.
    for (const id of createdIds) {
      await db.delete(streamSource).where(eq(streamSource.id, id));
    }
  }

  await pool.end();
});

describe('testSource', () => {
  it('records OK when the origin answers a HEAD with 200', async (ctx) => {
    requireDb(ctx);

    const calls: string[] = [];
    stubFetch((_input, init) => {
      calls.push(init?.method ?? 'GET');
      return new Response(null, { status: 200 });
    });

    const id = await seedSource(PUBLIC_URL);
    const outcome = await testSource(id);

    expect(outcome.result).toBe('OK');
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
    // A healthy HEAD must not be followed by a body-fetching GET.
    expect(calls).toEqual(['HEAD']);

    const [row] = await db.select().from(streamSource).where(eq(streamSource.id, id));
    expect(row?.lastTestResult).toBe('OK');
    expect(row?.lastTestedAt).toBeInstanceOf(Date);
  });

  it('falls back to a ranged GET when HEAD is not supported', async (ctx) => {
    requireDb(ctx);

    const seen: { method: string; range?: string }[] = [];

    stubFetch((_input, init) => {
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      seen.push({ method, range: headers.get('range') ?? undefined });

      // 405 Method Not Allowed is the common origin response to HEAD.
      return method === 'HEAD'
        ? new Response(null, { status: 405 })
        : new Response('#EXTM3U', { status: 206 });
    });

    const id = await seedSource(PUBLIC_URL);
    const outcome = await testSource(id);

    expect(outcome.result).toBe('OK');
    expect(seen).toEqual([
      { method: 'HEAD', range: undefined },
      { method: 'GET', range: 'bytes=0-1023' },
    ]);
  });

  it('records FAILED on a 4xx and on a 5xx', async (ctx) => {
    requireDb(ctx);

    for (const status of [404, 403, 500, 502]) {
      stubFetch(() => new Response(null, { status }));

      const id = await seedSource(PUBLIC_URL);
      const outcome = await testSource(id);

      expect(outcome.result, `status ${status}`).toBe('FAILED');
      expect(outcome.reason).toContain(String(status));

      vi.restoreAllMocks();
    }
  });

  it('records FAILED when the request times out', async (ctx) => {
    requireDb(ctx);

    stubFetch(() => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    });

    const id = await seedSource(PUBLIC_URL);
    const outcome = await testSource(id);

    expect(outcome.result).toBe('FAILED');
    expect(outcome.reason).toMatch(/timed out/);

    const [row] = await db.select().from(streamSource).where(eq(streamSource.id, id));
    expect(row?.lastTestResult).toBe('FAILED');
  });

  it('records FAILED on a network error', async (ctx) => {
    requireDb(ctx);

    stubFetch(() => {
      const error = new Error('fetch failed');
      (error as Error & { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
      throw error;
    });

    const id = await seedSource(PUBLIC_URL);
    const outcome = await testSource(id);

    expect(outcome.result).toBe('FAILED');
    expect(outcome.reason).toContain('ECONNREFUSED');
  });

  it('refuses a private address without issuing a request', async (ctx) => {
    requireDb(ctx);

    const spy = stubFetch(() => new Response(null, { status: 200 }));

    const id = await seedSource('http://169.254.169.254/latest/meta-data/');
    const outcome = await testSource(id);

    expect(outcome.result).toBe('FAILED');
    expect(outcome.reason).toMatch(/non-public/);
    // The guard runs before the request, so fetch is never reached.
    expect(spy).not.toHaveBeenCalled();
    // Nothing left the box, so there is no round trip to have timed.
    expect(outcome.latencyMs).toBeNull();
  });

  it('refuses a redirect that points at a private address', async (ctx) => {
    requireDb(ctx);

    stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1:6379/' },
        }),
    );

    const id = await seedSource(PUBLIC_URL);
    const outcome = await testSource(id);

    expect(outcome.result).toBe('FAILED');
    expect(outcome.reason).toMatch(/non-public/);
  });

  it('never puts the URL in the returned reason', async (ctx) => {
    requireDb(ctx);

    stubFetch(() => new Response(null, { status: 404 }));

    const secret = 'https://stream.example.test/token-9f3a2b/master.m3u8';
    const id = await seedSource(secret);
    const outcome = await testSource(id);

    expect(outcome.reason).not.toContain('token-9f3a2b');
  });

  it('throws 404 for an unknown source id', async (ctx) => {
    requireDb(ctx);

    await expect(testSource(randomUUID())).rejects.toMatchObject({ status: 404 });
  });
});

/** Phase 12: the rolling history behind the current state on `stream_source`. */
describe('health check history', () => {
  async function historyRows(streamSourceId: string) {
    return db
      .select()
      .from(healthCheckLog)
      .where(eq(healthCheckLog.streamSourceId, streamSourceId))
      .orderBy(desc(healthCheckLog.checkedAt), desc(healthCheckLog.id));
  }

  it('logs one row per check, with the reason only on a failure', async (ctx) => {
    requireDb(ctx);

    const id = await seedSource(PUBLIC_URL);

    stubFetch(() => new Response(null, { status: 200 }));
    await testSource(id);
    vi.restoreAllMocks();

    stubFetch(() => new Response(null, { status: 404 }));
    await testSource(id);

    const rows = await historyRows(id);

    expect(rows).toHaveLength(2);
    // Newest first: the 404 was the later check.
    expect(rows[0]?.result).toBe('FAILED');
    expect(rows[0]?.errorMessage).toContain('404');
    expect(rows[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    // A healthy check has nothing to explain.
    expect(rows[1]?.result).toBe('OK');
    expect(rows[1]?.errorMessage).toBeNull();
  });

  it('keeps only the newest 20 checks for a source', async (ctx) => {
    requireDb(ctx);

    stubFetch(() => new Response(null, { status: 200 }));

    const id = await seedSource(PUBLIC_URL);

    // 21 checks: one more than the cap, so the trim has to have run.
    for (let attempt = 0; attempt < 21; attempt += 1) {
      await testSource(id);
    }

    const rows = await historyRows(id);
    expect(rows).toHaveLength(20);
  });

  it('trims only the source that was checked', async (ctx) => {
    requireDb(ctx);

    stubFetch(() => new Response(null, { status: 200 }));

    const kept = await seedSource(PUBLIC_URL);
    const churned = await seedSource(PUBLIC_URL);

    await testSource(kept);

    for (let attempt = 0; attempt < 21; attempt += 1) {
      await testSource(churned);
    }

    expect(await historyRows(kept)).toHaveLength(1);
    expect(await historyRows(churned)).toHaveLength(20);
  });

  it('returns the history newest first and never includes the URL', async (ctx) => {
    requireDb(ctx);

    const secret = 'https://stream.example.test/token-4c1d8e/master.m3u8';
    const id = await seedSource(secret);

    stubFetch(() => new Response(null, { status: 200 }));
    await testSource(id);
    vi.restoreAllMocks();

    stubFetch(() => new Response(null, { status: 500 }));
    await testSource(id);

    const history = await listHealthHistory(id);

    expect(history).toHaveLength(2);
    expect(history[0]?.result).toBe('FAILED');
    expect(history[1]?.result).toBe('OK');
    expect(Date.parse(history[0]!.checkedAt)).toBeGreaterThanOrEqual(
      Date.parse(history[1]!.checkedAt),
    );
    expect(JSON.stringify(history)).not.toContain('token-4c1d8e');
  });

  it('returns an empty history for a source that was never tested', async (ctx) => {
    requireDb(ctx);

    const id = await seedSource(PUBLIC_URL);

    expect(await listHealthHistory(id)).toEqual([]);
  });
});
