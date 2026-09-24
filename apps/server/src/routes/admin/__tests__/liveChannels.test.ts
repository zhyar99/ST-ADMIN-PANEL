import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

import argon2 from 'argon2';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminUser, auditLog, liveChannel, mediaAsset, streamSource } from '../../../db/schema';
import { app } from '../../../app';
import { db, pool } from '../../../db/client';
import { listPublishedLiveChannels } from '../../../services/consumer/consumerLiveChannelService';

/**
 * Integration coverage for the Phase 7 live channel routes.
 *
 * As in the Phase 5 catalogue suite, the recurring assertion is negative: no
 * channel, list or source response may contain a `url` field. That is checked
 * against the serialised body rather than a known key, so a URL leaking through
 * a newly added nested field fails the suite too.
 */

const ADMIN_PASSWORD = 'live-admin-password-1';
const VIEWER_PASSWORD = 'live-viewer-password-1';

const BYPASS = { 'x-test-bypass-rate-limit': '1' };

const STREAM_URL = 'https://stream.example.test/live/channel/master.m3u8';
const BACKUP_URL = 'https://stream.example.test/live/channel-backup/master.m3u8';

let server: Server;
let baseUrl: string;
let dbAvailable = false;
let adminId = '';
let viewerId = '';
let adminToken = '';
let viewerToken = '';

let logoId = '';
let posterId = '';

const createdChannelIds = new Set<string>();

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
async function seedAsset(kind: 'LOGO' | 'POSTER'): Promise<string> {
  const name = `${randomUUID()}.png`;

  const [row] = await db
    .insert(mediaAsset)
    .values({
      kind,
      filePath: `${kind.toLowerCase()}s/${name}`,
      fileName: name,
      mimeType: 'image/png',
      sizeBytes: 2048,
      status: 'READY',
    })
    .returning({ id: mediaAsset.id });

  return row!.id;
}

async function createChannel(overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await api('/api/v1/admin/live-channels', {
    method: 'POST',
    ...json({
      name_i18n: i18n(`Channel ${randomUUID().slice(0, 6)}`),
      category: 'News',
      ...overrides,
    }),
  });

  expect(response.status).toBe(201);
  const { channel } = (await response.json()) as { channel: { id: string } };
  createdChannelIds.add(channel.id);
  return channel.id;
}

