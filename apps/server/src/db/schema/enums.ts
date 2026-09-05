import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Cross-cutting Postgres enums.
 *
 * They are declared here in Phase 2 so later content phases import them
 * instead of redefining (and accidentally diverging from) the same type.
 */

/** Editorial lifecycle shared by every catalog entity. */
export const publicationStatus = pgEnum('publication_status', [
  'DRAFT',
  'PUBLISHED',
  'UNPUBLISHED',
]);

/** Which entity a `stream_source` row belongs to (Phase 5). */
export const streamSourceOwnerType = pgEnum('stream_source_owner_type', [
  'MOVIE',
  'EPISODE',
  'LIVE_CHANNEL',
]);

/** Languages a subtitle track can be authored in. Mirrors SUPPORTED_LOCALES. */
export const subtitleLanguage = pgEnum('subtitle_language', ['en', 'ar', 'ckb']);

/** Outcome of a manual stream playability check (Phase 5). */
export const streamTestResult = pgEnum('stream_test_result', ['OK', 'FAILED']);
