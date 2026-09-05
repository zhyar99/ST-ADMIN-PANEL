import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

import argon2 from 'argon2';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdConfigDto, AdCreativeDto } from '@streaming/shared' with {
  'resolution-mode': 'import',
};

import { adCreative, adminUser, auditLog, mediaAsset } from '../../../db/schema';
import { app } from '../../../app';
import { db, pool } from '../../../db/client';

/**
 * Integration coverage for the Phase 11 advertising routes.
 *
 * `ad_config` is a genuine singleton — one row for the whole installation, and
 * these tests run against the developer's real database — so the suite records
 * the stored config up front and restores it in `afterAll`. Without that, a
 * test run would silently rewrite the local ad timing and the next
 * `/playback/session` by hand would show numbers a test chose.
 */

const ADMIN_PASSWORD = 'ads-admin-password-1';
const VIEWER_PASSWORD = 'ads-viewer-password-1';

const BYPASS = { 'x-test-bypass-rate-limit': '1' };

let server: Server;
let baseUrl = '';
let dbAvailable = false;
let adminId = '';
let viewerId = '';
let adminToken = '';
let viewerToken = '';

let creativeAssetId = '';
let posterAssetId = '';
let originalConfig: AdConfigDto | null = null;

const createdCreativeIds = new Set<string>();

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

