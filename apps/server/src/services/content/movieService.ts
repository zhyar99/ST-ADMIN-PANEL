import { and, count, desc, eq, inArray } from 'drizzle-orm';

import type {
  AssetDto,
  GenreDto,
  MovieCreateInput,
  MovieDetailDto,
  MovieListItemDto,
  MovieUpdateInput,
  PublicationStatus,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import {
  genre,
  mediaAsset,
  movie,
  movieGenre,
  streamSource,
  subtitleTrack,
  type MediaAsset,
  type Movie,
} from '../../db/schema';
import { HttpError } from '../../middleware/errorHandler';
import { toAssetDto } from '../assets/assetService';

/**
 * Movie reads and writes.
 *
 * Nothing here ever selects `stream_source.url`. A movie DTO is assembled from
 * the movie row, its artwork and its genres only — sources are a separate
 * sub-resource with their own, deliberately narrower, responses.
 */

export function toMovieListItem(row: Movie): MovieListItemDto {
  return {
    id: row.id,
    titleI18n: row.titleI18n,
    status: row.status,
    releaseYear: row.releaseYear,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ListMoviesParams {
  status?: PublicationStatus;
  page: number;
  limit: number;
}

export interface ListMoviesResult {
  items: MovieListItemDto[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export async function listMovies(params: ListMoviesParams): Promise<ListMoviesResult> {
  const where = params.status ? eq(movie.status, params.status) : undefined;
  const offset = (params.page - 1) * params.limit;

  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(movie)
      .where(where)
      .orderBy(desc(movie.createdAt), desc(movie.id))
      .limit(params.limit)
      .offset(offset),
    db.select({ value: count() }).from(movie).where(where),
  ]);

  const total = totals?.value ?? 0;

  return {
    items: rows.map(toMovieListItem),
    total,
    page: params.page,
    limit: params.limit,
    hasMore: offset + rows.length < total,
  };
}

/** Loads the genres attached to a movie, English name first. */
async function genresForMovie(movieId: string): Promise<GenreDto[]> {
  const rows = await db
    .select({ id: genre.id, nameI18n: genre.nameI18n })
    .from(movieGenre)
    .innerJoin(genre, eq(genre.id, movieGenre.genreId))
    .where(eq(movieGenre.movieId, movieId));

  return rows
    .map((row) => ({ id: row.id, nameI18n: row.nameI18n }))
    .sort((a, b) => a.nameI18n.en.localeCompare(b.nameI18n.en));
}

/** Fetches both artwork rows in one query, keyed by id. */
async function assetsById(ids: string[]): Promise<Map<string, AssetDto>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();

  const rows = await db.select().from(mediaAsset).where(inArray(mediaAsset.id, unique));

  return new Map(rows.map((row: MediaAsset) => [row.id, toAssetDto(row)]));
}

async function toMovieDetail(row: Movie): Promise<MovieDetailDto> {
  const artworkIds = [row.posterAssetId, row.backdropAssetId].filter(
    (id): id is string => id !== null,
  );

  const [assets, genres] = await Promise.all([assetsById(artworkIds), genresForMovie(row.id)]);

  return {
    id: row.id,
    titleI18n: row.titleI18n,
    overviewI18n: row.overviewI18n,
    taglineI18n: row.taglineI18n ?? null,
    releaseYear: row.releaseYear,
    runtimeMinutes: row.runtimeMinutes,
    poster: row.posterAssetId ? (assets.get(row.posterAssetId) ?? null) : null,
    backdrop: row.backdropAssetId ? (assets.get(row.backdropAssetId) ?? null) : null,
    genres,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Loads a movie row or 404s. Used by the sub-resource routes to scope by owner. */
export async function requireMovie(id: string): Promise<Movie> {
  const [row] = await db.select().from(movie).where(eq(movie.id, id)).limit(1);

  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Movie not found');

  return row;
}

export async function getMovieDetail(id: string): Promise<MovieDetailDto> {
  return toMovieDetail(await requireMovie(id));
}

/**
 * Confirms an artwork id exists and is the kind the field expects.
 *
 * Without the kind check a portrait poster could be set as a backdrop, which
 * the database would happily accept and every consumer layout would render
 * wrong.
 */
async function assertAssetKind(
  assetId: string,
  kind: 'POSTER' | 'BACKDROP',
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

/** Rejects genre ids that do not exist, naming how many were bad. */
async function assertGenresExist(genreIds: string[]): Promise<void> {
  if (genreIds.length === 0) return;

  const unique = [...new Set(genreIds)];
  const rows = await db.select({ id: genre.id }).from(genre).where(inArray(genre.id, unique));

  if (rows.length !== unique.length) {
    throw new HttpError(400, 'GENRE_NOT_FOUND', 'One or more genre ids do not exist');
  }
}

/** Replaces a movie's genre set. Called inside the create/update transaction. */
async function setGenres(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  movieId: string,
  genreIds: string[],
): Promise<void> {
  await tx.delete(movieGenre).where(eq(movieGenre.movieId, movieId));

  const unique = [...new Set(genreIds)];
  if (unique.length === 0) return;

  await tx.insert(movieGenre).values(unique.map((genreId) => ({ movieId, genreId })));
}

export async function createMovie(input: MovieCreateInput): Promise<MovieDetailDto> {
  if (input.poster_asset_id) await assertAssetKind(input.poster_asset_id, 'POSTER', 'poster_asset_id');
  if (input.backdrop_asset_id) {
    await assertAssetKind(input.backdrop_asset_id, 'BACKDROP', 'backdrop_asset_id');
  }
  await assertGenresExist(input.genre_ids ?? []);

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(movie)
      .values({
        titleI18n: input.title_i18n,
        overviewI18n: input.overview_i18n,
        taglineI18n: input.tagline_i18n ?? null,
        releaseYear: input.release_year ?? null,
        runtimeMinutes: input.runtime_minutes ?? null,
        posterAssetId: input.poster_asset_id ?? null,
        backdropAssetId: input.backdrop_asset_id ?? null,
        // Status is not settable on create: everything starts as a draft and
        // publishing is Phase 8.
      })
      .returning();

    if (!row) throw new HttpError(500, 'INTERNAL_ERROR', 'Failed to create movie');

    if (input.genre_ids) await setGenres(tx, row.id, input.genre_ids);

    return row;
  });

  return toMovieDetail(created);
}

export async function updateMovie(id: string, input: MovieUpdateInput): Promise<MovieDetailDto> {
  await requireMovie(id);

  if (input.poster_asset_id) await assertAssetKind(input.poster_asset_id, 'POSTER', 'poster_asset_id');
  if (input.backdrop_asset_id) {
    await assertAssetKind(input.backdrop_asset_id, 'BACKDROP', 'backdrop_asset_id');
  }
  if (input.genre_ids) await assertGenresExist(input.genre_ids);

  const updated = await db.transaction(async (tx) => {
    // `null` clears a field, `undefined` leaves it alone — so each key is only
    // included when the client actually sent it.
    const [row] = await tx
      .update(movie)
      .set({
        ...(input.title_i18n !== undefined && { titleI18n: input.title_i18n }),
        ...(input.overview_i18n !== undefined && { overviewI18n: input.overview_i18n }),
        ...(input.tagline_i18n !== undefined && { taglineI18n: input.tagline_i18n ?? null }),
        ...(input.release_year !== undefined && { releaseYear: input.release_year ?? null }),
        ...(input.runtime_minutes !== undefined && { runtimeMinutes: input.runtime_minutes ?? null }),
        ...(input.poster_asset_id !== undefined && {
          posterAssetId: input.poster_asset_id ?? null,
        }),
        ...(input.backdrop_asset_id !== undefined && {
          backdropAssetId: input.backdrop_asset_id ?? null,
        }),
        updatedAt: new Date(),
      })
      .where(eq(movie.id, id))
      .returning();

    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Movie not found');

    if (input.genre_ids !== undefined) await setGenres(tx, id, input.genre_ids);

    return row;
  });

  return toMovieDetail(updated);
}

/**
 * Deletes a draft movie and everything hanging off it.
 *
 * `movie_genre` cascades via its foreign key, but `stream_source` and
 * `subtitle_track` are polymorphic — no FK can cascade them — so they are
 * removed explicitly in the same transaction. Missing that would leave orphan
 * rows carrying live stream URLs.
 */
export async function deleteMovie(id: string): Promise<void> {
  const row = await requireMovie(id);

  if (row.status !== 'DRAFT') {
    throw new HttpError(409, 'MOVIE_NOT_DRAFT', 'Only a DRAFT movie can be deleted');
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(streamSource)
      .where(and(eq(streamSource.ownerType, 'MOVIE'), eq(streamSource.ownerId, id)));

    await tx
      .delete(subtitleTrack)
      .where(and(eq(subtitleTrack.ownerType, 'MOVIE'), eq(subtitleTrack.ownerId, id)));

    await tx.delete(movie).where(eq(movie.id, id));
  });
}
