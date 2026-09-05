import { and, desc, eq, sql } from 'drizzle-orm';

import type {
  DeviceContentItem,
  DeviceContentType,
  DeviceHistoryItem,
  DeviceListResponse,
  SupportedLocale,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import { deviceFavorite, deviceWatchlist, watchEvent } from '../../db/schema';
import { assetUrl } from '../../lib/assetUrl';
import { localizeField } from '../../lib/i18n';
import { decodeCursor, encodeCursor } from './ranking';
import { resolveContentSummaries, summaryKey, type SummaryContentType } from './contentSummaries';

/**
 * A device's own lists: favourites, watchlist and watch history (Phase 15).
 *
 * Every function here takes the device id as its first argument and filters on
 * it unconditionally. That is the whole access-control story for this surface:
 * there is no authentication to check, so the only thing standing between one
 * device's history and another's is that the id comes from the request header
 * and is never read from a body or a query parameter. No caller may pass one in.
 */

/** Favourites and watchlist share a table shape, so they share a reader. */
type ListTable = typeof deviceFavorite | typeof deviceWatchlist;

interface ListOptions {
  contentType?: DeviceContentType;
  limit: number;
  cursor?: string;
  lang: SupportedLocale;
}

async function listRefs(
  table: ListTable,
  deviceId: string,
  options: ListOptions,
): Promise<DeviceListResponse<DeviceContentItem>> {
  const offset = decodeCursor(options.cursor);

  const where = options.contentType
    ? and(eq(table.deviceId, deviceId), eq(table.contentType, options.contentType))
    : eq(table.deviceId, deviceId);

  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(table)
    .where(where);

  const rows = await db
    .select({
      contentType: table.contentType,
      contentId: table.contentId,
      addedAt: table.addedAt,
    })
    .from(table)
    .where(where)
    .orderBy(desc(table.addedAt), desc(table.contentId))
    .limit(options.limit)
    .offset(offset);

  const summaries = await resolveContentSummaries(
    rows.map((row) => ({ contentType: row.contentType, contentId: row.contentId })),
  );

  const items: DeviceContentItem[] = [];

  for (const row of rows) {
    const summary = summaries.get(summaryKey(row.contentType, row.contentId));
    // Unresolvable means unpublished or deleted. The row stays — the device
    // asked for it and may see it again if it is republished — but it is not
    // rendered, because a draft title is not the consumer surface's to reveal.
    if (!summary) continue;

    items.push({
      content_type: row.contentType,
      content_id: row.contentId,
      title: localizeField(summary.titleI18n, options.lang),
      poster_url: assetUrl(summary.posterPath),
      added_at: row.addedAt.toISOString(),
    });
  }

  const nextCursor = offset + rows.length < Number(total) ? encodeCursor(offset + rows.length) : null;

  return { items, next_cursor: nextCursor, total_available: Number(total) };
}

export function listFavorites(
  deviceId: string,
  options: ListOptions,
): Promise<DeviceListResponse<DeviceContentItem>> {
  return listRefs(deviceFavorite, deviceId, options);
}

export function listWatchlist(
  deviceId: string,
  options: ListOptions,
): Promise<DeviceListResponse<DeviceContentItem>> {
  return listRefs(deviceWatchlist, deviceId, options);
}

/**
 * Adds an entry, idempotently.
 *
 * The composite primary key is what makes a double-tap a no-op rather than a
 * duplicate, so the endpoint can answer 201 either way and the client needs no
 * "already added" branch.
 */
export async function addToList(
  table: ListTable,
  deviceId: string,
  contentType: DeviceContentType,
  contentId: string,
): Promise<void> {
  await db.insert(table).values({ deviceId, contentType, contentId }).onConflictDoNothing();
}

export async function removeFromList(
  table: ListTable,
  deviceId: string,
  contentType: DeviceContentType,
  contentId: string,
): Promise<void> {
  await db
    .delete(table)
    .where(
      and(
        eq(table.deviceId, deviceId),
        eq(table.contentType, contentType),
        eq(table.contentId, contentId),
      ),
    );
}

export { deviceFavorite as favoriteTable, deviceWatchlist as watchlistTable };

/**
 * A device's watch history, newest first.
 *
 * Carries seconds and completion rates and never a stream URL — the history is
 * a record of what was watched, not a way to watch it again without going
 * through the playback session endpoint.
 */
export async function listHistory(
  deviceId: string,
  options: { limit: number; cursor?: string; lang: SupportedLocale },
): Promise<DeviceListResponse<DeviceHistoryItem>> {
  const offset = decodeCursor(options.cursor);

  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(watchEvent)
    .where(eq(watchEvent.deviceId, deviceId));

  const rows = await db
    .select({
      contentType: watchEvent.contentType,
      contentId: watchEvent.contentId,
      watchSeconds: watchEvent.watchSeconds,
      contentSeconds: watchEvent.contentSeconds,
      completionRate: watchEvent.completionRate,
      startedAt: watchEvent.startedAt,
    })
    .from(watchEvent)
    .where(eq(watchEvent.deviceId, deviceId))
    .orderBy(desc(watchEvent.startedAt))
    .limit(options.limit)
    .offset(offset);

  const summaries = await resolveContentSummaries(
    rows.map((row) => ({
      contentType: row.contentType as SummaryContentType,
      contentId: row.contentId,
    })),
  );

  const items: DeviceHistoryItem[] = [];

  for (const row of rows) {
    const summary = summaries.get(summaryKey(row.contentType, row.contentId));
    if (!summary) continue;

    items.push({
      content_type: row.contentType,
      content_id: row.contentId,
      title: localizeField(summary.titleI18n, options.lang),
      poster_url: assetUrl(summary.posterPath),
      watch_seconds: row.watchSeconds,
      content_seconds: row.contentSeconds,
      completion_rate: Number(row.completionRate ?? 0),
      started_at: row.startedAt.toISOString(),
    });
  }

  const nextCursor = offset + rows.length < Number(total) ? encodeCursor(offset + rows.length) : null;

  return { items, next_cursor: nextCursor, total_available: Number(total) };
}
