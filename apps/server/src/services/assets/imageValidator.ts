import fs from 'node:fs/promises';

import sharp from 'sharp';

import { logger } from '../../logger';
import { HttpError } from '../../middleware/errorHandler';
import { ASSET_POLICY, type AssetKind, type ImageConstraint } from './policy';

export interface ImageDimensions {
  width: number;
  height: number;
}

/** Best-effort cleanup: a file we are rejecting must not linger in storage/. */
async function discard(absolutePath: string): Promise<void> {
  try {
    await fs.unlink(absolutePath);
  } catch (error) {
    logger.warn({ err: error }, 'Could not remove a rejected upload');
  }
}

function orientationError(
  constraint: ImageConstraint,
  { width, height }: ImageDimensions,
): string | null {
  if (constraint.orientation === 'portrait' && width >= height) {
    return `expected a portrait image, got ${width}x${height}`;
  }

  if (constraint.orientation === 'landscape' && height >= width) {
    return `expected a landscape image, got ${width}x${height}`;
  }

  return null;
}

/**
 * Validates an already-saved image against its kind's dimension rules.
 *
 * multer writes the file before anything can inspect its pixels, so on failure
 * this deletes it and throws — there is no path that leaves an orphan on disk
 * next to a missing DB row.
 *
 * Returns null for kinds with no image constraint (subtitles, ad creatives).
 */
export async function validateImage(
  absolutePath: string,
  kind: AssetKind,
): Promise<ImageDimensions | null> {
  const constraint = ASSET_POLICY[kind].image;
  if (!constraint) return null;

  let width: number | undefined;
  let height: number | undefined;

  try {
    ({ width, height } = await sharp(absolutePath).metadata());
  } catch (error) {
    await discard(absolutePath);
    logger.warn({ err: error, kind }, 'Uploaded file could not be decoded as an image');
    throw new HttpError(400, 'INVALID_IMAGE', 'The uploaded file is not a readable image');
  }

  if (!width || !height) {
    await discard(absolutePath);
    throw new HttpError(400, 'INVALID_IMAGE', 'Could not read the image dimensions');
  }

  const dimensions: ImageDimensions = { width, height };

  const problem =
    width < constraint.minWidth || height < constraint.minHeight
      ? `minimum size is ${constraint.minWidth}x${constraint.minHeight}, got ${width}x${height}`
      : orientationError(constraint, dimensions);

  if (problem) {
    await discard(absolutePath);
    throw new HttpError(400, 'IMAGE_DIMENSIONS', `Invalid ${kind} image: ${problem}`);
  }

  return dimensions;
}

/** Exported for the upload route's failure path (e.g. a DB insert that throws). */
export { discard as discardUpload };
