import { and, eq } from 'drizzle-orm';

import type { LocalizedText } from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import { episode, liveChannel, movie, series, streamSource } from '../../db/schema';
import { HttpError } from '../../middleware/errorHandler';
import { recordPublicationAudit } from '../../lib/audit';

/**
 * The publication workflow: DRAFT → PUBLISHED → UNPUBLISHED.
 *
 * Publishing is the only transition with preconditions. They exist because a
 * published row is what the consumer apps read, and every rule here describes
 * something that would render as a hole in that UI — a missing translation, a
 * card with no artwork, a play button with nothing behind it.
 *
 * Unpublishing is deliberately unconditional. It is the escape hatch for
 * content that turned out to be wrong, so it must never be blocked by the same
 * checks that let the content out in the first place.
 */

export const PUBLISHABLE_TYPES = ['movie', 'series', 'episode', 'live_channel'] as const;

export type PublishableType = (typeof PUBLISHABLE_TYPES)[number];

export interface PublishValidationResult {
  valid: boolean;
  /** Empty when `valid`. One human-readable sentence per unmet requirement. */
  reasons: string[];
}

/**
 * A 422 carrying every unmet requirement at once.
 *
 * All reasons are reported together rather than failing on the first: an
 * operator fixing a half-finished movie should learn everything that is missing
 * from one click, not discover it one publish attempt at a time.
 */
export class PublishValidationError extends HttpError {
  constructor(readonly reasons: string[]) {
    super(422, 'PUBLISH_VALIDATION_FAILED', `Cannot publish: ${reasons.join('; ')}`);
    this.name = 'PublishValidationError';
  }
}

/**
 * Accepts either the pool-backed client or an open transaction, so a caller
 * that needs the checks and the status flip to see the same snapshot can pass
 * its `tx` instead of racing against a concurrent edit.
 */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The languages every published entity must carry copy in, with the labels used
 * in the failure messages.
 *
 * Spelled out here rather than imported from `SUPPORTED_LOCALES` for the reason
 * `catalogSchemas.ts` gives at length: @streaming/shared is ESM and this server
 * compiles to CommonJS, so its types cross the boundary but its runtime values
 * do not.
 */
const REQUIRED_LOCALES = [
  ['en', 'English'],
  ['ckb', 'Kurdish Sorani'],
  ['ar', 'Arabic'],
] as const;

/**
 * Names the translations a localized field is missing.
 *
 * Whitespace counts as missing: a title of " " satisfies the NOT NULL column
 * and the create-time Zod trim, but is still nothing to render.
 */
function missingTranslations(value: LocalizedText | null, field: string): string[] {
  if (value === null || typeof value !== 'object') {
    return [`${field} is missing in English, Kurdish Sorani and Arabic`];
  }

  return REQUIRED_LOCALES.filter(([locale]) => {
    const text = (value as Record<string, unknown>)[locale];
    return typeof text !== 'string' || text.trim() === '';
  }).map(([, label]) => `${field} is missing its ${label} translation`);
}

/** True when the entity has at least one playable URL attached. */
async function hasStreamSource(
  exec: Executor,
  ownerType: 'MOVIE' | 'EPISODE' | 'LIVE_CHANNEL',
  ownerId: string,
): Promise<boolean> {
  const rows = await exec
    .select({ id: streamSource.id })
    .from(streamSource)
    .where(and(eq(streamSource.ownerType, ownerType), eq(streamSource.ownerId, ownerId)))
    .limit(1);

  return rows.length > 0;
}

function notFound(contentType: PublishableType): HttpError {
  const labels: Record<PublishableType, string> = {
    movie: 'Movie',
    series: 'Series',
    episode: 'Episode',
    live_channel: 'Live channel',
  };

  return new HttpError(404, 'NOT_FOUND', `${labels[contentType]} not found`);
}

/**
 * Checks whether an entity is complete enough to publish.
 *
 * Never throws on an incomplete entity — an unpublishable movie is a normal
 * editorial state, not an error — so the result is returned and the caller
 * decides. A *missing* entity is different, and still 404s.
 */
