import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

import argon2 from 'argon2';
import { eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminUser, auditLog, mediaAsset } from '../../../db/schema';
import { app } from '../../../app';
import { config } from '../../../config';
import { db, pool } from '../../../db/client';
import { deleteAsset } from '../../../services/assets/assetService';

const ADMIN_PASSWORD = 'asset-admin-password-1';
const VIEWER_PASSWORD = 'asset-viewer-password-1';

let server: Server;
let baseUrl: string;
let dbAvailable = false;
let adminId = '';
let viewerId = '';
let adminToken = '';
let viewerToken = '';

/** Ids created by a test, torn down in afterAll even if the test failed. */
const createdAssetIds = new Set<string>();

const BYPASS = { 'x-test-bypass-rate-limit': '1' };

function requireDb(ctx: { skip: () => void }): void {
  if (!dbAvailable) ctx.skip();
}

function storagePathFor(...segments: string[]): string {
  return path.join(config.storageDir, ...segments);
}

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/** Number of files in a storage subdirectory, used to prove nothing leaked. */
async function fileCount(directory: string): Promise<number> {
  try {
    return (await fs.readdir(storagePathFor(directory))).length;
  } catch {
    return 0;
  }
}

function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 40, b: 90 } },
  })
    .jpeg()
    .toBuffer();
}

interface AssetBody {
  id: string;
  kind: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  createdAt: string;
}

async function upload(
  slug: string,
  file: { data: Buffer | string; name: string; type: string },
  token: string = adminToken,
): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([file.data], { type: file.type }), file.name);

  return fetch(`${baseUrl}/api/v1/admin/assets/upload/${slug}`, {
    method: 'POST',
    headers: { ...BYPASS, authorization: `Bearer ${token}` },
    body: form,
  });
}

/** Uploads a valid poster and registers it for cleanup. */
async function uploadPoster(): Promise<AssetBody> {
  const response = await upload('poster', {
    data: await jpeg(600, 900),
    name: 'poster.jpg',
    type: 'image/jpeg',
  });

  expect(response.status).toBe(201);
  const { asset } = (await response.json()) as { asset: AssetBody };
  createdAssetIds.add(asset.id);
  return asset;
}

function api(pathname: string, init: RequestInit = {}, token: string = adminToken) {
  return fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { ...BYPASS, authorization: `Bearer ${token}`, ...init.headers },
  });
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
  const adminEmail = `asset-admin-${suffix}@example.test`;
  const viewerEmail = `asset-viewer-${suffix}@example.test`;

  const [createdAdmin] = await db
    .insert(adminUser)
    .values({
      email: adminEmail,
      name: 'Asset Admin',
      role: 'ADMIN',
      passwordHash: await argon2.hash(ADMIN_PASSWORD),
    })
    .returning({ id: adminUser.id });

  const [createdViewer] = await db
    .insert(adminUser)
    .values({
      email: viewerEmail,
      name: 'Asset Viewer',
      role: 'VIEWER',
      passwordHash: await argon2.hash(VIEWER_PASSWORD),
    })
    .returning({ id: adminUser.id });

  adminId = createdAdmin?.id ?? '';
  viewerId = createdViewer?.id ?? '';

  adminToken = await login(adminEmail, ADMIN_PASSWORD);
  viewerToken = await login(viewerEmail, VIEWER_PASSWORD);
});

