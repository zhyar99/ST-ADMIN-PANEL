import { auditLog } from '../db/schema';
import { db } from '../db/client';
import { logger } from '../logger';

/** Actions recorded in `audit_log`. Publication actions land in Phase 8. */
export type AuditAction =
  | 'LOGIN'
  | 'LOGOUT'
  | 'USER_CREATE'
  | 'USER_UPDATE'
  | 'USER_DELETE'
  | 'ASSET_UPLOAD'
  | 'ASSET_DELETE'
  | 'GENRE_CREATE'
  | 'GENRE_UPDATE'
  | 'GENRE_DELETE'
  | 'MOVIE_CREATE'
  | 'MOVIE_UPDATE'
  | 'MOVIE_DELETE'
  | 'SERIES_CREATE'
  | 'SERIES_UPDATE'
  | 'SERIES_DELETE'
  | 'SEASON_CREATE'
  /** Cascades to the season's episodes, so worth recording separately. */
  | 'SEASON_DELETE'
  | 'EPISODE_CREATE'
  | 'EPISODE_UPDATE'
  | 'EPISODE_DELETE'
  | 'LIVE_CHANNEL_CREATE'
  | 'LIVE_CHANNEL_UPDATE'
  | 'LIVE_CHANNEL_REORDER'
  /** Cascades to the channel's stream sources, so worth recording separately. */
  | 'LIVE_CHANNEL_DELETE'
  | 'STREAM_SOURCE_CREATE'
  | 'STREAM_SOURCE_UPDATE'
  | 'STREAM_SOURCE_DELETE'
  | 'STREAM_SOURCE_REORDER'
  /** Someone read a raw stream URL — the main reason audit_log exists. */
  | 'STREAM_SOURCE_VIEWED'
  | 'STREAM_SOURCE_TESTED'
  | 'SUBTITLE_CREATE'
  | 'SUBTITLE_DELETE'
  | 'PUBLISH'
  | 'UNPUBLISH'
  | 'HOME_ROW_CREATE'
  | 'HOME_ROW_UPDATE'
  | 'HOME_ROW_DELETE'
  /** Bulk position rewrite — spans every row, so it names no single entity. */
  | 'HOME_ROW_REORDER'
  /** Global ad timing — one row, so it names no entity id. */
  | 'AD_CONFIG_UPDATE'
  | 'AD_CREATIVE_CREATE'
  | 'AD_CREATIVE_UPDATE'
  | 'AD_CREATIVE_DELETE'
  | 'IMPORT_JOB_CREATE'
  /** Cascades to every staged entry, so worth recording separately. */
  | 'IMPORT_JOB_DELETE'
  /** A staged playlist line became catalogue content. */
  | 'IMPORT_APPROVE'
  | 'IMPORT_REJECT'
  /** One click, many stubs — the entity is the job, not any single entry. */
  | 'IMPORT_BULK_APPROVE'
  /** A device was cut off from personalized ranking, or restored to it. */
  | 'DEVICE_BLOCK'
  | 'DEVICE_UNBLOCK'
  /** Someone put a thumb on the recommendation scale, or took it off. */
  | 'RECOMMENDATION_BOOST_SET'
  | 'RECOMMENDATION_BOOST_REMOVED';

export interface AuditEntry {
  adminUserId: string | null;
  action: AuditAction;
  entityType?: string;
  entityId?: string;
}

/**
 * Appends an audit row.
 *
 * Auditing is observational: a failure here must not fail the request that
 * triggered it, so the error is logged and swallowed.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLog).values({
      adminUserId: entry.adminUserId,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
    });
  } catch (error) {
    logger.error({ err: error, action: entry.action }, 'Failed to write audit log entry');
  }
}

/**
 * Ready for the content phases — deliberately not wired to any entity yet.
 * Catalogue routes will call this when they flip publication status.
 */
export async function recordPublicationAudit(
  adminUserId: string,
  entityType: string,
  entityId: string,
  published: boolean,
): Promise<void> {
  await recordAudit({
    adminUserId,
    action: published ? 'PUBLISH' : 'UNPUBLISH',
    entityType,
    entityId,
  });
}
