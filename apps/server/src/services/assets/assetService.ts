import fs from 'node:fs/promises';
import path from 'node:path';

import type { AssetDto } from '@streaming/shared' with { 'resolution-mode': 'import' };
import { count, desc, eq, sql } from 'drizzle-orm';

import { config } from '../../config';
import { db } from '../../db/client';
import { buildAssetUrl } from '../../lib/assetUrl';
import { logger } from '../../logger';
import { mediaAsset, type MediaAsset } from '../../db/schema';
import { HttpError } from '../../middleware/errorHandler';
import { ASSET_POLICY, type AssetKind } from './policy';
import type { ImageDimensions } from './imageValidator';

/**
 * The one place a row becomes a response. `filePath` is dropped here: callers
 * get a URL and never learn the on-disk layout.
 */
export function toAssetDto(row: MediaAsset): AssetDto {
  return {
    id: row.id,
    kind: row.kind,
    url: buildAssetUrl(row.filePath),
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes ?? 0,
    ...(row.width !== null && { width: row.width }),
    ...(row.height !== null && { height: row.height }),
    createdAt: row.createdAt.toISOString(),
  };
}

export interface CreateAssetParams {
  kind: AssetKind;
  /** Filename multer chose — already a uuid, never the client's name. */
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  dimensions?: ImageDimensions | null;
}

/**
 * Records an upload that already passed type, size and dimension checks.
 * Status is READY immediately: nothing is post-processed in this phase.
 */
export async function createAsset(params: CreateAssetParams): Promise<AssetDto> {
  const [row] = await db
    .insert(mediaAsset)
    .values({
      kind: params.kind,
      // Storage-relative, POSIX separators — it goes straight into a URL.
      filePath: `${ASSET_POLICY[params.kind].directory}/${params.fileName}`,
      fileName: params.fileName,
      mimeType: params.mimeType,
      sizeBytes: params.sizeBytes,
      width: params.dimensions?.width ?? null,
      height: params.dimensions?.height ?? null,
      status: 'READY',
    })
    .returning();

  if (!row) throw new HttpError(500, 'INTERNAL_ERROR', 'Failed to record the uploaded asset');

  return toAssetDto(row);
}

export interface ListAssetsParams {
  kind?: AssetKind;
  page: number;
  limit: number;
}

export interface ListAssetsResult {
  items: AssetDto[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export async function listAssets(params: ListAssetsParams): Promise<ListAssetsResult> {
  const where = params.kind ? eq(mediaAsset.kind, params.kind) : undefined;
  const offset = (params.page - 1) * params.limit;

  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(mediaAsset)
      .where(where)
      .orderBy(desc(mediaAsset.createdAt), desc(mediaAsset.id))
      .limit(params.limit)
      .offset(offset),
    db.select({ value: count() }).from(mediaAsset).where(where),
  ]);

  const total = totals?.value ?? 0;

  return {
    items: rows.map(toAssetDto),
    total,
    page: params.page,
    limit: params.limit,
    hasMore: offset + rows.length < total,
  };
}

export async function getAssetById(id: string): Promise<AssetDto> {
  const [row] = await db.select().from(mediaAsset).where(eq(mediaAsset.id, id)).limit(1);

  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Asset not found');

  return toAssetDto(row);
}

/** A column that may point at a `media_asset` row. */
export interface AssetReference {
  table: string;
  column: string;
  /** Human-readable name used in the 409 message. */
  entity: string;
}

/**
 * Every foreign key that can pin an asset in place.
 *
 * The referencing tables arrive in Phases 5–7, so each entry is skipped until
 * its table exists. Adding a new content table means adding one line here —
 * nothing else in the delete path changes.
 */
export const ASSET_REFERENCES: readonly AssetReference[] = [
  { table: 'movie', column: 'poster_asset_id', entity: 'movie poster' },
  { table: 'movie', column: 'backdrop_asset_id', entity: 'movie backdrop' },
  { table: 'series', column: 'poster_asset_id', entity: 'series poster' },
  { table: 'series', column: 'backdrop_asset_id', entity: 'series backdrop' },
  { table: 'episode', column: 'thumbnail_asset_id', entity: 'episode thumbnail' },
  { table: 'live_channel', column: 'logo_asset_id', entity: 'live channel logo' },
  { table: 'ad_creative', column: 'asset_id', entity: 'ad creative' },
  { table: 'subtitle_track', column: 'asset_id', entity: 'subtitle track' },
];

export interface AssetUsage {
  entity: string;
  count: number;
}

async function tableExists(table: string): Promise<boolean> {
  const result = await db.execute<{ present: boolean }>(
    sql`select to_regclass(${`public.${table}`}) is not null as present`,
  );

  return result.rows[0]?.present === true;
}

/**
 * Lists what currently points at an asset.
 *
 * `references` is injectable so tests can exercise the in-use path against a
 * throwaway table without waiting for the content phases to land.
 */
export async function findAssetReferences(
  id: string,
  references: readonly AssetReference[] = ASSET_REFERENCES,
): Promise<AssetUsage[]> {
  const usages: AssetUsage[] = [];

  for (const ref of references) {
    if (!(await tableExists(ref.table))) continue;

    // Identifiers come from the constant list above and are quoted by Drizzle,
    // so the value is the only interpolated input.
    const result = await db.execute<{ used: number }>(
      sql`select count(*)::int as used from ${sql.identifier(ref.table)} where ${sql.identifier(
        ref.column,
      )} = ${id}`,
    );

    const used = result.rows[0]?.used ?? 0;
    if (used > 0) usages.push({ entity: ref.entity, count: used });
  }

  return usages;
}

/** Resolves a storage-relative path, refusing anything that escapes storage/. */
function resolveInsideStorage(filePath: string): string {
  const absolute = path.resolve(config.storageDir, filePath);
  const root = path.resolve(config.storageDir);

  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new HttpError(500, 'INTERNAL_ERROR', 'Asset path is outside the storage directory');
  }

  return absolute;
}

/**
 * Deletes an unreferenced asset, row first and file second.
 *
 * That order is deliberate: a leftover file is invisible and reclaimable, while
 * a surviving row whose file is gone shows up as a broken image everywhere the
 * asset is used.
 */
export async function deleteAsset(
  id: string,
  references: readonly AssetReference[] = ASSET_REFERENCES,
): Promise<void> {
  const [row] = await db.select().from(mediaAsset).where(eq(mediaAsset.id, id)).limit(1);

  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Asset not found');

  const usages = await findAssetReferences(id, references);

  if (usages.length > 0) {
    const detail = usages.map((usage) => `${usage.entity} (${usage.count})`).join(', ');
    throw new HttpError(409, 'ASSET_IN_USE', `Asset is still used by: ${detail}`);
  }

  const absolute = resolveInsideStorage(row.filePath);

  await db.delete(mediaAsset).where(eq(mediaAsset.id, id));

  try {
    await fs.unlink(absolute);
  } catch (error) {
    // The row is already gone; a missing or unremovable file is not a failure
    // the caller can act on.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ err: error, assetId: id }, 'Deleted asset row but could not remove its file');
    }
  }
}
