import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

import argon2 from 'argon2';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  adminUser,
  importEntry,
  importJob,
  liveChannel,
  movie,
  streamSource,
} from '../../../db/schema';
import { app } from '../../../app';
import { db, pool } from '../../../db/client';
import { config } from '../../../config';

/**
 * Integration coverage for the Phase 14 import routes.
 *
 * Two assertions recur. The first is that nothing published moves: an upload
 * creates staging rows and no catalogue rows, and a stub only appears when
 * somebody approves an entry. The second is the familiar negative one — a
 * VIEWER's view of an entry must not contain the stream URL, checked against
 * the serialised body rather than a known key so a URL leaking through a newly
 * added field fails here too.
 */

const ADMIN_PASSWORD = 'import-admin-password-1';
const VIEWER_PASSWORD = 'import-viewer-password-1';

const BYPASS = { 'x-test-bypass-rate-limit': '1' };

let server: Server;
let baseUrl: string;
let dbAvailable = false;
let adminToken = '';
let viewerToken = '';

/** Everything this suite creates, torn down in afterAll. */
const createdJobIds = new Set<string>();
const createdAdminIds = new Set<string>();
const createdChannelIds = new Set<string>();
const createdMovieIds = new Set<string>();
/** A URL unique to this run, seeded into stream_source to force a DUPLICATE. */
const PRE_EXISTING_URL = `https://provider.example/live/pre-existing-${randomUUID()}.m3u8`;
let preExistingSourceId = '';
let preExistingChannelId = '';

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

/** Uploads `content` as a multipart playlist, returning the raw response. */
function upload(
  content: string,
  filename = 'playlist.m3u',
  token: string = adminToken,
  mimeType = 'audio/x-mpegurl',
): Promise<Response> {
  const form = new FormData();
  form.append('playlist', new Blob([content], { type: mimeType }), filename);

  return fetch(`${baseUrl}/api/v1/admin/import/jobs`, {
    method: 'POST',
    headers: { ...BYPASS, authorization: `Bearer ${token}` },
    body: form,
  });
}

interface JobBody {
  id: string;
  status: string;
  totalEntries: number;
  approvedCount: number;
  rejectedCount: number;
  errorMessage: string | null;
}

interface EntryBody {
  id: string;
  lineNumber: number;
  rawName: string | null;
  rawUrl?: string;
  status: string;
  mappedId: string | null;
  mappedType: string;
  duplicateOf: string | null;
  duplicateOwner: { type: string; id: string } | null;
  adminNote: string | null;
}

/** Uploads and returns the finished job, remembering it for teardown. */
async function importPlaylist(content: string, filename = 'playlist.m3u'): Promise<JobBody> {
  const response = await upload(content, filename);
  expect(response.status).toBe(201);

  const { job } = (await response.json()) as { job: JobBody };
  createdJobIds.add(job.id);
  return job;
}

async function entriesOf(jobId: string, token = adminToken, query = ''): Promise<EntryBody[]> {
  const response = await api(`/api/v1/admin/import/jobs/${jobId}/entries${query}`, {}, token);
  expect(response.status).toBe(200);

  const body = (await response.json()) as { items: EntryBody[] };
  return body.items;
}

/** Remembers whatever an approval created, so teardown can remove it. */
function trackStub(mappedType: string, mappedId: string | null): void {
  if (!mappedId) return;
  if (mappedType === 'LIVE_CHANNEL') createdChannelIds.add(mappedId);
  else createdMovieIds.add(mappedId);
}

function playlist(...channels: [name: string, url: string, group?: string][]): string {
  return [
    '#EXTM3U',
    ...channels.flatMap(([name, url, group]) => [
      `#EXTINF:-1 tvg-id="${name.toLowerCase()}" tvg-name="${name}" tvg-logo="https://logos.example/${name}.png"${
        group ? ` group-title="${group}"` : ''
      },${name}`,
      url,
    ]),
  ].join('\n');
}

