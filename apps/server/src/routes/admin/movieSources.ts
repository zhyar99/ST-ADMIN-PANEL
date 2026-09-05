import { Router, type Request, type Response } from 'express';

import { requireRole } from '../../middleware/rbac';
import { HttpError } from '../../middleware/errorHandler';
import { parseOrThrow } from '../../lib/validate';
import { recordAudit } from '../../lib/audit';
import {
  movieScopeParam,
  sourceScopeParam,
  streamSourceCreateBody,
  streamSourceReorderBody,
  streamSourceUpdateBody,
} from '../../schemas/catalogSchemas';
import { requireMovie } from '../../services/content/movieService';
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
 * `/admin/movies/:movieId/sources`.
 *
 * Stream sources are the most sensitive thing in the catalogue, so this whole
 * router is ADMIN-only — a VIEWER cannot even enumerate them. No response here
 * carries a URL except GET /:sourceId/url, which is audited.
 */
export const movieSourcesRouter: Router = Router({ mergeParams: true });

movieSourcesRouter.use(requireRole('ADMIN'));

function callerId(req: Request): string {
  const id = req.admin?.adminUserId;
  if (!id) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  return id;
}

/**
 * Resolves `:movieId` into an owner and proves the movie exists, so a source
 * id from another movie cannot be reached by guessing a path.
 */
async function scopeToMovie(req: Request): Promise<SourceOwner> {
  const { movieId } = parseOrThrow(movieScopeParam, req.params);
  await requireMovie(movieId);
  return { ownerType: 'MOVIE', ownerId: movieId };
}

movieSourcesRouter.get('/', async (req: Request, res: Response) => {
  const owner = await scopeToMovie(req);
  res.json({ sources: await listSources(owner) });
});

movieSourcesRouter.post('/', async (req: Request, res: Response) => {
  const owner = await scopeToMovie(req);
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
movieSourcesRouter.post('/reorder', async (req: Request, res: Response) => {
  const owner = await scopeToMovie(req);
  const input = parseOrThrow(streamSourceReorderBody, req.body ?? {});

  const sources = await reorderSources(owner, input.orderedIds);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'STREAM_SOURCE_REORDER',
    entityType: 'movie',
    entityId: owner.ownerId,
  });

  res.json({ sources });
});

movieSourcesRouter.patch('/:sourceId', async (req: Request, res: Response) => {
  const owner = await scopeToMovie(req);
  const { sourceId } = parseOrThrow(sourceScopeParam, req.params);
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

movieSourcesRouter.delete('/:sourceId', async (req: Request, res: Response) => {
  const owner = await scopeToMovie(req);
  const { sourceId } = parseOrThrow(sourceScopeParam, req.params);

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
movieSourcesRouter.get('/:sourceId/url', async (req: Request, res: Response) => {
  const owner = await scopeToMovie(req);
  const { sourceId } = parseOrThrow(sourceScopeParam, req.params);

  const url = await getSourceUrl(owner, sourceId);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'STREAM_SOURCE_VIEWED',
    entityType: 'stream_source',
    entityId: sourceId,
  });

  res.json({ url });
});

movieSourcesRouter.post('/:sourceId/test', async (req: Request, res: Response) => {
  const owner = await scopeToMovie(req);
  const { sourceId } = parseOrThrow(sourceScopeParam, req.params);

  // Scope check first: testSource takes a bare id, so without this a source
  // belonging to another movie could be probed through this path.
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
