import type { NextFunction, Request, Response } from 'express';

import { HttpError } from './errorHandler';
import type { AdminRole } from '../lib/tokens';

/**
 * Gates a route on the caller's role. Must run after `adminAuth`, which is what
 * populates `req.admin`; an unauthenticated request is a 401, not a 403.
 */
export function requireRole(...roles: AdminRole[]) {
  return function roleGuard(req: Request, _res: Response, next: NextFunction): void {
    const admin = req.admin;

    if (!admin) {
      next(new HttpError(401, 'UNAUTHORIZED', 'Authentication required'));
      return;
    }

    if (!roles.includes(admin.role)) {
      next(new HttpError(403, 'FORBIDDEN', 'Insufficient permissions for this resource'));
      return;
    }

    next();
  };
}
