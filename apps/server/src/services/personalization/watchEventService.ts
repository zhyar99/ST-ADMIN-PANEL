import { and, eq, gte, lte, sql } from 'drizzle-orm';

import type { WatchEventPayload } from '@streaming/shared' with { 'resolution-mode': 'import' };

import { config } from '../../config';
import { db } from '../../db/client';
import {
  deviceProfile,
  episode,
  liveChannel,
  movie,
  movieGenre,
  watchEvent,
} from '../../db/schema';
import { HttpError } from '../../middleware/errorHandler';
import { applyWatchSignal, rankContentTypes, signalStrength } from './affinity';

/**
 * Watch-event ingestion and the affinity update it drives (Phase 15).
 *
 * Everything one event touches happens in a single transaction: the event row,
 * the device's running totals, its affinity vector, its content-type ranking
 * and the retention purge. That is not incidental — the vector is a cache of
 * the event table, and a crash between the two writes would leave a device
 * permanently scored on a history it does not have.
 *
 * There is no queue and no background worker here by design (this phase adds no
 * scheduler), so the work is deliberately bounded: one insert, two small
 * aggregates over one device's rows, and a purge on an indexed predicate.
 */

/** Two reports of the same session this close together are one session. */
const DEDUPE_WINDOW_SECONDS = 60;

/** The transaction handle Drizzle hands the callback, named once. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Genres the content belongs to, for the affinity update.
 *
 * Only movies have any. `movie_genre` is the schema's single genre relation:
 * there is no `series_genre` table, so an episode contributes to the device's
 * *totals* and its in-progress state but not to its genre vector, and a live
 * channel's `category` is a broadcast grouping ("News", "Sport") drawn from a
 * different vocabulary than the film taxonomy and deliberately not conflated
 * with it. The day a `series_genre` relation lands, this function is the one
 * place that has to learn about it.
 */
async function genreIdsFor(
  tx: Tx,
  contentType: WatchEventPayload['content_type'],
  contentId: string,
): Promise<string[]> {
  if (contentType !== 'MOVIE') return [];

  const rows = await tx
    .select({ genreId: movieGenre.genreId })
    .from(movieGenre)
    .where(eq(movieGenre.movieId, contentId));

  return rows.map((row) => row.genreId);
}

/**
 * Asserts the content exists and is published.
 *
 * A draft is a 404 rather than a 403: an anonymous client has no business
 * learning that an id it guessed corresponds to something unreleased.
 */
async function assertPublished(
  tx: Tx,
  contentType: WatchEventPayload['content_type'],
  contentId: string,
): Promise<void> {
  // Written as three statements rather than one over a variable table: the
  // three tables are distinct Drizzle types, and unifying them would mean
  // erasing the column types that make the query safe in the first place.
  const found =
    contentType === 'MOVIE'
      ? await tx
          .select({ id: movie.id })
          .from(movie)
          .where(and(eq(movie.id, contentId), eq(movie.status, 'PUBLISHED')))
          .limit(1)
      : contentType === 'EPISODE'
        ? await tx
            .select({ id: episode.id })
            .from(episode)
            .where(and(eq(episode.id, contentId), eq(episode.status, 'PUBLISHED')))
            .limit(1)
        : await tx
            .select({ id: liveChannel.id })
            .from(liveChannel)
            .where(and(eq(liveChannel.id, contentId), eq(liveChannel.status, 'PUBLISHED')))
            .limit(1);

  if (found.length === 0) throw new HttpError(404, 'NOT_FOUND', 'No published content with that id');
}

/**
 * Records one viewing session and rebuilds the device's model around it.
 *
 * Returns nothing: the endpoint answers 204, because a TV client posting
 * telemetry has no use for a body and every byte of one is bandwidth spent on a
 * request it makes constantly.
 */
