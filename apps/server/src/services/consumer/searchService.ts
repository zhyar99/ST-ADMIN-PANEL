import { and, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type {
  SearchHit,
  SupportedLocale,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import { liveChannel, mediaAsset, movie, series } from '../../db/schema';
import { assetUrl } from '../../lib/assetUrl';
import { localizeField } from '../../lib/i18n';
import { likePattern } from './consumerShared';

/**
 * Cross-type catalogue search.
 *
 * Deliberately naive: a case-insensitive substring match against the title in
 * the requested language. No trigram index, no ranking, no stemming — Kurdish
 * Sorani and Arabic have no usable Postgres text search configuration, so a
 * `to_tsvector` implementation would work well in English and badly in the two
 * languages this platform is actually for. A substring match is equally
 * mediocre in all three, which is the honest starting point.
 *
 * `q` is escaped by `likePattern` before it reaches the pattern, so a caller
 * cannot smuggle `%` in and match the entire catalogue.
 */

const posterAsset = alias(mediaAsset, 'poster_asset');
const logoAsset = alias(mediaAsset, 'logo_asset');

export interface SearchParams {
  q: string;
  lang: SupportedLocale;
  limit: number;
}

export async function searchCatalog(params: SearchParams): Promise<SearchHit[]> {
  const pattern = likePattern(params.q);
  const { lang, limit } = params;

  const [movieRows, seriesRows, channelRows] = await Promise.all([
    db
      .select({ id: movie.id, titleI18n: movie.titleI18n, imagePath: posterAsset.filePath })
      .from(movie)
      .leftJoin(posterAsset, eq(posterAsset.id, movie.posterAssetId))
      .where(
        and(
          eq(movie.status, 'PUBLISHED'),
          sql`${movie.titleI18n} ->> ${lang}::text ilike ${pattern}`,
        ),
      )
      .orderBy(desc(movie.createdAt), desc(movie.id))
      .limit(limit),
    db
      .select({ id: series.id, titleI18n: series.titleI18n, imagePath: posterAsset.filePath })
      .from(series)
      .leftJoin(posterAsset, eq(posterAsset.id, series.posterAssetId))
      .where(
        and(
          eq(series.status, 'PUBLISHED'),
          sql`${series.titleI18n} ->> ${lang}::text ilike ${pattern}`,
        ),
      )
      .orderBy(desc(series.createdAt), desc(series.id))
      .limit(limit),
    db
      .select({ id: liveChannel.id, titleI18n: liveChannel.nameI18n, imagePath: logoAsset.filePath })
      .from(liveChannel)
      .leftJoin(logoAsset, eq(logoAsset.id, liveChannel.logoAssetId))
      .where(
        and(
          eq(liveChannel.status, 'PUBLISHED'),
          sql`${liveChannel.nameI18n} ->> ${lang}::text ilike ${pattern}`,
        ),
      )
      .orderBy(desc(liveChannel.createdAt), desc(liveChannel.id))
      .limit(limit),
  ]);

  const buckets: SearchHit[][] = [
    movieRows.map((row) => toHit('movie', row, lang)),
    seriesRows.map((row) => toHit('series', row, lang)),
    channelRows.map((row) => toHit('live_channel', row, lang)),
  ];

  return interleave(buckets, limit);
}

interface SearchRow {
  id: string;
  titleI18n: Record<string, string>;
  imagePath: string | null;
}

function toHit(type: SearchHit['type'], row: SearchRow, lang: SupportedLocale): SearchHit {
  return {
    type,
    id: row.id,
    title: localizeField(row.titleI18n, lang),
    imageUrl: assetUrl(row.imagePath),
  };
}

/**
 * Merges the per-type results round-robin, then truncates to `limit`.
 *
 * Concatenating instead would let a term matching 20 movies fill the whole
 * budget and hide the channel of the same name entirely — the one result the
 * user most likely meant. Round-robin gives every type a fair share and still
 * spends the full budget when a type has nothing to contribute.
 */
function interleave(buckets: SearchHit[][], limit: number): SearchHit[] {
  const merged: SearchHit[] = [];
  const deepest = Math.max(0, ...buckets.map((bucket) => bucket.length));

  for (let index = 0; index < deepest && merged.length < limit; index += 1) {
    for (const bucket of buckets) {
      const hit = bucket[index];
      if (hit && merged.length < limit) merged.push(hit);
    }
  }

  return merged;
}
