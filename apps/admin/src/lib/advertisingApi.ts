import type {
  AdConfigDto,
  AdConfigUpdateInput,
  AdCreativeCreateInput,
  AdCreativeDto,
  AdCreativeUpdateInput,
} from '@streaming/shared';

import { apiFetch } from './api';

/**
 * Advertising client (Phase 11).
 *
 * The config is a single resource, not a collection — there is one global ad
 * timing rule and the server refuses to hold a second — so there is no id in
 * any of these paths and no list endpoint for it.
 */

export function getAdConfig(): Promise<AdConfigDto> {
  return apiFetch<{ config: AdConfigDto }>('/admin/advertising/config').then((body) => body.config);
}

export function updateAdConfig(input: AdConfigUpdateInput): Promise<AdConfigDto> {
  return apiFetch<{ config: AdConfigDto }>('/admin/advertising/config', {
    method: 'PUT',
    body: input,
  }).then((body) => body.config);
}

/** Active and inactive alike, newest first — the table shows both. */
export function listAdCreatives(): Promise<AdCreativeDto[]> {
  return apiFetch<{ creatives: AdCreativeDto[] }>('/admin/advertising/creatives').then(
    (body) => body.creatives,
  );
}

export function createAdCreative(input: AdCreativeCreateInput): Promise<AdCreativeDto> {
  return apiFetch<{ creative: AdCreativeDto }>('/admin/advertising/creatives', {
    method: 'POST',
    body: input,
  }).then((body) => body.creative);
}

export function updateAdCreative(
  id: string,
  input: AdCreativeUpdateInput,
): Promise<AdCreativeDto> {
  return apiFetch<{ creative: AdCreativeDto }>(`/admin/advertising/creatives/${id}`, {
    method: 'PATCH',
    body: input,
  }).then((body) => body.creative);
}

export function deleteAdCreative(id: string): Promise<void> {
  return apiFetch<void>(`/admin/advertising/creatives/${id}`, { method: 'DELETE' });
}
