import { index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { adminUser } from './admin';
import { streamSource } from './catalog';

/**
 * Bulk playlist import staging (Phase 14).
 *
 * Nothing in here is part of the catalogue. An uploaded `.m3u` lands as a job
 * plus one `import_entry` per playable line, and those rows are inert until a
 * reviewer approves them one at a time or in bulk — which is the whole point of
 * the staging step: a provider playlist is untrusted, unranked and frequently
 * wrong, so it must never write straight into published content.
 *
 * `import_entry.raw_url` carries the same secret as `stream_source.url` and is
 * governed by the same rule: never logged, and never serialised into a response
 * to a VIEWER.
 */

/** Lifecycle of one upload. Mirrors `ImportJobStatus` in @streaming/shared. */
export const importJobStatus = pgEnum('import_job_status', [
  'PENDING',
  'PROCESSING',
  'DONE',
  'FAILED',
]);

/** Review state of one staged line. Mirrors `ImportEntryStatus`. */
export const importEntryStatus = pgEnum('import_entry_status', [
  'STAGED',
  'APPROVED',
  'REJECTED',
  'DUPLICATE',
]);

/**
 * What a staged line is destined to become.
 *
 * Wider than the two types an approval accepts: `EPISODE` is reserved for the
 * per-series import that Section 25 covers, and `UNKNOWN` is where every entry
 * starts, because a playlist says nothing about whether a URL is a channel or a
 * film.
 */
export const importMappedType = pgEnum('import_mapped_type', [
  'LIVE_CHANNEL',
  'MOVIE',
  'EPISODE',
  'UNKNOWN',
]);

export const importJob = pgTable(
  'import_job',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    filename: text('filename').notNull(),
    status: importJobStatus('status').notNull().default('PENDING'),
    totalEntries: integer('total_entries').notNull().default(0),
    approvedCount: integer('approved_count').notNull().default(0),
    rejectedCount: integer('rejected_count').notNull().default(0),
    /** Short and URL-free — the uploaded file's content never lands here. */
    errorMessage: text('error_message'),
    // `set null` rather than a cascade, matching `audit_log`: removing a member
    // of staff must not erase the record of what they imported.
    createdBy: uuid('created_by').references(() => adminUser.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The job list is newest-first and keyset-paginated on exactly this pair.
    index('import_job_created_at_id_idx').on(table.createdAt.desc(), table.id.desc()),
  ],
);

export const importEntry = pgTable(
  'import_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      // A job's entries are meaningless without it, and deleting a job is the
      // documented way to discard a bad import.
      .references(() => importJob.id, { onDelete: 'cascade' }),
    /** Where the entry begins in the source file: its `#EXTINF:`, else its URL. */
    lineNumber: integer('line_number').notNull(),
    rawName: text('raw_name'),
    /** Same secret as `stream_source.url`. Never logged, never sent to a VIEWER. */
    rawUrl: text('raw_url').notNull(),
    /** Stored as text only — nothing in this phase fetches it (Section 25). */
    rawLogo: text('raw_logo'),
    rawGroup: text('raw_group'),
    rawTvgId: text('raw_tvg_id'),
    mappedType: importMappedType('mapped_type').notNull().default('UNKNOWN'),
    /** The catalogue row this entry became. No FK: it names two tables. */
    mappedId: uuid('mapped_id'),
    status: importEntryStatus('status').notNull().default('STAGED'),
    // `set null`, not cascade: deleting the source this entry duplicates makes
    // the entry a normal candidate again, not a row to throw away.
    duplicateOf: uuid('duplicate_of').references(() => streamSource.id, { onDelete: 'set null' }),
    adminNote: text('admin_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Serves the entry list, which is always scoped to one job, ordered by line
    // number, and usually filtered by status.
    index('import_entry_job_line_idx').on(table.jobId, table.lineNumber, table.id),
    index('import_entry_job_status_idx').on(table.jobId, table.status),
  ],
);

export type ImportJob = typeof importJob.$inferSelect;
export type NewImportJob = typeof importJob.$inferInsert;
export type ImportEntry = typeof importEntry.$inferSelect;
export type NewImportEntry = typeof importEntry.$inferInsert;