async function seedAsset(kind: 'AD_CREATIVE' | 'POSTER'): Promise<string> {
  const name = `${randomUUID()}.${kind === 'AD_CREATIVE' ? 'mp4' : 'jpg'}`;

  const [row] = await db
    .insert(mediaAsset)
    .values({
      kind,
      filePath: `${kind === 'AD_CREATIVE' ? 'ad-creatives' : 'posters'}/${name}`,
      fileName: name,
      mimeType: kind === 'AD_CREATIVE' ? 'video/mp4' : 'image/jpeg',
      sizeBytes: 4096,
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

  return ((await response.json()) as { accessToken: string }).accessToken;
}

async function createCreative(overrides: Record<string, unknown> = {}): Promise<AdCreativeDto> {
  const response = await api('/api/v1/admin/advertising/creatives', {
    method: 'POST',
    ...json({ assetId: creativeAssetId, durationSeconds: 15, ...overrides }),
  });

  expect(response.status).toBe(201);
  const { creative } = (await response.json()) as { creative: AdCreativeDto };
  createdCreativeIds.add(creative.id);
  return creative;
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
  const adminEmail = `ads-admin-${suffix}@example.test`;
  const viewerEmail = `ads-viewer-${suffix}@example.test`;

  const [createdAdmin] = await db
    .insert(adminUser)
    .values({
      email: adminEmail,
      name: 'Ads Admin',
      role: 'ADMIN',
      passwordHash: await argon2.hash(ADMIN_PASSWORD),
    })
    .returning({ id: adminUser.id });

  const [createdViewer] = await db
    .insert(adminUser)
    .values({
      email: viewerEmail,
      name: 'Ads Viewer',
      role: 'VIEWER',
      passwordHash: await argon2.hash(VIEWER_PASSWORD),
    })
    .returning({ id: adminUser.id });

  adminId = createdAdmin!.id;
  viewerId = createdViewer!.id;

  adminToken = await login(adminEmail, ADMIN_PASSWORD);
  viewerToken = await login(viewerEmail, VIEWER_PASSWORD);

  creativeAssetId = await seedAsset('AD_CREATIVE');
  posterAssetId = await seedAsset('POSTER');

  const response = await api('/api/v1/admin/advertising/config');
  originalConfig = ((await response.json()) as { config: AdConfigDto }).config;
});

afterAll(async () => {
  if (dbAvailable) {
    if (originalConfig) {
      await api('/api/v1/admin/advertising/config', {
        method: 'PUT',
        ...json({
          preRollMinSeconds: originalConfig.preRollMinSeconds,
          preRollMaxSeconds: originalConfig.preRollMaxSeconds,
          midRollIntervalMinutes: originalConfig.midRollIntervalMinutes,
          midRollMaxSeconds: originalConfig.midRollMaxSeconds,
          skipAfterSeconds: originalConfig.skipAfterSeconds,
        }),
      });
    }

    if (createdCreativeIds.size > 0) {
      await db.delete(adCreative).where(inArray(adCreative.id, [...createdCreativeIds]));
    }

    const assetIds = [creativeAssetId, posterAssetId].filter(Boolean);
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

describe('ad config', () => {
  it('returns a config, creating it with the schema defaults on first call', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/advertising/config');
    expect(response.status).toBe(200);

    const { config } = (await response.json()) as { config: AdConfigDto };

    // Asserted as a shape rather than as the literal defaults: on a database
    // that has already been configured the values are whatever the operator
    // set, and pinning 5/10/30 here would make this test pass only on a fresh
    // install.
    expect(config).toEqual({
      preRollMinSeconds: expect.any(Number),
      preRollMaxSeconds: expect.any(Number),
      midRollIntervalMinutes: expect.any(Number),
      midRollMaxSeconds: expect.any(Number),
      skipAfterSeconds: expect.any(Number),
      updatedAt: expect.any(String),
    });
    expect(config.preRollMaxSeconds).toBeGreaterThanOrEqual(config.preRollMinSeconds);
  });

  it('is a singleton — a second GET does not create another row', async (ctx) => {
    requireDb(ctx);

    await api('/api/v1/admin/advertising/config');
    await api('/api/v1/admin/advertising/config');

    const rows = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from ad_config`,
    );

    expect(rows.rows[0]?.count).toBe(1);
  });

  it('applies an update and reflects it on the next read', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/advertising/config', {
      method: 'PUT',
      ...json({ midRollIntervalMinutes: 17, skipAfterSeconds: 7 }),
    });

    expect(response.status).toBe(200);
    const { config } = (await response.json()) as { config: AdConfigDto };
    expect(config.midRollIntervalMinutes).toBe(17);
    expect(config.skipAfterSeconds).toBe(7);

    const reread = (await (await api('/api/v1/admin/advertising/config')).json()) as {
      config: AdConfigDto;
    };
    expect(reread.config.midRollIntervalMinutes).toBe(17);
  });

  it('rejects a pre-roll maximum below the minimum', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/advertising/config', {
      method: 'PUT',
      ...json({ preRollMinSeconds: 10, preRollMaxSeconds: 4 }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('preRollMaxSeconds');
  });

  it('rejects a maximum that only conflicts with the *stored* minimum', async (ctx) => {
    requireDb(ctx);

    // The rule is a property of the merged config, not of the patch: this body
    // is internally consistent and still invalid.
    await api('/api/v1/admin/advertising/config', {
      method: 'PUT',
      ...json({ preRollMinSeconds: 8, preRollMaxSeconds: 20 }),
    });

    const response = await api('/api/v1/admin/advertising/config', {
      method: 'PUT',
      ...json({ preRollMaxSeconds: 3 }),
    });

    expect(response.status).toBe(400);
  });

  it('rejects non-integer, zero and unbounded values', async (ctx) => {
    requireDb(ctx);

    for (const body of [
      { preRollMinSeconds: 2.5 },
      { midRollIntervalMinutes: 0 },
      { midRollMaxSeconds: -1 },
      { skipAfterSeconds: '5' },
      { midRollIntervalMinutes: 100_000 },
      {},
    ]) {
      const response = await api('/api/v1/admin/advertising/config', {
        method: 'PUT',
        ...json(body),
      });

      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('lets a VIEWER read the config but not change it', async (ctx) => {
    requireDb(ctx);

    expect((await api('/api/v1/admin/advertising/config', {}, viewerToken)).status).toBe(200);

    const write = await api(
      '/api/v1/admin/advertising/config',
      { method: 'PUT', ...json({ skipAfterSeconds: 9 }) },
      viewerToken,
    );

    expect(write.status).toBe(403);
  });

  it('needs authentication', async (ctx) => {
    requireDb(ctx);

    const response = await fetch(`${baseUrl}/api/v1/admin/advertising/config`, {
      headers: BYPASS,
    });

    expect(response.status).toBe(401);
  });
});

describe('ad creatives', () => {
  it('creates a creative and returns it with its asset', async (ctx) => {
    requireDb(ctx);

    const creative = await createCreative({ durationSeconds: 12 });

    expect(creative.durationSeconds).toBe(12);
    expect(creative.isActive).toBe(true);
    expect(creative.asset.id).toBe(creativeAssetId);
    expect(creative.asset.kind).toBe('AD_CREATIVE');
    expect(creative.asset.url).toContain('/storage/ad-creatives/');
  });

  it('rejects an assetId whose asset is not an AD_CREATIVE', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/advertising/creatives', {
      method: 'POST',
      ...json({ assetId: posterAssetId, durationSeconds: 10 }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('AD_CREATIVE');
  });

  it('404s an assetId that names no asset', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/advertising/creatives', {
      method: 'POST',
      ...json({ assetId: randomUUID(), durationSeconds: 10 }),
    });

    expect(response.status).toBe(404);
  });

  it('rejects a malformed body', async (ctx) => {
    requireDb(ctx);

    for (const body of [
      { assetId: 'not-a-uuid', durationSeconds: 10 },
      { assetId: creativeAssetId, durationSeconds: 0 },
      { assetId: creativeAssetId, durationSeconds: 1.5 },
      { assetId: creativeAssetId },
    ]) {
      const response = await api('/api/v1/admin/advertising/creatives', {
        method: 'POST',
        ...json(body),
      });

      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('lists creatives, active and inactive alike', async (ctx) => {
    requireDb(ctx);

    const created = await createCreative();

    const response = await api('/api/v1/admin/advertising/creatives');
    expect(response.status).toBe(200);

    const { creatives } = (await response.json()) as { creatives: AdCreativeDto[] };
    expect(creatives.some((row) => row.id === created.id)).toBe(true);
  });

  it('toggles isActive and updates the duration', async (ctx) => {
    requireDb(ctx);

    const created = await createCreative();

    const response = await api(`/api/v1/admin/advertising/creatives/${created.id}`, {
      method: 'PATCH',
      ...json({ isActive: false, durationSeconds: 21 }),
    });

    expect(response.status).toBe(200);
    const { creative } = (await response.json()) as { creative: AdCreativeDto };
    expect(creative.isActive).toBe(false);
    expect(creative.durationSeconds).toBe(21);
  });

  it('deletes an existing creative and 404s the second time', async (ctx) => {
    requireDb(ctx);

    const created = await createCreative();

    const first = await api(`/api/v1/admin/advertising/creatives/${created.id}`, {
      method: 'DELETE',
    });
    expect(first.status).toBe(204);
    createdCreativeIds.delete(created.id);

    const second = await api(`/api/v1/admin/advertising/creatives/${created.id}`, {
      method: 'DELETE',
    });
    expect(second.status).toBe(404);
  });

  it('lets a VIEWER list creatives but not mutate them', async (ctx) => {
    requireDb(ctx);

    const created = await createCreative();

    expect((await api('/api/v1/admin/advertising/creatives', {}, viewerToken)).status).toBe(200);

    const write = await api(
      '/api/v1/admin/advertising/creatives',
      { method: 'POST', ...json({ assetId: creativeAssetId, durationSeconds: 10 }) },
      viewerToken,
    );
    expect(write.status).toBe(403);

    const patch = await api(
      `/api/v1/admin/advertising/creatives/${created.id}`,
      { method: 'PATCH', ...json({ isActive: false }) },
      viewerToken,
    );
    expect(patch.status).toBe(403);

    const remove = await api(
      `/api/v1/admin/advertising/creatives/${created.id}`,
      { method: 'DELETE' },
      viewerToken,
    );
    expect(remove.status).toBe(403);
  });

  it('never carries a stream URL', async (ctx) => {
    requireDb(ctx);

    await createCreative();

    const body = await (await api('/api/v1/admin/advertising/creatives')).text();
    expect(body).not.toContain('.m3u8');
  });
});
