import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { liveChannel } from './catalog';

/**
 * Per-viewer state: resume points, watchlist and channel favourites.
 *
 * Schema only in Phase 9 — there are no endpoints for any of it yet, because
 * there is nobody to attribute a row to. Consumer accounts are deferred, so
 * these tables deliberately have no user column; adding one later is a
 * migration, whereas guessing its shape now and getting it wrong is a
 * migration plus a data fix.
 *
 * `content_type`/`content_id` are polymorphic and carry no foreign key, the
 * same arrangement `stream_source` uses: the id points at whichever table
 * `content_type` names, which SQL cannot express as one constraint.
 * `favorite_channel` is the exception — it can only ever mean a live channel,
 * so it gets a real FK and a real cascade.
 */

export const playbackProgress = pgTable(
  'playback_progress',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contentType: text('content_type').notNull(),
    contentId: uuid('content_id').notNull(),
    /** How far in the viewer got. Seconds, not a percentage — a re-encode must not move the resume point. */
    positionSeconds: integer('position_seconds').notNull().default(0),
    /** Nullable: a live stream has no duration, and a VOD's may not be probed yet. */
    durationSeconds: integer('duration_seconds'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // "Where was I in this?" is the only question this table is ever asked.
    index('playback_progress_content_idx').on(table.contentType, table.contentId),
  ],
);

export const watchlistItem = pgTable(
  'watchlist_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contentType: text('content_type').notNull(),
    contentId: uuid('content_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('watchlist_item_content_idx').on(table.contentType, table.contentId)],
);

export const favoriteChannel = pgTable('favorite_channel', {
  id: uuid('id').primaryKey().defaultRandom(),
  channelId: uuid('channel_id')
    .notNull()
    .references(() => liveChannel.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PlaybackProgress = typeof playbackProgress.$inferSelect;
export type NewPlaybackProgress = typeof playbackProgress.$inferInsert;
export type WatchlistItem = typeof watchlistItem.$inferSelect;
export type NewWatchlistItem = typeof watchlistItem.$inferInsert;
export type FavoriteChannel = typeof favoriteChannel.$inferSelect;
export type NewFavoriteChannel = typeof favoriteChannel.$inferInsert;