async function addSource(channelId: string, url: string): Promise<string> {
  const response = await api(`/api/v1/admin/live-channels/${channelId}/sources`, {
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
  const adminEmail = `live-admin-${suffix}@example.test`;
  const viewerEmail = `live-viewer-${suffix}@example.test`;

  const [createdAdmin] = await db
    .insert(adminUser)
    .values({
      email: adminEmail,
      name: 'Live Admin',
      role: 'ADMIN',
      passwordHash: await argon2.hash(ADMIN_PASSWORD),
    })
    .returning({ id: adminUser.id });

  const [createdViewer] = await db
    .insert(adminUser)
    .values({
      email: viewerEmail,
      name: 'Live Viewer',
      role: 'VIEWER',
      passwordHash: await argon2.hash(VIEWER_PASSWORD),
    })
    .returning({ id: adminUser.id });

  adminId = createdAdmin!.id;
  viewerId = createdViewer!.id;

  adminToken = await login(adminEmail, ADMIN_PASSWORD);
  viewerToken = await login(viewerEmail, VIEWER_PASSWORD);

  logoId = await seedAsset('LOGO');
  posterId = await seedAsset('POSTER');
});

afterAll(async () => {
  if (dbAvailable) {
    const channelIds = [...createdChannelIds];

    if (channelIds.length > 0) {
      await db.delete(streamSource).where(inArray(streamSource.ownerId, channelIds));
      await db.delete(liveChannel).where(inArray(liveChannel.id, channelIds));
    }

    const assetIds = [logoId, posterId].filter(Boolean);
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

describe('live channel CRUD', () => {
  it('creates a channel with a logo and starts it as DRAFT', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/live-channels', {
      method: 'POST',
      ...json({
        name_i18n: i18n('Rudaw'),
        category: 'News',
        logo_asset_id: logoId,
      }),
    });

    expect(response.status).toBe(201);

    const { channel } = (await response.json()) as {
      channel: {
        id: string;
        status: string;
        category: string;
        logo: { id: string };
        nameI18n: { ckb: string };
      };
    };

    createdChannelIds.add(channel.id);

    expect(channel.status).toBe('DRAFT');
    expect(channel.category).toBe('News');
    expect(channel.logo.id).toBe(logoId);
    expect(channel.nameI18n.ckb).toBe('Rudaw (ckb)');
  });

  it('rejects a name missing a required language', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/live-channels', {
      method: 'POST',
      ...json({ name_i18n: { en: 'Half a name', ckb: 'x' }, category: 'News' }),
    });

    expect(response.status).toBe(400);
  });

  it('rejects a missing or blank category', async (ctx) => {
    requireDb(ctx);

    for (const body of [
      { name_i18n: i18n('No category') },
      { name_i18n: i18n('Blank category'), category: '   ' },
    ]) {
      const response = await api('/api/v1/admin/live-channels', { method: 'POST', ...json(body) });
      expect(response.status).toBe(400);
    }
  });

  it('rejects a logo id that points at a poster', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/live-channels', {
      method: 'POST',
      ...json({ name_i18n: i18n('Wrong art'), category: 'News', logo_asset_id: posterId }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'ASSET_KIND_MISMATCH' },
    });
  });

  it('rejects a logo id that does not exist', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/live-channels', {
      method: 'POST',
      ...json({ name_i18n: i18n('Ghost logo'), category: 'News', logo_asset_id: randomUUID() }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'ASSET_NOT_FOUND' },
    });
  });

  it('updates metadata and clears the logo', async (ctx) => {
    requireDb(ctx);

    const id = await createChannel({ logo_asset_id: logoId });

    const response = await api(`/api/v1/admin/live-channels/${id}`, {
      method: 'PATCH',
      ...json({ category: 'Sport', logo_asset_id: null }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as { channel: { category: string; logo: null } }).toMatchObject({
      channel: { category: 'Sport', logo: null },
    });
  });

  it('rejects an empty patch', async (ctx) => {
    requireDb(ctx);

    const id = await createChannel();
    const response = await api(`/api/v1/admin/live-channels/${id}`, {
      method: 'PATCH',
      ...json({}),
    });

    expect(response.status).toBe(400);
  });

  it('404s for an unknown channel and 400s for a malformed id', async (ctx) => {
    requireDb(ctx);

    expect((await api(`/api/v1/admin/live-channels/${randomUUID()}`)).status).toBe(404);
    expect((await api('/api/v1/admin/live-channels/not-a-uuid')).status).toBe(400);
  });

  it('filters the list by status and category', async (ctx) => {
    requireDb(ctx);

    const category = `Cat-${randomUUID().slice(0, 8)}`;
    const id = await createChannel({ category });

    const filtered = (await (
      await api(`/api/v1/admin/live-channels?category=${encodeURIComponent(category)}`)
    ).json()) as { items: { id: string }[]; total: number };

    expect(filtered.total).toBe(1);
    expect(filtered.items[0]!.id).toBe(id);

    // Everything starts as a DRAFT, so the PUBLISHED filter must exclude it.
    const published = (await (
      await api(`/api/v1/admin/live-channels?category=${encodeURIComponent(category)}&status=PUBLISHED`)
    ).json()) as { total: number };

    expect(published.total).toBe(0);
  });

  it('bounds the pagination parameters', async (ctx) => {
    requireDb(ctx);

    expect((await api('/api/v1/admin/live-channels?limit=500')).status).toBe(400);
    expect((await api('/api/v1/admin/live-channels?page=0')).status).toBe(400);
  });

  it('reports the source count on list rows', async (ctx) => {
    requireDb(ctx);

    const category = `Count-${randomUUID().slice(0, 8)}`;
    const id = await createChannel({ category });
    await addSource(id, STREAM_URL);
    await addSource(id, BACKUP_URL);

    const body = (await (
      await api(`/api/v1/admin/live-channels?category=${encodeURIComponent(category)}`)
    ).json()) as { items: { id: string; sourceCount: number }[] };

    expect(body.items[0]!.sourceCount).toBe(2);
  });

  it('lets a VIEWER read but not write', async (ctx) => {
    requireDb(ctx);

    const id = await createChannel();

    expect((await api('/api/v1/admin/live-channels', {}, viewerToken)).status).toBe(200);
    expect((await api(`/api/v1/admin/live-channels/${id}`, {}, viewerToken)).status).toBe(200);

    const created = await api(
      '/api/v1/admin/live-channels',
      { method: 'POST', ...json({ name_i18n: i18n('Nope'), category: 'News' }) },
      viewerToken,
    );
    expect(created.status).toBe(403);

    const deleted = await api(
      `/api/v1/admin/live-channels/${id}`,
      { method: 'DELETE' },
      viewerToken,
    );
    expect(deleted.status).toBe(403);
  });

  it('deletes a channel and its stream sources together', async (ctx) => {
    requireDb(ctx);

    const id = await createChannel();
    const sourceId = await addSource(id, STREAM_URL);

    const response = await api(`/api/v1/admin/live-channels/${id}`, { method: 'DELETE' });
    expect(response.status).toBe(204);
    createdChannelIds.delete(id);

    expect(await db.select().from(liveChannel).where(eq(liveChannel.id, id))).toHaveLength(0);
    // The cascade is explicit in the service — stream_source is polymorphic and
    // has no foreign key that could do this.
    expect(
      await db.select().from(streamSource).where(eq(streamSource.id, sourceId)),
    ).toHaveLength(0);
  });
});

