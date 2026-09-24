import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  publicationStatus,
  streamSourceKind,
  streamSourceOwnerType,
  streamTestResult,
  subtitleLanguage,
} from './enums';
import { mediaAsset } from './media';
import type { LocalizedText, PartialLocalizedText } from '@streaming/shared' with { 'resolution-mode': 'import' };

/**
 * Catalogue tables. Phase 5 fills in Movies; `stream_source` and
 * `subtitle_track` are deliberately polymorphic because Episodes (Phase 6) and
 * Live Channels (Phase 7) attach to them through the same shape.
 */

/** A genre label, authored in all three languages. */
export const genre = pgTable('genre', {
  id: uuid('id').primaryKey().defaultRandom(),
  nameI18n: jsonb('name_i18n').$type<LocalizedText>().notNull(),
});

export const movie = pgTable(
  'movie',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    titleI18n: jsonb('title_i18n').$type<LocalizedText>().notNull(),
    overviewI18n: jsonb('overview_i18n').$type<LocalizedText>().notNull(),
    taglineI18n: jsonb('tagline_i18n').$type<PartialLocalizedText>(),
    releaseYear: integer('release_year'),
    runtimeMinutes: integer('runtime_minutes'),
    // Artwork is nullable and ON DELETE RESTRICT by omission: assetService
    // refuses to delete an asset a movie still points at, so there is no path
    // that silently blanks a poster.
    posterAssetId: uuid('poster_asset_id').references(() => mediaAsset.id),
    backdropAssetId: uuid('backdrop_asset_id').references(() => mediaAsset.id),
    status: publicationStatus('status').notNull().default('DRAFT'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The admin list filters by status and orders by creation date.
    index('movie_status_created_at_idx').on(table.status, table.createdAt),
  ],
);

/** Many-to-many between movies and genres. */
export const movieGenre = pgTable(
  'movie_genre',
  {
    movieId: uuid('movie_id')
      .notNull()
      .references(() => movie.id, { onDelete: 'cascade' }),
    genreId: uuid('genre_id')
      .notNull()
      .references(() => genre.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.movieId, table.genreId] }),
    index('movie_genre_genre_id_idx').on(table.genreId),
  ],
);

/**
 * A television series. Carries the artwork and the copy; the watchable parts
 * hang off it through seasons.
 */
export const series = pgTable(
  'series',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    titleI18n: jsonb('title_i18n').$type<LocalizedText>().notNull(),
    overviewI18n: jsonb('overview_i18n').$type<LocalizedText>().notNull(),
    // Same ON DELETE RESTRICT by omission as `movie`: assetService refuses to
    // delete an asset that artwork still points at.
    posterAssetId: uuid('poster_asset_id').references(() => mediaAsset.id),
    backdropAssetId: uuid('backdrop_asset_id').references(() => mediaAsset.id),
    status: publicationStatus('status').notNull().default('DRAFT'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('series_status_created_at_idx').on(table.status, table.createdAt)],
);

/**
 * A numbered season.
 *
 * Deliberately has no copy of its own — operators label these "Season 2", not
 * something translatable — so there is nothing here to localise and no detail
 * endpoint to serve.
 *
 * The cascade is real: dropping a series takes its seasons with it. The service
 * layer refuses that delete unless the series is an empty draft, so the cascade
 * is a safety net rather than the normal path.
 */
export const season = pgTable(
  'season',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seriesId: uuid('series_id')
      .notNull()
      .references(() => series.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Two "Season 1"s under one series is always a mistake. This unique index
    // also serves lookups by series_id, so no separate index is needed.
    unique('season_series_number_key').on(table.seriesId, table.number),
  ],
);

/**
 * One episode. The series-side equivalent of a movie: it is the thing that owns
 * stream sources and subtitle tracks, and the thing that gets published.
 */
export const episode = pgTable(
  'episode',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => season.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    titleI18n: jsonb('title_i18n').$type<LocalizedText>().notNull(),
    // Nullable where a movie's overview is not; see EpisodeCreateInput.
    overviewI18n: jsonb('overview_i18n').$type<LocalizedText>(),
    thumbnailAssetId: uuid('thumbnail_asset_id').references(() => mediaAsset.id),
    status: publicationStatus('status').notNull().default('DRAFT'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('episode_season_number_key').on(table.seasonId, table.number),
    // The season-delete guard counts published episodes in a season, and the
    // series detail response aggregates the same thing per season.
    index('episode_season_status_idx').on(table.seasonId, table.status),
  ],
);

/**
 * A linear broadcast channel.
 *
 * The flattest thing in the catalogue: no seasons, no episodes, and — unlike
 * movies and episodes — no subtitle tracks, because a live feed carries its own
 * captions if it carries any at all. What it shares with them is `stream_source`,
 * which is where the actual playable URLs live.
 *
 * `category` is a plain string rather than a foreign key to `genre`: operators
 * group channels by broadcast category ("News", "Sport"), which is a different
 * vocabulary from the genre taxonomy that films are tagged with, and forcing
 * both through one table would make each list noisy for the other.
 */
