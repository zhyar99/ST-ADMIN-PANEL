import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  PlaybackSessionResponse,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../../db/client';
import { adCreative, mediaAsset, streamSource } from '../../../db/schema';
import {
  admin,
  consumer,
  createChannel,
  createMovie,
  createSeriesWithEpisodes,
  harness,
  requireDb,
  startHarness,
  stopHarness,
} from './harness';

/**
 * POST /api/v1/playback/session — the only endpoint that returns a stream URL.
 *
 * Failover is asserted by writing `last_test_result` straight to the database:
 * the admin API sets it from a real playability probe, and these tests need the
 * verdict without the network round trip.
 */

const PRIMARY_URL = 'https://stream.example.test/primary.m3u8';
const BACKUP_URL = 'https://stream.example.test/backup.m3u8';

let movieId = '';
let draftMovieId = '';
let channelId = '';
let episodeId = '';

function session(body: unknown) {
  return consumer('/api/v1/playback/session', { method: 'POST', body: JSON.stringify(body) });
}

/** Marks one of a movie's sources FAILED, the way a failed health check would. */
async function markFailed(ownerId: string, url: string): Promise<void> {
  await db
    .update(streamSource)
    .set({ lastTestResult: 'FAILED', lastTestedAt: new Date() })
    .where(and(eq(streamSource.ownerId, ownerId), eq(streamSource.url, url)));
}

async function clearTestResults(ownerId: string): Promise<void> {
  await db
    .update(streamSource)
    .set({ lastTestResult: null, lastTestedAt: null })
    .where(eq(streamSource.ownerId, ownerId));
}

beforeAll(async () => {
  await startHarness();
  if (!harness().dbAvailable) return;

  // Priority 0 is the primary; the second source is appended behind it.
  movieId = await createMovie({
    sources: [PRIMARY_URL, BACKUP_URL],
    subtitle: 'https://subs.example.test/playback.en.vtt',
  });

  draftMovieId = await createMovie({ publish: false, sources: [PRIMARY_URL] });
  channelId = await createChannel();
  episodeId = (await createSeriesWithEpisodes()).publishedEpisodeId;
}, 60_000);

afterAll(stopHarness);

describe('source selection', () => {
  it('returns the primary source when nothing is known to be broken', async (ctx) => {
    requireDb(ctx);
    await clearTestResults(movieId);

    const response = await session({ contentType: 'movie', contentId: movieId });
    expect(response.status).toBe(200);

    const body = (await response.json()) as PlaybackSessionResponse;
    expect(body.sourceUrl).toBe(PRIMARY_URL);
  });

  it('falls through to the backup when the primary last failed', async (ctx) => {
    requireDb(ctx);
    await clearTestResults(movieId);
    await markFailed(movieId, PRIMARY_URL);

    const body = (await (
      await session({ contentType: 'movie', contentId: movieId })
    ).json()) as PlaybackSessionResponse;

    expect(body.sourceUrl).toBe(BACKUP_URL);
  });

  it('still returns the primary when every source has failed', async (ctx) => {
    requireDb(ctx);
    await clearTestResults(movieId);
    await markFailed(movieId, PRIMARY_URL);
    await markFailed(movieId, BACKUP_URL);

    // A stale FAILED verdict is a guess about the past; returning nothing is a
    // guaranteed black screen.
    const body = (await (
      await session({ contentType: 'movie', contentId: movieId })
    ).json()) as PlaybackSessionResponse;

    expect(body.sourceUrl).toBe(PRIMARY_URL);
  });

  it('treats an OK result as usable', async (ctx) => {
    requireDb(ctx);
    await clearTestResults(movieId);
    await db
      .update(streamSource)
      .set({ lastTestResult: 'OK' })
      .where(and(eq(streamSource.ownerId, movieId), eq(streamSource.url, PRIMARY_URL)));

    const body = (await (
      await session({ contentType: 'movie', contentId: movieId })
    ).json()) as PlaybackSessionResponse;

    expect(body.sourceUrl).toBe(PRIMARY_URL);
  });
});

