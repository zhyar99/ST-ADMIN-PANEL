import { Router, type Request, type Response } from 'express';

import { recordAudit } from '../../lib/audit';
import { parseOrThrow } from '../../lib/validate';
import { adminAuth } from '../../middleware/adminAuth';
import { HttpError } from '../../middleware/errorHandler';
import { requireRole } from '../../middleware/rbac';
import {
  adConfigUpdateBody,
  adCreativeCreateBody,
  adCreativeIdParam,
  adCreativeUpdateBody,
  assertPreRollOrder,
} from '../../schemas/advertisingSchemas';
import { getAdConfig, updateAdConfig } from '../../repositories/adConfigRepository';
import {
  createAdCreative,
  deleteAdCreative,
  listAdCreatives,
  updateAdCreative,
} from '../../repositories/adCreativeRepository';

/**
 * Advertising configuration and the creative pool.
 *
 * Same split as `adminHomeRouter`: a VIEWER may read both resources, and every
 * mutation is ADMIN-only. The boundary is unambiguous here because neither
 * resource is content — changing the ad config changes what every viewer of
 * every VOD title sees, which is squarely a platform setting.
 *
 * Nothing under this router touches `stream_source`, and no response it
 * produces carries a stream URL. The only URL here is a creative's public
 * `/storage/ad-creatives/...` path, which is a file anyone playing the content
 * is about to be served anyway.
 */
export const adminAdvertisingRouter: Router = Router();

adminAdvertisingRouter.use(adminAuth);

function callerId(req: Request): string {
  const id = req.admin?.adminUserId;
  if (!id) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  return id;
}

/** Creates the config with its schema defaults if this is the first ever call. */
adminAdvertisingRouter.get('/config', async (_req: Request, res: Response) => {
  res.json({ config: await getAdConfig() });
});

/**
 * Partial update.
 *
 * The stored row is read before the write so the pre-roll ordering rule can be
 * checked against the merged result rather than the patch — a body that lowers
 * only the maximum below the stored minimum is exactly the case a per-field
 * schema would wave through.
 */
adminAdvertisingRouter.put('/config', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const patch = parseOrThrow(adConfigUpdateBody, req.body ?? {});
  const current = await getAdConfig();

  assertPreRollOrder({
    preRollMinSeconds: patch.preRollMinSeconds ?? current.preRollMinSeconds,
    preRollMaxSeconds: patch.preRollMaxSeconds ?? current.preRollMaxSeconds,
  });

  const config = await updateAdConfig(patch);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'AD_CONFIG_UPDATE',
    entityType: 'ad_config',
  });

  res.json({ config });
});

adminAdvertisingRouter.get('/creatives', async (_req: Request, res: Response) => {
  res.json({ creatives: await listAdCreatives() });
});

/**
 * Adds a creative to the pool.
 *
 * `assetId` is validated as a uuid here and as an `AD_CREATIVE` asset in the
 * repository, which is where the row it points at is actually read.
 */
adminAdvertisingRouter.post(
  '/creatives',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const input = parseOrThrow(adCreativeCreateBody, req.body ?? {});

    const creative = await createAdCreative(input);

    await recordAudit({
      adminUserId: callerId(req),
      action: 'AD_CREATIVE_CREATE',
      entityType: 'ad_creative',
      entityId: creative.id,
    });

    res.status(201).json({ creative });
  },
);

adminAdvertisingRouter.patch(
  '/creatives/:id',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { id } = parseOrThrow(adCreativeIdParam, req.params);
    const patch = parseOrThrow(adCreativeUpdateBody, req.body ?? {});

    const creative = await updateAdCreative(id, patch);

    await recordAudit({
      adminUserId: callerId(req),
      action: 'AD_CREATIVE_UPDATE',
      entityType: 'ad_creative',
      entityId: id,
    });

    res.json({ creative });
  },
);

/** Removes the creative. Its underlying file stays in the media library. */
adminAdvertisingRouter.delete(
  '/creatives/:id',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { id } = parseOrThrow(adCreativeIdParam, req.params);
    const actorId = callerId(req);

    await deleteAdCreative(id);

    await recordAudit({
      adminUserId: actorId,
      action: 'AD_CREATIVE_DELETE',
      entityType: 'ad_creative',
      entityId: id,
    });

    res.status(204).end();
  },
);
