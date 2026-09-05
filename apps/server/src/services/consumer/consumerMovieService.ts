import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type {
  GenreRef,
  LocalizedText,
  MovieDetail,
  MovieListItem,
  PaginatedResponse,
  PartialLocalizedText,
  SupportedLocale,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import { mediaAsset, movie, movieGenre } from '../../db/schema';
import { assetUrl } from '../../lib/assetUrl';
import { localizeField, localizeOptionalField } from '../../lib/i18n';
import { HttpError } from '../../middleware/errorHandler';
import { genresForMovies, subtitleTracksForOne } from './consumerShared';

/**
 * Consumer movie reads.
 *
 * Two rules hold over every query in this file, and they are what separate it
 * from `movieService`, which serves the same table to the Admin SPA:
 *
 *  1. `status = 'PUBLISHED'` is not a filter the caller supplies — it is welded
 *     into every WHERE clause, so no parameter exists that could widen it to
 *     drafts.
 *  2. Nothing here touches `stream_source`. A movie DTO is assembled from the
 *     movie row, its artwork, its genres and its subtitle tracks; the playable
 *     URL is `playbackService`'s business alone.
 */

const poster = alias(mediaAsset, 'poster_asset');
const backdrop = alias(mediaAsset, 'backdrop_asset');

/**
 * The column list every movie read shares.
 *
 * Written out rather than `select()`ing the row: a column added to `movie`
 * later then has to be named here to reach a response, instead of appearing in
 * one by default.
 */
const movieColumns = {
  id: movie.id,
  titleI18n: movie.titleI18n,
  overviewI18n: movie.overviewI18n,
  taglineI18n: movie.taglineI18n,
  releaseYear: movie.releaseYear,
  runtimeMinutes: movie.runtimeMinutes,
  posterPath: poster.filePath,
  backdropPath: backdrop.filePath,
};

interface MovieRow {
  id: string;
  titleI18n: LocalizedText;
  overviewI18n: LocalizedText;
  taglineI18n: PartialLocalizedText | null;
  releaseYear: number | null;
  runtimeMinutes: number | null;
  posterPath: string | null;
  backdropPath: string | null;
}

function toListItem(row: MovieRow, lang: SupportedLocale, genres: GenreRef[]): MovieListItem {
  return {
    id: row.id,
    title: localizeField(row.titleI18n, lang),
    overview: localizeField(row.overviewI18n, lang),
    releaseYear: row.releaseYear,
    runtimeMinutes: row.runtimeMinutes,
    posterUrl: assetUrl(row.posterPath),
    backdropUrl: assetUrl(row.backdropPath),
    genres,
  };
}

export interface ListMoviesParams {
  page: number;
  limit: number;
  genreId?: string;
  lang: SupportedLocale;
}

export async function listPublishedMovies(
  params: ListMoviesParams,
): Promise<PaginatedResponse<MovieListItem>> {
  const filters = [eq(movie.status, 'PUBLISHED')];

  if (params.genreId) {
    // A subquery rather than a join to `movie_genre`: the join works today
    // because one genre yields at most one row per movie, but it would make
    // LIMIT and COUNT() silently wrong the day the filter accepts a second one.
    filters.push(
      inArray(
        movie.id,
        db
          .select({ id: movieGenre.movieId })
          .from(movieGenre)
          .where(eq(movieGenre.genreId, params.genreId)),
      ),
    );
  }

  const where = and(...filters);
  const offset = (params.page - 1) * params.limit;

  const [rows, [totals]] = await Promise.all([
    db
      .select(movieColumns)
      .from(movie)
      .leftJoin(poster, eq(poster.id, movie.posterAssetId))
      .leftJoin(backdrop, eq(backdrop.id, movie.backdropAssetId))
      .where(where)
      .orderBy(desc(movie.createdAt), desc(movie.id))
      .limit(params.limit)
      .offset(offset),
    db.select({ value: count() }).from(movie).where(where),
  ]);

  const genresByMovie = await genresForMovies(
    rows.map((row) => row.id),
    params.lang,
  );

  return {
    data: rows.map((row) => toListItem(row, params.lang, genresByMovie.get(row.id) ?? [])),
    meta: { page: params.page, limit: params.limit, total: totals?.value ?? 0 },
  };
}

/**
 * One published movie in full.
 *
 * A draft or unpublished movie 404s rather than 403s: that an unreleased title
 * exists at all is itself editorial information, and a distinguishable error
 * would let anyone walk the id space to find out what is coming.
 */
export async function getPublishedMovie(id: string, lang: SupportedLocale): Promise<MovieDetail> {
  const [row] = await db
    .select(movieColumns)
    .from(movie)
    .leftJoin(poster, eq(poster.id, movie.posterAssetId))
    .leftJoin(backdrop, eq(backdrop.id, movie.backdropAssetId))
    .where(and(eq(movie.id, id), eq(movie.status, 'PUBLISHED')))
    .limit(1);

  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Movie not found');

  const [genresByMovie, subtitleTracks] = await Promise.all([
    genresForMovies([row.id], lang),
    subtitleTracksForOne('MOVIE', row.id),
  ]);

  return {
    ...toListItem(row, lang, genresByMovie.get(row.id) ?? []),
    tagline: localizeOptionalField(row.taglineI18n, lang),
    subtitleTracks,
  };
}
