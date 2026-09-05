import { and, eq, inArray } from 'drizzle-orm';

import type { LocalizedText } from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import { episode, liveChannel, movie, series } from '../../db/schema';
import { mediaAsset } from '../../db/schema';

/**
 * Resolving polymorphic content refs to something renderable.
 *
 * Every device-facing list — favourites, watchlist, history, the admin's
 * trending table — stores `(content_type, content_id)` and has to turn a page
 * of them into titles and artwork. Doing that per row would be one query per
 * card; this batches by type, so a page of twenty costs at most four queries
 * regardless of how the types are mixed.
 *
 * Only PUBLISHED rows are returned. A ref whose target is a draft, or has been
 * deleted outright, resolves to nothing and the caller drops it: an unpublished
 * title's name must not reach a consumer response, even one describing that
 * consumer's own history.
 */

export type SummaryContentType = 'MOVIE' | 'SERIES' | 'EPISODE' | 'LIVE_CHANNEL';

export interface ContentRef {
  contentType: SummaryContentType;
  contentId: string;
}

export interface ContentSummary {
  titleI18n: LocalizedText;
  posterPath: string | null;
}

/** `MOVIE:0e1f…` — the key both sides of a resolve agree on. */
export function summaryKey(contentType: string, contentId: string): string {
  return `${contentType}:${contentId}`;
}

export async function resolveContentSummaries(
  refs: readonly ContentRef[],
): Promise<Map<string, ContentSummary>> {
  const found = new Map<string, ContentSummary>();
  if (refs.length === 0) return found;

  const idsOf = (type: SummaryContentType): string[] => [
    ...new Set(refs.filter((ref) => ref.contentType === type).map((ref) => ref.contentId)),
  ];

  const movieIds = idsOf('MOVIE');
  const seriesIds = idsOf('SERIES');
  const episodeIds = idsOf('EPISODE');
  const channelIds = idsOf('LIVE_CHANNEL');

  const [movies, allSeries, episodes, channels] = await Promise.all([
    movieIds.length === 0
      ? []
      : db
          .select({ id: movie.id, titleI18n: movie.titleI18n, filePath: mediaAsset.filePath })
          .from(movie)
          .leftJoin(mediaAsset, eq(mediaAsset.id, movie.posterAssetId))
          .where(and(inArray(movie.id, movieIds), eq(movie.status, 'PUBLISHED'))),
    seriesIds.length === 0
      ? []
      : db
          .select({ id: series.id, titleI18n: series.titleI18n, filePath: mediaAsset.filePath })
          .from(series)
          .leftJoin(mediaAsset, eq(mediaAsset.id, series.posterAssetId))
          .where(and(inArray(series.id, seriesIds), eq(series.status, 'PUBLISHED'))),
    episodeIds.length === 0
      ? []
      : db
          .select({ id: episode.id, titleI18n: episode.titleI18n, filePath: mediaAsset.filePath })
          .from(episode)
          .leftJoin(mediaAsset, eq(mediaAsset.id, episode.thumbnailAssetId))
          .where(and(inArray(episode.id, episodeIds), eq(episode.status, 'PUBLISHED'))),
    channelIds.length === 0
      ? []
      : db
          .select({ id: liveChannel.id, titleI18n: liveChannel.nameI18n, filePath: mediaAsset.filePath })
          .from(liveChannel)
          .leftJoin(mediaAsset, eq(mediaAsset.id, liveChannel.logoAssetId))
          .where(and(inArray(liveChannel.id, channelIds), eq(liveChannel.status, 'PUBLISHED'))),
  ]);

  const collect = (type: SummaryContentType, rows: typeof movies): void => {
    for (const row of rows) {
      found.set(summaryKey(type, row.id), { titleI18n: row.titleI18n, posterPath: row.filePath });
    }
  };

  collect('MOVIE', movies);
  collect('SERIES', allSeries);
  collect('EPISODE', episodes);
  collect('LIVE_CHANNEL', channels);

  return found;
}
