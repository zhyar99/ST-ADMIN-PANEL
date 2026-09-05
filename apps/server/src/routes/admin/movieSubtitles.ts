import { Router, type Request, type Response } from 'express';

import { requireRole } from '../../middleware/rbac';
import { HttpError } from '../../middleware/errorHandler';
import { parseOrThrow } from '../../lib/validate';
import { recordAudit } from '../../lib/audit';
import {
  movieScopeParam,
  subtitleCreateBody,
  subtitleScopeParam,
} from '../../schemas/catalogSchemas';
import { requireMovie } from '../../services/content/movieService';
import {
  addSubtitle,
  deleteSubtitle,
  listSubtitles,
  type SubtitleOwner,
} from '../../services/content/subtitleService';

/**
 * `/admin/movies/:movieId/subtitles`.
 *
 * Unlike stream sources, a subtitle track holds nothing sensitive — a VIEWER
 * may list them. Writes are ADMIN-only.
 */
export const movieSubtitlesRouter: Router = Router({ mergeParams: true });

function callerId(req: Request): string {
  const id = req.admin?.adminUserId;
  if (!id) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  return id;
}

async function scopeToMovie(req: Request): Promise<SubtitleOwner> {
  const { movieId } = parseOrThrow(movieScopeParam, req.params);
  await requireMovie(movieId);
  return { ownerType: 'MOVIE', ownerId: movieId };
}

movieSubtitlesRouter.get('/', async (req: Request, res: Response) => {
  const owner = await scopeToMovie(req);
  res.json({ subtitles: await listSubtitles(owner) });
});

movieSubtitlesRouter.post('/', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const owner = await scopeToMovie(req);
  const input = parseOrThrow(subtitleCreateBody, req.body ?? {});

  const created = await addSubtitle(owner, input);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'SUBTITLE_CREATE',
    entityType: 'subtitle_track',
    entityId: created.id,
  });

  res.status(201).json({ subtitle: created });
});

movieSubtitlesRouter.delete(
  '/:subtitleId',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const owner = await scopeToMovie(req);
    const { subtitleId } = parseOrThrow(subtitleScopeParam, req.params);

    await deleteSubtitle(owner, subtitleId);

    await recordAudit({
      adminUserId: callerId(req),
      action: 'SUBTITLE_DELETE',
      entityType: 'subtitle_track',
      entityId: subtitleId,
    });

    res.status(204).end();
  },
);