export const liveChannel = pgTable(
  'live_channel',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nameI18n: jsonb('name_i18n').$type<LocalizedText>().notNull(),
    // Same ON DELETE RESTRICT by omission as `movie` artwork: assetService
    // refuses to delete an asset a channel still points at.
    logoAssetId: uuid('logo_asset_id').references(() => mediaAsset.id),
    category: text('category').notNull(),
    sortOrder: integer('sort_order').notNull().default(2147483647),
    status: publicationStatus('status').notNull().default('DRAFT'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('live_channel_sort_order_idx').on(table.sortOrder),
    // Creation date remains the tie-breaker for newly added channels.
    index('live_channel_status_created_at_idx').on(table.status, table.createdAt),
    // ...and filters by category independently of status.
    index('live_channel_category_idx').on(table.category),
  ],
);

/**
 * A playable URL for some catalogue entity.
 *
 * `url` is plain text by design — no encryption at rest in this system. It is
 * kept out of every DTO instead (see `omitStreamUrl` in @streaming/shared), so
 * the column is only ever read by the dedicated view-url and test endpoints.
 *
 * `owner_id` has no foreign key: the column points at whichever table
 * `owner_type` names, which SQL cannot express as a single constraint.
 * Deletion of an owner therefore has to clean up its sources explicitly.
 */
export const streamSource = pgTable(
  'stream_source',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerType: streamSourceOwnerType('owner_type').notNull(),
    ownerId: uuid('owner_id').notNull(),
    /** 0 is the primary source; higher numbers are ordered fallbacks. */
    priority: integer('priority').notNull().default(0),
    url: text('url').notNull(),
    /**
     * Whether `url` is a media file or a third-party player page. Defaults to
     * DIRECT so every row that predates the column keeps its meaning.
     */
    kind: streamSourceKind('kind').notNull().default('DIRECT'),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastTestResult: streamTestResult('last_test_result'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('stream_source_owner_idx').on(table.ownerType, table.ownerId, table.priority),
  ],
);

/**
 * A subtitle track, sourced either from the media library or from a remote URL.
 * Same polymorphic owner arrangement as `stream_source`.
 */
export const subtitleTrack = pgTable(
  'subtitle_track',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerType: streamSourceOwnerType('owner_type').notNull(),
    ownerId: uuid('owner_id').notNull(),
    language: subtitleLanguage('language').notNull(),
    assetId: uuid('asset_id').references(() => mediaAsset.id),
    externalUrl: text('external_url'),
  },
  (table) => [
    // One track per language per owner — a second English track is a mistake,
    // not a variant.
    unique('subtitle_track_owner_language_key').on(
      table.ownerType,
      table.ownerId,
      table.language,
    ),
    // A track is either library-hosted or remote, never both and never neither.
    check(
      'subtitle_track_exactly_one_source',
      sql`(${table.assetId} is not null) <> (${table.externalUrl} is not null)`,
    ),
    // Phase 2 declared a single owner-type enum for the whole catalogue rather
    // than one per table. Live channels have no subtitle tracks, so the value
    // that the shared enum allows but this table does not is excluded here.
    check(
      'subtitle_track_owner_type_allowed',
      sql`${table.ownerType} in ('MOVIE', 'EPISODE')`,
    ),
  ],
);

/**
 * One manual "Test Source" outcome (Phase 12).
 *
 * A rolling history rather than an audit trail: `streamHealthService` trims
 * each source back to the newest 20 rows after every insert, so this table
 * cannot grow without bound from repeated clicking. The
 * URL is deliberately absent — the row is joined to `stream_source` when one is
 * needed, and `error_message` holds only the short, URL-free reason.
 */
export const healthCheckLog = pgTable(
  'health_check_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    streamSourceId: uuid('stream_source_id')
      .notNull()
      // Cascade: history for a deleted source is noise, and nothing else reads it.
      .references(() => streamSource.id, { onDelete: 'cascade' }),
    result: streamTestResult('result').notNull(),
    /** Round-trip time of the probe. Null when the request never got that far. */
    latencyMs: integer('latency_ms'),
    errorMessage: text('error_message'),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Serves both reads this table has: the newest-first history page and the
    // trim that follows every insert.
    index('health_check_log_source_checked_at_idx').on(
      table.streamSourceId,
      table.checkedAt.desc(),
    ),
  ],
);

export type Genre = typeof genre.$inferSelect;
export type NewGenre = typeof genre.$inferInsert;
export type Movie = typeof movie.$inferSelect;
export type NewMovie = typeof movie.$inferInsert;
export type MovieGenre = typeof movieGenre.$inferSelect;
export type Series = typeof series.$inferSelect;
export type NewSeries = typeof series.$inferInsert;
export type Season = typeof season.$inferSelect;
export type NewSeason = typeof season.$inferInsert;
export type Episode = typeof episode.$inferSelect;
export type NewEpisode = typeof episode.$inferInsert;
export type LiveChannel = typeof liveChannel.$inferSelect;
export type NewLiveChannel = typeof liveChannel.$inferInsert;
export type StreamSource = typeof streamSource.$inferSelect;
export type NewStreamSource = typeof streamSource.$inferInsert;
export type HealthCheckLog = typeof healthCheckLog.$inferSelect;
export type NewHealthCheckLog = typeof healthCheckLog.$inferInsert;
export type SubtitleTrack = typeof subtitleTrack.$inferSelect;
export type NewSubtitleTrack = typeof subtitleTrack.$inferInsert;
