import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';

import type {
  AssetDto,
  BulkChannelPublicationResult,
  MoveLiveChannelInput,
  LiveChannelCreateInput,
  LiveChannelDetailDto,
  LiveChannelListItemDto,
  LiveChannelUpdateInput,
  PublicationStatus,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import {
  liveChannel,
  mediaAsset,
  streamSource,
  type LiveChannel,
  type MediaAsset,
} from '../../db/schema';
import { HttpError } from '../../middleware/errorHandler';
import { publishContent, unpublishContent } from './publishService';
import { toAssetDto } from '../assets/assetService';

/**
 * Live channel reads and writes.
 *
 * The same rule as `movieService` holds and matters more here, because a live
 * channel is little more than a name wrapped around a stream: nothing in this
 * file ever selects `stream_source.url`. A channel DTO is assembled from the
 * channel row and its logo only. Sources are a separate ADMIN-only sub-resource
 * served by the owner-agnostic `streamSourceService`, whose `StreamSourceDto`
 * has no `url` field to leak in the first place.
 */

/** Fetches logo rows in one query, keyed by id. */
async function assetsById(ids: string[]): Promise<Map<string, AssetDto>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();

  const rows = await db.select().from(mediaAsset).where(inArray(mediaAsset.id, unique));

  return new Map(rows.map((row: MediaAsset) => [row.id, toAssetDto(row)]));
}

function toLiveChannelDetail(row: LiveChannel, logo: AssetDto | null): LiveChannelDetailDto {
  return {
    id: row.id,
    nameI18n: row.nameI18n,
    category: row.category,
    logo,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Loads a channel row with its logo resolved. */
async function detailFor(row: LiveChannel): Promise<LiveChannelDetailDto> {
  const assets = await assetsById(row.logoAssetId ? [row.logoAssetId] : []);
  return toLiveChannelDetail(row, row.logoAssetId ? (assets.get(row.logoAssetId) ?? null) : null);
}

export interface ListLiveChannelsParams {
  status?: PublicationStatus;
  category?: string;
  page: number;
  limit: number;
}

export interface ListLiveChannelsResult {
  items: LiveChannelListItemDto[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export async function listLiveChannels(
  params: ListLiveChannelsParams,
): Promise<ListLiveChannelsResult> {
  const filters = [
    params.status ? eq(liveChannel.status, params.status) : undefined,
    params.category ? eq(liveChannel.category, params.category) : undefined,
  ].filter((filter) => filter !== undefined);

  const where = filters.length > 0 ? and(...filters) : undefined;
  const offset = (params.page - 1) * params.limit;

  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(liveChannel)
      .where(where)
      .orderBy(asc(liveChannel.sortOrder), desc(liveChannel.createdAt), desc(liveChannel.id))
      .limit(params.limit)
      .offset(offset),
    db.select({ value: count() }).from(liveChannel).where(where),
  ]);

  const total = totals?.value ?? 0;
  const ids = rows.map((row) => row.id);

  // Logos and source counts are fetched once for the whole page rather than per
  // row — the list renders both for every channel, and the per-row shape would
  // be two queries per result.
  const [assets, counts] = await Promise.all([
    assetsById(rows.map((row) => row.logoAssetId).filter((id): id is string => id !== null)),
    sourceCountsFor(ids),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      nameI18n: row.nameI18n,
      category: row.category,
      logo: row.logoAssetId ? (assets.get(row.logoAssetId) ?? null) : null,
      status: row.status,
      sourceCount: counts.get(row.id) ?? 0,
      createdAt: row.createdAt.toISOString(),
    })),
    total,
    page: params.page,
    limit: params.limit,
    hasMore: offset + rows.length < total,
  };
}

/**
 * Counts stream sources per channel.
 *
 * Selects only the owner id and a count — never `url` — so the list path has no
 * way to touch the column even accidentally.
 */
async function sourceCountsFor(channelIds: string[]): Promise<Map<string, number>> {
  if (channelIds.length === 0) return new Map();

  const rows = await db
    .select({ ownerId: streamSource.ownerId, value: count() })
    .from(streamSource)
    .where(
      and(
        eq(streamSource.ownerType, 'LIVE_CHANNEL'),
        inArray(streamSource.ownerId, channelIds),
      ),
    )
    .groupBy(streamSource.ownerId);

  return new Map(rows.map((row) => [row.ownerId, row.value]));
}

/**
 * Loads a channel row or 404s. Used by the sources sub-resource to prove the
 * owner exists before scoping to it.
 */
export async function requireLiveChannel(id: string): Promise<LiveChannel> {
  const [row] = await db.select().from(liveChannel).where(eq(liveChannel.id, id)).limit(1);

  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Live channel not found');

  return row;
}

export async function getLiveChannelDetail(id: string): Promise<LiveChannelDetailDto> {
  return detailFor(await requireLiveChannel(id));
}

/** The distinct categories in use, for the list page filter. */
export async function listChannelCategories(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ category: liveChannel.category })
    .from(liveChannel)
    .orderBy(asc(liveChannel.category));

  return rows.map((row) => row.category);
}

/**
 * Confirms the logo id exists and is actually a LOGO.
 *
 * Without the kind check a poster could be set as a channel logo, which the
 * database would accept and every channel strip in the consumer app would then
 * render at the wrong aspect ratio.
 */
async function assertLogoAsset(assetId: string): Promise<void> {
  const [row] = await db
    .select({ kind: mediaAsset.kind })
    .from(mediaAsset)
    .where(eq(mediaAsset.id, assetId))
    .limit(1);

  if (!row) {
    throw new HttpError(400, 'ASSET_NOT_FOUND', 'logo_asset_id does not reference a known asset');
  }

  if (row.kind !== 'LOGO') {
    throw new HttpError(400, 'ASSET_KIND_MISMATCH', 'logo_asset_id must reference a LOGO asset');
  }
}

