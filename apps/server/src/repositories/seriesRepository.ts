import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';

import type { PublicationStatus } from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../db/client';
import {
  episode,
  season,
  series,
  streamSource,
  subtitleTrack,
  type Episode,
  type Season,
  type Series,
} from '../db/schema';

/**
 * Every `series` / `season` / `episode` row access in one place.
 *
 * This is the only file in the phase that talks to Drizzle about these three
 * tables. Nothing here validates, authorises or throws HTTP errors — it returns
 * rows and counts, or `undefined` when something is absent, and lets
 * `seriesService` decide what that means. Keeping the split strict is what
 * makes the service readable as pure policy.
 *
 * Note the deliberate omission: no function here selects `stream_source.url`.
 * Sources reach a series through `streamSourceService`, which owns that column.
 */

/** A Drizzle transaction handle, as handed to a `db.transaction` callback. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// --- series ----------------------------------------------------------------

export interface ListSeriesParams {
  status?: PublicationStatus;
  page: number;
  limit: number;
}

/**
 * One page of series, plus the total matching the same filter.
 *
 * The season counts are fetched in a single grouped query rather than per row:
 * the list is capped at 100 rows, but 100 extra round trips to render a number
 * is exactly the N+1 the DTO's `seasonCount` exists to avoid.
 */
export async function listSeriesPage(
  params: ListSeriesParams,
): Promise<{ rows: Series[]; total: number; seasonCounts: Map<string, number> }> {
  const where = params.status ? eq(series.status, params.status) : undefined;
  const offset = (params.page - 1) * params.limit;

  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(series)
      .where(where)
      // `id` breaks ties so a page boundary cannot show the same row twice when
      // two series were created in the same millisecond.
      .orderBy(desc(series.createdAt), desc(series.id))
      .limit(params.limit)
      .offset(offset),
    db.select({ value: count() }).from(series).where(where),
  ]);

  const seasonCounts = await countSeasonsBySeries(rows.map((row) => row.id));

  return { rows, total: totals?.value ?? 0, seasonCounts };
}

async function countSeasonsBySeries(seriesIds: string[]): Promise<Map<string, number>> {
  if (seriesIds.length === 0) return new Map();

  const rows = await db
    .select({ seriesId: season.seriesId, value: count() })
    .from(season)
    .where(inArray(season.seriesId, seriesIds))
    .groupBy(season.seriesId);

  return new Map(rows.map((row) => [row.seriesId, row.value]));
}

export async function findSeries(id: string): Promise<Series | undefined> {
  const [row] = await db.select().from(series).where(eq(series.id, id)).limit(1);
  return row;
}

export async function insertSeries(values: {
  titleI18n: Series['titleI18n'];
  overviewI18n: Series['overviewI18n'];
  posterAssetId: string | null;
  backdropAssetId: string | null;
}): Promise<Series | undefined> {
  // `status` is not settable here: everything starts as a draft and publishing
  // is Phase 8. Matches how `createMovie` inserts.
  const [row] = await db.insert(series).values(values).returning();
  return row;
}

/**
 * Patches a series. Callers pass only the keys the client actually sent, so an
 * absent key leaves the column alone and an explicit `null` clears it.
 */
export async function updateSeriesRow(
  id: string,
  values: Partial<Pick<Series, 'titleI18n' | 'overviewI18n' | 'posterAssetId' | 'backdropAssetId'>>,
): Promise<Series | undefined> {
  const [row] = await db
    .update(series)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(series.id, id))
    .returning();

  return row;
}

/** Seasons cascade via their foreign key, so only the parent row is deleted. */
export async function deleteSeriesRow(id: string): Promise<void> {
  await db.delete(series).where(eq(series.id, id));
}

// --- seasons ---------------------------------------------------------------

export async function listSeasons(seriesId: string): Promise<Season[]> {
  return db.select().from(season).where(eq(season.seriesId, seriesId)).orderBy(asc(season.number));
}

export async function findSeason(seasonId: string): Promise<Season | undefined> {
  const [row] = await db.select().from(season).where(eq(season.id, seasonId)).limit(1);
  return row;
}