afterAll(async () => {
  if (dbAvailable) {
    const ids = [...createdAssetIds];

    if (ids.length > 0) {
      const rows = await db
        .select({ filePath: mediaAsset.filePath })
        .from(mediaAsset)
        .where(inArray(mediaAsset.id, ids));

      for (const row of rows) {
        await fs.rm(path.join(config.storageDir, row.filePath), { force: true });
      }

      await db.delete(mediaAsset).where(inArray(mediaAsset.id, ids));
    }

    for (const id of [adminId, viewerId].filter(Boolean)) {
      await db.delete(auditLog).where(eq(auditLog.adminUserId, id));
      await db.delete(adminUser).where(eq(adminUser.id, id));
    }
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('POST /api/v1/admin/assets/upload/:kind', () => {
  it('stores a valid poster and returns a URL built from STORAGE_URL_PREFIX', async (ctx) => {
    requireDb(ctx);

    const asset = await uploadPoster();

    expect(asset.kind).toBe('POSTER');
    expect(asset.mimeType).toBe('image/jpeg');
    expect(asset.width).toBe(600);
    expect(asset.height).toBe(900);
    expect(asset.sizeBytes).toBeGreaterThan(0);

    const prefix = `${config.STORAGE_URL_PREFIX}/posters/`;
    expect(asset.url.startsWith(prefix)).toBe(true);

    const fileName = asset.url.slice(prefix.length);
    expect(fileName).toMatch(/^[0-9a-f-]{36}\.jpg$/);
    expect(await exists(storagePathFor('posters', fileName))).toBe(true);
  });

  it('never exposes the stored file path', async (ctx) => {
    requireDb(ctx);

    const asset = await uploadPoster();
    const serialised = JSON.stringify(asset);

    expect(serialised).not.toContain('file_path');
    expect(serialised).not.toContain('filePath');
    expect(serialised).not.toContain(config.storageDir);
  });

  it('rejects a non-image poster with 400 and writes nothing to disk', async (ctx) => {
    requireDb(ctx);

    const before = await fileCount('posters');
    const response = await upload('poster', {
      data: 'this is not an image',
      name: 'notes.txt',
      type: 'text/plain',
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'UNSUPPORTED_MEDIA_TYPE' },
    });
    expect(await fileCount('posters')).toBe(before);
  });

  it('rejects a file over the kind size limit with 400 and leaves no partial file', async (ctx) => {
    requireDb(ctx);

    const before = await fileCount('subtitles');
    // SUBTITLE caps at 5 MB; 6 MB of text is cheap to build and streams past it.
    const response = await upload('subtitle', {
      data: 'a'.repeat(6 * 1024 * 1024),
      name: 'huge.srt',
      type: 'text/plain',
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'FILE_TOO_LARGE' },
    });
    expect(await fileCount('subtitles')).toBe(before);
  });

  it('rejects an image below the kind minimum and deletes the saved file', async (ctx) => {
    requireDb(ctx);

    const before = await fileCount('posters');
    const response = await upload('poster', {
      data: await jpeg(120, 180),
      name: 'tiny.jpg',
      type: 'image/jpeg',
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'IMAGE_DIMENSIONS' },
    });
    expect(await fileCount('posters')).toBe(before);
  });

  it('rejects a landscape image uploaded as a poster', async (ctx) => {
    requireDb(ctx);

    const response = await upload('poster', {
      data: await jpeg(1280, 720),
      name: 'wide.jpg',
      type: 'image/jpeg',
    });

    expect(response.status).toBe(400);
  });

  it('rejects an unknown kind slug with 400', async (ctx) => {
    requireDb(ctx);

    const response = await upload('banana', {
      data: await jpeg(600, 900),
      name: 'poster.jpg',
      type: 'image/jpeg',
    });

    expect(response.status).toBe(400);
  });

  // The destination directory comes from the kind, so a traversal attempt must
  // never reach the upload handler at all.
  it('does not route a traversal attempt in :kind', async (ctx) => {
    requireDb(ctx);

    const response = await upload('..%2F..%2Fetc', {
      data: await jpeg(600, 900),
      name: 'poster.jpg',
      type: 'image/jpeg',
    });

    expect([400, 404]).toContain(response.status);
    expect(await exists(storagePathFor('..', 'poster.jpg'))).toBe(false);
  });

  it('requires authentication', async (ctx) => {
    requireDb(ctx);

    const form = new FormData();
    form.append('file', new Blob([await jpeg(600, 900)], { type: 'image/jpeg' }), 'p.jpg');

    const response = await fetch(`${baseUrl}/api/v1/admin/assets/upload/poster`, {
      method: 'POST',
      headers: BYPASS,
      body: form,
    });

    expect(response.status).toBe(401);
  });
});

