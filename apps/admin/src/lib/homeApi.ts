import type {
  ContentSearchResult,
  HomeItemRef,
  HomeItemRefType,
  HomeRowCreateInput,
  HomeRowDto,
  HomeRowUpdateInput,
} from '@streaming/shared';

import { apiFetch } from './api';

/**
 * Home row curation client.
 *
 * Rows arrive with `itemRefs` unresolved — ids and types, no titles — because
 * that is what the server stores. The picker resolves them for display through
 * {@link searchContent}; nothing here caches a title into a ref, so a renamed
 * movie shows its new name the next time the page loads.
 */

export function listHomeRows(): Promise<HomeRowDto[]> {
  return apiFetch<{ rows: HomeRowDto[] }>('/admin/home/rows').then((body) => body.rows);
}

export function getHomeRow(id: string): Promise<HomeRowDto> {
  return apiFetch<{ row: HomeRowDto }>(`/admin/home/rows/${id}`).then((body) => body.row);
}

export function createHomeRow(input: HomeRowCreateInput): Promise<HomeRowDto> {
  return apiFetch<{ row: HomeRowDto }>('/admin/home/rows', { method: 'POST', body: input }).then(
    (body) => body.row,
  );
}

export function updateHomeRow(id: string, input: HomeRowUpdateInput): Promise<HomeRowDto> {
  return apiFetch<{ row: HomeRowDto }>(`/admin/home/rows/${id}`, {
    method: 'PATCH',
    body: input,
  }).then((body) => body.row);
}

export function deleteHomeRow(id: string): Promise<void> {
  return apiFetch<void>(`/admin/home/rows/${id}`, { method: 'DELETE' });
}

/**
 * Bulk reorder.
 *
 * `ids` must name every row — the server rejects a partial list, because rows
 * it was not told about would keep their old positions and interleave
 * unpredictably with the dense sequence it assigns.
 */
export function reorderHomeRows(ids: string[]): Promise<HomeRowDto[]> {
  return apiFetch<{ rows: HomeRowDto[] }>('/admin/home/rows/reorder', {
    method: 'PUT',
    body: { ids },
  }).then((body) => body.rows);
}

/** Convenience wrapper for the item editor, which only ever patches refs. */
export function setHomeRowItems(id: string, itemRefs: HomeItemRef[]): Promise<HomeRowDto> {
  return updateHomeRow(id, { item_refs: itemRefs });
}

export interface ContentSearchParams {
  q?: string;
  type?: HomeItemRefType;
}

/**
 * Resolves refs a row already holds to their titles.
 *
 * Only currently-published content comes back. A ref with no entry in the
 * result is unpublished or deleted — the editor renders it as unavailable
 * rather than hiding it, because it is still in the row and still removable.
 */
export function lookupContent(refs: HomeItemRef[]): Promise<ContentSearchResult[]> {
  if (refs.length === 0) return Promise.resolve([]);

  const query = new URLSearchParams({
    refs: refs.map((ref) => `${ref.type}:${ref.id}`).join(','),
  });

  return apiFetch<{ results: ContentSearchResult[] }>(
    `/admin/home/content-lookup?${query.toString()}`,
  ).then((body) => body.results);
}

/** Published content only — a draft cannot appear on Home, so it is not offered. */
export function searchContent(params: ContentSearchParams = {}): Promise<ContentSearchResult[]> {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.type) query.set('type', params.type);

  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch<{ results: ContentSearchResult[] }>(
    `/admin/home/content-search${suffix}`,
  ).then((body) => body.results);
}
