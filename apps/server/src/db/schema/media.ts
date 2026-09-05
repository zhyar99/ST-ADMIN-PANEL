import { integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** What a stored file is used for. */
export const mediaAssetKind = pgEnum('media_asset_kind', [
  'POSTER',
  'BACKDROP',
  'THUMBNAIL',
  'LOGO',
  'SUBTITLE',
  'AD_CREATIVE',
]);

/** Processing state of a stored file (derivatives, probing, ...). */
export const mediaAssetStatus = pgEnum('media_asset_status', ['PENDING', 'READY', 'FAILED']);

/**
 * One row per file under apps/server/storage/, served at /storage/*.
 * `file_path` is storage-relative — never an absolute filesystem path.
 */
export const mediaAsset = pgTable('media_asset', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: mediaAssetKind('kind').notNull(),
  filePath: text('file_path').notNull(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes'),
  width: integer('width'),
  height: integer('height'),
  status: mediaAssetStatus('status').notNull().default('PENDING'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type MediaAsset = typeof mediaAsset.$inferSelect;
export type NewMediaAsset = typeof mediaAsset.$inferInsert;
