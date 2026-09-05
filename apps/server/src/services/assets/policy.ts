import type { MediaAssetKind } from '@streaming/shared' with { 'resolution-mode': 'import' };

import { mediaAssetKind } from '../../db/schema';

/**
 * The single source of truth for what may be uploaded, how big it may be and
 * where it lands on disk. Both the multer layer and the image validator read
 * from here, so the rules cannot drift apart between "rejected" and "checked".
 */

export type AssetKind = (typeof mediaAssetKind.enumValues)[number];

const MB = 1024 * 1024;

export type ImageOrientation = 'portrait' | 'landscape' | 'any';

export interface ImageConstraint {
  minWidth: number;
  minHeight: number;
  orientation: ImageOrientation;
}

export interface KindPolicy {
  /** Lower-case URL segment: POST /admin/assets/upload/<slug>. */
  slug: string;
  /** Subdirectory under STORAGE_DIR. Also the first segment of `file_path`. */
  directory: string;
  maxBytes: number;
  /**
   * Mime types accepted by the multer fileFilter. The stored extension is
   * derived from this map, never from the client-supplied filename.
   */
  extensionByMime: Readonly<Record<string, string>>;
  /** Dimension rules applied by the image validator; absent = no image check. */
  image?: ImageConstraint;
}

const IMAGE_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

/**
 * Keyed by the *shared* enum on purpose: if the pg enum and
 * `@streaming/shared` ever diverge, every `ASSET_POLICY[kind]` lookup below
 * stops compiling instead of silently 500-ing at runtime.
 */
export const ASSET_POLICY: Readonly<Record<MediaAssetKind, KindPolicy>> = {
  POSTER: {
    slug: 'poster',
    directory: 'posters',
    maxBytes: 10 * MB,
    extensionByMime: IMAGE_EXTENSIONS,
    image: { minWidth: 300, minHeight: 450, orientation: 'portrait' },
  },
  BACKDROP: {
    slug: 'backdrop',
    directory: 'backdrops',
    maxBytes: 10 * MB,
    extensionByMime: IMAGE_EXTENSIONS,
    image: { minWidth: 1280, minHeight: 720, orientation: 'landscape' },
  },
  THUMBNAIL: {
    slug: 'thumbnail',
    directory: 'thumbnails',
    maxBytes: 10 * MB,
    extensionByMime: IMAGE_EXTENSIONS,
    image: { minWidth: 640, minHeight: 360, orientation: 'landscape' },
  },
  LOGO: {
    slug: 'logo',
    directory: 'logos',
    maxBytes: 10 * MB,
    extensionByMime: IMAGE_EXTENSIONS,
    image: { minWidth: 100, minHeight: 100, orientation: 'any' },
  },
  SUBTITLE: {
    slug: 'subtitle',
    directory: 'subtitles',
    // Phase 13: tightened from 5 MB. A feature-length WebVTT or SRT track is a
    // few hundred kilobytes; anything near this ceiling is not a subtitle file.
    maxBytes: 2 * MB,
    // Browsers send .srt as text/plain, so it has to be allowed; the stored
    // extension for text/plain is taken from the original name (srt or vtt).
    extensionByMime: {
      'text/vtt': 'vtt',
      'application/x-subrip': 'srt',
      'text/plain': 'srt',
    },
  },
  AD_CREATIVE: {
    slug: 'ad-creative',
    directory: 'ad-creatives',
    maxBytes: 50 * MB,
    extensionByMime: {
      'video/mp4': 'mp4',
      'image/jpeg': 'jpg',
      'image/png': 'png',
    },
    // Creative dimensions are campaign-specific; nothing to enforce yet.
  },
};

const KIND_BY_SLUG: ReadonlyMap<string, AssetKind> = new Map(
  mediaAssetKind.enumValues.map((kind) => [ASSET_POLICY[kind].slug, kind]),
);

/** Resolves `poster` / `POSTER` / `ad-creative` to a kind, or null if unknown. */
export function kindFromSlug(slug: string): AssetKind | null {
  return KIND_BY_SLUG.get(slug.trim().toLowerCase()) ?? null;
}

export const ASSET_KIND_SLUGS: readonly string[] = [...KIND_BY_SLUG.keys()];

/**
 * Picks the on-disk extension for an accepted upload. The mime type decides;
 * the original filename is consulted only to tell .srt from .vtt when the
 * browser flattened both to text/plain — and only from a fixed allowlist, so a
 * crafted name can never steer the extension.
 */
export function extensionFor(kind: AssetKind, mimeType: string, originalName: string): string {
  const fallback = ASSET_POLICY[kind].extensionByMime[mimeType] ?? 'bin';

  if (kind !== 'SUBTITLE' || mimeType !== 'text/plain') return fallback;

  return originalName.toLowerCase().endsWith('.vtt') ? 'vtt' : 'srt';
}
