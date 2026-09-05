import { index, integer, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

import type {
  HomeItemRef,
  LocalizedText,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

/**
 * Manually-curated Home rows (Phase 10).
 *
 * `item_refs` is jsonb rather than a `home_row_item` join table, and that is
 * the one design decision in this file worth defending. A join table would buy
 * referential integrity — a deleted movie could not leave a dangling row — at
 * the cost of making the thing an operator actually manipulates (an *ordered
 * list*) into rows with a position column that has to be renumbered on every
 * drag. Ordering is the entire job here, so the ordered value is stored as an
 * ordered value.
 *
 * What that trades away is handled at read time instead: `homeService` treats
 * every ref as a claim to be checked, skipping any whose target is missing or
 * unpublished. That check is needed regardless of storage — a join table with a
 * cascade would still have to filter drafts — so the FK would have removed only
 * the "deleted" half of a test that must exist either way.
 */
export const homeRow = pgTable(
  'home_row',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    titleI18n: jsonb('title_i18n').$type<LocalizedText>().notNull(),
    /**
     * Ascending display position.
     *
     * Not unique: a reorder rewrites every row's position, and a unique index
     * would make any such rewrite fail halfway through on a transient
     * collision unless it were deferrable. The reorder endpoint assigns dense
     * 0..n-1 values in one transaction, and ties break by id, so equal values
     * are merely untidy rather than nondeterministic.
     */
    order: integer('order').notNull().default(0),
    itemRefs: jsonb('item_refs').$type<HomeItemRef[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Every read of this table — admin list and consumer Home alike — is
    // "all rows, in order".
    index('home_row_order_idx').on(table.order, table.id),
  ],
);

export type HomeRow = typeof homeRow.$inferSelect;
export type NewHomeRow = typeof homeRow.$inferInsert;
