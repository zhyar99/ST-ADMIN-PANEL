import { randomUUID } from 'node:crypto';

import { and, asc, count, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';

import type {
  ImportApprovableType,
  ImportEntryDto,
  ImportEntryStatus,
  ImportJobDetailDto,
  ImportJobDto,
  ImportLinkTargetDto,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../../db/client';
import {
  importEntry,
  importJob,
  liveChannel,
  movie,
  streamSource,
  type ImportEntry,
  type ImportJob,
  type NewImportEntry,
} from '../../db/schema';
import { HttpError } from '../../middleware/errorHandler';
import { logger } from '../../logger';
import { parseM3U, type ParsedEntry } from './m3uParser';

/**
 * Playlist import: staging, review and approval.
 *
 * The invariant the whole phase exists to protect is that an uploaded playlist
 * writes nothing into the catalogue. Parsing produces `import_entry` rows and
 * stops; a `live_channel` or `movie` appears only when a reviewer approves an
 * entry, and it appears as a DRAFT with no artwork, so it still has to pass the
 * Phase 8 publish checks before anyone can watch it.
 *
 * `import_entry.raw_url` is treated exactly like `stream_source.url`: it is
 * never logged, and {@link toImportEntryDto} only puts it on the wire for an
 * ADMIN.
 */

/**
 * The point past which synchronous parsing stops being reasonable.
 *
 * Deliberately a hard stop rather than a truncation: silently importing the
 * first 200 000 lines of a larger file would look like success and leave the
 * operator to discover the missing channels later. Crossing it is the signal
 * that the background-worker item in Section 25 has become necessary.
 */
export const MAX_IMPORT_ENTRIES = 200_000;

export const TOO_MANY_ENTRIES_MESSAGE =
  'File too large for synchronous import; pg-boss background processing is required (Section 25 item).';

/** Rows per statement. Keeps the bind-parameter count well under Postgres' limit. */
const INSERT_BATCH = 500;

/** Accepts either the pool-backed client or an open transaction. */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Category given to a stub whose playlist entry carried no `group-title`. */
const FALLBACK_CATEGORY = 'Imported';

// --- DTOs ------------------------------------------------------------------

export function toImportJobDto(row: ImportJob): ImportJobDto {
  return {
    id: row.id,
    filename: row.filename,
    status: row.status,
    totalEntries: row.totalEntries,
    approvedCount: row.approvedCount,
    rejectedCount: row.rejectedCount,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** An entry row joined to the owner of the source it duplicates, if any. */
interface EntryRow {
  entry: ImportEntry;
  duplicateOwnerType: 'MOVIE' | 'EPISODE' | 'LIVE_CHANNEL' | null;
  duplicateOwnerId: string | null;
}

/**
 * Maps an entry to its DTO.
 *
 * `includeUrl` is the security boundary, and it is passed in by the route from
 * the caller's role rather than defaulted here — so adding a new read path
 * forces the question "may this caller see the URL?" to be answered explicitly.
 */
export function toImportEntryDto(row: EntryRow, includeUrl: boolean): ImportEntryDto {
  const { entry } = row;

  return {
    id: entry.id,
    lineNumber: entry.lineNumber,
    rawName: entry.rawName,
    ...(includeUrl ? { rawUrl: entry.rawUrl } : {}),
    rawLogo: entry.rawLogo,
    rawGroup: entry.rawGroup,
    rawTvgId: entry.rawTvgId,
    mappedType: entry.mappedType,
    mappedId: entry.mappedId,
    status: entry.status,
    duplicateOf: entry.duplicateOf,
    duplicateOwner:
      row.duplicateOwnerType && row.duplicateOwnerId
        ? { type: row.duplicateOwnerType, id: row.duplicateOwnerId }
        : null,
    adminNote: entry.adminNote,
  };
}

// --- keyset pagination -----------------------------------------------------

/**
 * Cursor pagination rather than the page/limit the catalogue lists use.
 *
 * One job can hold 200 000 entries, and `OFFSET 190000` makes Postgres walk
 * every skipped row. A keyset cursor is a constant-cost seek into the index
 * these tables already carry.
 */
function encodeCursor(parts: readonly (string | number)[]): string {
  return Buffer.from(parts.join(' '), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, expected: number): string[] {
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split(' ');

  if (parts.length !== expected) {
    throw new HttpError(400, 'INVALID_CURSOR', 'The pagination cursor is not valid');
  }

  return parts;
}

export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` for the next page; null when this was the last one. */
  nextCursor: string | null;
}

// --- reads -----------------------------------------------------------------

export interface ListJobsParams {
  cursor?: string;
  limit: number;
}

/** Import jobs, newest first. */
export async function listImportJobs(params: ListJobsParams): Promise<Page<ImportJobDto>> {
  let where;

  if (params.cursor) {
    const [createdAt, id] = decodeCursor(params.cursor, 2);
    const at = new Date(createdAt!);

    if (Number.isNaN(at.getTime())) {
      throw new HttpError(400, 'INVALID_CURSOR', 'The pagination cursor is not valid');
    }

    // Strictly "older than", with the id breaking ties on identical timestamps.
    where = or(
      lt(importJob.createdAt, at),
      and(eq(importJob.createdAt, at), lt(importJob.id, id!)),
    );
  }

  const rows = await db
    .select()
    .from(importJob)
    .where(where)
    .orderBy(desc(importJob.createdAt), desc(importJob.id))
    .limit(params.limit + 1);

  const page = rows.slice(0, params.limit);
  const last = page.at(-1);

  return {
    items: page.map(toImportJobDto),
    nextCursor:
      rows.length > params.limit && last
        ? encodeCursor([last.createdAt.toISOString(), last.id])
        : null,
  };
}

/** Loads a job row or 404s. */
export async function requireImportJob(jobId: string): Promise<ImportJob> {
  const [row] = await db.select().from(importJob).where(eq(importJob.id, jobId)).limit(1);

  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Import job not found');

  return row;
}

/** Per-status tallies for one job, as a single GROUP BY. */
async function entryCountsFor(jobId: string): Promise<Record<ImportEntryStatus, number>> {
  const rows = await db
    .select({ status: importEntry.status, value: count() })
    .from(importEntry)
    .where(eq(importEntry.jobId, jobId))
    .groupBy(importEntry.status);

  const counts: Record<ImportEntryStatus, number> = {
    STAGED: 0,
    APPROVED: 0,
    REJECTED: 0,
    DUPLICATE: 0,
  };

  for (const row of rows) counts[row.status] = row.value;

  return counts;
}

export async function getImportJobDetail(jobId: string): Promise<ImportJobDetailDto> {
  const row = await requireImportJob(jobId);

  return { ...toImportJobDto(row), entryCounts: await entryCountsFor(jobId) };
}

export interface ListEntriesParams {
  jobId: string;
  status?: ImportEntryStatus;
  cursor?: string;
  limit: number;
  /** True only for an ADMIN — decides whether `rawUrl` reaches the response. */
  includeUrl: boolean;
}

/** One job's entries, in source order. */
export async function listImportEntries(params: ListEntriesParams): Promise<Page<ImportEntryDto>> {
  const filters = [
    eq(importEntry.jobId, params.jobId),
    params.status ? eq(importEntry.status, params.status) : undefined,
  ].filter((filter) => filter !== undefined);

  if (params.cursor) {
    const [lineNumber, id] = decodeCursor(params.cursor, 2);
    const line = Number(lineNumber);

    if (!Number.isInteger(line)) {
      throw new HttpError(400, 'INVALID_CURSOR', 'The pagination cursor is not valid');
    }

    filters.push(
      or(
        sql`${importEntry.lineNumber} > ${line}`,
        and(eq(importEntry.lineNumber, line), sql`${importEntry.id} > ${id!}::uuid`),
      )!,
    );
  }

  const rows = await db
    .select({
      entry: importEntry,
      duplicateOwnerType: streamSource.ownerType,
      duplicateOwnerId: streamSource.ownerId,
    })
    .from(importEntry)
    // Joined for the "already in the catalogue" link. Selects the owner pair
    // only; the joined table's URL column is never read on this path.
    .leftJoin(streamSource, eq(streamSource.id, importEntry.duplicateOf))
    .where(and(...filters))
    .orderBy(asc(importEntry.lineNumber), asc(importEntry.id))
    .limit(params.limit + 1);

  const page = rows.slice(0, params.limit);
  const last = page.at(-1);

  return {
    items: page.map((row) => toImportEntryDto(row, params.includeUrl)),
    nextCursor:
      rows.length > params.limit && last
        ? encodeCursor([last.entry.lineNumber, last.entry.id])
        : null,
  };
}

/**
 * Catalogue items an entry can be linked to.
 *
 * Deliberately not the Home curation search: that one returns PUBLISHED rows
 * only, and the item a reviewer most often wants to attach a second source to
 * is a draft that someone imported ten minutes ago.
 */
export async function listLinkTargets(params: {
  type: ImportApprovableType;
  q?: string;
  limit: number;
}): Promise<ImportLinkTargetDto[]> {
  const term = params.q?.trim();
  // Escapes the LIKE metacharacters so a search for "100%" is a literal one.
  const pattern = term ? `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null;

  if (params.type === 'LIVE_CHANNEL') {
    const rows = await db
      .select({
        id: liveChannel.id,
        name: sql<string | null>`${liveChannel.nameI18n} ->> 'en'`,
        status: liveChannel.status,
      })
      .from(liveChannel)
      .where(pattern ? sql`${liveChannel.nameI18n} ->> 'en' ilike ${pattern}` : undefined)
      .orderBy(desc(liveChannel.createdAt), desc(liveChannel.id))
      .limit(params.limit);

    return withSourceCounts(rows, 'LIVE_CHANNEL');
  }

  const rows = await db
    .select({
      id: movie.id,
      name: sql<string | null>`${movie.titleI18n} ->> 'en'`,
      status: movie.status,
    })
    .from(movie)
    .where(pattern ? sql`${movie.titleI18n} ->> 'en' ilike ${pattern}` : undefined)
    .orderBy(desc(movie.createdAt), desc(movie.id))
    .limit(params.limit);

  return withSourceCounts(rows, 'MOVIE');
}

/** Attaches "how many sources does this already have" in one grouped query. */
async function withSourceCounts(
  rows: { id: string; name: string | null; status: ImportLinkTargetDto['status'] }[],
  type: ImportApprovableType,
): Promise<ImportLinkTargetDto[]> {
  if (rows.length === 0) return [];

  const counted = await db
    .select({ ownerId: streamSource.ownerId, value: count() })
    .from(streamSource)
    .where(
      and(
        eq(streamSource.ownerType, type),
        inArray(
          streamSource.ownerId,
          rows.map((row) => row.id),
        ),
      ),
    )
    .groupBy(streamSource.ownerId);

  const counts = new Map(counted.map((row) => [row.ownerId, row.value]));

  return rows.map((row) => ({
    id: row.id,
    type,
    name: row.name ?? '(untitled)',
    status: row.status,
    sourceCount: counts.get(row.id) ?? 0,
  }));
}

// --- upload ----------------------------------------------------------------

interface ExistingSource {
  id: string;
  ownerType: string;
  ownerId: string;
}

/** Looks up which of these URLs the catalogue already serves. */
async function existingSourcesByUrl(urls: string[]): Promise<Map<string, ExistingSource>> {
  const found = new Map<string, ExistingSource>();

  // Chunked: a 200 000-channel playlist would otherwise build one IN list with
  // 200 000 bind parameters, which Postgres will not accept.
  for (let offset = 0; offset < urls.length; offset += INSERT_BATCH) {
    const rows = await db
      .select({
        id: streamSource.id,
        url: streamSource.url,
        ownerType: streamSource.ownerType,
        ownerId: streamSource.ownerId,
      })
      .from(streamSource)
      .where(inArray(streamSource.url, urls.slice(offset, offset + INSERT_BATCH)));

    for (const row of rows) {
      found.set(row.url, { id: row.id, ownerType: row.ownerType, ownerId: row.ownerId });
    }
  }

  return found;
}

/**
 * Turns parsed lines into the rows that will be staged.
 *
 * Two kinds of repeat are marked DUPLICATE. One is a URL the catalogue already
 * serves, which is the case the brief names, and it carries a `duplicate_of`
 * pointing at that source. The other is a URL that appears twice inside the
 * uploaded file — routine in provider playlists, which list the same feed under
 * several groups — and it has no `duplicate_of` to point at, so it says so in
 * `admin_note` instead. Without the second check, bulk-approving a file with
 * 200 repeats would silently create 200 identical channels.
 */
function stageRows(
  jobId: string,
  entries: ParsedEntry[],
  existing: Map<string, ExistingSource>,
): NewImportEntry[] {
  const seen = new Map<string, number>();

  return entries.map((entry) => {
    const alreadyInCatalogue = existing.get(entry.rawUrl);
    const firstSeenOnLine = seen.get(entry.rawUrl);

    if (firstSeenOnLine === undefined) seen.set(entry.rawUrl, entry.lineNumber);

    const base: NewImportEntry = {
      jobId,
      lineNumber: entry.lineNumber,
      rawName: entry.rawName,
      rawUrl: entry.rawUrl,
      rawLogo: entry.rawLogo,
      rawGroup: entry.rawGroup,
      rawTvgId: entry.rawTvgId,
    };

    if (alreadyInCatalogue) {
      return { ...base, status: 'DUPLICATE' as const, duplicateOf: alreadyInCatalogue.id };
    }

    if (firstSeenOnLine !== undefined) {
      return {
        ...base,
        status: 'DUPLICATE' as const,
        adminNote: `Repeated in this playlist; first seen on line ${firstSeenOnLine}.`,
      };
    }

    return { ...base, status: 'STAGED' as const };
  });
}

/**
 * Parses an uploaded playlist into a staged job.
 *
 * Runs inside the HTTP request by design — there is no background runner in
 * this phase — which is what {@link MAX_IMPORT_ENTRIES} exists to bound.
 */
export async function createImportJob(
  adminUserId: string,
  filename: string,
  fileContent: string,
): Promise<ImportJobDto> {
  const [job] = await db
    .insert(importJob)
    .values({ filename, status: 'PROCESSING', createdBy: adminUserId })
    .returning();

  if (!job) throw new HttpError(500, 'INTERNAL_ERROR', 'Failed to create the import job');

  try {
    let skipped = 0;
    const entries = parseM3U(fileContent, () => {
      skipped += 1;
    });

    if (skipped > 0) {
      // Counted, not enumerated: the reason is per line and the URL may never be
      // logged, so a total is all there is worth saying.
      logger.info({ jobId: job.id, skipped }, 'Playlist lines skipped: unsupported URL');
    }

    if (entries.length > MAX_IMPORT_ENTRIES) {
      await failJob(job.id, TOO_MANY_ENTRIES_MESSAGE);
      throw new HttpError(413, 'IMPORT_TOO_LARGE', TOO_MANY_ENTRIES_MESSAGE);
    }

    const existing = await existingSourcesByUrl([...new Set(entries.map((entry) => entry.rawUrl))]);
    const rows = stageRows(job.id, entries, existing);

    for (let offset = 0; offset < rows.length; offset += INSERT_BATCH) {
      await db.insert(importEntry).values(rows.slice(offset, offset + INSERT_BATCH));
    }

    const [done] = await db
      .update(importJob)
      .set({ status: 'DONE', totalEntries: rows.length, updatedAt: new Date() })
      .where(eq(importJob.id, job.id))
      .returning();

    return toImportJobDto(done ?? job);
  } catch (error) {
    if (error instanceof HttpError) throw error;

    logger.error({ err: error, jobId: job.id }, 'Import job failed');
    await failJob(job.id, 'The playlist could not be parsed.');

    throw new HttpError(500, 'IMPORT_FAILED', 'The playlist could not be imported.');
  }
}

/**
 * Records a failure on the job.
 *
 * The message is written here and never quotes the uploaded file: a playlist is
 * attacker-controlled text, and reflecting it into a stored error message would
 * carry it back out to every reader of the job list.
 */
async function failJob(jobId: string, message: string): Promise<void> {
  await db
    .update(importJob)
    .set({ status: 'FAILED', errorMessage: message, updatedAt: new Date() })
    .where(eq(importJob.id, jobId));
}

// --- approval --------------------------------------------------------------

/**
 * Appends a source to an owner, always at the end of the fallback chain.
 *
 * Never priority 0 on an owner that already has one: promoting an unvetted
 * imported URL over the source an operator chose is exactly the surprise this
 * phase must not spring on anyone.
 */
async function appendSource(
  exec: Executor,
  ownerType: ImportApprovableType,
  ownerId: string,
  url: string,
): Promise<void> {
  const [highest] = await exec
    .select({ value: sql<number | null>`max(${streamSource.priority})` })
    .from(streamSource)
    .where(and(eq(streamSource.ownerType, ownerType), eq(streamSource.ownerId, ownerId)));

  const priority = highest?.value === null || highest?.value === undefined ? 0 : highest.value + 1;

  await exec.insert(streamSource).values({ ownerType, ownerId, url, priority });
}

/**
 * The three-language copy a stub is created with.
 *
 * The same string in all three slots, so the row is legible in every locale
 * while still failing the Phase 8 publish check until somebody translates it.
 */
function stubName(entry: ImportEntry): { en: string; ckb: string; ar: string } {
  const name = entry.rawName?.trim() || `Imported entry (line ${entry.lineNumber})`;

  return { en: name, ckb: name, ar: name };
}

const EMPTY_COPY = { en: '', ckb: '', ar: '' };

async function requireEntry(jobId: string, entryId: string): Promise<ImportEntry> {
  const [row] = await db
    .select()
    .from(importEntry)
    .where(and(eq(importEntry.jobId, jobId), eq(importEntry.id, entryId)))
    .limit(1);

  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Import entry not found');

  return row;
}

/** Confirms a link target exists, and that it is the type the caller claimed. */
async function requireLinkTarget(type: ImportApprovableType, targetId: string): Promise<void> {
  const label = type === 'LIVE_CHANNEL' ? 'live channel' : 'movie';

  const [row] =
    type === 'LIVE_CHANNEL'
      ? await db
          .select({ id: liveChannel.id })
          .from(liveChannel)
          .where(eq(liveChannel.id, targetId))
          .limit(1)
      : await db.select({ id: movie.id }).from(movie).where(eq(movie.id, targetId)).limit(1);

  if (!row) {
    throw new HttpError(400, 'TARGET_NOT_FOUND', `targetId does not name an existing ${label}`);
  }
}

export interface ApproveOptions {
  targetId?: string;
  createNew?: boolean;
}

/**
 * Approves one staged entry.
 *
 * Only a STAGED entry is approvable. A DUPLICATE is left alone on purpose: the
 * reviewer's next move there is to open the item that already serves the URL,
 * not to attach it a second time.
 */
export async function approveEntry(
  jobId: string,
  entryId: string,
  mappedType: ImportApprovableType,
  options: ApproveOptions,
): Promise<ImportEntryDto> {
  const entry = await requireEntry(jobId, entryId);

  if (entry.status !== 'STAGED') {
    throw new HttpError(
      409,
      'ENTRY_NOT_STAGED',
      `Only a staged entry can be approved; this one is ${entry.status}`,
    );
  }

  const createNew = options.createNew === true;

  // Exactly one of the two, so "create a stub" and "attach to that item" can
  // never both be meant by the same request.
  if (createNew === (options.targetId !== undefined)) {
    throw new HttpError(
      400,
      'INVALID_APPROVAL',
      'Supply either createNew:true or a targetId, but not both',
    );
  }

  if (options.targetId) await requireLinkTarget(mappedType, options.targetId);

  const updated = await db.transaction(async (tx) => {
    const mappedId = options.targetId ?? randomUUID();

    if (createNew) {
      if (mappedType === 'LIVE_CHANNEL') {
        await tx.insert(liveChannel).values({
          id: mappedId,
          nameI18n: stubName(entry),
          category: entry.rawGroup?.trim() || FALLBACK_CATEGORY,
          // `status` is left at its DRAFT default: a stub has no logo and no
          // real translations, so it must not become publishable by accident.
        });
      } else {
        await tx.insert(movie).values({
          id: mappedId,
          titleI18n: stubName(entry),
          overviewI18n: EMPTY_COPY,
        });
      }
    }

    await appendSource(tx, mappedType, mappedId, entry.rawUrl);

    const [row] = await tx
      .update(importEntry)
      .set({ status: 'APPROVED', mappedType, mappedId })
      .where(eq(importEntry.id, entry.id))
      .returning();

    await tx
      .update(importJob)
      .set({ approvedCount: sql`${importJob.approvedCount} + 1`, updatedAt: new Date() })
      .where(eq(importJob.id, jobId));

    return row!;
  });

  // Approval is ADMIN-gated, so the caller may see the URL it just approved.
  return toImportEntryDto({ entry: updated, duplicateOwnerType: null, duplicateOwnerId: null }, true);
}

/** Marks an entry reviewed-and-not-wanted, with an optional reason. */
export async function rejectEntry(
  jobId: string,
  entryId: string,
  note?: string,
): Promise<ImportEntryDto> {
  const entry = await requireEntry(jobId, entryId);

  if (entry.status === 'APPROVED' || entry.status === 'REJECTED') {
    throw new HttpError(
      409,
      'ENTRY_ALREADY_REVIEWED',
      `This entry is already ${entry.status.toLowerCase()}`,
    );
  }

  const [updated] = await db
    .update(importEntry)
    // An empty note leaves whatever was already there — for a DUPLICATE that is
    // the "repeated on line N" note, which is worth keeping.
    .set({ status: 'REJECTED', adminNote: note?.trim() || entry.adminNote })
    .where(eq(importEntry.id, entry.id))
    .returning();

  await db
    .update(importJob)
    .set({ rejectedCount: sql`${importJob.rejectedCount} + 1`, updatedAt: new Date() })
    .where(eq(importJob.id, jobId));

  return toImportEntryDto({ entry: updated!, duplicateOwnerType: null, duplicateOwnerId: null }, true);
}

export interface BulkApproveResult {
  approved: number;
  /** Entries left untouched because they are DUPLICATE, APPROVED or REJECTED. */
  skipped: number;
}

/**
 * Creates a stub for every STAGED entry in a job.
 *
 * The unit of work is one transaction over batched statements rather than a
 * loop of {@link approveEntry} calls: a 5 000-channel playlist would otherwise
 * be 20 000 round trips, and a failure halfway would leave half a catalogue
 * behind with no record of where it stopped.
 */
export async function bulkApproveEntries(
  jobId: string,
  mappedType: ImportApprovableType,
  createNew: boolean,
): Promise<BulkApproveResult> {
  await requireImportJob(jobId);

  if (!createNew) {
    throw new HttpError(
      400,
      'INVALID_BULK_APPROVAL',
      'Bulk approval creates stubs; call it with createNew:true, or approve entries one at a time to link them to existing items',
    );
  }

  const counts = await entryCountsFor(jobId);
  const staged = await db
    .select()
    .from(importEntry)
    .where(and(eq(importEntry.jobId, jobId), eq(importEntry.status, 'STAGED')))
    .orderBy(asc(importEntry.lineNumber), asc(importEntry.id));

  const skipped = counts.DUPLICATE + counts.APPROVED + counts.REJECTED;

  if (staged.length === 0) return { approved: 0, skipped };

  const assigned = staged.map((entry) => ({ entry, mappedId: randomUUID() }));

  await db.transaction(async (tx) => {
    for (let offset = 0; offset < assigned.length; offset += INSERT_BATCH) {
      const batch = assigned.slice(offset, offset + INSERT_BATCH);

      if (mappedType === 'LIVE_CHANNEL') {
        await tx.insert(liveChannel).values(
          batch.map(({ entry, mappedId }) => ({
            id: mappedId,
            nameI18n: stubName(entry),
            category: entry.rawGroup?.trim() || FALLBACK_CATEGORY,
          })),
        );
      } else {
        await tx.insert(movie).values(
          batch.map(({ entry, mappedId }) => ({
            id: mappedId,
            titleI18n: stubName(entry),
            overviewI18n: EMPTY_COPY,
          })),
        );
      }

      // Every stub here is brand new, so each source is that owner's first and
      // priority 0 is correct with no max() lookup.
      await tx.insert(streamSource).values(
        batch.map(({ entry, mappedId }) => ({
          ownerType: mappedType,
          ownerId: mappedId,
          url: entry.rawUrl,
          priority: 0,
        })),
      );

      // One UPDATE ... FROM (VALUES ...) per batch: `mapped_id` differs per row,
      // so a plain `WHERE id IN (...)` cannot express the assignment.
      const pairs = sql.join(
        batch.map(({ entry, mappedId }) => sql`(${entry.id}::uuid, ${mappedId}::uuid)`),
        sql`, `,
      );

      await tx.execute(sql`
        update ${importEntry} as e
        set status = 'APPROVED',
            mapped_type = ${mappedType}::import_mapped_type,
            mapped_id = v.mapped_id
        from (values ${pairs}) as v(id, mapped_id)
        where e.id = v.id
      `);
    }

    await tx
      .update(importJob)
      .set({
        approvedCount: sql`${importJob.approvedCount} + ${assigned.length}`,
        updatedAt: new Date(),
      })
      .where(eq(importJob.id, jobId));
  });

  return { approved: assigned.length, skipped };
}

/**
 * Discards a job and its staged entries.
 *
 * The cascade is a foreign key, so nothing here touches the catalogue: channels
 * and movies created by earlier approvals outlive their import job, which is
 * the point — the job is a review queue, not an owner.
 */
export async function deleteImportJob(jobId: string): Promise<void> {
  const job = await requireImportJob(jobId);

  if (job.status !== 'DONE' && job.status !== 'FAILED') {
    throw new HttpError(409, 'JOB_IN_PROGRESS', 'Only a finished or failed import job can be deleted');
  }

  await db.delete(importJob).where(eq(importJob.id, jobId));
}
