import { and, asc, eq, max } from 'drizzle-orm';

import type {
  StreamSourceCreateInput,
  StreamSourceDto,
  StreamSourceOwnerType,
  StreamSourceUpdateInput,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import { streamSource, type StreamSource } from '../../db/schema';
import { HttpError } from '../../middleware/errorHandler';

/**
 * Stream source CRUD, written against an owner pair rather than a movie id so
 * Episodes and Live Channels can reuse it without a rewrite.
 *
 * Every read path here returns {@link StreamSourceDto}, which has no `url`
 * field at all. Reading a URL goes through {@link getSourceUrl}, which callers
 * must gate on ADMIN and audit.
 */

export interface SourceOwner {
  ownerType: StreamSourceOwnerType;
  ownerId: string;
}

function ownerFilter(owner: SourceOwner) {
  return and(
    eq(streamSource.ownerType, owner.ownerType),
    eq(streamSource.ownerId, owner.ownerId),
  );
}

/**
 * Maps a row to its DTO.
 *
 * Written as an explicit field list rather than a spread-minus-url: a future
 * column added to the table then has to be named here to be exposed, instead
 * of leaking by default.
 */
export function toStreamSourceDto(row: StreamSource): StreamSourceDto {
  return {
    id: row.id,
    priority: row.priority,
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
    lastTestResult: row.lastTestResult,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Sources for one owner, primary (priority 0) first. */
export async function listSources(owner: SourceOwner): Promise<StreamSourceDto[]> {
  const rows = await db
    .select()
    .from(streamSource)
    .where(ownerFilter(owner))
    .orderBy(asc(streamSource.priority), asc(streamSource.createdAt));

  return rows.map(toStreamSourceDto);
}

/** Loads a source, 404ing if it belongs to a different owner. */
async function requireSource(owner: SourceOwner, sourceId: string): Promise<StreamSource> {
  const [row] = await db
    .select()
    .from(streamSource)
    .where(and(ownerFilter(owner), eq(streamSource.id, sourceId)))
    .limit(1);

  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Stream source not found');

  return row;
}

export async function addSource(
  owner: SourceOwner,
  input: StreamSourceCreateInput,
): Promise<StreamSourceDto> {
  // Default to the end of the fallback chain, so adding a source never quietly
  // demotes the current primary.
  let priority = input.priority;

  if (priority === undefined) {
    const [row] = await db
      .select({ highest: max(streamSource.priority) })
      .from(streamSource)
      .where(ownerFilter(owner));

    priority = row?.highest === null || row?.highest === undefined ? 0 : row.highest + 1;
  }

  const [created] = await db
    .insert(streamSource)
    .values({
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      url: input.url,
      priority,
    })
    .returning();

  if (!created) throw new HttpError(500, 'INTERNAL_ERROR', 'Failed to create stream source');

  return toStreamSourceDto(created);
}

export async function updateSource(
  owner: SourceOwner,
  sourceId: string,
  input: StreamSourceUpdateInput,
): Promise<StreamSourceDto> {
  await requireSource(owner, sourceId);

  const [updated] = await db
    .update(streamSource)
    .set({
      ...(input.url !== undefined && { url: input.url }),
      ...(input.priority !== undefined && { priority: input.priority }),
      // Editing the URL invalidates the previous health result.
      ...(input.url !== undefined && { lastTestedAt: null, lastTestResult: null }),
      updatedAt: new Date(),
    })
    .where(eq(streamSource.id, sourceId))
    .returning();

  if (!updated) throw new HttpError(404, 'NOT_FOUND', 'Stream source not found');

  return toStreamSourceDto(updated);
}

export async function deleteSource(owner: SourceOwner, sourceId: string): Promise<void> {
  await requireSource(owner, sourceId);
  await db.delete(streamSource).where(eq(streamSource.id, sourceId));
}

/**
 * Rewrites priorities to 0,1,2,... in the given order.
 *
 * The list must be exactly the owner's sources: a partial reorder would leave
 * the omitted rows sharing priorities with the reordered ones, and "which one
 * is primary" would stop being answerable.
 */
export async function reorderSources(
  owner: SourceOwner,
  orderedIds: string[],
): Promise<StreamSourceDto[]> {
  const existing = await db
    .select({ id: streamSource.id })
    .from(streamSource)
    .where(ownerFilter(owner));

  const existingIds = new Set(existing.map((row) => row.id));
  const requestedIds = new Set(orderedIds);

  if (requestedIds.size !== orderedIds.length) {
    throw new HttpError(400, 'DUPLICATE_SOURCE_ID', 'orderedIds contains duplicates');
  }

  if (requestedIds.size !== existingIds.size || orderedIds.some((id) => !existingIds.has(id))) {
    throw new HttpError(
      400,
      'INCOMPLETE_ORDER',
      'orderedIds must list every stream source for this owner exactly once',
    );
  }

  const now = new Date();

  await db.transaction(async (tx) => {
    for (const [index, id] of orderedIds.entries()) {
      await tx
        .update(streamSource)
        .set({ priority: index, updatedAt: now })
        .where(eq(streamSource.id, id));
    }
  });

  return listSources(owner);
}

/**
 * Reads the raw URL of a source.
 *
 * The one function in the codebase that returns a stream URL. Callers must be
 * ADMIN-gated and must write an audit entry — see the route.
 */
export async function getSourceUrl(owner: SourceOwner, sourceId: string): Promise<string> {
  const row = await requireSource(owner, sourceId);
  return row.url;
}