describe('live channel stream URL confidentiality', () => {
  it('never includes a url in the detail response', async (ctx) => {
    requireDb(ctx);

    const id = await createChannel({ logo_asset_id: logoId });
    await addSource(id, STREAM_URL);

    const response = await api(`/api/v1/admin/live-channels/${id}`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).not.toContain(STREAM_URL);

    // The detail DTO does not embed sources at all — they are a separate
    // ADMIN-only sub-resource — so there is no object here that could carry a
    // stream url in the first place.
    const { channel } = JSON.parse(body) as { channel: Record<string, unknown> };
    expect(channel).not.toHaveProperty('sources');

    // The logo's `url` is a public /storage path and is meant to be here; the
    // channel itself must still have no url of its own.
    expect(channel).not.toHaveProperty('url');
  });

  it('never includes a url in the list response', async (ctx) => {
    requireDb(ctx);

    const category = `Leak-${randomUUID().slice(0, 8)}`;
    const id = await createChannel({ category });
    await addSource(id, STREAM_URL);

    const response = await api(
      `/api/v1/admin/live-channels?category=${encodeURIComponent(category)}`,
    );

    const body = await response.text();
    expect(body).not.toContain(STREAM_URL);
  });

  it('never includes a url when listing sources', async (ctx) => {
    requireDb(ctx);

    const id = await createChannel();
    await addSource(id, STREAM_URL);

    const response = await api(`/api/v1/admin/live-channels/${id}/sources`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).not.toContain(STREAM_URL);
    expect(body).not.toContain('"url"');
  });

  it('returns the url to an ADMIN and writes an audit entry', async (ctx) => {
    requireDb(ctx);

    const id = await createChannel();
    const sourceId = await addSource(id, STREAM_URL);

    const response = await api(`/api/v1/admin/live-channels/${id}/sources/${sourceId}/url`);
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

    const id = await createChannel();
    const sourceId = await addSource(id, STREAM_URL);

    expect(
      (await api(`/api/v1/admin/live-channels/${id}/sources/${sourceId}/url`, {}, viewerToken))
        .status,
    ).toBe(403);

    expect((await api(`/api/v1/admin/live-channels/${id}/sources`, {}, viewerToken)).status).toBe(
      403,
    );
  });

  it('does not leak a source belonging to another channel', async (ctx) => {
    requireDb(ctx);

    const [channelA, channelB] = [await createChannel(), await createChannel()];
    const sourceId = await addSource(channelA, STREAM_URL);

    const response = await api(`/api/v1/admin/live-channels/${channelB}/sources/${sourceId}/url`);
    expect(response.status).toBe(404);
  });
});

