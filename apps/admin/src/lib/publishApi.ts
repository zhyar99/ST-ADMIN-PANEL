import type { PublicationStatus } from '@streaming/shared';

import { apiFetch } from './api';

/**
 * Publish / unpublish, for every catalogue entity that has a status.
 *
 * One module rather than a pair of functions in each of catalogApi, seriesApi
 * and liveTvApi: the request shape is identical across all four types, and only
 * the path differs. `PublishActions` is generic over the same union, so keeping
 * the path logic in one place is what lets a single component drive every edit
 * page.
 */

/**
 * Identifies what to publish.
 *
 * An episode carries its season and series ids because that is how the API
 * addresses it — the server proves the episode sits in the named season before
 * touching it, so the nesting is not decorative and cannot be flattened away.
 */
export type PublishTarget =
  | { contentType: 'movie'; id: string }
  | { contentType: 'series'; id: string }
  | { contentType: 'live_channel'; id: string }
  | { contentType: 'episode'; id: string; seriesId: string; seasonId: string };

export interface PublicationResult {
  id: string;
  status: PublicationStatus;
}

function basePath(target: PublishTarget): string {
  switch (target.contentType) {
    case 'movie':
      return `/admin/movies/${target.id}`;
    case 'series':
      return `/admin/series/${target.id}`;
    case 'live_channel':
      return `/admin/live-channels/${target.id}`;
    case 'episode':
      return `/admin/series/${target.seriesId}/seasons/${target.seasonId}/episodes/${target.id}`;
  }
}

/** Rejects with an `ApiError` whose `reasons` list the unmet requirements on a 422. */
export function publishContent(target: PublishTarget): Promise<PublicationResult> {
  return apiFetch<PublicationResult>(`${basePath(target)}/publish`, { method: 'POST' });
}

export function unpublishContent(target: PublishTarget): Promise<PublicationResult> {
  return apiFetch<PublicationResult>(`${basePath(target)}/unpublish`, { method: 'POST' });
}
