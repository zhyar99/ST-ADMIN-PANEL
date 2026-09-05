import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { adminUser } from './admin';

/**
 * Device-based anonymous personalization (Phase 15).
 *
 * The identity model is the thing to understand before anything else here: a
 * *device* is the subject, not a person. The client generates a UUID on first
 * launch, persists it, and sends it as `X-Device-ID`. There is no account, no
 * email and no password anywhere in this file, which is why the phase can ship
 * without the consumer-account work that Phase 9 deferred.
 *
 * `device_id` is `text` rather than `uuid`. The column stores exactly what the
 * client sent, and the middleware is what guarantees the value is a well-formed
 * UUID; keeping the storage type wide means a malformed header is rejected by a
 * validator that can return `INVALID_DEVICE_ID` rather than by a cast that
 * would surface as a 500.
 *
 * The `content_type`/`content_id` pairs below are polymorphic and carry no
 * foreign key, the same arrangement `stream_source` and `home_row` use: the id
 * points at whichever table `content_type` names, which SQL cannot express as
 * one constraint. Every read path therefore treats a ref as a claim and joins
 * it to a PUBLISHED row before returning it.
 */

/**
 * What a watch event points at.
 *
 * `EPISODE` rather than `SERIES`: a completion rate only means something
 * against a runtime, and a series has none. The rollup from episode to series
 * happens in the recommendation query, not in storage.
 */
export const watchContentType = pgEnum('watch_content_type', [
  'MOVIE',
  'EPISODE',
  'LIVE_CHANNEL',
]);

/**
 * What a device may favourite, watchlist, be recommended or have boosted.
 *
 * The mirror image of {@link watchContentType}: nobody watchlists one episode,
 * they watchlist the show.
 */
export const deviceContentType = pgEnum('device_content_type', [
  'MOVIE',
  'SERIES',
  'LIVE_CHANNEL',
]);

/**
 * One anonymous device, and the model built from what it has watched.
 *
 * `genre_affinity` and `top_content_types` are denormalised caches: both are
 * derivable from `watch_event`, and both are stored anyway because the
 * recommendation query reads them on every request and recomputing a vector
 * from a device's whole history per request is the one thing this design cannot
 * afford. They are updated incrementally inside the same transaction as the
 * event that changes them, so they cannot drift from it.
 */
export const deviceProfile = pgTable(
  'device_profile',
  {
    /** The raw UUID sent by the client. */
    id: text('id').primaryKey(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Cumulative seconds watched, ever.
     *
     * `bigint` with `mode: 'number'`: a device would have to watch for 285
     * million years to exceed Number.MAX_SAFE_INTEGER, so the JS number is
     * exact, while a 32-bit integer column would overflow after 68 years of
     * viewing — improbable, but not impossible for a shared lobby screen.
     */
    totalWatchSeconds: bigint('total_watch_seconds', { mode: 'number' }).notNull().default(0),
    /** `{ "<genre_id>": <score 0..1> }`, normalised so the maximum is 1.0. */
    genreAffinity: jsonb('genre_affinity')
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Content types ordered by how much this device watches them. */
    topContentTypes: jsonb('top_content_types')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * Moderation flag. A blocked device still records events — the profile keeps
     * building — but is scored as if it had no history, so it sees the same
     * globally-popular ranking a brand-new device does. Never exposed to the
     * device itself.
     */
    isBlocked: boolean('is_blocked').notNull().default(false),
  },
  (table) => [
    // The analytics overview counts devices seen in a period, and the "new
    // devices" tile counts devices first seen in one.
    index('device_profile_last_seen_at_idx').on(table.lastSeenAt),
    index('device_profile_first_seen_at_idx').on(table.firstSeenAt),
  ],
);

/**
 * One reported viewing session.
 *
 * `completion_rate` is a stored generated column rather than a value the client
 * sends or the service computes: it is a function of two columns in the same
 * row, so letting anything else produce it is an invitation for the number to
 * disagree with the seconds it claims to summarise. `LEAST(..., 1.0)` is
 * belt-and-braces — the service already caps `watch_seconds` at
 * `content_seconds` — and the `content_seconds > 0` guard is what makes an
 * unknown runtime a 0 rather than a division error.
 */
export const watchEvent = pgTable(
  'watch_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: text('device_id')
      .notNull()
      .references(() => deviceProfile.id, { onDelete: 'cascade' }),
    contentType: watchContentType('content_type').notNull(),
    contentId: uuid('content_id').notNull(),
    watchSeconds: integer('watch_seconds').notNull().default(0),
    /** Total runtime of the content. 0 means "unknown", not "instantaneous". */
    contentSeconds: integer('content_seconds').notNull().default(0),
    completionRate: numeric('completion_rate', { precision: 4, scale: 3 }).generatedAlwaysAs(
      sql`(CASE WHEN content_seconds > 0 THEN LEAST(watch_seconds::numeric / content_seconds, 1.0) ELSE 0 END)`,
    ),
    /** Client-side flag: this device had seen this content before. */
    rewatch: boolean('rewatch').notNull().default(false),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // History, the ±60 s de-duplication lookup and the per-device affinity
    // rebuild all read one device newest-first.
    index('watch_event_device_started_at_idx').on(table.deviceId, table.startedAt.desc()),
    // Popularity: "how many devices watched this in the last 30 days".
    index('watch_event_content_idx').on(table.contentType, table.contentId),
    // The retention purge deletes by age on every write, so the predicate it
    // scans has to be indexed or the table's own growth would slow every
    // ingestion.
    index('watch_event_created_at_idx').on(table.createdAt),
  ],
);

