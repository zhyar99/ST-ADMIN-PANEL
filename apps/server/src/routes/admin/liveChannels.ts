import { Router, type Request, type Response } from 'express';

import { adminAuth } from '../../middleware/adminAuth';
import { requireRole } from '../../middleware/rbac';
import { HttpError } from '../../middleware/errorHandler';
import { parseOrThrow } from '../../lib/validate';
import { recordAudit } from '../../lib/audit';
import {
  listLiveChannelsQuery,
  liveChannelCreateBody,
  liveChannelIdParam,
  liveChannelUpdateBody,
} from '../../schemas/catalogSchemas';
import {
  createLiveChannel,
  deleteLiveChannel,
  getLiveChannelDetail,
  listChannelCategories,
  listLiveChannels,
  requireLiveChannel,
  updateLiveChannel,
} from '../../services/content/liveChannelService';
import { publishContent, unpublishContent } from '../../services/content/publishService';
import { liveChannelSourcesRouter } from './liveChannelSources';

export const adminLiveChannelsRouter: Router = Router();

// A VIEWER may browse channels; every mutation below is ADMIN-gated, and the
// sources sub-router is ADMIN-only in full.
adminLiveChannelsRouter.use(adminAuth);

function callerId(req: Request): string {
  const id = req.admin?.adminUserId;
  if (!id) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  return id;
}

// Sub-resources are mounted first: Express matches in declaration order, and
// "/:id" would otherwise swallow "/:channelId/sources".
adminLiveChannelsRouter.use('/:channelId/sources', liveChannelSourcesRouter);

// Declared before /:id so "categories" is not parsed as a channel id.
adminLiveChannelsRouter.get('/categories', async (_req: Request, res: Response) => {
  res.json({ categories: await listChannelCategories() });
});

adminLiveChannelsRouter.get('/', async (req: Request, res: Response) => {
  const query = parseOrThrow(listLiveChannelsQuery, req.query);
  res.json(await listLiveChannels(query));
});

adminLiveChannelsRouter.post('/', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const input = parseOrThrow(liveChannelCreateBody, req.body ?? {});

  const created = await createLiveChannel(input);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'LIVE_CHANNEL_CREATE',
    entityType: 'live_channel',
    entityId: created.id,
  });

  res.status(201).json({ channel: created });
});

adminLiveChannelsRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = parseOrThrow(liveChannelIdParam, req.params);
  res.json({ channel: await getLiveChannelDetail(id) });
});

adminLiveChannelsRouter.patch('/:id', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const { id } = parseOrThrow(liveChannelIdParam, req.params);
  const input = parseOrThrow(liveChannelUpdateBody, req.body ?? {});

  const updated = await updateLiveChannel(id, input);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'LIVE_CHANNEL_UPDATE',
    entityType: 'live_channel',
    entityId: id,
  });

  res.json({ channel: updated });
});

adminLiveChannelsRouter.post(
  '/:id/publish',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { id } = parseOrThrow(liveChannelIdParam, req.params);

    await requireLiveChannel(id);

    res.json(await publishContent('live_channel', id, callerId(req)));
  },
);

adminLiveChannelsRouter.post(
  '/:id/unpublish',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { id } = parseOrThrow(liveChannelIdParam, req.params);

    await requireLiveChannel(id);

    res.json(await unpublishContent('live_channel', id, callerId(req)));
  },
);

adminLiveChannelsRouter.delete('/:id', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const { id } = parseOrThrow(liveChannelIdParam, req.params);

  await deleteLiveChannel(id);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'LIVE_CHANNEL_DELETE',
    entityType: 'live_channel',
    entityId: id,
  });

  res.status(204).end();
});