/** A URL nothing else in this run will produce. */
function freshUrl(label: string): string {
  return `https://provider.example/live/${label}-${randomUUID()}.m3u8`;
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
  const adminEmail = `import-admin-${suffix}@example.test`;
  const viewerEmail = `import-viewer-${suffix}@example.test`;

  const created = await db
    .insert(adminUser)
    .values([
      {
        email: adminEmail,
        name: 'Import Admin',
        role: 'ADMIN',
        passwordHash: await argon2.hash(ADMIN_PASSWORD),
      },
      {
        email: viewerEmail,
        name: 'Import Viewer',
        role: 'VIEWER',
        passwordHash: await argon2.hash(VIEWER_PASSWORD),
      },
    ])
    .returning({ id: adminUser.id });

  for (const row of created) createdAdminIds.add(row.id);

  adminToken = await login(adminEmail, ADMIN_PASSWORD);
  viewerToken = await login(viewerEmail, VIEWER_PASSWORD);

  // A channel that already serves one of the URLs the playlists below carry —
  // the fixture behind every duplicate-detection assertion.
  const [channel] = await db
    .insert(liveChannel)
    .values({
      nameI18n: { en: 'Pre-existing', ckb: 'Pre-existing', ar: 'Pre-existing' },
      category: 'News',
    })
    .returning({ id: liveChannel.id });

  preExistingChannelId = channel!.id;
  createdChannelIds.add(preExistingChannelId);

  const [source] = await db
    .insert(streamSource)
    .values({
      ownerType: 'LIVE_CHANNEL',
      ownerId: preExistingChannelId,
      url: PRE_EXISTING_URL,
      priority: 0,
    })
    .returning({ id: streamSource.id });

  preExistingSourceId = source!.id;
});

