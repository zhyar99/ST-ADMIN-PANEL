import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';

import type {
  AdminDeviceProfileDTO,
  DeviceAnalyticsOverviewDTO,
  DeviceContentType,
  GenreAffinityEntry,
  LocalizedText,
  SupportedLocale,
  TrendingContentItem,
  WatchContentType,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import {
  deviceFavorite,
  deviceProfile,
  deviceWatchlist,
  genre,
  watchEvent,
} from '../../db/schema';
import { assetUrl } from '../../lib/assetUrl';
import { localizeField } from '../../lib/i18n';
import { HttpError } from '../../middleware/errorHandler';
import { normalizeAffinity } from './affinity';
import { resolveContentSummaries, summaryKey, type SummaryContentType } from './contentSummaries';
import { listHistory } from './deviceListService';

/**
 * Read models for the Admin analytics section (Phase 15).
 *
 * Everything here is a report, not a resource: nothing in this module writes,
 * and every function answers a question an operator asked by opening a page.
 * The aggregates run against `watch_event` directly rather than against a
 * rollup table — this phase adds no scheduler, so there is nothing to maintain
 * one — which is affordable because the retention window bounds the table and
 * every predicate below is on an index.
 */

/** The overview's genre chart is a top-10, and the tile row is a top-10. */
const TOP_GENRE_LIMIT = 10;

/** How many of a device's most recent events the detail page shows. */
const DEVICE_HISTORY_LIMIT = 20;

const SECONDS_PER_HOUR = 3600;

function hours(seconds: number): number {
  return Math.round((seconds / SECONDS_PER_HOUR) * 100) / 100;
}

function since(periodDays: number): Date {
  return new Date(Date.now() - periodDays * 86_400_000);
}

/**
 * Platform-wide device activity for a period.
 *
 * "Active" means seen — `last_seen_at` moves on any request carrying the
 * device's header, not only on a watch event — because the question the tile
 * answers is how many devices are out there using the platform, of which
 * watching is only one kind of use.
 */
export async function getDeviceOverview(
  periodDays: number,
  lang: SupportedLocale,
): Promise<DeviceAnalyticsOverviewDTO> {
  const periodStart = since(periodDays);

  const [totals] = await db
    .select({
      total: count(),
      active: sql<number>`count(*) filter (where ${deviceProfile.lastSeenAt} >= ${periodStart})::int`,
      fresh: sql<number>`count(*) filter (where ${deviceProfile.firstSeenAt} >= ${periodStart})::int`,
    })
    .from(deviceProfile);

  const breakdownRows = await db
    .select({
      contentType: watchEvent.contentType,
      events: sql<number>`count(*)::int`,
      seconds: sql<number>`coalesce(sum(${watchEvent.watchSeconds}), 0)::bigint`,
    })
    .from(watchEvent)
    .where(gte(watchEvent.createdAt, periodStart))
    .groupBy(watchEvent.contentType);

  const breakdown: Record<WatchContentType, number> = {
    MOVIE: 0,
    EPISODE: 0,
    LIVE_CHANNEL: 0,
  };
  let totalSeconds = 0;

  for (const row of breakdownRows) {
    breakdown[row.contentType] = Number(row.events);
    totalSeconds += Number(row.seconds);
  }

  // One device per genre it has any affinity for, which is what the bar chart
  // is counting — not how strong the affinity is, which would need a different
  // chart to be readable.
  const genreRows = await db.execute<{
    genre_id: string;
    devices: string;
    name_i18n: LocalizedText | null;
  }>(sql`
    select entry.key as genre_id,
           count(*)::text as devices,
           g.name_i18n as name_i18n
      from device_profile dp
      cross join lateral jsonb_each_text(dp.genre_affinity) as entry(key, value)
      left join genre g on g.id::text = entry.key
     where entry.value::numeric > 0
     group by entry.key, g.name_i18n
     order by count(*) desc, entry.key asc
     limit ${TOP_GENRE_LIMIT}
  `);

  const activeDevices = Number(totals?.active ?? 0);

  return {
    period_days: periodDays,
    total_devices: Number(totals?.total ?? 0),
    active_devices_in_period: activeDevices,
    new_devices_in_period: Number(totals?.fresh ?? 0),
    total_watch_hours: hours(totalSeconds),
    avg_watch_seconds_per_device:
      activeDevices === 0 ? 0 : Math.round(totalSeconds / activeDevices),
    top_genres: (genreRows.rows ?? []).map((row) => ({
      genre_id: row.genre_id,
      // A genre that has been deleted still has affinity scores pointing at it
      // until every device that liked it watches something else. Labelled
      // rather than dropped, so the count still adds up.
      genre_name: row.name_i18n ? localizeField(row.name_i18n, lang) : 'Removed genre',
      affinity_count: Number(row.devices),
    })),
    content_type_breakdown: breakdown,
  };
}

/**
 * What the platform is watching, ranked by event count.
 *
 * Reported per watched thing — so an episode, not the series it belongs to.
 * Rolling episodes up to their series would answer a different and also useful
 * question, but it would hide the case this table exists to surface: one
 * episode that everybody watches and nine that nobody does.
 */
export async function getTrending(
  periodDays: number,
  options: { contentType?: WatchContentType; limit: number; lang: SupportedLocale },
): Promise<TrendingContentItem[]> {
  const periodStart = since(periodDays);

  const where = options.contentType
    ? and(gte(watchEvent.createdAt, periodStart), eq(watchEvent.contentType, options.contentType))
    : gte(watchEvent.createdAt, periodStart);

  const rows = await db
    .select({
      contentType: watchEvent.contentType,
      contentId: watchEvent.contentId,
      watchCount: sql<number>`count(*)::int`,
      uniqueDevices: sql<number>`count(distinct ${watchEvent.deviceId})::int`,
      avgCompletion: sql<string>`coalesce(avg(${watchEvent.completionRate}), 0)::text`,
      totalSeconds: sql<string>`coalesce(sum(${watchEvent.watchSeconds}), 0)::text`,
    })
    .from(watchEvent)
    .where(where)
    .groupBy(watchEvent.contentType, watchEvent.contentId)
    .orderBy(desc(sql`count(*)`), desc(sql`count(distinct ${watchEvent.deviceId})`))
    .limit(options.limit);

  const summaries = await resolveContentSummaries(
    rows.map((row) => ({
      contentType: row.contentType as SummaryContentType,
      contentId: row.contentId,
    })),
  );

  const items: TrendingContentItem[] = [];

  for (const row of rows) {
    const summary = summaries.get(summaryKey(row.contentType, row.contentId));

    items.push({
      content_type: row.contentType,
      content_id: row.contentId,
      // Unlike the consumer lists, an unresolvable ref is kept and labelled: an
      // operator looking at a trending row for content that has been
      // unpublished needs to see that it happened, not to have the row vanish.
      title: summary ? localizeField(summary.titleI18n, options.lang) : 'Unavailable content',
      poster_url: summary ? assetUrl(summary.posterPath) : null,
      watch_count: Number(row.watchCount),
      unique_devices: Number(row.uniqueDevices),
      avg_completion_rate: Math.round(Number(row.avgCompletion) * 1000) / 1000,
      total_watch_hours: hours(Number(row.totalSeconds)),
    });
  }

  return items;
}

/**
 * One device's full profile, with genre ids resolved to names.
 *
 * ADMIN-only at the route. A device id plus this response is a viewing history,
 * which is the most sensitive thing this system stores about anybody — there is
 * no name attached, but there is a pattern of behaviour, and a VIEWER has no
 * operational reason to read one.
 */
export async function getDeviceDetail(
  deviceId: string,
  lang: SupportedLocale,
): Promise<AdminDeviceProfileDTO> {
  const [profile] = await db
    .select()
    .from(deviceProfile)
    .where(eq(deviceProfile.id, deviceId))
    .limit(1);

  if (!profile) throw new HttpError(404, 'NOT_FOUND', 'No such device');

  const affinity = normalizeAffinity(profile.genreAffinity ?? {});
  const genreIds = Object.keys(affinity);

  const genreNames = new Map<string, LocalizedText>();

  if (genreIds.length > 0) {
    const rows = await db
      .select({ id: genre.id, nameI18n: genre.nameI18n })
      .from(genre)
      .where(inArray(genre.id, genreIds));

    for (const row of rows) genreNames.set(row.id, row.nameI18n);
  }

  const genreAffinity: GenreAffinityEntry[] = Object.entries(affinity)
    .map(([genreId, score]) => ({
      genre_id: genreId,
      genre_name: genreNames.has(genreId)
        ? localizeField(genreNames.get(genreId)!, lang)
        : 'Removed genre',
      score,
    }))
    .sort((a, b) => b.score - a.score || a.genre_name.localeCompare(b.genre_name));

  const [history, [favorites], [watchlist]] = await Promise.all([
    listHistory(deviceId, { limit: DEVICE_HISTORY_LIMIT, lang }),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(deviceFavorite)
      .where(eq(deviceFavorite.deviceId, deviceId)),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(deviceWatchlist)
      .where(eq(deviceWatchlist.deviceId, deviceId)),
  ]);

  return {
    id: profile.id,
    first_seen_at: profile.firstSeenAt.toISOString(),
    last_seen_at: profile.lastSeenAt.toISOString(),
    total_watch_seconds: Number(profile.totalWatchSeconds),
    total_watch_hours: hours(Number(profile.totalWatchSeconds)),
    top_content_types: (profile.topContentTypes ?? []) as DeviceContentType[],
    genre_affinity: genreAffinity,
    is_blocked: profile.isBlocked,
    recent_watch_events: history.items,
    favorites_count: Number(favorites?.total ?? 0),
    watchlist_count: Number(watchlist?.total ?? 0),
  };
}

/** Flips the moderation flag. Returns the new state for the audit trail. */
export async function setDeviceBlocked(deviceId: string, isBlocked: boolean): Promise<void> {
  const updated = await db
    .update(deviceProfile)
    .set({ isBlocked })
    .where(eq(deviceProfile.id, deviceId))
    .returning({ id: deviceProfile.id });

  if (updated.length === 0) throw new HttpError(404, 'NOT_FOUND', 'No such device');
}
