import { eq, inArray } from 'drizzle-orm';

import type {
  AssetDto,
  EpisodeCreateInput,
  EpisodeDetailDto,
  EpisodeListItemDto,
  EpisodeUpdateInput,
  PublicationStatus,
  SeasonDto,
  SeriesCreateInput,
  SeriesDetailDto,
  SeriesListItemDto,
  SeriesUpdateInput,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import {
  mediaAsset,
  type Episode,
  type MediaAsset,
  type Season,
  type Series,
} from '../../db/schema';
import { HttpError } from '../../middleware/errorHandler';
import { toAssetDto } from '../assets/assetService';
import * as repo from '../../repositories/seriesRepository';

/**
 * Series, season and episode policy.
 *
 * All row access goes through `seriesRepository`; what lives here is the part
 * that has opinions — which artwork kinds are acceptable, when a delete is
 * allowed, and what a caller is permitted to see.
 *
 * Stream sources and subtitle tracks are *not* handled here. They belong to
 * `streamSourceService` and `subtitleService`, which are already owner-agnostic
 * (both take `{ ownerType, ownerId }`); the episode routes call them directly
 * with `ownerType: 'EPISODE'`. Reimplementing that logic against episodes would
 * mean two copies of the URL-confidentiality rules, which is precisely the bug
 * this arrangement is meant to make impossible.
 */

/** Loads a series row or 404s. Also used to scope the sub-resource routes. */
export async function requireSeries(id: string): Promise<Series> {
  const row = await repo.findSeries(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Series not found');
  return row;
}

/**
 * Loads a season and proves it belongs to `seriesId`.
 *
 * The ownership check answers with the same 404 as a missing row rather than a
 * 403: a caller guessing season ids should not be able to tell "exists, but not
 * yours" from "does not exist".
 */
export async function requireSeason(seriesId: string, seasonId: string): Promise<Season> {
  const row = await repo.findSeason(seasonId);
  if (!row || row.seriesId !== seriesId) {
    throw new HttpError(404, 'NOT_FOUND', 'Season not found');
  }
  return row;
}

/** Same scoping rule one level down: the episode must sit in the named season. */
export async function requireEpisode(
  seriesId: string,
  seasonId: string,
  episodeId: string,
): Promise<Episode> {
  await requireSeason(seriesId, seasonId);

  const row = await repo.findEpisode(episodeId);
  if (!row || row.seasonId !== seasonId) {
    throw new HttpError(404, 'NOT_FOUND', 'Episode not found');
  }
  return row;
}

/**
 * Confirms an artwork id exists and is the kind the field expects.
 *
 * Without the kind check a portrait poster could be set as an episode
 * thumbnail, which the database would accept and every 16:9 layout would then
 * render wrong. Mirrors `assertAssetKind` in movieService.
 */
async function assertAssetKind(
  assetId: string,
  kind: 'POSTER' | 'BACKDROP' | 'THUMBNAIL',
  field: string,
): Promise<void> {
  const [row] = await db
    .select({ kind: mediaAsset.kind })
    .from(mediaAsset)
    .where(eq(mediaAsset.id, assetId))
    .limit(1);

  if (!row) throw new HttpError(400, 'ASSET_NOT_FOUND', `${field} does not reference a known asset`);

  if (row.kind !== kind) {
    throw new HttpError(400, 'ASSET_KIND_MISMATCH', `${field} must reference a ${kind} asset`);
  }
}

/** Fetches artwork rows in one query, keyed by id for assembly into a DTO. */
async function assetsById(ids: (string | null)[]): Promise<Map<string, AssetDto>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  if (unique.length === 0) return new Map();

  const rows = await db.select().from(mediaAsset).where(inArray(mediaAsset.id, unique));

  return new Map(rows.map((row: MediaAsset) => [row.id, toAssetDto(row)]));
}

// --- series ----------------------------------------------------------------

function toSeriesListItem(row: Series, seasonCount: number): SeriesListItemDto {
  return {
    id: row.id,
    titleI18n: row.titleI18n,
    status: row.status,
    seasonCount,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ListSeriesParams {
  status?: PublicationStatus;
  page: number;
  limit: number;
}

export interface ListSeriesResult {
  items: SeriesListItemDto[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export async function listSeries(params: ListSeriesParams): Promise<ListSeriesResult> {
  const { rows, total, seasonCounts } = await repo.listSeriesPage(params);
  const offset = (params.page - 1) * params.limit;

  return {
    items: rows.map((row) => toSeriesListItem(row, seasonCounts.get(row.id) ?? 0)),
    total,
    page: params.page,
    limit: params.limit,
    hasMore: offset + rows.length < total,
  };
}

/** Seasons with their episode tallies, ascending by number. */
async function seasonsForSeries(seriesId: string): Promise<SeasonDto[]> {
  const rows = await repo.listSeasons(seriesId);
  const counts = await repo.countEpisodesBySeason(rows.map((row) => row.id));

  return rows.map((row) => {
    const tally = counts.get(row.id);
    return {
      id: row.id,
      number: row.number,
      episodeCount: tally?.total ?? 0,
      publishedEpisodeCount: tally?.published ?? 0,
    };
  });
}

async function toSeriesDetail(row: Series): Promise<SeriesDetailDto> {
  const [assets, seasons] = await Promise.all([
    assetsById([row.posterAssetId, row.backdropAssetId]),
    seasonsForSeries(row.id),
  ]);

  return {
    id: row.id,
    titleI18n: row.titleI18n,
    overviewI18n: row.overviewI18n,
    poster: row.posterAssetId ? (assets.get(row.posterAssetId) ?? null) : null,
    backdrop: row.backdropAssetId ? (assets.get(row.backdropAssetId) ?? null) : null,
    seasons,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getSeriesDetail(id: string): Promise<SeriesDetailDto> {
  return toSeriesDetail(await requireSeries(id));
}

export async function createSeries(input: SeriesCreateInput): Promise<SeriesDetailDto> {
  if (input.poster_asset_id) {
    await assertAssetKind(input.poster_asset_id, 'POSTER', 'poster_asset_id');
  }
  if (input.backdrop_asset_id) {
    await assertAssetKind(input.backdrop_asset_id, 'BACKDROP', 'backdrop_asset_id');
  }

  const created = await repo.insertSeries({
    titleI18n: input.title_i18n,
    overviewI18n: input.overview_i18n,
    posterAssetId: input.poster_asset_id ?? null,
    backdropAssetId: input.backdrop_asset_id ?? null,
  });

  if (!created) throw new HttpError(500, 'INTERNAL_ERROR', 'Failed to create series');

  return toSeriesDetail(created);
}

export async function updateSeries(
  id: string,
  input: SeriesUpdateInput,
): Promise<SeriesDetailDto> {
  await requireSeries(id);

  if (input.poster_asset_id) {
    await assertAssetKind(input.poster_asset_id, 'POSTER', 'poster_asset_id');
  }
  if (input.backdrop_asset_id) {
    await assertAssetKind(input.backdrop_asset_id, 'BACKDROP', 'backdrop_asset_id');
  }

  // `null` clears a field, `undefined` leaves it alone — so each key is only
  // included when the client actually sent it.
  const updated = await repo.updateSeriesRow(id, {
    ...(input.title_i18n !== undefined && { titleI18n: input.title_i18n }),
    ...(input.overview_i18n !== undefined && { overviewI18n: input.overview_i18n }),
    ...(input.poster_asset_id !== undefined && { posterAssetId: input.poster_asset_id ?? null }),
    ...(input.backdrop_asset_id !== undefined && {
      backdropAssetId: input.backdrop_asset_id ?? null,
    }),
  });

  if (!updated) throw new HttpError(404, 'NOT_FOUND', 'Series not found');

  return toSeriesDetail(updated);
}

/**
 * Deletes a series.
 *
 * Two guards, both narrower than the season rule below. A series must be a
 * DRAFT, and it must have no seasons at all — not merely no published ones.
 * Removing a show is a bigger action than removing one of its seasons, so it is
 * deliberately only possible on something that was never built out; anything
 * else has to be dismantled a season at a time, where the published-episode
 * check applies.
 */
export async function deleteSeries(id: string): Promise<void> {
  const row = await requireSeries(id);

  if (row.status !== 'DRAFT') {
    throw new HttpError(409, 'SERIES_NOT_DRAFT', 'Only a DRAFT series can be deleted');
  }

  const seasons = await repo.listSeasons(id);
  if (seasons.length > 0) {
    throw new HttpError(
      409,
      'SERIES_HAS_SEASONS',
      'Delete this series’ seasons before deleting the series',
    );
  }

  await repo.deleteSeriesRow(id);
}

// --- seasons ---------------------------------------------------------------

export async function listSeasonsForSeries(seriesId: string): Promise<SeasonDto[]> {
  await requireSeries(seriesId);
  return seasonsForSeries(seriesId);
}

export async function createSeason(seriesId: string, number: number): Promise<SeasonDto> {
  await requireSeries(seriesId);

  // Checked here for the readable error, and enforced by the
  // `season_series_number_key` unique index for the concurrent case — two
  // parallel creates both pass this check, and only one survives the insert.
  const existing = await repo.listSeasons(seriesId);
  if (existing.some((row) => row.number === number)) {
    throw new HttpError(409, 'SEASON_EXISTS', `Season ${number} already exists for this series`);
  }

  let created;
  try {
    created = await repo.insertSeason(seriesId, number);
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      throw new HttpError(409, 'SEASON_EXISTS', `Season ${number} already exists for this series`);
    }
    throw cause;
  }

  if (!created) throw new HttpError(500, 'INTERNAL_ERROR', 'Failed to create season');

  return { id: created.id, number: created.number, episodeCount: 0, publishedEpisodeCount: 0 };
}

/**
 * Deletes a season and every episode in it.
 *
 * Decision, deliberate: a season whose episodes are all DRAFT is removed
 * outright, taking those episodes and their stream sources and subtitle tracks
 * with it. A season holding even one PUBLISHED episode is refused.
 *
 * The asymmetry is about what is visible to viewers. Draft episodes have never
 * been reachable, so deleting them destroys only unshipped work. A published
 * episode may be in someone's continue-watching list right now, and cascading
 * it away from a season-level click is far too easy an accident — unpublishing
 * is the reversible action, and Phase 8 is where that lives. Until then the
 * operator has to make the intent explicit episode by episode.
 */
export async function deleteSeason(seriesId: string, seasonId: string): Promise<void> {
  await requireSeason(seriesId, seasonId);

  const counts = await repo.countEpisodesBySeason([seasonId]);
  const published = counts.get(seasonId)?.published ?? 0;

  if (published > 0) {
    throw new HttpError(
      409,
      'SEASON_HAS_PUBLISHED_EPISODES',
      `This season has ${published} published ${
        published === 1 ? 'episode' : 'episodes'
      }. Unpublish them before deleting the season.`,
    );
  }

  const episodeIds = await repo.listEpisodeIdsInSeason(seasonId);
  await repo.deleteSeasonCascade(seasonId, episodeIds);
}

// --- episodes --------------------------------------------------------------

function toEpisodeListItem(row: Episode): EpisodeListItemDto {
  return {
    id: row.id,
    number: row.number,
    titleI18n: row.titleI18n,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listEpisodesForSeason(
  seriesId: string,
  seasonId: string,
): Promise<EpisodeListItemDto[]> {
  await requireSeason(seriesId, seasonId);
  const rows = await repo.listEpisodes(seasonId);
  return rows.map(toEpisodeListItem);
}

async function toEpisodeDetail(row: Episode, seasonRow: Season): Promise<EpisodeDetailDto> {
  const assets = await assetsById([row.thumbnailAssetId]);

  return {
    id: row.id,
    seriesId: seasonRow.seriesId,
    seasonId: row.seasonId,
    seasonNumber: seasonRow.number,
    number: row.number,
    titleI18n: row.titleI18n,
    overviewI18n: row.overviewI18n ?? null,
    thumbnail: row.thumbnailAssetId ? (assets.get(row.thumbnailAssetId) ?? null) : null,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getEpisodeDetail(
  seriesId: string,
  seasonId: string,
  episodeId: string,
): Promise<EpisodeDetailDto> {
  const row = await requireEpisode(seriesId, seasonId, episodeId);
  const seasonRow = await requireSeason(seriesId, seasonId);
  return toEpisodeDetail(row, seasonRow);
}

export async function createEpisode(
  seriesId: string,
  seasonId: string,
  input: EpisodeCreateInput,
): Promise<EpisodeDetailDto> {
  const seasonRow = await requireSeason(seriesId, seasonId);

  if (input.thumbnail_asset_id) {
    await assertAssetKind(input.thumbnail_asset_id, 'THUMBNAIL', 'thumbnail_asset_id');
  }

  let created;
  try {
    created = await repo.insertEpisode({
      seasonId,
      number: input.number,
      titleI18n: input.title_i18n,
      overviewI18n: input.overview_i18n ?? null,
      thumbnailAssetId: input.thumbnail_asset_id ?? null,
    });
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      throw new HttpError(
        409,
        'EPISODE_EXISTS',
        `Episode ${input.number} already exists in this season`,
      );
    }
    throw cause;
  }

  if (!created) throw new HttpError(500, 'INTERNAL_ERROR', 'Failed to create episode');

  return toEpisodeDetail(created, seasonRow);
}

export async function updateEpisode(
  seriesId: string,
  seasonId: string,
  episodeId: string,
  input: EpisodeUpdateInput,
): Promise<EpisodeDetailDto> {
  await requireEpisode(seriesId, seasonId, episodeId);
  const seasonRow = await requireSeason(seriesId, seasonId);

  if (input.thumbnail_asset_id) {
    await assertAssetKind(input.thumbnail_asset_id, 'THUMBNAIL', 'thumbnail_asset_id');
  }

  let updated;
  try {
    updated = await repo.updateEpisodeRow(episodeId, {
      ...(input.number !== undefined && { number: input.number }),
      ...(input.title_i18n !== undefined && { titleI18n: input.title_i18n }),
      ...(input.overview_i18n !== undefined && { overviewI18n: input.overview_i18n ?? null }),
      ...(input.thumbnail_asset_id !== undefined && {
        thumbnailAssetId: input.thumbnail_asset_id ?? null,
      }),
    });
  } catch (cause) {
    // Renumbering onto an occupied slot hits the same unique index as create.
    if (isUniqueViolation(cause)) {
      throw new HttpError(
        409,
        'EPISODE_EXISTS',
        `Episode ${input.number} already exists in this season`,
      );
    }
    throw cause;
  }

  if (!updated) throw new HttpError(404, 'NOT_FOUND', 'Episode not found');

  return toEpisodeDetail(updated, seasonRow);
}

/** Deletes a draft episode together with its sources and subtitle tracks. */
export async function deleteEpisode(
  seriesId: string,
  seasonId: string,
  episodeId: string,
): Promise<void> {
  const row = await requireEpisode(seriesId, seasonId, episodeId);

  if (row.status !== 'DRAFT') {
    throw new HttpError(409, 'EPISODE_NOT_DRAFT', 'Only a DRAFT episode can be deleted');
  }

  await repo.deleteEpisodeCascade(episodeId);
}

/**
 * True for Postgres 23505 (unique_violation).
 *
 * The pre-checks above narrow the window but cannot close it — two concurrent
 * requests both read "free" before either inserts. Translating the constraint
 * error keeps that race a 409 with the same message rather than a 500.
 */
function isUniqueViolation(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: unknown }).code === '23505'
  );
}
