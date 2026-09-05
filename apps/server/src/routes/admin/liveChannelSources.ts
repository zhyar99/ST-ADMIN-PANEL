import { Router, type Request, type Response } from 'express';

import { requireRole } from '../../middleware/rbac';
import { HttpError } from '../../middleware/errorHandler';
import { parseOrThrow } from '../../lib/validate';
import { recordAudit } from '../../lib/audit';
import {
  liveChannelScopeParam,
  liveChannelSourceScopeParam,
  streamSourceCreateBody,
  streamSourceReorderBody,
  streamSourceUpdateBody,
} from '../../schemas/catalogSchemas';
import { requireLiveChannel } from '../../services/content/liveChannelService';
import { testSource } from '../../services/content/streamHealthService';
import {
  addSource,
  deleteSource,
  getSourceUrl,
  listSources,
  reorderSources,
  updateSource,
  type SourceOwner,
} from '../../services/content/streamSourceService';

/**
 * `/admin/live-channels/:channelId/sources`.
 *
 * The live-TV twin of `movieSources` and `episodeSources`. Every rule from
 * those holds unchanged: the whole router is ADMIN-only so a VIEWER cannot even
 * enumerate sources, and no response carries a URL except GET /:sourceId/url,
 * which is audited.
 *
 * As with the episode router, the behaviour is identical because it is not
 * implemented here — `streamSourceService` and `streamHealthService` are
 * owner-agnostic, and this file differs from its siblings only in how it
 * resolves the owner.
 */
export const liveChannelSourcesRouter: Router = Router({ mergeParams: true });

liveChannelSourcesRouter.use(requireRole('ADMIN'));

function callerId(req: Request): string {
  const id = req.admin?.adminUserId;
  if (!id) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  return id;
}

/**
 * Resolves `:channelId` into an owner and proves the channel exists, so a
 * source id from another channel cannot be reached by guessing a path.
 */
async function scopeToChannel(req: Request): Promise<SourceOwner> {
  const { channelId } = parseOrThrow(liveChannelScopeParam, req.params);
  await requireLiveChannel(channelId);
  return { ownerType: 'LIVE_CHANNEL', ownerId: channelId };
}

liveChannelSourcesRouter.get('/', async (req: Request, res: Response) => {
  const owner = await scopeToChannel(req);
  res.json({ sources: await listSources(owner) });
});

liveChannelSourcesRouter.post('/', async (req: Request, res: Response) => {
  const owner = await scopeToChannel(req);
  const input = parseOrThrow(streamSourceCreateBody, req.body ?? {});

  const created = await addSource(owner, input);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'STREAM_SOURCE_CREATE',
    entityType: 'stream_source',
    entityId: created.id,
  });

  res.status(201).json({ source: created });
});

// Declared before /:sourceId so "reorder" is not parsed as a source id.
liveChannelSourcesRouter.post('/reorder', async (req: Request, res: Response) => {
  const owner = await scopeToChannel(req);
  const input = parseOrThrow(streamSourceReorderBody, req.body ?? {});

  const sources = await reorderSources(owner, input.orderedIds);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'STREAM_SOURCE_REORDER',
    entityType: 'live_channel',
    entityId: owner.ownerId,
  });

  res.json({ sources });
});

liveChannelSourcesRouter.patch('/:sourceId', async (req: Request, res: Response) => {
  const owner = await scopeToChannel(req);
  const { sourceId } = parseOrThrow(liveChannelSourceScopeParam, req.params);
  const input = parseOrThrow(streamSourceUpdateBody, req.body ?? {});

  const updated = await updateSource(owner, sourceId, input);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'STREAM_SOURCE_UPDATE',
    entityType: 'stream_source',
    entityId: sourceId,
  });

  res.json({ source: updated });
});

liveChannelSourcesRouter.delete('/:sourceId', async (req: Request, res: Response) => {
  const owner = await scopeToChannel(req);
  const { sourceId } = parseOrThrow(liveChannelSourceScopeParam, req.params);

  await deleteSource(owner, sourceId);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'STREAM_SOURCE_DELETE',
    entityType: 'stream_source',
    entityId: sourceId,
  });

  res.status(204).end();
});

/**
 * The only endpoint that returns a live channel's stream URL.
 *
 * The audit row is written *before* the response so a read is recorded even if
 * the client disconnects mid-write — an unrecorded disclosure is worse than a
 * recorded read that never arrived.
 */
liveChannelSourcesRouter.get('/:sourceId/url', async (req: Request, res: Response) => {
  const owner = await scopeToChannel(req);
  const { sourceId } = parseOrThrow(liveChannelSourceScopeParam, req.params);

  const url = await getSourceUrl(owner, sourceId);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'STREAM_SOURCE_VIEWED',
    entityType: 'stream_source',
    entityId: sourceId,
  });

  res.json({ url });
});

liveChannelSourcesRouter.post('/:sourceId/test', async (req: Request, res: Response) => {
  const owner = await scopeToChannel(req);
  const { sourceId } = parseOrThrow(liveChannelSourceScopeParam, req.params);

  // Scope check first: testSource takes a bare id, so without this a source
  // belonging to another channel could be probed through this path.
  await getSourceUrl(owner, sourceId);

  const outcome = await testSource(sourceId);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'STREAM_SOURCE_TESTED',
    entityType: 'stream_source',
    entityId: sourceId,
  });

  res.json(outcome);
});