describe('live channel stream sources', () => {
  it('stores the url as plain text on the row', async (ctx) => {
    requireDb(ctx);

    const id = await createChannel();
    const sourceId = await addSource(id, STREAM_URL);

    const [row] = await db.select().from(streamSource).where(eq(streamSource.id, sourceId));

    expect(row!.url).toBe(STREAM_URL);
    expect(row!.ownerType).toBe('LIVE_CHANNEL');
    expect(row!.ownerId).toBe(id);
  });

  it('appends new sources as backups and reorders them', async (ctx) => {
    requireDb(ctx);

    const id = await createChannel();
    const primary = await addSource(id, STREAM_URL);
    const backup = await addSource(id, BACKUP_URL);

    const before = (await (await api(`/api/v1/admin/live-channels/${id}/sources`)).json()) as {
      sources: { id: string; priority: number }[];
    };

    expect(before.sources.map((item) => item.id)).toEqual([primary, backup]);
    expect(before.sources.map((item) => item.priority)).toEqual([0, 1]);

    const response = await api(`/api/v1/admin/live-channels/${id}/sources/reorder`, {
      method: 'POST',
      ...json({ orderedIds: [backup, primary] }),
    });

    expect(response.status).toBe(200);

    const { sources } = (await response.json()) as { sources: { id: string; priority: number }[] };
    expect(sources.map((item) => item.id)).toEqual([backup, primary]);
    expect(sources.map((item) => item.priority)).toEqual([0, 1]);

    // ...and the new priorities are what actually landed in the database.
    const [promoted] = await db.select().from(streamSource).where(eq(streamSource.id, backup));
    expect(promoted!.priority).toBe(0);
  });

  it('rejects a partial reorder', async (ctx) => {
    requireDb(ctx);

    const id = await createChannel();
    const primary = await addSource(id, STREAM_URL);
    await addSource(id, BACKUP_URL);

    const response = await api(`/api/v1/admin/live-channels/${id}/sources/reorder`, {
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

    const id = await createChannel();

    for (const url of ['file:///etc/passwd', 'not-a-url', 'ftp://example.com/a.m3u8']) {
      const response = await api(`/api/v1/admin/live-channels/${id}/sources`, {
        method: 'POST',
        ...json({ url }),
      });

      expect(response.status, url).toBe(400);
    }
  });

  it('records the outcome of a test on the row', async (ctx) => {
    requireDb(ctx);

    const id = await createChannel();
    // Reserved by RFC 2606 — resolves nowhere, so the probe fails fast rather
    // than reaching a real host from the test suite.
    const sourceId = await addSource(id, 'https://unreachable.invalid/live/master.m3u8');

    const response = await api(`/api/v1/admin/live-channels/${id}/sources/${sourceId}/test`, {
      method: 'POST',
    });

    expect(response.status).toBe(200);

    const outcome = (await response.json()) as { result: string; testedAt: string; reason: string };
    expect(outcome.result).toBe('FAILED');
    // The reason is shown in the admin UI and logged; it must never carry the URL.
    expect(outcome.reason).not.toContain('unreachable.invalid');

    const [row] = await db.select().from(streamSource).where(eq(streamSource.id, sourceId));
    expect(row!.lastTestResult).toBe('FAILED');
    expect(row!.lastTestedAt).not.toBeNull();
  });

  it('clears the stale health result when the url changes', async (ctx) => {
    requireDb(ctx);

    const id = await createChannel();
    const sourceId = await addSource(id, STREAM_URL);

    await db
      .update(streamSource)
      .set({ lastTestResult: 'OK', lastTestedAt: new Date() })
      .where(eq(streamSource.id, sourceId));

    const response = await api(`/api/v1/admin/live-channels/${id}/sources/${sourceId}`, {
      method: 'PATCH',
      ...json({ url: BACKUP_URL }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as { source: unknown }).toMatchObject({
      source: { lastTestResult: null, lastTestedAt: null },
    });
  });

  it('deletes a source', async (ctx) => {
    requireDb(ctx);

    const id = await createChannel();
    const sourceId = await addSource(id, STREAM_URL);

    expect(
      (await api(`/api/v1/admin/live-channels/${id}/sources/${sourceId}`, { method: 'DELETE' }))
        .status,
    ).toBe(204);

    expect(await db.select().from(streamSource).where(eq(streamSource.id, sourceId))).toHaveLength(
      0,
    );
  });
});

describe('bulk channel management', () => {
  it('publishes ready selections, reports failures, and leaves other channels alone', async (ctx) => {
    requireDb(ctx);
    const ready = await createChannel();
    const incomplete = await createChannel();
    const untouched = await createChannel();
    await addSource(ready, STREAM_URL);
    const missing = randomUUID();
    const response = await api('/api/v1/admin/live-channels/bulk-publication', {
      method: 'POST', ...json({ ids: [ready, incomplete, missing], status: 'PUBLISHED' }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { succeeded: string[]; failed: Array<{ id: string; message: string }> };
    expect(body.succeeded).toEqual([ready]);
    expect(body.failed.map((item) => item.id)).toEqual([incomplete, missing]);
    expect(body.failed[0]!.message).toContain('stream source');
    const rows = await db.select().from(liveChannel).where(inArray(liveChannel.id, [ready, incomplete, untouched]));
    expect(rows.find((row) => row.id === ready)!.status).toBe('PUBLISHED');
    expect(rows.filter((row) => row.id !== ready).every((row) => row.status === 'DRAFT')).toBe(true);
    const unpublish = await api('/api/v1/admin/live-channels/bulk-publication', {
      method: 'POST', ...json({ ids: [ready, incomplete], status: 'UNPUBLISHED' }),
    });
    expect(await unpublish.json()).toEqual({ succeeded: [ready, incomplete], failed: [] });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.entityId, ready), eq(auditLog.adminUserId, adminId)));
    expect(audits.map((row) => row.action)).toEqual(expect.arrayContaining(['PUBLISH', 'UNPUBLISH']));
  });

  it('persists relative and end moves across pages and in the consumer list', async (ctx) => {
    requireDb(ctx);
    const category = `Order-${randomUUID().slice(0, 8)}`;
    const ids = await Promise.all([createChannel({ category }), createChannel({ category }), createChannel({ category })]);
    await db.update(liveChannel).set({ status: 'PUBLISHED' }).where(inArray(liveChannel.id, ids));
    for (const id of [...ids].reverse()) {
      expect((await api('/api/v1/admin/live-channels/reorder', { method: 'POST', ...json({ id, placement: 'first' }) })).status).toBe(204);
    }
    const firstPage = await (await api(`/api/v1/admin/live-channels?category=${category}&limit=2`)).json() as { items: Array<{ id: string }> };
    const secondPage = await (await api(`/api/v1/admin/live-channels?category=${category}&limit=2&page=2`)).json() as { items: Array<{ id: string }> };
    expect([...firstPage.items, ...secondPage.items].map((row) => row.id)).toEqual(ids);
    expect((await api('/api/v1/admin/live-channels/reorder', { method: 'POST', ...json({ id: ids[2], targetId: ids[0], placement: 'before' }) })).status).toBe(204);
    const consumer = await listPublishedLiveChannels({ category, page: 1, limit: 100, lang: 'en' });
    expect(consumer.data.map((row) => row.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect((await api('/api/v1/admin/live-channels/reorder', { method: 'POST', ...json({ id: ids[2], placement: 'last' }) })).status).toBe(204);
    const after = await listPublishedLiveChannels({ category, page: 1, limit: 100, lang: 'en' });
    expect(after.data.map((row) => row.id)).toEqual(ids);
    expect((await api('/api/v1/admin/live-channels/reorder', { method: 'POST', ...json({ id: ids[0], targetId: ids[1], placement: 'after' }) })).status).toBe(204);
    expect((await listPublishedLiveChannels({ category, page: 1, limit: 100, lang: 'en' })).data.map((row) => row.id)).toEqual([ids[1], ids[0], ids[2]]);
    const added = await createChannel({ category });
    const all = await (await api(`/api/v1/admin/live-channels?category=${category}`)).json() as { items: Array<{ id: string }> };
    expect(all.items.at(-1)!.id).toBe(added);
  });

  it('rejects invalid selections and unauthorized mutations', async (ctx) => {
    requireDb(ctx);
    const id = await createChannel();
    for (const ids of [[], [id, id], ['invalid']]) {
      expect((await api('/api/v1/admin/live-channels/bulk-publication', { method: 'POST', ...json({ ids, status: 'PUBLISHED' }) })).status).toBe(400);
    }
    for (const input of [{ id, placement: 'before' }, { id, targetId: id, placement: 'before' }]) {
      expect((await api('/api/v1/admin/live-channels/reorder', { method: 'POST', ...json(input) })).status).toBe(400);
    }
    expect((await api('/api/v1/admin/live-channels/reorder', { method: 'POST', ...json({ id, targetId: randomUUID(), placement: 'after' }) })).status).toBe(404);
    expect((await api('/api/v1/admin/live-channels/reorder', { method: 'POST', ...json({ id, placement: 'first' }) }, viewerToken)).status).toBe(403);
    expect((await api('/api/v1/admin/live-channels/bulk-publication', { method: 'POST', ...json({ ids: [id], status: 'PUBLISHED' }) }, viewerToken)).status).toBe(403);
  });
});
