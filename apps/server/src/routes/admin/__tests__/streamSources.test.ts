import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

import argon2 from 'argon2';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminUser, auditLog, healthCheckLog, streamSource } from '../../../db/schema';
import { app } from '../../../app';
import { db, pool } from '../../../db/client';

/**
 * Phase 12 coverage for `/admin/stream-sources/:sourceId/health-history`.
 *
 * The route is deliberately owner-agnostic, so the assertions are about what it
 * will and will not hand out: at most the retained 20 rows, newest first, never
 * a URL, and never to a VIEWER — which matches the owner-scoped source routers,
 * where a VIEWER cannot enumerate sources in the first place.
 */

const ADMIN_PASSWORD = 'health-admin-password-1';
const VIEWER_PASSWORD = 'health-viewer-password-1';

const BYPASS = { 'x-test-bypass-rate-limit': '1' };

const STREAM_URL = 'https://stream.example.test/health/token-b71f0c/master.m3u8';

let server: Server;
let baseUrl: string;
let dbAvailable = false;
let adminId = '';
let viewerId = '';
let adminToken = '';
let viewerToken = '';

const createdSourceIds = new Set<string>();

function requireDb(ctx: { skip: () => void }): void {
  if (!dbAvailable) ctx.skip();
}

function api(pathname: string, init: RequestInit = {}, token: string = adminToken) {
  const headers: Record<string, string> = { ...BYPASS, authorization: `Bearer ${token}` };
  return fetch(`${baseUrl}${pathname}`, { ...init, headers: { ...headers, ...init.headers } });
}

/** A bare source row — the history route never walks to an owner. */
async function seedSource(): Promise<string> {
  const [row] = await db
    .insert(streamSource)
    .values({ ownerType: 'MOVIE', ownerId: randomUUID(), url: STREAM_URL, priority: 0 })
    .returning({ id: streamSource.id });

  createdSourceIds.add(row!.id);
  return row!.id;
}

/**
 * Writes history directly rather than through `testSource`: the point here is
 * the shape of the response, and the service's own suite already covers what
 * a check writes.
 */
async function seedHistory(streamSourceId: string, count: number): Promise<void> {
  const base = Date.now();

  await db.insert(healthCheckLog).values(
    Array.from({ length: count }, (_unused, index) => ({
      streamSourceId,
      result: index % 2 === 0 ? ('OK' as const) : ('FAILED' as const),
      latencyMs: 100 + index,
      errorMessage: index % 2 === 0 ? null : `HTTP 50${index % 10}`,
      // One second apart so "newest first" is unambiguous.
      checkedAt: new Date(base - index * 1000),
    })),
  );
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
  const adminEmail = `health-admin-${suffix}@example.test`;
  const viewerEmail = `health-viewer-${suffix}@example.test`;

  const [createdAdmin] = await db
    .insert(adminUser)
    .values({
      email: adminEmail,
      name: 'Health Admin',
      role: 'ADMIN',
      passwordHash: await argon2.hash(ADMIN_PASSWORD),
    })
    .returning({ id: adminUser.id });

  const [createdViewer] = await db
    .insert(adminUser)
    .values({
      email: viewerEmail,
      name: 'Health Viewer',
      role: 'VIEWER',
      passwordHash: await argon2.hash(VIEWER_PASSWORD),
    })
    .returning({ id: adminUser.id });

  adminId = createdAdmin!.id;
  viewerId = createdViewer!.id;

  adminToken = await login(adminEmail, ADMIN_PASSWORD);
  viewerToken = await login(viewerEmail, VIEWER_PASSWORD);
});

afterAll(async () => {
  if (dbAvailable) {
    const sourceIds = [...createdSourceIds];

    // health_check_log rows go with the sources: ON DELETE CASCADE.
    if (sourceIds.length > 0) {
      await db.delete(streamSource).where(inArray(streamSource.id, sourceIds));
    }

    for (const id of [adminId, viewerId].filter(Boolean)) {
      await db.delete(auditLog).where(eq(auditLog.adminUserId, id));
      await db.delete(adminUser).where(eq(adminUser.id, id));
    }
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('GET /admin/stream-sources/:sourceId/health-history', () => {
  it('returns at most 20 rows, newest first', async (ctx) => {
    requireDb(ctx);

    const sourceId = await seedSource();
    await seedHistory(sourceId, 25);

    const response = await api(`/api/v1/admin/stream-sources/${sourceId}/health-history`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      items: { id: string; result: string; latencyMs: number | null; checkedAt: string }[];
    };

    expect(body.items).toHaveLength(20);

    const timestamps = body.items.map((item) => Date.parse(item.checkedAt));
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));

    // The newest of the 25 seeded rows, not an arbitrary page of them.
    expect(body.items[0]?.latencyMs).toBe(100);
  });

  it('never includes a URL', async (ctx) => {
    requireDb(ctx);

    const sourceId = await seedSource();
    await seedHistory(sourceId, 3);

    const response = await api(`/api/v1/admin/stream-sources/${sourceId}/health-history`);

    // Asserted against the whole serialised body rather than a known key, so a
    // URL arriving through a field added later fails this too.
    expect(await response.text()).not.toContain('token-b71f0c');
  });

  it('returns an empty list for a source that was never tested', async (ctx) => {
    requireDb(ctx);

    const sourceId = await seedSource();

    const response = await api(`/api/v1/admin/stream-sources/${sourceId}/health-history`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it('404s an unknown source id instead of returning an empty history', async (ctx) => {
    requireDb(ctx);

    const response = await api(`/api/v1/admin/stream-sources/${randomUUID()}/health-history`);
    expect(response.status).toBe(404);
  });

  it('rejects a malformed source id', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/stream-sources/not-a-uuid/health-history');
    expect(response.status).toBe(400);
  });

  it('is ADMIN-only, matching the owner-scoped source routers', async (ctx) => {
    requireDb(ctx);

    const sourceId = await seedSource();
    await seedHistory(sourceId, 2);

    const asViewer = await api(
      `/api/v1/admin/stream-sources/${sourceId}/health-history`,
      {},
      viewerToken,
    );
    expect(asViewer.status).toBe(403);

    const anonymous = await fetch(
      `${baseUrl}/api/v1/admin/stream-sources/${sourceId}/health-history`,
      { headers: BYPASS },
    );
    expect(anonymous.status).toBe(401);
  });
});
