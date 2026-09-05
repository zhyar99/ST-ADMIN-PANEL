import { and, desc, eq, sql } from 'drizzle-orm';

import type {
  AdCreativeDto,
  AdCreativeUpdateInput,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../db/client';
import { adCreative, mediaAsset, type AdCreative, type MediaAsset } from '../db/schema';
import { buildAssetUrl } from '../lib/assetUrl';
import { HttpError } from '../middleware/errorHandler';
import { toAssetDto } from '../services/assets/assetService';

/**
 * Persistence for the `ad_creative` pool.
 *
 * Every read joins `media_asset`, because a creative without its file is not a
 * thing any caller can use — the admin table renders a thumbnail and the
 * playback path needs a URL. The join is inner rather than left: `asset_id` is
 * NOT NULL with a foreign key, so a creative with no asset row cannot exist,
 * and a left join would only introduce a null the DTO would have to pretend to
 * handle.
 */

/**
 * Whole rows rather than a column list, so the asset half can go straight
 * through `toAssetDto` — the one function that turns a `media_asset` row into
 * the shape the Admin SPA already knows, including the `file_path`-to-URL step
 * and the optional dimensions. Restating those here is how a creative's
 * thumbnail would eventually differ from the same asset shown on the Media
 * Library page.
 */
const selection = { creative: adCreative, asset: mediaAsset };

function toDto(row: { creative: AdCreative; asset: MediaAsset }): AdCreativeDto {
  return {
    id: row.creative.id,
    asset: toAssetDto(row.asset),
    durationSeconds: row.creative.durationSeconds,
    isActive: row.creative.isActive,
    createdAt: row.creative.createdAt.toISOString(),
    updatedAt: row.creative.updatedAt.toISOString(),
  };
}

function baseQuery() {
  return db
    .select(selection)
    .from(adCreative)
    .innerJoin(mediaAsset, eq(adCreative.assetId, mediaAsset.id));
}

/** Newest first, active and inactive alike — the admin table shows both. */
export async function listAdCreatives(): Promise<AdCreativeDto[]> {
  const rows = await baseQuery().orderBy(desc(adCreative.createdAt), desc(adCreative.id));
  return rows.map(toDto);
}

export async function findAdCreative(id: string): Promise<AdCreativeDto | null> {
  const [row] = await baseQuery().where(eq(adCreative.id, id)).limit(1);
  return row ? toDto(row) : null;
}

export interface CreateAdCreativeInput {
  assetId: string;
  durationSeconds: number;
}

/**
 * Adds a creative to the pool.
 *
 * The asset's kind is checked here rather than trusted from the request: the
 * route validates that `assetId` is a uuid, which says nothing about what it
 * points at. Pointing a creative at a movie poster would produce a session
 * response that plays a JPEG as a pre-roll, so the wrong kind is a 400 with a
 * message naming what was actually found.
 */
export async function createAdCreative(input: CreateAdCreativeInput): Promise<AdCreativeDto> {
  const [asset] = await db
    .select({ id: mediaAsset.id, kind: mediaAsset.kind })
    .from(mediaAsset)
    .where(eq(mediaAsset.id, input.assetId))
    .limit(1);

  if (!asset) throw new HttpError(404, 'NOT_FOUND', 'Asset not found');

  if (asset.kind !== 'AD_CREATIVE') {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      `assetId must reference an AD_CREATIVE asset (found ${asset.kind})`,
    );
  }

  const [inserted] = await db
    .insert(adCreative)
    .values({ assetId: input.assetId, durationSeconds: input.durationSeconds })
    .returning({ id: adCreative.id });

  const created = await findAdCreative(inserted!.id);

  if (!created) throw new HttpError(500, 'INTERNAL_ERROR', 'Failed to record the ad creative');

  return created;
}

export async function updateAdCreative(
  id: string,
  patch: AdCreativeUpdateInput,
): Promise<AdCreativeDto> {
  const [row] = await db
    .update(adCreative)
    .set({
      ...(patch.durationSeconds !== undefined && { durationSeconds: patch.durationSeconds }),
      ...(patch.isActive !== undefined && { isActive: patch.isActive }),
      updatedAt: new Date(),
    })
    .where(eq(adCreative.id, id))
    .returning({ id: adCreative.id });

  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Ad creative not found');

  return (await findAdCreative(id))!;
}

/**
 * Removes a creative from the pool.
 *
 * Nothing holds a reference to a creative — a playback session is a response,
 * not a stored row — so there is no in-use guard to apply. The file itself
 * survives in the media library, which is the reversible half: re-adding a
 * deleted creative is a create, not a re-upload. The caller records the
 * deletion in `audit_log`.
 */
export async function deleteAdCreative(id: string): Promise<void> {
  const [row] = await db
    .delete(adCreative)
    .where(eq(adCreative.id, id))
    .returning({ id: adCreative.id });

  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Ad creative not found');
}

export interface PlaybackCreative {
  id: string;
  url: string;
  durationSeconds: number;
}

/**
 * One active creative for a VOD session, or null when the pool is empty.
 *
 * `order by random()` is a full scan of the active rows, which is the right
 * trade at this size: the pool is a handful of files an operator uploaded by
 * hand, and the alternatives — a rotation cursor, a weighted picker — are the
 * scheduling machinery this phase deliberately does not build. If the pool
 * ever grows to where the scan matters, that is the moment to introduce a real
 * rotation strategy rather than to optimise this query.
 */
export async function getOneActiveCreative(): Promise<PlaybackCreative | null> {
  const [row] = await db
    .select({
      id: adCreative.id,
      durationSeconds: adCreative.durationSeconds,
      filePath: mediaAsset.filePath,
    })
    .from(adCreative)
    .innerJoin(mediaAsset, eq(adCreative.assetId, mediaAsset.id))
    .where(and(eq(adCreative.isActive, true), eq(mediaAsset.kind, 'AD_CREATIVE')))
    .orderBy(sql`random()`)
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    url: buildAssetUrl(row.filePath),
    durationSeconds: row.durationSeconds,
  };
}