describe('GET /api/v1/admin/assets', () => {
  it('paginates and filters by kind', async (ctx) => {
    requireDb(ctx);

    const asset = await uploadPoster();

    const response = await api('/api/v1/admin/assets?kind=POSTER&page=1&limit=5');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      items: AssetBody[];
      total: number;
      page: number;
      limit: number;
      hasMore: boolean;
    };

    expect(body.page).toBe(1);
    expect(body.limit).toBe(5);
    expect(body.items.length).toBeLessThanOrEqual(5);
    expect(body.items.every((item) => item.kind === 'POSTER')).toBe(true);
    // Newest first, so a just-uploaded poster is on page 1.
    expect(body.items.some((item) => item.id === asset.id)).toBe(true);
    expect(JSON.stringify(body)).not.toContain('filePath');
  });

  it('rejects an unknown kind filter with 400', async (ctx) => {
    requireDb(ctx);
    expect((await api('/api/v1/admin/assets?kind=BANANA')).status).toBe(400);
  });

  it('lets a VIEWER browse the library', async (ctx) => {
    requireDb(ctx);
    expect((await api('/api/v1/admin/assets', {}, viewerToken)).status).toBe(200);
  });
});

describe('GET /api/v1/admin/assets/:id', () => {
  it('returns a single asset', async (ctx) => {
    requireDb(ctx);

    const asset = await uploadPoster();
    const response = await api(`/api/v1/admin/assets/${asset.id}`);

    expect(response.status).toBe(200);
    expect((await response.json()) as { asset: AssetBody }).toMatchObject({
      asset: { id: asset.id, kind: 'POSTER' },
    });
  });

  it('returns 404 for an unknown id', async (ctx) => {
    requireDb(ctx);
    expect((await api(`/api/v1/admin/assets/${randomUUID()}`)).status).toBe(404);
  });

  it('returns 400 for a malformed id', async (ctx) => {
    requireDb(ctx);
    expect((await api('/api/v1/admin/assets/not-a-uuid')).status).toBe(400);
  });
});

describe('DELETE /api/v1/admin/assets/:id', () => {
  it('removes an unreferenced asset from the database and from disk', async (ctx) => {
    requireDb(ctx);

    const asset = await uploadPoster();
    const fileName = asset.url.slice(asset.url.lastIndexOf('/') + 1);
    const absolute = storagePathFor('posters', fileName);
    expect(await exists(absolute)).toBe(true);

    const response = await api(`/api/v1/admin/assets/${asset.id}`, { method: 'DELETE' });
    expect(response.status).toBe(204);
    createdAssetIds.delete(asset.id);

    const rows = await db.select().from(mediaAsset).where(eq(mediaAsset.id, asset.id));
    expect(rows).toHaveLength(0);
    expect(await exists(absolute)).toBe(false);
  });

  it('rejects a VIEWER with 403 and keeps the asset', async (ctx) => {
    requireDb(ctx);

    const asset = await uploadPoster();

    const response = await api(`/api/v1/admin/assets/${asset.id}`, { method: 'DELETE' }, viewerToken);
    expect(response.status).toBe(403);

    const rows = await db.select().from(mediaAsset).where(eq(mediaAsset.id, asset.id));
    expect(rows).toHaveLength(1);
  });

  it('returns 404 for an unknown id', async (ctx) => {
    requireDb(ctx);

    const response = await api(`/api/v1/admin/assets/${randomUUID()}`, { method: 'DELETE' });
    expect(response.status).toBe(404);
  });

  // The content tables that reference media_asset arrive in Phases 5-7, so the
  // in-use path is exercised against a throwaway table with the same shape.
  it('refuses to delete an asset something still points at (409)', async (ctx) => {
    requireDb(ctx);

    const asset = await uploadPoster();
    const probeTable = `asset_ref_probe_${randomUUID().replace(/-/g, '')}`;

    await pool.query(`create table "${probeTable}" (asset_id uuid not null)`);

    try {
      await pool.query(`insert into "${probeTable}" (asset_id) values ($1)`, [asset.id]);

      await expect(
        deleteAsset(asset.id, [{ table: probeTable, column: 'asset_id', entity: 'probe entity' }]),
      ).rejects.toMatchObject({ status: 409, code: 'ASSET_IN_USE' });

      const rows = await db.select().from(mediaAsset).where(eq(mediaAsset.id, asset.id));
      expect(rows).toHaveLength(1);
    } finally {
      await pool.query(`drop table if exists "${probeTable}"`);
    }
  });
});

describe('GET /storage/*', () => {
  it('serves an uploaded poster over HTTP', async (ctx) => {
    requireDb(ctx);

    const asset = await uploadPoster();
    const fileName = asset.url.slice(asset.url.lastIndexOf('/') + 1);

    const response = await fetch(`${baseUrl}/storage/posters/${fileName}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/jpeg');
  });
});