/** A device's favourites. Composite PK, so a double-tap is idempotent. */
export const deviceFavorite = pgTable(
  'device_favorite',
  {
    deviceId: text('device_id')
      .notNull()
      .references(() => deviceProfile.id, { onDelete: 'cascade' }),
    contentType: deviceContentType('content_type').notNull(),
    contentId: uuid('content_id').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.deviceId, table.contentType, table.contentId] })],
);

/**
 * A device's watchlist.
 *
 * Structurally identical to {@link deviceFavorite} and deliberately a separate
 * table: "I love this" and "I mean to watch this" are different statements, one
 * of which feeds the ranking (`favorite_score`) while the other does not.
 */
export const deviceWatchlist = pgTable(
  'device_watchlist',
  {
    deviceId: text('device_id')
      .notNull()
      .references(() => deviceProfile.id, { onDelete: 'cascade' }),
    contentType: deviceContentType('content_type').notNull(),
    contentId: uuid('content_id').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.deviceId, table.contentType, table.contentId] })],
);

/**
 * An editorial thumb on the scale, applied to every device's ranking.
 *
 * Additive rather than weighted, and bounded to ±1.0 by the schema in
 * @streaming/shared: the weighted signals sum to at most 1.0, so +1.0 pins an
 * item near the top of any list it is eligible for and -1.0 buries it beneath
 * everything unboosted. `UNIQUE (content_type, content_id)` makes the write an
 * upsert — one standing decision per item, not a stack of them.
 *
 * Deletion is soft (`active = false`) because the audit trail records the
 * removal and a hard delete would leave that record pointing at nothing.
 */
export const recommendationBoost = pgTable(
  'recommendation_boost',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contentType: deviceContentType('content_type').notNull(),
    contentId: uuid('content_id').notNull(),
    boostScore: numeric('boost_score', { precision: 4, scale: 2 }).notNull().default('0.0'),
    reason: text('reason'),
    active: boolean('active').notNull().default(true),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => adminUser.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('recommendation_boost_content_key').on(table.contentType, table.contentId)],
);

export type DeviceProfile = typeof deviceProfile.$inferSelect;
export type NewDeviceProfile = typeof deviceProfile.$inferInsert;
export type WatchEvent = typeof watchEvent.$inferSelect;
export type NewWatchEvent = typeof watchEvent.$inferInsert;
export type DeviceFavorite = typeof deviceFavorite.$inferSelect;
export type NewDeviceFavorite = typeof deviceFavorite.$inferInsert;
export type DeviceWatchlist = typeof deviceWatchlist.$inferSelect;
export type NewDeviceWatchlist = typeof deviceWatchlist.$inferInsert;
export type RecommendationBoost = typeof recommendationBoost.$inferSelect;
export type NewRecommendationBoost = typeof recommendationBoost.$inferInsert;