export async function recordWatchEvent(
  deviceId: string,
  payload: WatchEventPayload,
  now: Date = new Date(),
): Promise<void> {
  const startedAt = payload.started_at ? new Date(payload.started_at) : now;
  const contentSeconds = payload.content_seconds;

  // A client that reports more seconds watched than the content is long is
  // reporting a bug (a seek loop, a stuck timer, a re-encode with a shorter
  // runtime). Capping keeps the completion rate meaningful instead of letting
  // one such report count as several viewings.
  const watchSeconds =
    contentSeconds > 0 ? Math.min(payload.watch_seconds, contentSeconds) : payload.watch_seconds;

  await db.transaction(async (scoped) => {
    await assertPublished(scoped, payload.content_type, payload.content_id);

    // The middleware has already upserted this row; doing it again inside the
    // transaction is what makes the foreign key below safe against a device
    // that was blocked and deleted between the two statements.
    await scoped
      .insert(deviceProfile)
      .values({ id: deviceId })
      .onConflictDoUpdate({ target: deviceProfile.id, set: { lastSeenAt: now } });

    const windowStart = new Date(startedAt.getTime() - DEDUPE_WINDOW_SECONDS * 1000);
    const windowEnd = new Date(startedAt.getTime() + DEDUPE_WINDOW_SECONDS * 1000);

    // Aggressive client retry logic is the norm on TV platforms: a flaky
    // connection turns one session into five identical POSTs. Collapsing them
    // here keeps `watch_count` an honest measure of viewings rather than of
    // network quality.
    const [duplicate] = await scoped
      .select({
        id: watchEvent.id,
        watchSeconds: watchEvent.watchSeconds,
      })
      .from(watchEvent)
      .where(
        and(
          eq(watchEvent.deviceId, deviceId),
          eq(watchEvent.contentType, payload.content_type),
          eq(watchEvent.contentId, payload.content_id),
          gte(watchEvent.startedAt, windowStart),
          lte(watchEvent.startedAt, windowEnd),
        ),
      )
      .limit(1);

    let completionRate = 0;

    if (duplicate) {
      // The later report of a session always knows more than the earlier one,
      // but a retry of an *earlier* prefix must not walk the number backwards.
      const merged = Math.max(duplicate.watchSeconds, watchSeconds);

      const [updated] = await scoped
        .update(watchEvent)
        .set({
          watchSeconds: merged,
          contentSeconds,
          rewatch: payload.rewatch,
        })
        .where(eq(watchEvent.id, duplicate.id))
        .returning({ completionRate: watchEvent.completionRate });

      completionRate = Number(updated?.completionRate ?? 0);

      const delta = merged - duplicate.watchSeconds;
      if (delta > 0) {
        await scoped
          .update(deviceProfile)
          .set({
            totalWatchSeconds: sql`${deviceProfile.totalWatchSeconds} + ${delta}`,
            lastSeenAt: now,
          })
          .where(eq(deviceProfile.id, deviceId));
      }
    } else {
      const [inserted] = await scoped
        .insert(watchEvent)
        .values({
          deviceId,
          contentType: payload.content_type,
          contentId: payload.content_id,
          watchSeconds,
          contentSeconds,
          rewatch: payload.rewatch,
          startedAt,
        })
        .returning({ completionRate: watchEvent.completionRate });

      completionRate = Number(inserted?.completionRate ?? 0);

      await scoped
        .update(deviceProfile)
        .set({
          totalWatchSeconds: sql`${deviceProfile.totalWatchSeconds} + ${watchSeconds}`,
          lastSeenAt: now,
        })
        .where(eq(deviceProfile.id, deviceId));
    }

    const [profile] = await scoped
      .select({ genreAffinity: deviceProfile.genreAffinity })
      .from(deviceProfile)
      .where(eq(deviceProfile.id, deviceId))
      .limit(1);

    const signal = signalStrength(
      { completionRate, startedAt, rewatch: payload.rewatch },
      now,
    );

    const genreIds = await genreIdsFor(scoped, payload.content_type, payload.content_id);
    const affinity = applyWatchSignal(profile?.genreAffinity ?? {}, genreIds, signal);

    // Cumulative counts, not a running increment: the number this derives from
    // is small (one device's rows, on an index), and recomputing it means a
    // purge or a de-duplication can never leave the ranking overstating a type.
    const counts = await scoped
      .select({ contentType: watchEvent.contentType, total: sql<number>`count(*)::int` })
      .from(watchEvent)
      .where(eq(watchEvent.deviceId, deviceId))
      .groupBy(watchEvent.contentType);

    await scoped
      .update(deviceProfile)
      .set({
        genreAffinity: affinity,
        topContentTypes: rankContentTypes(
          Object.fromEntries(counts.map((row) => [row.contentType, Number(row.total)])),
        ),
      })
      .where(eq(deviceProfile.id, deviceId));

    // Retention, enforced synchronously because this phase introduces no
    // scheduler. It is a delete on an indexed predicate that matches nothing on
    // all but the first write of each day, so the steady-state cost is an index
    // probe.
    await scoped.execute(
      sql`delete from ${watchEvent} where ${watchEvent.createdAt} < now() - make_interval(days => ${config.WATCH_EVENT_RETENTION_DAYS})`,
    );
  });
}
