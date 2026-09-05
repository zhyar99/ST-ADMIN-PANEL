import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { mediaAsset } from './media';

/**
 * Fixed-rule VOD advertising (Phase 11).
 *
 * The whole feature is two tables because the product decision is that ad
 * breaks are a *platform setting*, not a campaign system: one global timing
 * rule, and a pool of creatives one of which is handed to each VOD session.
 * There is no advertiser, no targeting, no frequency cap and no impression
 * record here — those belong to a campaign model that does not exist yet, and
 * seeding half of one now would make the eventual real thing a migration
 * rather than an addition.
 */

/**
 * The single global ad timing rule.
 *
 * `singleton` is the one column not in the feature's vocabulary, and it earns
 * its place: it is `true` on every row, unique, and constrained to be true, so
 * "there is at most one ad_config" is enforced by Postgres rather than by every
 * caller remembering to check. Without it the get-or-create in
 * `adConfigRepository` is a read-then-write race — two admins opening the page
 * at once would insert two configs, and which one governs playback would be
 * whichever the next query happened to return first.
 *
 * Seconds and minutes are stored as plain integers rather than an interval:
 * the API speaks in `minSeconds`/`intervalMinutes`, a player counts in the
 * same units, and an interval would have to be converted back at every edge.
 */
export const adConfig = pgTable(
  'ad_config',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    singleton: boolean('singleton').notNull().default(true).unique(),
    preRollMinSeconds: integer('pre_roll_min_seconds').notNull().default(5),
    preRollMaxSeconds: integer('pre_roll_max_seconds').notNull().default(10),
    midRollIntervalMinutes: integer('mid_roll_interval_minutes').notNull().default(30),
    midRollMaxSeconds: integer('mid_roll_max_seconds').notNull().default(30),
    skipAfterSeconds: integer('skip_after_seconds').notNull().default(5),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('ad_config_singleton_true', sql`${table.singleton} = true`),
    // The same ordering Zod enforces at the route boundary, restated where a
    // hand-written UPDATE also has to obey it.
    check(
      'ad_config_pre_roll_range',
      sql`${table.preRollMinSeconds} >= 1 and ${table.preRollMaxSeconds} >= ${table.preRollMinSeconds}`,
    ),
    check(
      'ad_config_positive_intervals',
      sql`${table.midRollIntervalMinutes} >= 1 and ${table.midRollMaxSeconds} >= 1 and ${table.skipAfterSeconds} >= 1`,
    ),
  ],
);

export type AdConfig = typeof adConfig.$inferSelect;
export type NewAdConfig = typeof adConfig.$inferInsert;

/**
 * The pool of ad creatives one of which each VOD session receives.
 *
 * `asset_id` has no `onDelete` clause on purpose. Deleting a `media_asset`
 * already refuses while anything references it — `ASSET_REFERENCES` in
 * `assetService` lists `ad_creative.asset_id` — so a cascade would only serve
 * to make that guard reachable-but-pointless, and a creative whose file
 * silently vanished is exactly the state the guard exists to prevent.
 *
 * `duration_seconds` is stored rather than probed from the file: nothing in
 * this system decodes video, and the player needs a number before it fetches
 * the creative. It is what the operator typed, so it is advisory — the same
 * status the timing fields in `ad_config` have.
 */
export const adCreative = pgTable(
  'ad_creative',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => mediaAsset.id),
    durationSeconds: integer('duration_seconds').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('ad_creative_duration_positive', sql`${table.durationSeconds} >= 1`),
    // The playback path's only query is "one active creative", and it runs on
    // the latency path of every VOD start.
    index('ad_creative_active_idx').on(table.isActive),
  ],
);

export type AdCreative = typeof adCreative.$inferSelect;
export type NewAdCreative = typeof adCreative.$inferInsert;
