import type {
  LiveChannelCreateInput,
  BulkChannelPublicationResult,
  MoveLiveChannelInput,
  LiveChannelDetailDto,
  LiveChannelListItemDto,
  LiveChannelUpdateInput,
  PublicationStatus,
  StreamSourceCreateInput,
  StreamSourceDto,
  StreamSourceUpdateInput,
} from '@streaming/shared';

import { apiFetch } from './api';
import type { StreamTestOutcome } from './catalogApi';

/**
 * Live TV client.
 *
 * Source calls mirror `catalogApi`'s movie ones exactly — same endpoints under
 * a different owner prefix — and return the same `StreamSourceDto`, so the
 * absence of a `url` field is enforced by the compiler here as well as by the
 * server.
 */

// --- Channels ---

export interface ListLiveChannelsParams {
  status?: PublicationStatus;
  category?: string;
  page?: number;
  limit?: number;
}

export interface ListLiveChannelsResult {
  items: LiveChannelListItemDto[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export function listLiveChannels(
  params: ListLiveChannelsParams = {},
): Promise<ListLiveChannelsResult> {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.category) query.set('category', params.category);
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));

  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch<ListLiveChannelsResult>(`/admin/live-channels${suffix}`);
}

/** Distinct categories in use, for the list page filter. */
export function listChannelCategories(): Promise<string[]> {
  return apiFetch<{ categories: string[] }>('/admin/live-channels/categories').then(
    (body) => body.categories,
  );
}

export function getLiveChannel(id: string): Promise<LiveChannelDetailDto> {
  return apiFetch<{ channel: LiveChannelDetailDto }>(`/admin/live-channels/${id}`).then(
    (body) => body.channel,
  );
}

export function createLiveChannel(input: LiveChannelCreateInput): Promise<LiveChannelDetailDto> {
  return apiFetch<{ channel: LiveChannelDetailDto }>('/admin/live-channels', {
    method: 'POST',
    body: input,
  }).then((body) => body.channel);
}

export function updateLiveChannel(
  id: string,
  input: LiveChannelUpdateInput,
): Promise<LiveChannelDetailDto> {
  return apiFetch<{ channel: LiveChannelDetailDto }>(`/admin/live-channels/${id}`, {
    method: 'PATCH',
    body: input,
  }).then((body) => body.channel);
}

export function deleteLiveChannel(id: string): Promise<void> {
  return apiFetch<void>(`/admin/live-channels/${id}`, { method: 'DELETE' });
}

// --- Stream sources ---

export function listChannelSources(channelId: string): Promise<StreamSourceDto[]> {
  return apiFetch<{ sources: StreamSourceDto[] }>(
    `/admin/live-channels/${channelId}/sources`,
  ).then((body) => body.sources);
}

export function addChannelSource(
  channelId: string,
  input: StreamSourceCreateInput,
): Promise<StreamSourceDto> {
  return apiFetch<{ source: StreamSourceDto }>(`/admin/live-channels/${channelId}/sources`, {
    method: 'POST',
    body: input,
  }).then((body) => body.source);
}

export function updateChannelSource(
  channelId: string,
  sourceId: string,
  input: StreamSourceUpdateInput,
): Promise<StreamSourceDto> {
  return apiFetch<{ source: StreamSourceDto }>(
    `/admin/live-channels/${channelId}/sources/${sourceId}`,
    { method: 'PATCH', body: input },
  ).then((body) => body.source);
}

export function deleteChannelSource(channelId: string, sourceId: string): Promise<void> {
  return apiFetch<void>(`/admin/live-channels/${channelId}/sources/${sourceId}`, {
    method: 'DELETE',
  });
}

export function reorderChannelSources(
  channelId: string,
  orderedIds: string[],
): Promise<StreamSourceDto[]> {
  return apiFetch<{ sources: StreamSourceDto[] }>(
    `/admin/live-channels/${channelId}/sources/reorder`,
    { method: 'POST', body: { orderedIds } },
  ).then((body) => body.sources);
}

/** ADMIN-only and audited server-side — every call writes an audit_log row. */
export function getChannelSourceUrl(channelId: string, sourceId: string): Promise<string> {
  return apiFetch<{ url: string }>(
    `/admin/live-channels/${channelId}/sources/${sourceId}/url`,
  ).then((body) => body.url);
}

export function testChannelSource(
  channelId: string,
  sourceId: string,
): Promise<StreamTestOutcome> {
  return apiFetch<StreamTestOutcome>(
    `/admin/live-channels/${channelId}/sources/${sourceId}/test`,
    { method: 'POST' },
  );
}

export function bulkChannelPublication(ids: string[], status: 'PUBLISHED' | 'UNPUBLISHED') {
  return apiFetch<BulkChannelPublicationResult>('/admin/live-channels/bulk-publication', {
    method: 'POST', body: { ids, status },
  });
}

export function moveLiveChannel(input: MoveLiveChannelInput): Promise<void> {
  return apiFetch<void>('/admin/live-channels/reorder', { method: 'POST', body: input });
}
