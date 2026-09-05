import { config } from '../config';

/**
 * Builds the public URL for a stored file.
 *
 * STORAGE_URL_PREFIX is the only place the host appears — swapping local disk
 * for a CDN origin later is a config change, not a code change.
 */
export function buildAssetUrl(filePath: string): string {
  return `${config.STORAGE_URL_PREFIX.replace(/\/+$/, '')}/${filePath.replace(/^\/+/, '')}`;
}

/**
 * Nullable variant, for the consumer read paths.
 *
 * Those queries reach `media_asset` through left joins — artwork, thumbnails
 * and subtitle assets are all optional — so `file_path` arrives as `string |
 * null` and the null has to survive all the way into the DTO rather than
 * becoming the string "null" in a URL.
 */
export function assetUrl(filePath: string | null | undefined): string | null {
  return filePath === null || filePath === undefined ? null : buildAssetUrl(filePath);
}
