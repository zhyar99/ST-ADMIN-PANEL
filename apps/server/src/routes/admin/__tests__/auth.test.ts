import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

import argon2 from 'argon2';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminUser, auditLog } from '../../../db/schema';
import { app } from '../../../app';
import { db, pool } from '../../../db/client';

const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const VIEWER_PASSWORD = 'viewer-password-12345';

let server: Server;
let baseUrl: string;
let dbAvailable = false;
let adminId = '';
let viewerId = '';
let adminEmail = '';
let viewerEmail = '';

/** Everything but the rate-limit test opts out of the auth limiter. */
const BYPASS = { 'x-test-bypass-rate-limit': '1', 'content-type': 'application/json' };

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { ...BYPASS, ...headers },
    body: JSON.stringify(body),
  });
}

function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, { headers: { ...BYPASS, ...headers } });
}

/** The suite needs a live Postgres; without one it reports skipped, not failed. */
function requireDb(ctx: { skip: () => void }): void {
  if (!dbAvailable) ctx.skip();
}

async function loginAsAdmin(): Promise<{ accessToken: string; refreshToken: string }> {
  const response = await post('/api/v1/admin/auth/login', {
    email: adminEmail,
    password: ADMIN_PASSWORD,
  });
  return (await response.json()) as { accessToken: string; refreshToken: string };
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

  // Unique emails keep repeat runs from colliding with leftovers.
  const suffix = randomUUID().slice(0, 8);
  adminEmail = `test-admin-${suffix}@example.test`;
  viewerEmail = `test-viewer-${suffix}@example.test`;

  const [createdAdmin] = await db
    .insert(adminUser)
    .values({
      email: adminEmail,
      name: 'Test Admin',
      role: 'ADMIN',
      passwordHash: await argon2.hash(ADMIN_PASSWORD),
    })
    .returning({ id: adminUser.id });

  const [createdViewer] = await db
    .insert(adminUser)
    .values({
      email: viewerEmail,
      name: 'Test Viewer',
      role: 'VIEWER',
      passwordHash: await argon2.hash(VIEWER_PASSWORD),
    })
    .returning({ id: adminUser.id });

  adminId = createdAdmin?.id ?? '';
  viewerId = createdViewer?.id ?? '';
});