/**
 * Guards against a category that is blank once trimmed.
 *
 * Zod already rejects this at the route boundary; repeating it here keeps the
 * rule true for any future non-HTTP caller (a seed script, a bulk import) that
 * reaches the service directly.
 */
function normaliseCategory(category: string): string {
  const trimmed = category.trim();

  if (trimmed.length === 0) {
    throw new HttpError(400, 'CATEGORY_REQUIRED', 'category must not be empty');
  }

  return trimmed;
}

export async function createLiveChannel(
  input: LiveChannelCreateInput,
): Promise<LiveChannelDetailDto> {
  if (input.logo_asset_id) await assertLogoAsset(input.logo_asset_id);

  const [row] = await db
    .insert(liveChannel)
    .values({
      nameI18n: input.name_i18n,
      category: normaliseCategory(input.category),
      logoAssetId: input.logo_asset_id ?? null,
      // Status is not settable on create: everything starts as a draft and
      // publishing is Phase 8.
    })
    .returning();

  if (!row) throw new HttpError(500, 'INTERNAL_ERROR', 'Failed to create live channel');

  return detailFor(row);
}

export async function updateLiveChannel(
  id: string,
  input: LiveChannelUpdateInput,
): Promise<LiveChannelDetailDto> {
  await requireLiveChannel(id);

  if (input.logo_asset_id) await assertLogoAsset(input.logo_asset_id);

  // `null` clears the logo, `undefined` leaves it alone — so each key is only
  // included when the client actually sent it.
  const [row] = await db
    .update(liveChannel)
    .set({
      ...(input.name_i18n !== undefined && { nameI18n: input.name_i18n }),
      ...(input.category !== undefined && { category: normaliseCategory(input.category) }),
      ...(input.logo_asset_id !== undefined && { logoAssetId: input.logo_asset_id ?? null }),
      updatedAt: new Date(),
    })
    .where(eq(liveChannel.id, id))
    .returning();

  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Live channel not found');

  return detailFor(row);
}

/**
 * Deletes a channel and the sources hanging off it.
 *
 * Cascading rather than blocking: a channel's sources have no meaning without
 * the channel, so refusing the delete would strand rows an operator cannot
 * reach through any UI. No foreign key can do this for us — `stream_source` is
 * polymorphic on `owner_type` — so the cleanup is explicit and shares the
 * channel's transaction. Missing it would leave orphan rows holding live URLs.
 *
 * There is no DRAFT-only guard here, unlike `deleteMovie`: publication gating
 * for live channels is Phase 8.
 */
export async function deleteLiveChannel(id: string): Promise<void> {
  await requireLiveChannel(id);

  await db.transaction(async (tx) => {
    await tx
      .delete(streamSource)
      .where(and(eq(streamSource.ownerType, 'LIVE_CHANNEL'), eq(streamSource.ownerId, id)));

    await tx.delete(liveChannel).where(eq(liveChannel.id, id));
  });
}

export async function bulkChannelPublication(
  ids: string[], status: 'PUBLISHED' | 'UNPUBLISHED', adminUserId: string,
): Promise<BulkChannelPublicationResult> {
  const result: BulkChannelPublicationResult = { succeeded: [], failed: [] };
  for (const id of ids) {
    try {
      await requireLiveChannel(id);
      if (status === 'PUBLISHED') await publishContent('live_channel', id, adminUserId);
      else await unpublishContent('live_channel', id, adminUserId);
      result.succeeded.push(id);
    } catch (error) {
      result.failed.push({ id, message: error instanceof HttpError && error.status < 500
        ? error.message : 'Could not change this channel. Please retry.' });
    }
  }
  return result;
}

/** Move relative to the current order, including channels on other pages. */
export async function moveLiveChannel(input: MoveLiveChannelInput): Promise<void> {
  await db.transaction(async (tx) => {
    // Serialize reorders with each other and with channel creation/deletion.
    await tx.execute(sql`LOCK TABLE ${liveChannel} IN SHARE ROW EXCLUSIVE MODE`);
    const rows = await tx.select({ id: liveChannel.id, sortOrder: liveChannel.sortOrder })
      .from(liveChannel)
      .orderBy(asc(liveChannel.sortOrder), desc(liveChannel.createdAt), desc(liveChannel.id));
    const from = rows.findIndex((row) => row.id === input.id);
    if (from < 0) throw new HttpError(404, 'NOT_FOUND', 'Live channel not found');
    const [moved] = rows.splice(from, 1);
    let to = input.placement === 'first' ? 0 : rows.length;
    if (input.placement === 'before' || input.placement === 'after') {
      to = rows.findIndex((row) => row.id === input.targetId);
      if (to < 0) throw new HttpError(404, 'NOT_FOUND', 'Target channel not found');
      if (input.placement === 'after') to += 1;
    }
    rows.splice(to, 0, moved!);
    const changed = rows.map((row, position) => ({ ...row, position }))
      .filter((row) => row.sortOrder !== row.position);
    for (let offset = 0; offset < changed.length; offset += 500) {
      const values = sql.join(changed.slice(offset, offset + 500)
        .map((row) => sql`(${row.id}::uuid, ${row.position}::integer)`), sql`, `);
      await tx.execute(sql`UPDATE ${liveChannel} AS c
        SET sort_order = v.position, updated_at = now()
        FROM (VALUES ${values}) AS v(id, position) WHERE c.id = v.id`);
    }
  });
}