describe('response shape', () => {
  it('carries subtitle tracks and an ad policy for a movie', async (ctx) => {
    requireDb(ctx);
    await clearTestResults(movieId);

    const body = (await (
      await session({ contentType: 'movie', contentId: movieId })
    ).json()) as PlaybackSessionResponse;

    expect(body.subtitleTracks).toEqual([
      { language: 'en', url: 'https://subs.example.test/playback.en.vtt' },
    ]);

    expect(body.adPolicy).toEqual({
      preRoll: {
        minSeconds: expect.any(Number),
        maxSeconds: expect.any(Number),
        // Fixed rule, not a stored column.
        skippable: false,
      },
      midRoll: {
        intervalMinutes: expect.any(Number),
        maxSeconds: expect.any(Number),
        skipAfterSeconds: expect.any(Number),
      },
      // Whatever the local pool holds; the creative-specific cases below
      // control it explicitly.
      creative: body.adPolicy?.creative ?? null,
    });
  });

  it('reflects a config change on the very next session', async (ctx) => {
    requireDb(ctx);

    const before = (await (
      await session({ contentType: 'movie', contentId: movieId })
    ).json()) as PlaybackSessionResponse;

    const changed = (before.adPolicy!.midRoll.intervalMinutes % 45) + 11;

    await admin('/api/v1/admin/advertising/config', {
      method: 'PUT',
      body: JSON.stringify({ midRollIntervalMinutes: changed }),
    });

    // No restart, no cache: the policy is read per session.
    const after = (await (
      await session({ contentType: 'movie', contentId: movieId })
    ).json()) as PlaybackSessionResponse;

    expect(after.adPolicy!.midRoll.intervalMinutes).toBe(changed);

    await admin('/api/v1/admin/advertising/config', {
      method: 'PUT',
      body: JSON.stringify({ midRollIntervalMinutes: before.adPolicy!.midRoll.intervalMinutes }),
    });
  });

  it('serves the active creative, and null once it is deactivated', async (ctx) => {
    requireDb(ctx);

    // Every creative already in the local pool is stood down for the duration
    // of this test, so the assertion is about the one this test created rather
    // than about whatever a developer happens to have uploaded.
    const existing = await db
      .update(adCreative)
      .set({ isActive: false })
      .where(eq(adCreative.isActive, true))
      .returning({ id: adCreative.id });

    const [asset] = await db
      .insert(mediaAsset)
      .values({
        kind: 'AD_CREATIVE',
        filePath: `ad-creatives/${randomUUID()}.mp4`,
        fileName: 'creative.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 4096,
        status: 'READY',
      })
      .returning({ id: mediaAsset.id });

    const [creative] = await db
      .insert(adCreative)
      .values({ assetId: asset!.id, durationSeconds: 13 })
      .returning({ id: adCreative.id });

    try {
      const withCreative = (await (
        await session({ contentType: 'movie', contentId: movieId })
      ).json()) as PlaybackSessionResponse;

      expect(withCreative.adPolicy!.creative).toEqual({
        id: creative!.id,
        url: expect.stringContaining('/storage/ad-creatives/'),
        durationSeconds: 13,
      });

      await db
        .update(adCreative)
        .set({ isActive: false })
        .where(eq(adCreative.id, creative!.id));

      const withoutCreative = (await (
        await session({ contentType: 'movie', contentId: movieId })
      ).json()) as PlaybackSessionResponse;

      // An empty pool is not "advertising off": the timing still stands.
      expect(withoutCreative.adPolicy!.creative).toBeNull();
      expect(withoutCreative.adPolicy!.preRoll.minSeconds).toEqual(expect.any(Number));
      expect(withoutCreative.adPolicy!.midRoll.intervalMinutes).toEqual(expect.any(Number));
    } finally {
      await db.delete(adCreative).where(eq(adCreative.id, creative!.id));
      await db.delete(mediaAsset).where(eq(mediaAsset.id, asset!.id));

      if (existing.length > 0) {
        await db
          .update(adCreative)
          .set({ isActive: true })
          .where(inArray(adCreative.id, existing.map((row) => row.id)));
      }
    }
  });

  it('resolves an episode session', async (ctx) => {
    requireDb(ctx);

    const response = await session({ contentType: 'episode', contentId: episodeId });
    expect(response.status).toBe(200);

    const body = (await response.json()) as PlaybackSessionResponse;
    expect(body.sourceUrl).toBe('https://stream.example.test/episode.m3u8');
    expect(body.subtitleTracks).toEqual([
      { language: 'ar', url: 'https://subs.example.test/ep1.ar.vtt' },
    ]);
  });

  it('reports the kind of the source it hands back', async (ctx) => {
    requireDb(ctx);

    const EMBED_URL = 'https://play.example.test/e/movie/1204680?autostart=true';

    // Two sources, the embed first. What the player is given is a page to
    // frame, and the response has to say so — the URL alone cannot be parsed
    // into that answer, which is the whole reason the column exists.
    const embedMovieId = await createMovie({ sources: [EMBED_URL, BACKUP_URL] });

    await db
      .update(streamSource)
      .set({ kind: 'EMBED' })
      .where(and(eq(streamSource.ownerId, embedMovieId), eq(streamSource.url, EMBED_URL)));

    const body = (await (
      await session({ contentType: 'movie', contentId: embedMovieId })
    ).json()) as PlaybackSessionResponse;

    expect(body.sourceUrl).toBe(EMBED_URL);
    expect(body.sourceKind).toBe('EMBED');

    // Failing the embed over falls back to the direct file, and the kind
    // follows the source rather than the movie.
    await markFailed(embedMovieId, EMBED_URL);

    const afterFailover = (await (
      await session({ contentType: 'movie', contentId: embedMovieId })
    ).json()) as PlaybackSessionResponse;

    expect(afterFailover.sourceUrl).toBe(BACKUP_URL);
    expect(afterFailover.sourceKind).toBe('DIRECT');
  });

  it('omits adPolicy and subtitleTracks entirely for a live channel', async (ctx) => {
    requireDb(ctx);

    const response = await session({ contentType: 'live_channel', contentId: channelId });
    expect(response.status).toBe(200);

    const body = (await response.json()) as PlaybackSessionResponse;

    expect(body.sourceUrl).toBe('https://stream.example.test/channel.m3u8');
    // `sourceKind` rides along for every content type, a channel included: the
    // player has to know whether it was handed a manifest or a page to frame
    // before it knows anything else about the session.
    expect(Object.keys(body)).toEqual(['sourceUrl', 'sourceKind']);
    expect('adPolicy' in body).toBe(false);
    expect('subtitleTracks' in body).toBe(false);
  });
});

