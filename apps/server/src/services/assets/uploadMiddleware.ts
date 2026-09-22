import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer, { type Options } from 'multer';

import { config } from '../../config';
import { parseOrThrow } from '../../lib/validate';
import { HttpError } from '../../middleware/errorHandler';
import { uploadKindParam } from '../../schemas/assetSchemas';
import {
  ASSET_POLICY,
  extensionFor,
  isUploadTypeAllowed,
  kindFromSlug,
  type AssetKind,
} from './policy';

/** Field name the client must use in the multipart body. */
export const UPLOAD_FIELD = 'file';

/**
 * Resolves `:kind` before multer runs.
 *
 * This ordering matters for more than error messages: the kind decides the
 * destination directory, so it has to come from a closed allowlist and never
 * from the raw path segment — otherwise `upload/..%2F..` picks the directory.
 */
export function resolveAssetKind(req: Request, _res: Response, next: NextFunction): void {
  const { kind: slug } = parseOrThrow(uploadKindParam, req.params);
  const kind = kindFromSlug(slug);

  if (!kind) {
    next(new HttpError(400, 'UNKNOWN_ASSET_KIND', `Unknown asset kind "${slug}"`));
    return;
  }

  req.assetKind = kind;
  next();
}

function buildUploader(kind: AssetKind): RequestHandler {
  const policy = ASSET_POLICY[kind];
  const targetDir = path.join(config.storageDir, policy.directory);

  const options: Options = {
    storage: multer.diskStorage({
      destination(_req, _file, cb) {
        // Phase 1 creates these, but a fresh clone or a wiped storage/ should
        // not turn every upload into a 500.
        fs.mkdir(targetDir, { recursive: true }, (error) => cb(error, targetDir));
      },
      filename(_req, file, cb) {
        cb(null, `${randomUUID()}.${extensionFor(kind, file.mimetype, file.originalname)}`);
      },
    }),
    limits: { fileSize: policy.maxBytes, files: 1, fields: 4 },
    fileFilter(_req, file, cb) {
      // multer calls this before opening the write stream, so a rejected type
      // never leaves a file behind.
      if (isUploadTypeAllowed(kind, file.mimetype, file.originalname)) {
        cb(null, true);
        return;
      }

      cb(
        new HttpError(
          400,
          'UNSUPPORTED_MEDIA_TYPE',
          `${file.mimetype} is not allowed for ${kind}. Allowed: ${Object.keys(
            policy.extensionByMime,
          ).join(', ')}`,
        ),
      );
    },
  };

  return multer(options).single(UPLOAD_FIELD);
}

const UPLOADERS: Readonly<Record<AssetKind, RequestHandler>> = Object.fromEntries(
  (Object.keys(ASSET_POLICY) as AssetKind[]).map((kind) => [kind, buildUploader(kind)]),
) as Record<AssetKind, RequestHandler>;

/** Turns multer's own errors into the API's `{ error: { code, message } }`. */
function translateUploadError(error: unknown, kind: AssetKind): HttpError {
  if (error instanceof HttpError) return error;

  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      const limitMb = Math.round(ASSET_POLICY[kind].maxBytes / (1024 * 1024));
      return new HttpError(400, 'FILE_TOO_LARGE', `${kind} uploads are limited to ${limitMb} MB`);
    }

    return new HttpError(400, 'INVALID_UPLOAD', `Upload rejected: ${error.message}`);
  }

  return new HttpError(400, 'INVALID_UPLOAD', 'Could not read the uploaded file');
}

/**
 * Runs the kind-specific multer instance. Must be mounted after
 * {@link resolveAssetKind}.
 */
export function uploadAssetFile(req: Request, res: Response, next: NextFunction): void {
  const kind = req.assetKind;

  if (!kind) {
    next(new HttpError(500, 'INTERNAL_ERROR', 'Asset kind was not resolved before upload'));
    return;
  }

  UPLOADERS[kind](req, res, (error: unknown) => {
    if (error) {
      next(translateUploadError(error, kind));
      return;
    }

    if (!req.file) {
      next(new HttpError(400, 'FILE_REQUIRED', `Expected a multipart field named "${UPLOAD_FIELD}"`));
      return;
    }

    next();
  });
}