export async function validateForPublish(
  contentType: PublishableType,
  id: string,
  exec: Executor = db,
): Promise<PublishValidationResult> {
  const reasons: string[] = [];

  switch (contentType) {
    case 'movie': {
      const [row] = await exec.select().from(movie).where(eq(movie.id, id)).limit(1);
      if (!row) throw notFound(contentType);

      reasons.push(...missingTranslations(row.titleI18n, 'Title'));

      if (row.posterAssetId === null) {
        reasons.push('A poster image is required');
      }

      if (!(await hasStreamSource(exec, 'MOVIE', id))) {
        reasons.push('At least one stream source is required');
      }

      break;
    }

    case 'series': {
      const [row] = await exec.select().from(series).where(eq(series.id, id)).limit(1);
      if (!row) throw notFound(contentType);

      reasons.push(...missingTranslations(row.titleI18n, 'Title'));

      if (row.posterAssetId === null) {
        reasons.push('A poster image is required');
      }

      // Episodes are published one at a time, so a series is publishable
      // before any of them are. Publishing the shell first is what lets an
      // operator release a season episode by episode.

      break;
    }

    case 'episode': {
      const [row] = await exec.select().from(episode).where(eq(episode.id, id)).limit(1);
      if (!row) throw notFound(contentType);

      reasons.push(...missingTranslations(row.titleI18n, 'Title'));

      if (!(await hasStreamSource(exec, 'EPISODE', id))) {
        reasons.push('At least one stream source is required');
      }

      break;
    }

    case 'live_channel': {
      const [row] = await exec.select().from(liveChannel).where(eq(liveChannel.id, id)).limit(1);
      if (!row) throw notFound(contentType);

      reasons.push(...missingTranslations(row.nameI18n, 'Name'));

      if (!(await hasStreamSource(exec, 'LIVE_CHANNEL', id))) {
        reasons.push('At least one stream source is required');
      }

      break;
    }
  }

  return { valid: reasons.length === 0, reasons };
}

/**
 * Writes the new status.
 *
 * A switch rather than a table lookup because Drizzle's `update` is typed per
 * table: a union of the four would erase the column types that make this
 * statement safe to write.
 */
async function setStatus(
  exec: Executor,
  contentType: PublishableType,
  id: string,
  status: 'PUBLISHED' | 'UNPUBLISHED',
): Promise<void> {
  const updatedAt = new Date();

  switch (contentType) {
    case 'movie':
      await exec.update(movie).set({ status, updatedAt }).where(eq(movie.id, id));
      return;
    case 'series':
      await exec.update(series).set({ status, updatedAt }).where(eq(series.id, id));
      return;
    case 'episode':
      await exec.update(episode).set({ status, updatedAt }).where(eq(episode.id, id));
      return;
    case 'live_channel':
      await exec.update(liveChannel).set({ status, updatedAt }).where(eq(liveChannel.id, id));
      return;
  }
}

export interface PublicationResult {
  id: string;
  status: 'PUBLISHED' | 'UNPUBLISHED';
}

/**
 * Validates and publishes, or throws `PublishValidationError` naming everything
 * that is unmet.
 *
 * Both steps run in one transaction so the checks cannot pass against a source
 * that a concurrent request deletes before the status flips.
 */
export async function publishContent(
  contentType: PublishableType,
  id: string,
  adminUserId: string,
): Promise<PublicationResult> {
  await db.transaction(async (tx) => {
    const validation = await validateForPublish(contentType, id, tx);

    if (!validation.valid) throw new PublishValidationError(validation.reasons);

    await setStatus(tx, contentType, id, 'PUBLISHED');
  });

  await recordPublicationAudit(adminUserId, contentType, id, true);

  return { id, status: 'PUBLISHED' };
}

/**
 * Takes an entity off the consumer apps.
 *
 * Unconditional by design — see the note at the top of this file. Publishing an
 * already-published row, or unpublishing a draft, is idempotent rather than a
 * conflict: the caller asked for an end state and gets it.
 */
export async function unpublishContent(
  contentType: PublishableType,
  id: string,
  adminUserId: string,
): Promise<PublicationResult> {
  await setStatus(db, contentType, id, 'UNPUBLISHED');

  await recordPublicationAudit(adminUserId, contentType, id, false);

  return { id, status: 'UNPUBLISHED' };
}