describe('access and validation', () => {
  it('needs no authentication', async (ctx) => {
    requireDb(ctx);

    expect((await session({ contentType: 'movie', contentId: movieId })).status).toBe(200);
  });

  it('404s unpublished content without saying why', async (ctx) => {
    requireDb(ctx);

    const response = await session({ contentType: 'movie', contentId: draftMovieId });
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).not.toContain('stream');
    expect(JSON.stringify(body)).not.toContain(PRIMARY_URL);
  });

  it('404s an unknown id', async (ctx) => {
    requireDb(ctx);

    expect((await session({ contentType: 'movie', contentId: randomUUID() })).status).toBe(404);
  });

  it('404s when the id names a different content type', async (ctx) => {
    requireDb(ctx);

    expect((await session({ contentType: 'movie', contentId: channelId })).status).toBe(404);
  });

  it('400s a malformed body', async (ctx) => {
    requireDb(ctx);

    expect((await session({ contentType: 'movie', contentId: 'not-a-uuid' })).status).toBe(400);
    expect((await session({ contentType: 'podcast', contentId: movieId })).status).toBe(400);
    expect((await session({})).status).toBe(400);
  });

  it('never exposes a source URL through the catalogue endpoints', async (ctx) => {
    requireDb(ctx);

    // The same movie whose session hands out PRIMARY_URL above.
    const detail = await (await consumer(`/api/v1/movies/${movieId}`)).text();
    const list = await (await consumer('/api/v1/movies?limit=100')).text();

    expect(detail).not.toContain(PRIMARY_URL);
    expect(detail).not.toContain(BACKUP_URL);
    expect(list).not.toContain(PRIMARY_URL);
  });

  it('does not let an admin source listing carry the URL either', async (ctx) => {
    requireDb(ctx);

    const body = await (await admin(`/api/v1/admin/movies/${movieId}/sources`)).text();

    expect(body).not.toContain(PRIMARY_URL);
  });
});
