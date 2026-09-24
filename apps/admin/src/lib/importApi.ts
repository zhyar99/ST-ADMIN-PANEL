import type {
  ImportEntryDto,
  ImportEntryStatus,
  ImportJobDetailDto,
  ImportJobDto,
  ImportLinkTargetDto,
} from '@streaming/shared';

import { apiFetch } from './api';

/**
 * Playlist import client.
 *
 * `ImportEntryDto.rawUrl` is optional in the type because the server omits it
 * for a VIEWER, so the compiler makes every render path handle its absence —
 * the same arrangement `StreamSourceDto` uses to keep a stream URL out of the
 * catalogue screens.
 */

/** Keyset pages: pass `nextCursor` back as `cursor` to continue. */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export function listImportJobs(params: { cursor?: string; limit?: number } = {}) {
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));

  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch<CursorPage<ImportJobDto>>(`/admin/import/jobs${suffix}`);
}

export function getImportJob(jobId: string): Promise<ImportJobDetailDto> {
  return apiFetch<{ job: ImportJobDetailDto }>(`/admin/import/jobs/${jobId}`).then(
    (body) => body.job,
  );
}

export interface ListEntriesParams {
  status?: ImportEntryStatus;
  cursor?: string;
  limit?: number;
}

export function listImportEntries(
  jobId: string,
  params: ListEntriesParams = {},
): Promise<CursorPage<ImportEntryDto>> {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));

  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch<CursorPage<ImportEntryDto>>(`/admin/import/jobs/${jobId}/entries${suffix}`);
}

export function uploadPlaylist(file: File): Promise<ImportJobDto> {
  const form = new FormData();
  form.append('playlist', file);

  return apiFetch<{ job: ImportJobDto }>('/admin/import/jobs', {
    method: 'POST',
    body: form,
  }).then((body) => body.job);
}

export type ImportTargetType = 'LIVE_CHANNEL' | 'MOVIE';

export interface ApproveEntryInput {
  mappedType: ImportTargetType;
  /** Exactly one of these: create a stub, or attach to an existing item. */
  createNew?: boolean;
  targetId?: string;
}

export function approveEntry(
  jobId: string,
  entryId: string,
  input: ApproveEntryInput,
): Promise<ImportEntryDto> {
  return apiFetch<{ entry: ImportEntryDto }>(
    `/admin/import/jobs/${jobId}/entries/${entryId}/approve`,
    { method: 'PATCH', body: input },
  ).then((body) => body.entry);
}

export function rejectEntry(
  jobId: string,
  entryId: string,
  note?: string,
): Promise<ImportEntryDto> {
  return apiFetch<{ entry: ImportEntryDto }>(
    `/admin/import/jobs/${jobId}/entries/${entryId}/reject`,
    { method: 'PATCH', body: note ? { note } : {} },
  ).then((body) => body.entry);
}

export interface BulkApproveResult {
  approved: number;
  skipped: number;
}

export function bulkApproveEntries(
  jobId: string,
  mappedType: ImportTargetType,
  entryIds?: string[],
): Promise<BulkApproveResult> {
  return apiFetch<BulkApproveResult>(`/admin/import/jobs/${jobId}/bulk-approve`, {
    method: 'POST',
    // Bulk approval only ever creates stubs — linking is a per-entry decision.
    body: { mappedType, createNew: true, ...(entryIds ? { entryIds } : {}) },
  });
}

export function deleteImportJob(jobId: string): Promise<void> {
  return apiFetch<void>(`/admin/import/jobs/${jobId}`, { method: 'DELETE' });
}

/** Catalogue items an entry can be attached to, drafts included. */
export function listLinkTargets(params: {
  type: ImportTargetType;
  q?: string;
  limit?: number;
}): Promise<ImportLinkTargetDto[]> {
  const query = new URLSearchParams({ type: params.type });
  if (params.q) query.set('q', params.q);
  if (params.limit) query.set('limit', String(params.limit));

  return apiFetch<{ targets: ImportLinkTargetDto[] }>(
    `/admin/import/link-targets?${query.toString()}`,
  ).then((body) => body.targets);
}

/** Where a duplicate's existing owner lives in the admin panel. */
export function catalogPathFor(owner: { type: string; id: string }): string | null {
  if (owner.type === 'LIVE_CHANNEL') return `/live-tv/${owner.id}`;
  if (owner.type === 'MOVIE') return `/movies/${owner.id}`;
  // An episode is addressed through its season, which this row does not know.
  return null;
}
