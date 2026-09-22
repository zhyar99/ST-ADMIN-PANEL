import { z } from 'zod';

import { mediaAssetKind } from '../db/schema';
import { ASSET_KIND_SLUGS } from '../services/assets/policy';

/**
 * Zod shapes for every untrusted input the asset routes accept. The multipart
 * body itself is validated by the multer layer (type and size); everything
 * else goes through here.
 */

const kindValues = mediaAssetKind.enumValues;

/** `?kind=POSTER` — the enum name, matching what the DTO returns. */
export const assetKindQuery = z.enum(kindValues);

export const listAssetsQuery = z.object({
  kind: assetKindQuery.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListAssetsQuery = z.infer<typeof listAssetsQuery>;

/** `:kind` in the upload path — the lower-case slug, e.g. `ad-creative`. */
export const uploadKindParam = z.object({
  kind: z.enum(ASSET_KIND_SLUGS as [string, ...string[]]),
});

/** Optional human-readable name supplied alongside the multipart file. */
export const uploadAssetFields = z.object({
  name: z.string().trim().min(1, 'Asset name cannot be empty').max(120).optional(),
});

export const assetIdParam = z.object({
  id: z.string().uuid('Not a valid asset id'),
});

/** Response shape, kept in step with `AssetDto` in @streaming/shared. */
export const assetDto = z.object({
  id: z.string().uuid(),
  kind: assetKindQuery,
  name: z.string(),
  url: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  createdAt: z.string(),
});

export type AssetDtoShape = z.infer<typeof assetDto>;
