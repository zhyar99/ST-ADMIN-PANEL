import { z } from 'zod';

import { importEntryStatus, importMappedType } from '../db/schema';

/**
 * Zod shapes for the Phase 14 import routes.
 *
 * Named to match the other files in this directory (`catalogSchemas`,
 * `assetSchemas`) rather than the bare `import.ts` the brief suggests: `import`
 * is a reserved word, and a module by that name reads badly at every call site.
 *
 * Enum values come from the Drizzle schema so they cannot drift from the
 * database. The 200 000-entry ceiling is deliberately *not* here — it is a
 * property of the parsed file, not of the request, so it lives in the service.
 */

const uuid = z.string().uuid();

/** Only two of the four mapped types are a legal approval target. */
const approvableType = z.enum(['LIVE_CHANNEL', 'MOVIE'] as const satisfies readonly [
  (typeof importMappedType.enumValues)[number],
  (typeof importMappedType.enumValues)[number],
]);

/**
 * Keyset cursor, opaque to the client.
 *
 * Bounded and base64url-shaped so a malformed value is rejected here rather
 * than reaching `Buffer.from`, which silently accepts nearly anything.
 */
const cursor = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, 'cursor is not a valid pagination cursor');

export const jobIdParam = z.object({ jobId: uuid });

export const entryParams = z.object({ jobId: uuid, entryId: uuid });

export const listJobsQuery = z.object({
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const listEntriesQuery = z.object({
  status: z.enum(importEntryStatus.enumValues).optional(),
  cursor: cursor.optional(),
  // Higher ceiling than the job list: one job holds up to 200 000 entries and
  // the review table is meant to be scrolled.
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const approveEntryBody = z.object({
  mappedType: approvableType,
  targetId: uuid.optional(),
  createNew: z.boolean().optional(),
});

export const rejectEntryBody = z.object({
  note: z.string().trim().max(500).optional(),
});

export const bulkApproveBody = z.object({
  mappedType: approvableType,
  createNew: z.boolean(),
  entryIds: z.array(uuid).min(1).max(1000).refine((ids) => new Set(ids).size === ids.length, "Entry ids must be unique").optional(),
});

export const linkTargetsQuery = z.object({
  type: approvableType,
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type ApproveEntryBody = z.infer<typeof approveEntryBody>;
export type BulkApproveBody = z.infer<typeof bulkApproveBody>;
export type ListEntriesQuery = z.infer<typeof listEntriesQuery>;
