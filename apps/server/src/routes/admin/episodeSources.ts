import { Router, type Request, type Response } from 'express';

import { requireRole } from '../../middleware/rbac';
import { HttpError } from '../../middleware/errorHandler';
import { parseOrThrow } from '../../lib/validate';
import { recordAudit } from '../../lib/audit';
import {
  episodeScopeParam,
  episodeSourceScopeParam,
  streamSourceCreateBody,
  streamSourceReorderBody,
  streamSourceUpdateBody,
} from '../../schemas/catalogSchemas';
import { requireEpisode } from '../../services/content/seriesService';
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
 * `/admin/series/:seriesId/seasons/:seasonId/episodes/:episodeId/sources`.
 *
 * The episode-side twin of `movieSources`. Every rule from there holds
 * unchanged: the whole router is ADMIN-only so a VIEWER cannot even enumerate
 * sources, and no response carries a URL except GET /:sourceId/url, which is
 * audited.
 *
 * The behaviour is identical because the behaviour is not implemented here —
 * `streamSourceService` and `streamHealthService` are owner-agnostic, and this
 * file only differs from its movie counterpart in how it resolves the owner.
 */
export const episodeSourcesRouter: Router = Router({ mergeParams: true });

episodeSourcesRouter.use(requireRole('ADMIN'));

function callerId(req: Request): string {
  const id = req.admin?.adminUserId;
  if (!id) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  return id;
}

/**
 * Resolves the path into an owner, proving the whole series → season → episode
 * chain holds. Without the full walk, a source belonging to an episode of some
 * other series could be reached by pairing a valid episode id with an unrelated
 * series id.
 */
async function scopeToEpisode(req: Request): Promise<SourceOwner> {
  const { seriesId, seasonId, episodeId } = parseOrThrow(episodeScopeParam, req.params);
  await requireEpisode(seriesId, seasonId, episodeId);
  return { ownerType: 'EPISODE', ownerId: episodeId };
}

episodeSourcesRouter.get('/', async (req: Request, res: Response) => {
  const owner = await scopeToEpisode(req);
  res.json({ sources: await listSources(owner) });
});

episodeSourcesRouter.post('/', async (req: Request, res: Response) => {
  const owner = await scopeToEpisode(req);
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
episodeSourcesRouter.post('/reorder', async (req: Request, res: Response) => {
  const owner = await scopeToEpisode(req);
  const input = parseOrThrow(streamSourceReorderBody, req.body ?? {});

  const sources = await reorderSources(owner, input.orderedIds);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'STREAM_SOURCE_REORDER',
    entityType: 'episode',
    entityId: owner.ownerId,
  });

  res.json({ sources });
});

episodeSourcesRouter.patch('/:sourceId', async (req: Request, res: Response) => {
  const owner = await scopeToEpisode(req);
  const { sourceId } = parseOrThrow(episodeSourceScopeParam, req.params);
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

episodeSourcesRouter.delete('/:sourceId', async (req: Request, res: Response) => {
  const owner = await scopeToEpisode(req);
  const { sourceId } = parseOrThrow(episodeSourceScopeParam, req.params);

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
 * The only endpoint that returns a stream URL.
 *
 * The audit row is written *before* the response so a read is recorded even if
 * the client disconnects mid-write — an unrecorded disclosure is worse than a
 * recorded read that never arrived.
 */
episodeSourcesRouter.get('/:sourceId/url', async (req: Request, res: Response) => {
  const owner = await scopeToEpisode(req);
  const { sourceId } = parseOrThrow(episodeSourceScopeParam, req.params);

  const url = await getSourceUrl(owner, sourceId);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'STREAM_SOURCE_VIEWED',
    entityType: 'stream_source',
    entityId: sourceId,
  });

  res.json({ url });
});

episodeSourcesRouter.post('/:sourceId/test', async (req: Request, res: Response) => {
  const owner = await scopeToEpisode(req);
  const { sourceId } = parseOrThrow(episodeSourceScopeParam, req.params);

  // Scope check first: testSource takes a bare id, so without this a source
  // belonging to another episode could be probed through this path.
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
