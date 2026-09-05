import type {
  AdminDeviceProfileDTO,
  DeviceAnalyticsOverviewDTO,
  DeviceContentType,
  RecommendationBoostDTO,
  ScoredRecommendationItem,
  TrendingContentItem,
  WatchContentType,
} from '@streaming/shared';

import { apiFetch } from './api';

/**
 * Device analytics client (Phase 15).
 *
 * Two of these calls are ADMIN-only server-side and will 403 for a VIEWER:
 * {@link getDeviceDetail} and {@link previewDeviceRecommendations}. The UI hides
 * the routes that use them, but the guard that matters is the server's — the
 * hiding is only there so a VIEWER is not offered a door that will not open.
 */

export interface TrendingParams {
  periodDays: number;
  contentType?: WatchContentType;
  limit?: number;
}

export function getDeviceOverview(periodDays: number): Promise<DeviceAnalyticsOverviewDTO> {
  return apiFetch<DeviceAnalyticsOverviewDTO>(
    `/admin/analytics/devices?period_days=${periodDays}`,
  );
}

export function getTrending(params: TrendingParams): Promise<TrendingContentItem[]> {
  const query = new URLSearchParams({
    period_days: String(params.periodDays),
    limit: String(params.limit ?? 25),
  });
  if (params.contentType) query.set('content_type', params.contentType);

  return apiFetch<{ items: TrendingContentItem[] }>(
    `/admin/analytics/trending?${query.toString()}`,
  ).then((body) => body.items);
}

export function getDeviceDetail(deviceId: string): Promise<AdminDeviceProfileDTO> {
  return apiFetch<{ device: AdminDeviceProfileDTO }>(
    `/admin/analytics/devices/${deviceId}`,
  ).then((body) => body.device);
}

/** The audit view: what this device would be shown, and why. */
export function previewDeviceRecommendations(
  deviceId: string,
  limit = 10,
): Promise<{ items: ScoredRecommendationItem[]; cold_start: boolean }> {
  return apiFetch<{ items: ScoredRecommendationItem[]; cold_start: boolean }>(
    `/admin/analytics/devices/${deviceId}/recommendations?limit=${limit}`,
  );
}

export function setDeviceBlocked(deviceId: string, isBlocked: boolean): Promise<void> {
  return apiFetch<void>(`/admin/analytics/devices/${deviceId}/block`, {
    method: 'PATCH',
    body: { is_blocked: isBlocked },
  });
}

/** Active and inactive alike — the table renders the state, not a filtered list. */
export function listBoosts(): Promise<RecommendationBoostDTO[]> {
  return apiFetch<{ boosts: RecommendationBoostDTO[] }>('/admin/recommendation-boosts').then(
    (body) => body.boosts,
  );
}

export interface BoostInput {
  content_type: DeviceContentType;
  content_id: string;
  boost_score: number;
  reason?: string;
  expires_at?: string | null;
}

export function createBoost(input: BoostInput): Promise<{ id: string }> {
  return apiFetch<{ boost: { id: string } }>('/admin/recommendation-boosts', {
    method: 'POST',
    body: input,
  }).then((body) => body.boost);
}

export function removeBoost(id: string): Promise<void> {
  return apiFetch<void>(`/admin/recommendation-boosts/${id}`, { method: 'DELETE' });
}
