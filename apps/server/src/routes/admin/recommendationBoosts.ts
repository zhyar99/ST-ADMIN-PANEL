import { Router, type Request, type Response } from 'express';

import { recordAudit } from '../../lib/audit';
import { parseOrThrow } from '../../lib/validate';
import { adminAuth } from '../../middleware/adminAuth';
import { HttpError } from '../../middleware/errorHandler';
import { requireRole } from '../../middleware/rbac';
import { boostIdParam, recommendationBoostBody } from '../../schemas/personalizationSchemas';
import {
  deactivateBoost,
  listBoosts,
  upsertBoost,
} from '../../services/personalization/boostService';

/**
 * Editorial control over the recommender (Phase 15).
 *
 * The same split every curation router in this API uses: a VIEWER may read what
 * has been boosted, and only an ADMIN may change it. Both writes are
 * audit-logged, because a boost silently changes what every device on the
 * platform is shown and the record of who set it is the only way to answer for
 * that afterwards.
 */
export const adminRecommendationBoostsRouter: Router = Router();

adminRecommendationBoostsRouter.use(adminAuth);

function callerId(req: Request): string {
  const id = req.admin?.adminUserId;
  if (!id) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  return id;
}

adminRecommendationBoostsRouter.get('/', async (_req: Request, res: Response) => {
  res.json({ boosts: await listBoosts() });
});

adminRecommendationBoostsRouter.post(
  '/',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const input = parseOrThrow(recommendationBoostBody, req.body ?? {});
    const actorId = callerId(req);

    const boost = await upsertBoost({
      contentType: input.content_type,
      contentId: input.content_id,
      boostScore: input.boost_score,
      reason: input.reason,
      expiresAt: input.expires_at ?? null,
      createdBy: actorId,
    });

    await recordAudit({
      adminUserId: actorId,
      action: 'RECOMMENDATION_BOOST_SET',
      entityType: 'recommendation_boost',
      entityId: boost.id,
    });

    res.status(201).json({ boost });
  },
);

adminRecommendationBoostsRouter.delete(
  '/:id',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { id } = parseOrThrow(boostIdParam, req.params);
    const actorId = callerId(req);

    await deactivateBoost(id);

    await recordAudit({
      adminUserId: actorId,
      action: 'RECOMMENDATION_BOOST_REMOVED',
      entityType: 'recommendation_boost',
      entityId: id,
    });

    res.status(204).end();
  },
);
