import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';

import type {
  ContentSearchResult,
  HomeItemRef,
  HomeItemRefType,
  SupportedLocale,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import { liveChannel, mediaAsset, movie, series } from '../../db/schema';
import { assetUrl } from '../../lib/assetUrl';
import { localizeField } from '../../lib/i18n';
import { likePattern } from '../consumer/consumerShared';

/**
 * Backs the Admin item picker.
 *
 * An admin-only endpoint that nonetheless returns published content only, which
 * looks like the wrong default until you notice what it feeds: a picker whose
 * results become `item_refs`. Offering drafts there would let an operator build
 * a row out of items that cannot appear on Home, and the row would silently
 * render short. Restricting the search is how the picker stays honest about
 * what it can actually add.
 *
 * Search behaviour mirrors `searchService`: a case-insensitive substring match
 * on the title in the requested language, escaped by `likePattern` so a caller
 * cannot smuggle `%` in and match everything. With no `q` it degrades to "the
 * most recent published content", which is what the picker shows on open.
 */

const posterAsset = alias(mediaAsset, 'poster_asset');
const logoAsset = alias(mediaAsset, 'logo_asset');

export interface ContentSearchParams {
  q?: string;
  type?: HomeItemRefType;
  lang: SupportedLocale;
  limit: number;
}

interface SearchRow {
  id: string;
  titleI18n: Record<string, string>;
  imagePath: string | null;
}

function toResult(
  type: HomeItemRefType,
  row: SearchRow,
  lang: SupportedLocale,
): ContentSearchResult {
  return {
    type,
    id: row.id,
    title: localizeField(row.titleI18n, lang),
    posterUrl: assetUrl(row.imagePath),
  };
}

export async function searchContent(
  params: ContentSearchParams,
): Promise<ContentSearchResult[]> {
  const { lang, limit, type } = params;
  const term = params.q?.trim();
  const pattern = term ? likePattern(term) : null;

  /** The title filter, or undefined when the caller supplied no term. */
  const matches = (column: PgColumn): SQL | undefined =>
    pattern === null ? undefined : sql`${column} ->> ${lang}::text ilike ${pattern}`;

  const wanted = (candidate: HomeItemRefType): boolean =>
    type === undefined || type === candidate;

  const [movieRows, seriesRows, channelRows] = await Promise.all([
    !wanted('MOVIE')
      ? []
      : db
          .select({ id: movie.id, titleI18n: movie.titleI18n, imagePath: posterAsset.filePath })
          .from(movie)
          .leftJoin(posterAsset, eq(posterAsset.id, movie.posterAssetId))
          .where(and(eq(movie.status, 'PUBLISHED'), matches(movie.titleI18n)))
          .orderBy(desc(movie.createdAt), desc(movie.id))
          .limit(limit),
    !wanted('SERIES')
      ? []
      : db
          .select({ id: series.id, titleI18n: series.titleI18n, imagePath: posterAsset.filePath })
          .from(series)
          .leftJoin(posterAsset, eq(posterAsset.id, series.posterAssetId))
          .where(and(eq(series.status, 'PUBLISHED'), matches(series.titleI18n)))
          .orderBy(desc(series.createdAt), desc(series.id))
          .limit(limit),
    !wanted('LIVE_CHANNEL')
      ? []
      : db
          .select({
            id: liveChannel.id,
            titleI18n: liveChannel.nameI18n,
            imagePath: logoAsset.filePath,
          })
          .from(liveChannel)
          .leftJoin(logoAsset, eq(logoAsset.id, liveChannel.logoAssetId))
          .where(and(eq(liveChannel.status, 'PUBLISHED'), matches(liveChannel.nameI18n)))
          .orderBy(desc(liveChannel.createdAt), desc(liveChannel.id))
          .limit(limit),
  ]);

  const buckets: ContentSearchResult[][] = [
    movieRows.map((row) => toResult('MOVIE', row, lang)),
    seriesRows.map((row) => toResult('SERIES', row, lang)),
    channelRows.map((row) => toResult('LIVE_CHANNEL', row, lang)),
  ];

  return interleave(buckets, limit);
}

/**
 * Resolves an explicit list of refs to their titles, for the row editor.
 *
 * Separate from {@link searchContent} because the editor is not searching — it
 * holds refs already and needs the copy to render them. A text search cannot
 * answer that: it is bounded to 20 hits ranked by recency, so a row's fifteenth
 * item would simply not come back.
 *
 * Refs that resolve to nothing are *omitted rather than errored*, and the
 * caller is expected to notice the gap: an entry missing from this response is
 * one whose target is unpublished or deleted, which is exactly what the editor
 * needs to flag, since Home will silently drop it.
 */
export async function lookupContent(
  refs: HomeItemRef[],
  lang: SupportedLocale,
): Promise<ContentSearchResult[]> {
  const idsOf = (type: HomeItemRefType): string[] => [
    ...new Set(refs.filter((ref) => ref.type === type).map((ref) => ref.id)),
  ];

  const movieIds = idsOf('MOVIE');
  const seriesIds = idsOf('SERIES');
  const channelIds = idsOf('LIVE_CHANNEL');

  const [movieRows, seriesRows, channelRows] = await Promise.all([
    movieIds.length === 0
      ? []
      : db
          .select({ id: movie.id, titleI18n: movie.titleI18n, imagePath: posterAsset.filePath })
          .from(movie)
          .leftJoin(posterAsset, eq(posterAsset.id, movie.posterAssetId))
          .where(and(eq(movie.status, 'PUBLISHED'), inArray(movie.id, movieIds))),
    seriesIds.length === 0
      ? []
      : db
          .select({ id: series.id, titleI18n: series.titleI18n, imagePath: posterAsset.filePath })
          .from(series)
          .leftJoin(posterAsset, eq(posterAsset.id, series.posterAssetId))
          .where(and(eq(series.status, 'PUBLISHED'), inArray(series.id, seriesIds))),
    channelIds.length === 0
      ? []
      : db
          .select({
            id: liveChannel.id,
            titleI18n: liveChannel.nameI18n,
            imagePath: logoAsset.filePath,
          })
          .from(liveChannel)
          .leftJoin(logoAsset, eq(logoAsset.id, liveChannel.logoAssetId))
          .where(and(eq(liveChannel.status, 'PUBLISHED'), inArray(liveChannel.id, channelIds))),
  ]);

  return [
    ...movieRows.map((row) => toResult('MOVIE', row, lang)),
    ...seriesRows.map((row) => toResult('SERIES', row, lang)),
    ...channelRows.map((row) => toResult('LIVE_CHANNEL', row, lang)),
  ];
}

/**
 * Merges the per-type buckets round-robin, then truncates.
 *
 * Same reasoning as `searchService.interleave`: concatenating would let 20
 * matching movies spend the whole budget and hide the channel of the same name
 * — often the one the operator was looking for.
 */
function interleave(
  buckets: ContentSearchResult[][],
  limit: number,
): ContentSearchResult[] {
  const merged: ContentSearchResult[] = [];
  const deepest = Math.max(0, ...buckets.map((bucket) => bucket.length));

  for (let index = 0; index < deepest && merged.length < limit; index += 1) {
    for (const bucket of buckets) {
      const hit = bucket[index];
      if (hit && merged.length < limit) merged.push(hit);
    }
  }

  return merged;
}
