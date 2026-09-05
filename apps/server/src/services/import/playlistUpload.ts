import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';

import { config } from '../../config';
import { HttpError } from '../../middleware/errorHandler';

/**
 * Multipart handling for a playlist upload.
 *
 * Memory storage rather than the disk storage the media library uses: a
 * playlist is read once, parsed into `import_entry` rows and then has no
 * further purpose, so persisting it would leave a file full of stream URLs on
 * disk for no one to read. The size limit is what keeps "in memory" safe.
 */

/** Field name the client must use in the multipart body. */
export const PLAYLIST_FIELD = 'playlist';

const ALLOWED_EXTENSIONS = ['.m3u', '.m3u8'];

/**
 * Content types seen in the wild for these files.
 *
 * Browsers are inconsistent here — Chrome sends `audio/x-mpegurl` for a `.m3u`
 * and `application/octet-stream` for a `.m3u8` — so the extension is the real
 * gate and this list only exists to reject something obviously else.
 */
const ALLOWED_MIME_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/mpegurl',
  'application/octet-stream',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'text/plain',
  'text/uri-list',
];

function hasPlaylistExtension(originalName: string): boolean {
  const lowered = originalName.toLowerCase();
  return ALLOWED_EXTENSIONS.some((extension) => lowered.endsWith(extension));
}

const uploader: RequestHandler = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.importMaxFileBytes, files: 1, fields: 4 },
  fileFilter(_req, file, cb) {
    // Runs before multer buffers anything, so a rejected type costs no memory.
    if (hasPlaylistExtension(file.originalname) && ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
      return;
    }

    cb(
      new HttpError(
        422,
        'UNSUPPORTED_MEDIA_TYPE',
        'Upload a playlist file with a .m3u or .m3u8 extension',
      ),
    );
  },
}).single(PLAYLIST_FIELD);

/** Turns multer's own errors into the API's `{ error: { code, message } }`. */
function translateUploadError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;

  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return new HttpError(
        413,
        'FILE_TOO_LARGE',
        `Playlist uploads are limited to ${config.IMPORT_MAX_FILE_SIZE_MB} MB`,
      );
    }

    return new HttpError(400, 'INVALID_UPLOAD', `Upload rejected: ${error.message}`);
  }

  return new HttpError(400, 'INVALID_UPLOAD', 'Could not read the uploaded file');
}

/**
 * The first line that is not blank, upper-cased and with any BOM stripped.
 *
 * Reads a slice rather than the whole buffer: this runs before the file is
 * trusted, and there is no reason to decode 50 MB to look at one line.
 */
function firstMeaningfulLine(buffer: Buffer): string {
  return (
    buffer
      .subarray(0, 512)
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r\n|\r|\n/)
      .find((line) => line.trim() !== '')
      ?.trim()
      .toUpperCase() ?? ''
  );
}

/**
 * Accepts the upload, or rejects it before any parsing happens.
 *
 * The content sniff accepts `#EXTINF:` as well as the `#EXTM3U` header: plenty
 * of exported playlists omit the header, and the parser handles those, so
 * rejecting them here would fail a file the importer can read perfectly well.
 * What it does reject is a `.m3u`-named CSV, which is the case worth catching.
 */
export function uploadPlaylistFile(req: Request, res: Response, next: NextFunction): void {
  uploader(req, res, (error: unknown) => {
    if (error) {
      next(translateUploadError(error));
      return;
    }

    if (!req.file) {
      next(
        new HttpError(
          400,
          'FILE_REQUIRED',
          `Expected a multipart field named "${PLAYLIST_FIELD}"`,
        ),
      );
      return;
    }

    const header = firstMeaningfulLine(req.file.buffer);

    if (!header.startsWith('#EXTM3U') && !header.startsWith('#EXTINF')) {
      next(
        new HttpError(
          422,
          'NOT_A_PLAYLIST',
          'That file does not look like an M3U playlist: it starts with neither #EXTM3U nor #EXTINF',
        ),
      );
      return;
    }

    next();
  });
}
