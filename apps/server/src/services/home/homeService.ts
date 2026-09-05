import { and, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type {
  HomeItem,
  HomeItemRef,
  HomeResponse,
  HomeRow as HomeRowResponse,
  SupportedLocale,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import { liveChannel, mediaAsset, movie, series } from '../../db/schema';
import { assetUrl } from '../../lib/assetUrl';
import { localizeField } from '../../lib/i18n';
import { listHomeRows } from '../../repositories/homeRowRepository';

/**
 * Resolves curated Home rows into content for the consumer API.
 *
 * Three rules hold over everything in this file:
 *
 *  1. `status = 'PUBLISHED'` is welded into every WHERE clause. No parameter
 *     widens it, exactly as in `consumerMovieService`.
 *  2. Nothing here touches `stream_source`. A Home card is a title, artwork and
 *     an id; the playable URL is `playbackService`'s business alone.
 *  3. A ref that cannot be resolved is *skipped*, never an error. An operator
 *     unpublishing a movie must not 500 the home page of every client, and a
 *     row that has been emptied that way is dropped rather than rendered as a
 *     heading with nothing under it.
 */

const poster = alias(mediaAsset, 'poster_asset');
const backdrop = alias(mediaAsset, 'backdrop_asset');
const logo = alias(mediaAsset, 'logo_asset');

/**
 * Loads every published item referenced anywhere in the supplied rows.
 *
 * Three queries total, regardless of how many rows or items there are: a Home
 * page with 10 rows of 20 items must not become 200 lookups. The refs are
 * pooled across all rows first for the same reason — the same movie appearing
 * in "New Releases" and "Staff Picks" is fetched once.
 */
async function loadPublished(refs: HomeItemRef[], lang: SupportedLocale) {
  const idsOf = (type: HomeItemRef['type']): string[] => [
    ...new Set(refs.filter((ref) => ref.type === type).map((ref) => ref.id)),
  ];

  const movieIds = idsOf('MOVIE');
  const seriesIds = idsOf('SERIES');
  const channelIds = idsOf('LIVE_CHANNEL');

  const [movieRows, seriesRows, channelRows] = await Promise.all([
    movieIds.length === 0
      ? []
      : db
          .select({
            id: movie.id,
            titleI18n: movie.titleI18n,
            overviewI18n: movie.overviewI18n,
            releaseYear: movie.releaseYear,
            runtimeMinutes: movie.runtimeMinutes,
            posterPath: poster.filePath,
            backdropPath: backdrop.filePath,
          })
          .from(movie)
          .leftJoin(poster, eq(poster.id, movie.posterAssetId))
          .leftJoin(backdrop, eq(backdrop.id, movie.backdropAssetId))
          .where(and(eq(movie.status, 'PUBLISHED'), inArray(movie.id, movieIds))),
    seriesIds.length === 0
      ? []
      : db
          .select({
            id: series.id,
            titleI18n: series.titleI18n,
            overviewI18n: series.overviewI18n,
            posterPath: poster.filePath,
            backdropPath: backdrop.filePath,
          })
          .from(series)
          .leftJoin(poster, eq(poster.id, series.posterAssetId))
          .leftJoin(backdrop, eq(backdrop.id, series.backdropAssetId))
          .where(and(eq(series.status, 'PUBLISHED'), inArray(series.id, seriesIds))),
    channelIds.length === 0
      ? []
      : db
          .select({
            id: liveChannel.id,
            nameI18n: liveChannel.nameI18n,
            category: liveChannel.category,
            logoPath: logo.filePath,
          })
          .from(liveChannel)
          .leftJoin(logo, eq(logo.id, liveChannel.logoAssetId))
          .where(and(eq(liveChannel.status, 'PUBLISHED'), inArray(liveChannel.id, channelIds))),
  ]);

  const items = new Map<string, HomeItem>();

  for (const row of movieRows) {
    items.set(`MOVIE:${row.id}`, {
      type: 'MOVIE',
      id: row.id,
      title: localizeField(row.titleI18n, lang),
      overview: localizeField(row.overviewI18n, lang),
      posterUrl: assetUrl(row.posterPath),
      backdropUrl: assetUrl(row.backdropPath),
      releaseYear: row.releaseYear,
      runtimeMinutes: row.runtimeMinutes,
    });
  }

  for (const row of seriesRows) {
    items.set(`SERIES:${row.id}`, {
      type: 'SERIES',
      id: row.id,
      title: localizeField(row.titleI18n, lang),
      overview: localizeField(row.overviewI18n, lang),
      posterUrl: assetUrl(row.posterPath),
      backdropUrl: assetUrl(row.backdropPath),
    });
  }

  for (const row of channelRows) {
    items.set(`LIVE_CHANNEL:${row.id}`, {
      type: 'LIVE_CHANNEL',
      id: row.id,
      name: localizeField(row.nameI18n, lang),
      logoUrl: assetUrl(row.logoPath),
      category: row.category,
    });
  }

  return items;
}

/**
 * The public Home page: every curated row, in order, resolved.
 *
 * Ordering comes from two independent places and both matter — rows are ordered
 * by the `order` column, and the items inside a row keep the sequence the
 * operator dragged them into, which is the array order of `item_refs`. The
 * lookup map exists so preserving the latter does not cost a query per item.
 */
export async function getHome(lang: SupportedLocale): Promise<HomeResponse> {
  const rows = await listHomeRows();

  if (rows.length === 0) return { rows: [] };

  const published = await loadPublished(
    rows.flatMap((row) => row.itemRefs),
    lang,
  );

  const resolved: HomeRowResponse[] = [];

  for (const row of rows) {
    const items = row.itemRefs
      .map((ref) => published.get(`${ref.type}:${ref.id}`))
      .filter((item): item is HomeItem => item !== undefined);

    // A row whose every ref points at draft or deleted content is not an empty
    // row, it is a row with nothing to say — the client should not render a
    // heading for it.
    if (items.length === 0) continue;

    resolved.push({ id: row.id, title: localizeField(row.titleI18n, lang), items });
  }

  return { rows: resolved };
}
