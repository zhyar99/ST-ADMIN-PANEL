import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type {
  EpisodeDetail,
  LocalizedText,
  PaginatedResponse,
  Season,
  SeriesDetail,
  SeriesListItem,
  SupportedLocale,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import { episode, mediaAsset, season, series } from '../../db/schema';
import { assetUrl } from '../../lib/assetUrl';
import { localizeField, localizeOptionalField } from '../../lib/i18n';
import { HttpError } from '../../middleware/errorHandler';
import { subtitleTracksFor } from './consumerShared';

/**
 * Consumer series reads. Same two rules as `consumerMovieService`: PUBLISHED is
 * welded into every WHERE clause, and nothing here reads `stream_source`.
 *
 * The publication check runs at both levels independently. A published series
 * shows only its published episodes, so pulling one episode back to draft hides
 * that episode without taking the whole show off the shelf.
 */

const poster = alias(mediaAsset, 'poster_asset');
const backdrop = alias(mediaAsset, 'backdrop_asset');
const thumbnail = alias(mediaAsset, 'thumbnail_asset');

const seriesColumns = {
  id: series.id,
  titleI18n: series.titleI18n,
  overviewI18n: series.overviewI18n,
  posterPath: poster.filePath,
  backdropPath: backdrop.filePath,
};

interface SeriesRow {
  id: string;
  titleI18n: LocalizedText;
  overviewI18n: LocalizedText;
  posterPath: string | null;
  backdropPath: string | null;
}

function toListItem(row: SeriesRow, lang: SupportedLocale): SeriesListItem {
  return {
    id: row.id,
    title: localizeField(row.titleI18n, lang),
    overview: localizeField(row.overviewI18n, lang),
    posterUrl: assetUrl(row.posterPath),
    backdropUrl: assetUrl(row.backdropPath),
    // No series-to-genre relation exists — see the note on `SeriesListItem`.
    genres: [],
  };
}

export interface ListSeriesParams {
  page: number;
  limit: number;
  lang: SupportedLocale;
}

export async function listPublishedSeries(
  params: ListSeriesParams,
): Promise<PaginatedResponse<SeriesListItem>> {
  const where = eq(series.status, 'PUBLISHED');
  const offset = (params.page - 1) * params.limit;

  const [rows, [totals]] = await Promise.all([
    db
      .select(seriesColumns)
      .from(series)
      .leftJoin(poster, eq(poster.id, series.posterAssetId))
      .leftJoin(backdrop, eq(backdrop.id, series.backdropAssetId))
      .where(where)
      .orderBy(desc(series.createdAt), desc(series.id))
      .limit(params.limit)
      .offset(offset),
    db.select({ value: count() }).from(series).where(where),
  ]);

  return {
    data: rows.map((row) => toListItem(row, params.lang)),
    meta: { page: params.page, limit: params.limit, total: totals?.value ?? 0 },
  };
}

/**
 * A published series with its seasons and their published episodes.
 *
 * Three queries regardless of how large the show is: the series row, every
 * published episode across all its seasons in one pass, and the subtitle tracks
 * for those episodes in one more. Seasons with nothing published in them are
 * still listed — an empty "Season 3" tells a viewer the show is ongoing, where
 * omitting it suggests it was never made.
 */
export async function getPublishedSeries(
  id: string,
  lang: SupportedLocale,
): Promise<SeriesDetail> {
  const [row] = await db
    .select(seriesColumns)
    .from(series)
    .leftJoin(poster, eq(poster.id, series.posterAssetId))
    .leftJoin(backdrop, eq(backdrop.id, series.backdropAssetId))
    .where(and(eq(series.id, id), eq(series.status, 'PUBLISHED')))
    .limit(1);

  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Series not found');

  const seasonRows = await db
    .select({ id: season.id, number: season.number })
    .from(season)
    .where(eq(season.seriesId, id))
    .orderBy(asc(season.number));

  const seasonIds = seasonRows.map((seasonRow) => seasonRow.id);

  const episodeRows =
    seasonIds.length === 0
      ? []
      : await db
          .select({
            id: episode.id,
            seasonId: episode.seasonId,
            number: episode.number,
            titleI18n: episode.titleI18n,
            overviewI18n: episode.overviewI18n,
            thumbnailPath: thumbnail.filePath,
            status: episode.status,
          })
          .from(episode)
          .leftJoin(thumbnail, eq(thumbnail.id, episode.thumbnailAssetId))
          .where(and(inArray(episode.seasonId, seasonIds), eq(episode.status, 'PUBLISHED')))
          .orderBy(asc(episode.number));

  const tracksByEpisode = await subtitleTracksFor(
    'EPISODE',
    episodeRows.map((episodeRow) => episodeRow.id),
  );

  const episodesBySeason = new Map<string, EpisodeDetail[]>();

  for (const episodeRow of episodeRows) {
    const list = episodesBySeason.get(episodeRow.seasonId) ?? [];
    list.push({
      id: episodeRow.id,
      number: episodeRow.number,
      title: localizeField(episodeRow.titleI18n, lang),
      overview: localizeOptionalField(episodeRow.overviewI18n, lang),
      thumbnailUrl: assetUrl(episodeRow.thumbnailPath),
      subtitleTracks: tracksByEpisode.get(episodeRow.id) ?? [],
      status: episodeRow.status,
    });
    episodesBySeason.set(episodeRow.seasonId, list);
  }

  const seasons: Season[] = seasonRows.map((seasonRow) => ({
    id: seasonRow.id,
    number: seasonRow.number,
    episodes: episodesBySeason.get(seasonRow.id) ?? [],
  }));

  return { ...toListItem(row, lang), seasons };
}