afterAll(async () => {
  if (dbAvailable) {
    // audit_log nulls its actor on delete, so clear those rows first.
    for (const id of [adminId, viewerId].filter(Boolean)) {
      await db.delete(auditLog).where(eq(auditLog.adminUserId, id));
      await db.delete(adminUser).where(eq(adminUser.id, id));
    }
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('POST /api/v1/admin/auth/login', () => {
  it('returns access and refresh tokens for correct credentials', async (ctx) => {
    requireDb(ctx);

    const response = await post('/api/v1/admin/auth/login', {
      email: adminEmail,
      password: ADMIN_PASSWORD,
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(body.user).toMatchObject({ id: adminId, email: adminEmail, role: 'ADMIN' });
    expect(JSON.stringify(body)).not.toContain('password_hash');
    expect(JSON.stringify(body)).not.toContain('passwordHash');
  });

  it('rejects a wrong password with 401', async (ctx) => {
    requireDb(ctx);

    const response = await post('/api/v1/admin/auth/login', {
      email: adminEmail,
      password: 'not-the-password',
    });
    expect(response.status).toBe(401);
  });

  it('rejects an unknown email with the same 401', async (ctx) => {
    requireDb(ctx);

    const response = await post('/api/v1/admin/auth/login', {
      email: `nobody-${randomUUID()}@example.test`,
      password: ADMIN_PASSWORD,
    });
    expect(response.status).toBe(401);
  });

  it('rejects a malformed body with 400', async (ctx) => {
    requireDb(ctx);

    const response = await post('/api/v1/admin/auth/login', { email: 'not-an-email' });
    expect(response.status).toBe(400);
  });

  it('writes an audit_log row with action=LOGIN', async (ctx) => {
    requireDb(ctx);

    await post('/api/v1/admin/auth/login', { email: adminEmail, password: ADMIN_PASSWORD });

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.adminUserId, adminId), eq(auditLog.action, 'LOGIN')))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);

    expect(entry).toBeDefined();
    expect(entry?.entityType).toBe('admin_user');
    expect(entry?.entityId).toBe(adminId);
  });

  it('records last_login_at on success', async (ctx) => {
    requireDb(ctx);

    await post('/api/v1/admin/auth/login', { email: adminEmail, password: ADMIN_PASSWORD });

    const [user] = await db
      .select({ lastLoginAt: adminUser.lastLoginAt })
      .from(adminUser)
      .where(eq(adminUser.id, adminId))
      .limit(1);

    expect(user?.lastLoginAt).toBeInstanceOf(Date);
  });
});

describe('GET /api/v1/admin/auth/me', () => {
  it('returns the caller for a valid bearer token', async (ctx) => {
    requireDb(ctx);

    const { accessToken } = await loginAsAdmin();
    const response = await get('/api/v1/admin/auth/me', {
      authorization: `Bearer ${accessToken}`,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id: adminId, email: adminEmail, role: 'ADMIN' });
    expect(body).not.toHaveProperty('passwordHash');
  });

  it('returns 401 without a token', async (ctx) => {
    requireDb(ctx);
    expect((await get('/api/v1/admin/auth/me')).status).toBe(401);
  });

  it('returns 401 for a forged token', async (ctx) => {
    requireDb(ctx);

    const response = await get('/api/v1/admin/auth/me', {
      authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.bm90LWEtc2lnbmF0dXJl',
    });
    expect(response.status).toBe(401);
  });
});

describe('POST /api/v1/admin/auth/refresh', () => {
  it('rotates both tokens and rejects the spent refresh token', async (ctx) => {
    requireDb(ctx);

    const { refreshToken } = await loginAsAdmin();

    const rotated = await post('/api/v1/admin/auth/refresh', { refreshToken });
    expect(rotated.status).toBe(200);

    const body = (await rotated.json()) as { accessToken: string; refreshToken: string };
    expect(typeof body.accessToken).toBe('string');
    expect(body.refreshToken).not.toBe(refreshToken);

    // The new token authenticates...
    const me = await get('/api/v1/admin/auth/me', {
      authorization: `Bearer ${body.accessToken}`,
    });
    expect(me.status).toBe(200);

    // ...and the old one is spent.
    const replay = await post('/api/v1/admin/auth/refresh', { refreshToken });
    expect(replay.status).toBe(401);
  });

  it('rejects a well-formed but unknown refresh token with 401', async (ctx) => {
    requireDb(ctx);

    const response = await post('/api/v1/admin/auth/refresh', {
      refreshToken: `${randomUUID()}.not-the-secret`,
    });
    expect(response.status).toBe(401);
  });

  // A non-UUID id used to reach Postgres and raise, turning garbage into a 500.
  it.each(['bogus.token', 'no-separator', '.leading-dot', `${randomUUID()}.`])(
    'rejects the malformed refresh token %j with 4xx, never 500',
    async (refreshToken) => {
      if (!dbAvailable) return;

      const response = await post('/api/v1/admin/auth/refresh', { refreshToken });
      expect(response.status).toBeLessThan(500);
      expect([400, 401]).toContain(response.status);
    },
  );
});

describe('POST /api/v1/admin/auth/logout', () => {
  it('revokes the refresh token', async (ctx) => {
    requireDb(ctx);

    const { accessToken, refreshToken } = await loginAsAdmin();

    const logout = await post(
      '/api/v1/admin/auth/logout',
      { refreshToken },
      { authorization: `Bearer ${accessToken}` },
    );
    expect(logout.status).toBe(204);

    const afterLogout = await post('/api/v1/admin/auth/refresh', { refreshToken });
    expect(afterLogout.status).toBe(401);
  });

  it('requires authentication', async (ctx) => {
    requireDb(ctx);

    const response = await post('/api/v1/admin/auth/logout', { refreshToken: 'anything.at-all' });
    expect(response.status).toBe(401);
  });
});

describe('role-based access to /api/v1/admin/users', () => {
  it('lets an ADMIN list users without exposing password hashes', async (ctx) => {
    requireDb(ctx);

    const { accessToken } = await loginAsAdmin();
    const response = await get('/api/v1/admin/users', {
      authorization: `Bearer ${accessToken}`,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { users: Record<string, unknown>[] };
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.users.some((user) => user.id === adminId)).toBe(true);
    expect(JSON.stringify(body)).not.toContain('passwordHash');
    expect(JSON.stringify(body)).not.toContain('password_hash');
  });

  it('rejects a VIEWER with 403', async (ctx) => {
    requireDb(ctx);

    const login = await post('/api/v1/admin/auth/login', {
      email: viewerEmail,
      password: VIEWER_PASSWORD,
    });
    const { accessToken } = (await login.json()) as { accessToken: string };

    const response = await get('/api/v1/admin/users', {
      authorization: `Bearer ${accessToken}`,
    });
    expect(response.status).toBe(403);
  });

  it('rejects an unauthenticated caller with 401', async (ctx) => {
    requireDb(ctx);
    expect((await get('/api/v1/admin/users')).status).toBe(401);
  });
});

// Last: this test deliberately trips the limiter for this IP, and the window
// outlives the suite.
describe('auth rate limiting', () => {
  it('returns 429 once the per-IP attempt budget is spent', async (ctx) => {
    requireDb(ctx);

    const attempt = () =>
      fetch(`${baseUrl}/api/v1/admin/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: adminEmail, password: 'wrong-password' }),
      });

    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      statuses.push((await attempt()).status);
    }

    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  }, 30_000);
});
