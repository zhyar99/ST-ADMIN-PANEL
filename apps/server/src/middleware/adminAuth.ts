import type { NextFunction, Request, Response } from 'express';

import { HttpError } from './errorHandler';
import { verifyAccessToken } from '../lib/tokens';

const BEARER_PREFIX = 'Bearer ';

/**
 * Authenticates an admin request from `Authorization: Bearer <JWT>` and hangs
 * the verified claims on `req.admin`. Rejects with 401 when the header is
 * missing, malformed, expired or fails signature verification.
 */
export async function adminAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.get('authorization');

  if (!header?.startsWith(BEARER_PREFIX)) {
    next(new HttpError(401, 'UNAUTHORIZED', 'Missing bearer token'));
    return;
  }

  const payload = await verifyAccessToken(header.slice(BEARER_PREFIX.length).trim());

  if (!payload) {
    next(new HttpError(401, 'UNAUTHORIZED', 'Invalid or expired token'));
    return;
  }

  req.admin = payload;
  next();
}
