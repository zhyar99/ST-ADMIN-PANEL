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

/**
 * How a `stream_source.url` is meant to be played.
 *
 * `DIRECT` is a media URL the player hands to a video element (an .mp4 file, an
 * HLS manifest). `EMBED` is a third-party player *page* — the URL renders HTML
 * and has to go into an iframe or a webview, so feeding it to a video element
 * yields nothing. The distinction cannot be inferred from the URL: plenty of
 * embed pages have no extension and plenty of manifests have a query string.
 */
export const streamSourceKind = pgEnum('stream_source_kind', ['DIRECT', 'EMBED']);
