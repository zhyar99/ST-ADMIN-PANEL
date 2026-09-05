import { MEDIA_ASSET_KINDS, type AssetDto, type MediaAssetKind } from '@streaming/shared';

import { apiFetch } from './api';

/**
 * Media Library client. Every response is the canonical `AssetDto` from
 * @streaming/shared, so nothing here re-describes the server's shape.
 */

export interface ListAssetsParams {
  kind?: MediaAssetKind;
  page?: number;
  limit?: number;
}

export interface ListAssetsResult {
  items: AssetDto[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

/** URL segment the upload endpoint expects: POSTER -> poster, AD_CREATIVE -> ad-creative. */
export function kindSlug(kind: MediaAssetKind): string {
  return kind.toLowerCase().replace(/_/g, '-');
}

/**
 * `accept` hints for the file picker. Purely a UX filter — the server's multer
 * fileFilter is what actually enforces the allowed types.
 */
export const ACCEPT_BY_KIND: Record<MediaAssetKind, string> = {
  POSTER: 'image/jpeg,image/png,image/webp',
  BACKDROP: 'image/jpeg,image/png,image/webp',
  THUMBNAIL: 'image/jpeg,image/png,image/webp',
  LOGO: 'image/jpeg,image/png,image/webp',
  SUBTITLE: '.vtt,.srt,text/vtt,application/x-subrip,text/plain',
  AD_CREATIVE: 'video/mp4,image/jpeg,image/png',
};

export const KIND_LABELS: Record<MediaAssetKind, string> = {
  POSTER: 'Posters',
  BACKDROP: 'Backdrops',
  THUMBNAIL: 'Thumbnails',
  LOGO: 'Logos',
  SUBTITLE: 'Subtitles',
  AD_CREATIVE: 'Ad Creatives',
};

export const ASSET_KINDS = MEDIA_ASSET_KINDS;

export function listAssets(params: ListAssetsParams = {}): Promise<ListAssetsResult> {
  const query = new URLSearchParams();
  if (params.kind) query.set('kind', params.kind);
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));

  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch<ListAssetsResult>(`/admin/assets${suffix}`);
}

export async function uploadAsset(kind: MediaAssetKind, file: File): Promise<AssetDto> {
  const form = new FormData();
  form.append('file', file);

  const { asset } = await apiFetch<{ asset: AssetDto }>(
    `/admin/assets/upload/${kindSlug(kind)}`,
    { method: 'POST', body: form },
  );

  return asset;
}

export function deleteAsset(id: string): Promise<void> {
  return apiFetch<void>(`/admin/assets/${id}`, { method: 'DELETE' });
}
