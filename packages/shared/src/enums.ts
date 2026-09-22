/**
 * Shared enums. Each list is the canonical ordering and must stay in lockstep
 * with the matching Postgres enum in `apps/server/src/db/schema/`.
 */

/** What a stored file is used for. Mirrors the `media_asset_kind` pg enum. */
export const MEDIA_ASSET_KINDS = [
  'POSTER',
  'BACKDROP',
  'THUMBNAIL',
  'LOGO',
  'SUBTITLE',
  'AD_CREATIVE',
] as const;

export type MediaAssetKind = (typeof MEDIA_ASSET_KINDS)[number];

/** Processing state of a stored file. Mirrors the `media_asset_status` pg enum. */
export const MEDIA_ASSET_STATUSES = ['PENDING', 'READY', 'FAILED'] as const;

export type MediaAssetStatus = (typeof MEDIA_ASSET_STATUSES)[number];

/** Editorial lifecycle of a catalogue entity. Mirrors `publication_status`. */
export const PUBLICATION_STATUSES = ['DRAFT', 'PUBLISHED', 'UNPUBLISHED'] as const;

export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

/** Which entity a stream source or subtitle track hangs off. */
export const STREAM_SOURCE_OWNER_TYPES = ['MOVIE', 'EPISODE', 'LIVE_CHANNEL'] as const;

export type StreamSourceOwnerType = (typeof STREAM_SOURCE_OWNER_TYPES)[number];

/**
 * How a stream source's URL is meant to be played. Mirrors `stream_source_kind`.
 *
 * `DIRECT` is a media URL the player hands to a video element — an .mp4 file or
 * an HLS manifest. `EMBED` is a third-party player page (`https://play.example/
 * e/movie/1204680?autostart=true`), which serves HTML and therefore has to be
 * loaded in an iframe or a webview.
 *
 * Stored rather than inferred: an embed page usually has no file extension and
 * a manifest often carries a query string, so the URL alone does not say which
 * kind it is. Only the operator adding it knows.
 */
export const STREAM_SOURCE_KINDS = ['DIRECT', 'EMBED'] as const;

export type StreamSourceKind = (typeof STREAM_SOURCE_KINDS)[number];

/** Outcome of a manual stream playability check. Mirrors `stream_test_result`. */
export const STREAM_TEST_RESULTS = ['OK', 'FAILED'] as const;

export type StreamTestResult = (typeof STREAM_TEST_RESULTS)[number];

/**
 * Languages a subtitle track can be authored in. Mirrors the `subtitle_language`
 * pg enum, whose ordering differs from SUPPORTED_LOCALES.
 */
export const SUBTITLE_LANGUAGES = ['en', 'ar', 'ckb'] as const;

export type SubtitleLanguage = (typeof SUBTITLE_LANGUAGES)[number];

/** Lifecycle of a bulk playlist import. Mirrors the `import_job_status` pg enum. */
export const IMPORT_JOB_STATUSES = ['PENDING', 'PROCESSING', 'DONE', 'FAILED'] as const;

export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];

/** Review state of one staged playlist entry. Mirrors `import_entry_status`. */
export const IMPORT_ENTRY_STATUSES = ['STAGED', 'APPROVED', 'REJECTED', 'DUPLICATE'] as const;

export type ImportEntryStatus = (typeof IMPORT_ENTRY_STATUSES)[number];

/**
 * What a staged entry is destined to become. `UNKNOWN` is the state every entry
 * starts in — the parser reads a playlist, which says nothing about whether a
 * URL is a channel or a film, so the decision is the reviewer's.
 */
export const IMPORT_MAPPED_TYPES = ['LIVE_CHANNEL', 'MOVIE', 'EPISODE', 'UNKNOWN'] as const;

export type ImportMappedType = (typeof IMPORT_MAPPED_TYPES)[number];

/** The subset of {@link IMPORT_MAPPED_TYPES} an approval may actually target. */
export const IMPORT_APPROVABLE_TYPES = ['LIVE_CHANNEL', 'MOVIE'] as const;

export type ImportApprovableType = (typeof IMPORT_APPROVABLE_TYPES)[number];

/**
 * What a `watch_event` row can point at. Mirrors the `watch_content_type` pg
 * enum.
 *
 * `EPISODE` and not `SERIES`: a viewer watches an episode, and the completion
 * rate of a 42-minute episode is a real number where the completion rate of a
 * five-season show is not. The rollup to the series happens at read time.
 */
export const WATCH_CONTENT_TYPES = ['MOVIE', 'EPISODE', 'LIVE_CHANNEL'] as const;

export type WatchContentType = (typeof WATCH_CONTENT_TYPES)[number];

/**
 * What a device may favourite, watchlist or be recommended. Mirrors the
 * `device_content_type` pg enum.
 *
 * `SERIES` and not `EPISODE`, for the mirror-image reason: nobody adds episode
 * 4 of season 2 to a watchlist, they add the show.
 */
export const DEVICE_CONTENT_TYPES = ['MOVIE', 'SERIES', 'LIVE_CHANNEL'] as const;

export type DeviceContentType = (typeof DEVICE_CONTENT_TYPES)[number];