afterAll(async () => {
  if (dbAvailable) {
    // Jobs first: entries cascade, and an entry's duplicate_of would otherwise
    // hold a reference to a source this teardown is about to remove.
    if (createdJobIds.size > 0) {
      await db.delete(importJob).where(inArray(importJob.id, [...createdJobIds]));
    }

    const ownerIds = [...createdChannelIds, ...createdMovieIds];
    if (ownerIds.length > 0) {
      await db.delete(streamSource).where(inArray(streamSource.ownerId, ownerIds));
    }
    if (createdChannelIds.size > 0) {
      await db.delete(liveChannel).where(inArray(liveChannel.id, [...createdChannelIds]));
    }
    if (createdMovieIds.size > 0) {
      await db.delete(movie).where(inArray(movie.id, [...createdMovieIds]));
    }
    if (createdAdminIds.size > 0) {
      await db.delete(adminUser).where(inArray(adminUser.id, [...createdAdminIds]));
    }
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('POST /api/v1/admin/import/jobs', () => {
  it('parses a valid playlist into a finished job', async (ctx) => {
    requireDb(ctx);

    const job = await importPlaylist(
      playlist(['Alpha', freshUrl('alpha'), 'UK'], ['Beta', freshUrl('beta'), 'UK']),
      'provider.m3u',
    );

    expect(job.status).toBe('DONE');
    expect(job.totalEntries).toBe(2);
    expect(job.errorMessage).toBeNull();

    const entries = await entriesOf(job.id);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.rawName)).toEqual(['Alpha', 'Beta']);
    expect(entries.every((entry) => entry.status === 'STAGED')).toBe(true);
  });

  it('creates no catalogue rows of its own', async (ctx) => {
    requireDb(ctx);

    const url = freshUrl('untouched');
    const job = await importPlaylist(playlist(['Untouched', url]));

    const sources = await db.select().from(streamSource).where(eq(streamSource.url, url));
    expect(sources).toEqual([]);

    const entries = await entriesOf(job.id);
    expect(entries[0]?.mappedId).toBeNull();
  });

  it('flags a URL the catalogue already serves as DUPLICATE', async (ctx) => {
    requireDb(ctx);

    const job = await importPlaylist(
      playlist(['Known', PRE_EXISTING_URL], ['Novel', freshUrl('novel')]),
    );

    const entries = await entriesOf(job.id);
    const known = entries.find((entry) => entry.rawName === 'Known');
    const novel = entries.find((entry) => entry.rawName === 'Novel');

    expect(known?.status).toBe('DUPLICATE');
    expect(known?.duplicateOf).toBe(preExistingSourceId);
    expect(known?.duplicateOwner).toEqual({ type: 'LIVE_CHANNEL', id: preExistingChannelId });
    expect(novel?.status).toBe('STAGED');
  });

  it('flags a URL that repeats inside the uploaded file', async (ctx) => {
    requireDb(ctx);

    const url = freshUrl('twice');
    const job = await importPlaylist(playlist(['First', url, 'UK'], ['Again', url, 'Sport']));

    const entries = await entriesOf(job.id);

    expect(entries[0]?.status).toBe('STAGED');
    expect(entries[1]?.status).toBe('DUPLICATE');
    // No stream_source to point at — the note is where the reason lives.
    expect(entries[1]?.duplicateOf).toBeNull();
    expect(entries[1]?.adminNote).toMatch(/first seen on line 2/);
  });

  it('accepts a playlist with no playable entries', async (ctx) => {
    requireDb(ctx);

    const job = await importPlaylist('#EXTM3U\n#EXTINF:-1,Multicast\nrtp://239.0.0.1:5000\n');

    expect(job.status).toBe('DONE');
    expect(job.totalEntries).toBe(0);
    expect(job.errorMessage).toBeNull();
    expect(await entriesOf(job.id)).toEqual([]);
  });

  it('rejects a file that is not a playlist', async (ctx) => {
    requireDb(ctx);

    const response = await upload('name,url\nAlpha,https://a.example\n', 'channels.csv', adminToken, 'text/csv');

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects a playlist-named file whose contents are something else', async (ctx) => {
    requireDb(ctx);

    const response = await upload('name,url\nAlpha,https://a.example\n', 'channels.m3u');

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_A_PLAYLIST');
  });

  it('rejects a file larger than IMPORT_MAX_FILE_SIZE_MB', async (ctx) => {
    requireDb(ctx);

    // One line over the limit is enough — multer aborts mid-stream, so the body
    // never has to be built at full size in this process.
    const filler = '#'.repeat(1024);
    const oversized = `#EXTM3U\n${`${filler}\n`.repeat(Math.ceil(config.importMaxFileBytes / 1025) + 1)}`;

    const response = await upload(oversized, 'huge.m3u');

    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FILE_TOO_LARGE');
  });
});

describe('approval', () => {
  it('creates a draft live channel with one source', async (ctx) => {
    requireDb(ctx);

    const url = freshUrl('stub-channel');
    const job = await importPlaylist(playlist(['Stub Channel', url, 'Sport']));
    const [staged] = await entriesOf(job.id);

    const response = await api(
      `/api/v1/admin/import/jobs/${job.id}/entries/${staged!.id}/approve`,
      { method: 'PATCH', ...json({ mappedType: 'LIVE_CHANNEL', createNew: true }) },
    );

    expect(response.status).toBe(200);
    const { entry } = (await response.json()) as { entry: EntryBody };
    trackStub('LIVE_CHANNEL', entry.mappedId);

    expect(entry.status).toBe('APPROVED');
    expect(entry.mappedType).toBe('LIVE_CHANNEL');
    expect(entry.mappedId).not.toBeNull();

    const [channel] = await db
      .select()
      .from(liveChannel)
      .where(eq(liveChannel.id, entry.mappedId!));

    expect(channel?.status).toBe('DRAFT');
    // All three languages carry the playlist name — a stub is legible
    // everywhere while still failing the publish check until it is translated.
    expect(channel?.nameI18n).toEqual({
      en: 'Stub Channel',
      ckb: 'Stub Channel',
      ar: 'Stub Channel',
    });
    // `group-title` becomes the category, which the channel table requires.
    expect(channel?.category).toBe('Sport');

    const sources = await db
      .select()
      .from(streamSource)
      .where(eq(streamSource.ownerId, entry.mappedId!));

    expect(sources).toHaveLength(1);
    expect(sources[0]?.url).toBe(url);
    expect(sources[0]?.priority).toBe(0);

    const [reloaded] = (await db
      .select()
      .from(importJob)
      .where(eq(importJob.id, job.id))) as { approvedCount: number }[];
    expect(reloaded?.approvedCount).toBe(1);
  });

  it('creates a draft movie with one source', async (ctx) => {
    requireDb(ctx);

    const url = freshUrl('stub-movie');
    const job = await importPlaylist(playlist(['Stub Movie', url]));
    const [staged] = await entriesOf(job.id);

    const response = await api(
      `/api/v1/admin/import/jobs/${job.id}/entries/${staged!.id}/approve`,
      { method: 'PATCH', ...json({ mappedType: 'MOVIE', createNew: true }) },
    );

    expect(response.status).toBe(200);
    const { entry } = (await response.json()) as { entry: EntryBody };
    trackStub('MOVIE', entry.mappedId);

    const [created] = await db.select().from(movie).where(eq(movie.id, entry.mappedId!));

    expect(created?.status).toBe('DRAFT');
    expect(created?.titleI18n.en).toBe('Stub Movie');

    const sources = await db
      .select()
      .from(streamSource)
      .where(eq(streamSource.ownerId, entry.mappedId!));

    expect(sources).toHaveLength(1);
    expect(sources[0]?.ownerType).toBe('MOVIE');
  });

  it('appends to an existing item rather than displacing its primary source', async (ctx) => {
    requireDb(ctx);

    const url = freshUrl('linked');
    const job = await importPlaylist(playlist(['Linked', url]));
    const [staged] = await entriesOf(job.id);

    const response = await api(
      `/api/v1/admin/import/jobs/${job.id}/entries/${staged!.id}/approve`,
      {
        method: 'PATCH',
        ...json({ mappedType: 'LIVE_CHANNEL', targetId: preExistingChannelId }),
      },
    );

    expect(response.status).toBe(200);
    const { entry } = (await response.json()) as { entry: EntryBody };
    expect(entry.mappedId).toBe(preExistingChannelId);

    const sources = await db
      .select()
      .from(streamSource)
      .where(eq(streamSource.ownerId, preExistingChannelId));

    const added = sources.find((source) => source.url === url);
    // The channel's original priority-0 source keeps its place.
    expect(added?.priority).toBe(1);
    expect(sources.find((source) => source.priority === 0)?.url).toBe(PRE_EXISTING_URL);
  });

  it('refuses an approval that names both createNew and a targetId', async (ctx) => {
    requireDb(ctx);

    const job = await importPlaylist(playlist(['Ambiguous', freshUrl('ambiguous')]));
    const [staged] = await entriesOf(job.id);

    const response = await api(
      `/api/v1/admin/import/jobs/${job.id}/entries/${staged!.id}/approve`,
      {
        method: 'PATCH',
        ...json({ mappedType: 'LIVE_CHANNEL', createNew: true, targetId: preExistingChannelId }),
      },
    );

    expect(response.status).toBe(400);
  });

  it('refuses to approve an entry twice', async (ctx) => {
    requireDb(ctx);

    const job = await importPlaylist(playlist(['Once', freshUrl('once')]));
    const [staged] = await entriesOf(job.id);
    const path = `/api/v1/admin/import/jobs/${job.id}/entries/${staged!.id}/approve`;

    const first = await api(path, {
      method: 'PATCH',
      ...json({ mappedType: 'LIVE_CHANNEL', createNew: true }),
    });
    const { entry } = (await first.json()) as { entry: EntryBody };
    trackStub('LIVE_CHANNEL', entry.mappedId);

    const second = await api(path, {
      method: 'PATCH',
      ...json({ mappedType: 'LIVE_CHANNEL', createNew: true }),
    });

    expect(second.status).toBe(409);
  });

  it('rejects an entry with a note', async (ctx) => {
    requireDb(ctx);

    const job = await importPlaylist(playlist(['Unwanted', freshUrl('unwanted')]));
    const [staged] = await entriesOf(job.id);

    const response = await api(
      `/api/v1/admin/import/jobs/${job.id}/entries/${staged!.id}/reject`,
      { method: 'PATCH', ...json({ note: 'Geo-blocked here' }) },
    );

    expect(response.status).toBe(200);
    const { entry } = (await response.json()) as { entry: EntryBody };
    expect(entry.status).toBe('REJECTED');
    expect(entry.adminNote).toBe('Geo-blocked here');

    const detail = await api(`/api/v1/admin/import/jobs/${job.id}`);
    const body = (await detail.json()) as { job: { rejectedCount: number } };
    expect(body.job.rejectedCount).toBe(1);
  });
});

describe('POST /jobs/:jobId/bulk-approve', () => {
  it('creates a stub for every staged entry and skips the duplicates', async (ctx) => {
    requireDb(ctx);

    const staged: [string, string][] = Array.from({ length: 10 }, (_, index) => [
      `Bulk ${index}`,
      freshUrl(`bulk-${index}`),
    ]);

    const job = await importPlaylist(playlist(...staged, ['Known', PRE_EXISTING_URL]));

    const response = await api(`/api/v1/admin/import/jobs/${job.id}/bulk-approve`, {
      method: 'POST',
      ...json({ mappedType: 'LIVE_CHANNEL', createNew: true }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ approved: 10, skipped: 1 });

    const entries = await entriesOf(job.id);
    const approved = entries.filter((entry) => entry.status === 'APPROVED');
    const duplicates = entries.filter((entry) => entry.status === 'DUPLICATE');

    expect(approved).toHaveLength(10);
    expect(duplicates).toHaveLength(1);
    // Each approval must have its own stub — one shared id would mean ten
    // channels collapsed into one.
    expect(new Set(approved.map((entry) => entry.mappedId)).size).toBe(10);

    for (const entry of approved) trackStub('LIVE_CHANNEL', entry.mappedId);

    const channels = await db
      .select()
      .from(liveChannel)
      .where(inArray(liveChannel.id, approved.map((entry) => entry.mappedId!)));

    expect(channels).toHaveLength(10);
    expect(channels.every((channel) => channel.status === 'DRAFT')).toBe(true);

    const detail = await api(`/api/v1/admin/import/jobs/${job.id}`);
    const body = (await detail.json()) as {
      job: { approvedCount: number; entryCounts: Record<string, number> };
    };
    expect(body.job.approvedCount).toBe(10);
    expect(body.job.entryCounts).toEqual({
      STAGED: 0,
      APPROVED: 10,
      REJECTED: 0,
      DUPLICATE: 1,
    });
  });

  it('refuses a bulk approval that is not asking for stubs', async (ctx) => {
    requireDb(ctx);

    const job = await importPlaylist(playlist(['Solo', freshUrl('solo')]));

    const response = await api(`/api/v1/admin/import/jobs/${job.id}/bulk-approve`, {
      method: 'POST',
      ...json({ mappedType: 'MOVIE', createNew: false }),
    });

    expect(response.status).toBe(400);
  });
});

describe('the VIEWER role', () => {
  it('may read jobs and entries but never the stream URL', async (ctx) => {
    requireDb(ctx);

    const url = freshUrl('viewer-blind');
    const job = await importPlaylist(playlist(['Viewer Blind', url]));

    const list = await api('/api/v1/admin/import/jobs', {}, viewerToken);
    expect(list.status).toBe(200);

    const response = await api(
      `/api/v1/admin/import/jobs/${job.id}/entries`,
      {},
      viewerToken,
    );
    expect(response.status).toBe(200);

    const raw = await response.text();
    // Asserted against the whole body, not a named key: a URL arriving through
    // some newly added nested field has to fail here too.
    expect(raw).not.toContain(url);
    expect(raw).not.toContain('provider.example');

    const body = (await JSON.parse(raw)) as { items: EntryBody[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).not.toHaveProperty('rawUrl');
    // The rest of the row is still there — this is a redaction, not a 403.
    expect(body.items[0]?.rawName).toBe('Viewer Blind');

    // ...and the ADMIN view of the same entry does carry it.
    const asAdmin = await entriesOf(job.id);
    expect(asAdmin[0]?.rawUrl).toBe(url);
  });

  it('cannot upload, approve, reject or delete', async (ctx) => {
    requireDb(ctx);

    const job = await importPlaylist(playlist(['Guarded', freshUrl('guarded')]));
    const [staged] = await entriesOf(job.id);

    const attempts = await Promise.all([
      upload(playlist(['Nope', freshUrl('nope')]), 'nope.m3u', viewerToken),
      api(
        `/api/v1/admin/import/jobs/${job.id}/entries/${staged!.id}/approve`,
        { method: 'PATCH', ...json({ mappedType: 'LIVE_CHANNEL', createNew: true }) },
        viewerToken,
      ),
      api(
        `/api/v1/admin/import/jobs/${job.id}/entries/${staged!.id}/reject`,
        { method: 'PATCH', ...json({}) },
        viewerToken,
      ),
      api(
        `/api/v1/admin/import/jobs/${job.id}/bulk-approve`,
        { method: 'POST', ...json({ mappedType: 'MOVIE', createNew: true }) },
        viewerToken,
      ),
      api(`/api/v1/admin/import/jobs/${job.id}`, { method: 'DELETE' }, viewerToken),
    ]);

    expect(attempts.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
  });
});

describe('DELETE /jobs/:jobId', () => {
  it('removes the job and its entries but leaves approved content alone', async (ctx) => {
    requireDb(ctx);

    const url = freshUrl('survivor');
    const job = await importPlaylist(playlist(['Survivor', url]));
    const [staged] = await entriesOf(job.id);

    const approved = await api(
      `/api/v1/admin/import/jobs/${job.id}/entries/${staged!.id}/approve`,
      { method: 'PATCH', ...json({ mappedType: 'LIVE_CHANNEL', createNew: true }) },
    );
    const { entry } = (await approved.json()) as { entry: EntryBody };
    trackStub('LIVE_CHANNEL', entry.mappedId);

    const response = await api(`/api/v1/admin/import/jobs/${job.id}`, { method: 'DELETE' });
    expect(response.status).toBe(204);
    createdJobIds.delete(job.id);

    expect(await db.select().from(importJob).where(eq(importJob.id, job.id))).toEqual([]);
    expect(await db.select().from(importEntry).where(eq(importEntry.jobId, job.id))).toEqual([]);

    // The channel the approval created outlives the review queue it came from.
    const [channel] = await db
      .select()
      .from(liveChannel)
      .where(eq(liveChannel.id, entry.mappedId!));
    expect(channel?.id).toBe(entry.mappedId);
  });

  it('404s for a job that does not exist', async (ctx) => {
    requireDb(ctx);

    const response = await api(`/api/v1/admin/import/jobs/${randomUUID()}`, { method: 'DELETE' });
    expect(response.status).toBe(404);
  });
});

describe('GET /jobs and /entries', () => {
  it('pages through entries with a cursor, in source order', async (ctx) => {
    requireDb(ctx);

    const channels: [string, string][] = Array.from({ length: 5 }, (_, index) => [
      `Paged ${index}`,
      freshUrl(`paged-${index}`),
    ]);
    const job = await importPlaylist(playlist(...channels));

    const first = await api(`/api/v1/admin/import/jobs/${job.id}/entries?limit=2`);
    const firstBody = (await first.json()) as { items: EntryBody[]; nextCursor: string | null };

    expect(firstBody.items.map((entry) => entry.rawName)).toEqual(['Paged 0', 'Paged 1']);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await api(
      `/api/v1/admin/import/jobs/${job.id}/entries?limit=2&cursor=${firstBody.nextCursor}`,
    );
    const secondBody = (await second.json()) as { items: EntryBody[]; nextCursor: string | null };

    expect(secondBody.items.map((entry) => entry.rawName)).toEqual(['Paged 2', 'Paged 3']);

    const third = await api(
      `/api/v1/admin/import/jobs/${job.id}/entries?limit=2&cursor=${secondBody.nextCursor}`,
    );
    const thirdBody = (await third.json()) as { items: EntryBody[]; nextCursor: string | null };

    expect(thirdBody.items.map((entry) => entry.rawName)).toEqual(['Paged 4']);
    expect(thirdBody.nextCursor).toBeNull();
  });

  it('filters entries by status', async (ctx) => {
    requireDb(ctx);

    const job = await importPlaylist(
      playlist(['Fresh', freshUrl('fresh')], ['Known', PRE_EXISTING_URL]),
    );

    const duplicates = await entriesOf(job.id, adminToken, '?status=DUPLICATE');
    expect(duplicates.map((entry) => entry.rawName)).toEqual(['Known']);

    const stagedOnly = await entriesOf(job.id, adminToken, '?status=STAGED');
    expect(stagedOnly.map((entry) => entry.rawName)).toEqual(['Fresh']);
  });

  it('rejects a malformed cursor rather than returning page one', async (ctx) => {
    requireDb(ctx);

    const response = await api('/api/v1/admin/import/jobs?cursor=not%20a%20cursor');
    expect(response.status).toBe(400);
  });

  it('finds a draft channel as a link target', async (ctx) => {
    requireDb(ctx);

    const response = await api(
      '/api/v1/admin/import/link-targets?type=LIVE_CHANNEL&q=Pre-existing',
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      targets: { id: string; name: string; sourceCount: number }[];
    };

    const found = body.targets.find((target) => target.id === preExistingChannelId);
    expect(found?.name).toBe('Pre-existing');
    expect(found?.sourceCount).toBeGreaterThanOrEqual(1);
  });
});
