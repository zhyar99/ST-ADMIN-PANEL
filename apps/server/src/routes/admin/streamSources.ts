import { Router, type Request, type Response } from 'express';

import { eq } from 'drizzle-orm';

import { adminAuth } from '../../middleware/adminAuth';
import { requireRole } from '../../middleware/rbac';
import { HttpError } from '../../middleware/errorHandler';
import { parseOrThrow } from '../../lib/validate';
import { db } from '../../db/client';
import { streamSource } from '../../db/schema';
import { streamSourceIdParam } from '../../schemas/catalogSchemas';
import { listHealthHistory } from '../../services/content/streamHealthService';

/**
 * `/admin/stream-sources` — the owner-agnostic half of the source API.
 *
 * Health history is identical whatever a source hangs off, so it is served from
 * one place by bare source id rather than duplicated under the movie, episode
 * and live channel prefixes. The trade-off is that the owner chain is not
 * walked here, which is why the router stays ADMIN-only: a source id alone
 * proves nothing about who may see it, and ADMIN is exactly the role that may
 * see every source already.
 *
 * As everywhere else in the source API, no response carries a URL.
 */
export const adminStreamSourcesRouter: Router = Router();

adminStreamSourcesRouter.use(adminAuth);
// Matches the owner-scoped source routers: a VIEWER cannot enumerate sources,
// so it has nothing to read history for either.
adminStreamSourcesRouter.use(requireRole('ADMIN'));

adminStreamSourcesRouter.get('/:sourceId/health-history', async (req: Request, res: Response) => {
  const { sourceId } = parseOrThrow(streamSourceIdParam, req.params);

  // Existence is checked separately so an unknown id is a 404 rather than an
  // empty history that looks like "never tested".
  const [row] = await db
    .select({ id: streamSource.id })
    .from(streamSource)
    .where(eq(streamSource.id, sourceId))
    .limit(1);

  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Stream source not found');

  res.json({ items: await listHealthHistory(sourceId) });
});