export async function insertSeason(
  seriesId: string,
  number: number,
): Promise<Season | undefined> {
  const [row] = await db.insert(season).values({ seriesId, number }).returning();
  return row;
}

/**
 * Total and published episode counts per season, in one grouped query.
 *
 * `publishedCount` is a filtered aggregate rather than a second query because
 * both numbers feed the same DTO, and the season-delete guard needs the
 * published figure to be consistent with the total it was read alongside.
 */
export async function countEpisodesBySeason(
  seasonIds: string[],
): Promise<Map<string, { total: number; published: number }>> {
  if (seasonIds.length === 0) return new Map();

  const rows = await db
    .select({
      seasonId: episode.seasonId,
      total: count(),
      published: sql<number>`count(*) filter (where ${episode.status} = 'PUBLISHED')`.mapWith(
        Number,
      ),
    })
    .from(episode)
    .where(inArray(episode.seasonId, seasonIds))
    .groupBy(episode.seasonId);

  return new Map(rows.map((row) => [row.seasonId, { total: row.total, published: row.published }]));
}

/** Ids of every episode in a season, for the cascade delete's cleanup. */
export async function listEpisodeIdsInSeason(seasonId: string): Promise<string[]> {
  const rows = await db
    .select({ id: episode.id })
    .from(episode)
    .where(eq(episode.seasonId, seasonId));

  return rows.map((row) => row.id);
}

/**
 * Drops a season and its episodes.
 *
 * `episode` cascades from the foreign key, but `stream_source` and
 * `subtitle_track` are polymorphic — no FK can reach them — so they are cleared
 * explicitly in the same transaction. Missing that would leave orphaned rows
 * still carrying live stream URLs, which is the one outcome this whole
 * URL-confidentiality design exists to prevent.
 */
export async function deleteSeasonCascade(
  seasonId: string,
  episodeIds: string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await deleteEpisodeAttachments(tx, episodeIds);
    await tx.delete(season).where(eq(season.id, seasonId));
  });
}

/** Removes the polymorphic rows hanging off a set of episodes. */
async function deleteEpisodeAttachments(tx: Tx, episodeIds: string[]): Promise<void> {
  if (episodeIds.length === 0) return;

  await tx
    .delete(streamSource)
    .where(and(eq(streamSource.ownerType, 'EPISODE'), inArray(streamSource.ownerId, episodeIds)));

  await tx
    .delete(subtitleTrack)
    .where(and(eq(subtitleTrack.ownerType, 'EPISODE'), inArray(subtitleTrack.ownerId, episodeIds)));
}

// --- episodes --------------------------------------------------------------

export async function listEpisodes(seasonId: string): Promise<Episode[]> {
  return db
    .select()
    .from(episode)
    .where(eq(episode.seasonId, seasonId))
    .orderBy(asc(episode.number));
}

export async function findEpisode(episodeId: string): Promise<Episode | undefined> {
  const [row] = await db.select().from(episode).where(eq(episode.id, episodeId)).limit(1);
  return row;
}

export async function insertEpisode(values: {
  seasonId: string;
  number: number;
  titleI18n: Episode['titleI18n'];
  overviewI18n: Episode['overviewI18n'];
  thumbnailAssetId: string | null;
}): Promise<Episode | undefined> {
  const [row] = await db.insert(episode).values(values).returning();
  return row;
}

export async function updateEpisodeRow(
  episodeId: string,
  values: Partial<
    Pick<Episode, 'number' | 'titleI18n' | 'overviewI18n' | 'thumbnailAssetId'>
  >,
): Promise<Episode | undefined> {
  const [row] = await db
    .update(episode)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(episode.id, episodeId))
    .returning();

  return row;
}

/** Deletes one episode along with its sources and subtitle tracks. */
export async function deleteEpisodeCascade(episodeId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await deleteEpisodeAttachments(tx, [episodeId]);
    await tx.delete(episode).where(eq(episode.id, episodeId));
  });
}
