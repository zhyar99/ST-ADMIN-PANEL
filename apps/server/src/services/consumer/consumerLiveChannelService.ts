import { and, asc, count, desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type {
  LiveChannelListItem,
  PaginatedResponse,
  SupportedLocale,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import { liveChannel, mediaAsset } from '../../db/schema';
import { assetUrl } from '../../lib/assetUrl';
import { localizeField } from '../../lib/i18n';

/**
 * Consumer live channel reads.
 *
 * The thinnest surface in the consumer API, and the one where leaving out
 * `stream_source` matters most: a channel is barely more than a name wrapped
 * around a feed, so the temptation to include the URL "since there is nothing
 * else here" is exactly the mistake this file exists to not make. There is no
 * detail endpoint for the same reason — the list item is already everything a
 * channel has that a viewer may see, and the URL comes from a playback session.
 */

const logo = alias(mediaAsset, 'logo_asset');

export interface ListLiveChannelsParams {
  page: number;
  limit: number;
  category?: string;
  lang: SupportedLocale;
}

export async function listPublishedLiveChannels(
  params: ListLiveChannelsParams,
): Promise<PaginatedResponse<LiveChannelListItem>> {
  const filters = [eq(liveChannel.status, 'PUBLISHED')];

  if (params.category) filters.push(eq(liveChannel.category, params.category));

  const where = and(...filters);
  const offset = (params.page - 1) * params.limit;

  const [rows, [totals]] = await Promise.all([
    db
      .select({
        id: liveChannel.id,
        nameI18n: liveChannel.nameI18n,
        category: liveChannel.category,
        logoPath: logo.filePath,
      })
      .from(liveChannel)
      .leftJoin(logo, eq(logo.id, liveChannel.logoAssetId))
      .where(where)
      .orderBy(asc(liveChannel.sortOrder), desc(liveChannel.createdAt), desc(liveChannel.id))
      .limit(params.limit)
      .offset(offset),
    db.select({ value: count() }).from(liveChannel).where(where),
  ]);

  return {
    data: rows.map((row) => ({
      id: row.id,
      name: localizeField(row.nameI18n, params.lang),
      logoUrl: assetUrl(row.logoPath),
      category: row.category,
    })),
    meta: { page: params.page, limit: params.limit, total: totals?.value ?? 0 },
  };
}
