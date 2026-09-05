import { Router, type Request, type Response } from 'express';

import { requireRole } from '../../middleware/rbac';
import { HttpError } from '../../middleware/errorHandler';
import { parseOrThrow } from '../../lib/validate';
import { recordAudit } from '../../lib/audit';
import {
  episodeScopeParam,
  episodeSubtitleScopeParam,
  subtitleCreateBody,
} from '../../schemas/catalogSchemas';
import { requireEpisode } from '../../services/content/seriesService';
import {
  addSubtitle,
  deleteSubtitle,
  listSubtitles,
  type SubtitleOwner,
} from '../../services/content/subtitleService';

/**
 * `/admin/series/:seriesId/seasons/:seasonId/episodes/:episodeId/subtitles`.
 *
 * The episode-side twin of `movieSubtitles`, with the same permission split: a
 * subtitle track holds nothing sensitive, so a VIEWER may list them, and writes
 * are ADMIN-only.
 */
export const episodeSubtitlesRouter: Router = Router({ mergeParams: true });

function callerId(req: Request): string {
  const id = req.admin?.adminUserId;
  if (!id) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  return id;
}

/** Walks the full series → season → episode chain; see `episodeSources`. */
async function scopeToEpisode(req: Request): Promise<SubtitleOwner> {
  const { seriesId, seasonId, episodeId } = parseOrThrow(episodeScopeParam, req.params);
  await requireEpisode(seriesId, seasonId, episodeId);
  return { ownerType: 'EPISODE', ownerId: episodeId };
}

episodeSubtitlesRouter.get('/', async (req: Request, res: Response) => {
  const owner = await scopeToEpisode(req);
  res.json({ subtitles: await listSubtitles(owner) });
});

episodeSubtitlesRouter.post('/', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const owner = await scopeToEpisode(req);
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

episodeSubtitlesRouter.delete(
  '/:subtitleId',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const owner = await scopeToEpisode(req);
    const { subtitleId } = parseOrThrow(episodeSubtitleScopeParam, req.params);

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
