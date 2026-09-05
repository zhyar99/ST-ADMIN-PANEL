import { and, asc, eq } from 'drizzle-orm';

import type {
  StreamSourceOwnerType,
  SubtitleTrackCreateInput,
  SubtitleTrackDto,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import { mediaAsset, subtitleTrack, type SubtitleTrack } from '../../db/schema';
import { HttpError } from '../../middleware/errorHandler';
import { toAssetDto } from '../assets/assetService';

/**
 * Subtitle track CRUD. Owner-agnostic like the stream sources, minus
 * LIVE_CHANNEL — a live channel has no subtitle tracks, which the
 * `subtitle_track_owner_type_allowed` CHECK also enforces.
 */

export type SubtitleOwnerType = Exclude<StreamSourceOwnerType, 'LIVE_CHANNEL'>;

export interface SubtitleOwner {
  ownerType: SubtitleOwnerType;
  ownerId: string;
}

function ownerFilter(owner: SubtitleOwner) {
  return and(
    eq(subtitleTrack.ownerType, owner.ownerType),
    eq(subtitleTrack.ownerId, owner.ownerId),
  );
}

/** Tracks for one owner, with the library asset resolved where there is one. */
export async function listSubtitles(owner: SubtitleOwner): Promise<SubtitleTrackDto[]> {
  const rows = await db
    .select({ track: subtitleTrack, asset: mediaAsset })
    .from(subtitleTrack)
    .leftJoin(mediaAsset, eq(mediaAsset.id, subtitleTrack.assetId))
    .where(ownerFilter(owner))
    .orderBy(asc(subtitleTrack.language));

  return rows.map(({ track, asset }) => ({
    id: track.id,
    language: track.language,
    asset: asset ? toAssetDto(asset) : null,
    externalUrl: track.externalUrl,
  }));
}

/** Confirms a library asset exists and is actually a subtitle file. */
async function assertSubtitleAsset(assetId: string): Promise<void> {
  const [row] = await db
    .select({ kind: mediaAsset.kind })
    .from(mediaAsset)
    .where(eq(mediaAsset.id, assetId))
    .limit(1);

  if (!row) throw new HttpError(400, 'ASSET_NOT_FOUND', 'asset_id does not reference a known asset');

  if (row.kind !== 'SUBTITLE') {
    throw new HttpError(400, 'ASSET_KIND_MISMATCH', 'asset_id must reference a SUBTITLE asset');
  }
}

/**
 * Adds a track.
 *
 * A second track for a language is rejected rather than upserted: silently
 * replacing an existing subtitle on what looks like an "add" is how an
 * operator loses work they cannot get back.
 */
export async function addSubtitle(
  owner: SubtitleOwner,
  input: SubtitleTrackCreateInput,
): Promise<SubtitleTrackDto> {
  if (input.asset_id) await assertSubtitleAsset(input.asset_id);

  const [duplicate] = await db
    .select({ id: subtitleTrack.id })
    .from(subtitleTrack)
    .where(and(ownerFilter(owner), eq(subtitleTrack.language, input.language)))
    .limit(1);

  if (duplicate) {
    throw new HttpError(
      409,
      'SUBTITLE_LANGUAGE_TAKEN',
      `A ${input.language} subtitle track already exists — delete it first`,
    );
  }

  const [created] = await db
    .insert(subtitleTrack)
    .values({
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      language: input.language,
      assetId: input.asset_id ?? null,
      externalUrl: input.external_url ?? null,
    })
    .returning();

  if (!created) throw new HttpError(500, 'INTERNAL_ERROR', 'Failed to create subtitle track');

  return hydrate(created);
}

/** Re-reads the asset for a freshly written row so the DTO is complete. */
async function hydrate(row: SubtitleTrack): Promise<SubtitleTrackDto> {
  if (!row.assetId) {
    return { id: row.id, language: row.language, asset: null, externalUrl: row.externalUrl };
  }

  const [asset] = await db.select().from(mediaAsset).where(eq(mediaAsset.id, row.assetId)).limit(1);

  return {
    id: row.id,
    language: row.language,
    asset: asset ? toAssetDto(asset) : null,
    externalUrl: row.externalUrl,
  };
}

export async function deleteSubtitle(owner: SubtitleOwner, subtitleId: string): Promise<void> {
  const [row] = await db
    .select({ id: subtitleTrack.id })
    .from(subtitleTrack)
    .where(and(ownerFilter(owner), eq(subtitleTrack.id, subtitleId)))
    .limit(1);

  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Subtitle track not found');

  await db.delete(subtitleTrack).where(eq(subtitleTrack.id, subtitleId));
}
