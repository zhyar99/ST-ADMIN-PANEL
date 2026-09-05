import { Router, type Request, type Response } from 'express';

import { adminAuth } from '../../middleware/adminAuth';
import { requireRole } from '../../middleware/rbac';
import { HttpError } from '../../middleware/errorHandler';
import { parseOrThrow } from '../../lib/validate';
import { recordAudit } from '../../lib/audit';
import {
  episodeCreateBody,
  episodeScopeParam,
  episodeUpdateBody,
  listSeriesQuery,
  seasonCreateBody,
  seasonScopeParam,
  seriesCreateBody,
  seriesScopeParam,
  seriesUpdateBody,
} from '../../schemas/catalogSchemas';
import {
  createEpisode,
  createSeason,
  createSeries,
  deleteEpisode,
  deleteSeason,
  deleteSeries,
  getEpisodeDetail,
  getSeriesDetail,
  listEpisodesForSeason,
  listSeasonsForSeries,
  listSeries,
  requireEpisode,
  requireSeries,
  updateEpisode,
  updateSeries,
} from '../../services/content/seriesService';
import { publishContent, unpublishContent } from '../../services/content/publishService';
import { episodeSourcesRouter } from './episodeSources';
import { episodeSubtitlesRouter } from './episodeSubtitles';

/**
 * `/admin/series` and everything nested beneath it.
 *
 * A VIEWER may browse the whole tree — series, seasons and episodes — because
 * none of it carries a stream URL. Every mutation is ADMIN-gated, and the
 * sources sub-router is ADMIN-only in full.
 */
export const adminSeriesRouter: Router = Router();

adminSeriesRouter.use(adminAuth);

function callerId(req: Request): string {
  const id = req.admin?.adminUserId;
  if (!id) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  return id;
}

// Sub-resources are mounted first: Express matches in declaration order, and
// "/:seriesId" would otherwise swallow the deeper paths.
adminSeriesRouter.use(
  '/:seriesId/seasons/:seasonId/episodes/:episodeId/sources',
  episodeSourcesRouter,
);
adminSeriesRouter.use(
  '/:seriesId/seasons/:seasonId/episodes/:episodeId/subtitles',
  episodeSubtitlesRouter,
);

// --- series ----------------------------------------------------------------

adminSeriesRouter.get('/', async (req: Request, res: Response) => {
  const query = parseOrThrow(listSeriesQuery, req.query);
  res.json(await listSeries(query));
});

adminSeriesRouter.post('/', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const input = parseOrThrow(seriesCreateBody, req.body ?? {});

  const created = await createSeries(input);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'SERIES_CREATE',
    entityType: 'series',
    entityId: created.id,
  });

  res.status(201).json({ series: created });
});

adminSeriesRouter.get('/:seriesId', async (req: Request, res: Response) => {
  const { seriesId } = parseOrThrow(seriesScopeParam, req.params);
  res.json({ series: await getSeriesDetail(seriesId) });
});

adminSeriesRouter.patch('/:seriesId', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const { seriesId } = parseOrThrow(seriesScopeParam, req.params);
  const input = parseOrThrow(seriesUpdateBody, req.body ?? {});

  const updated = await updateSeries(seriesId, input);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'SERIES_UPDATE',
    entityType: 'series',
    entityId: seriesId,
  });

  res.json({ series: updated });
});

/**
 * Publication for the series shell.
 *
 * Publishing a series does not publish its episodes, and does not require any:
 * an operator releases the series page first and then drops episodes into it
 * one at a time. See `validateForPublish` for the full rule.
 */
adminSeriesRouter.post(
  '/:seriesId/publish',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { seriesId } = parseOrThrow(seriesScopeParam, req.params);

    await requireSeries(seriesId);

    res.json(await publishContent('series', seriesId, callerId(req)));
  },
);

adminSeriesRouter.post(
  '/:seriesId/unpublish',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { seriesId } = parseOrThrow(seriesScopeParam, req.params);

    await requireSeries(seriesId);

    res.json(await unpublishContent('series', seriesId, callerId(req)));
  },
);

/**
 * Deletes a series. Refused unless it is a DRAFT with no seasons at all — see
 * `deleteSeries` for why this is stricter than the season rule below.
 */
adminSeriesRouter.delete(
  '/:seriesId',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { seriesId } = parseOrThrow(seriesScopeParam, req.params);

    await deleteSeries(seriesId);

    await recordAudit({
      adminUserId: callerId(req),
      action: 'SERIES_DELETE',
      entityType: 'series',
      entityId: seriesId,
    });

    res.status(204).end();
  },
);

// --- seasons ---------------------------------------------------------------

adminSeriesRouter.get('/:seriesId/seasons', async (req: Request, res: Response) => {
  const { seriesId } = parseOrThrow(seriesScopeParam, req.params);
  res.json({ seasons: await listSeasonsForSeries(seriesId) });
});

adminSeriesRouter.post(
  '/:seriesId/seasons',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { seriesId } = parseOrThrow(seriesScopeParam, req.params);
    const input = parseOrThrow(seasonCreateBody, req.body ?? {});

    const created = await createSeason(seriesId, input.number);

    await recordAudit({
      adminUserId: callerId(req),
      action: 'SEASON_CREATE',
      entityType: 'season',
      entityId: created.id,
    });

    res.status(201).json({ season: created });
  },
);

/**
 * Deletes a season.
 *
 * Decision, deliberate: a season whose episodes are all DRAFT is deleted
 * outright and cascades to those episodes, taking their stream sources and
 * subtitle tracks with them. A season holding even one PUBLISHED episode is
 * refused with a 409 naming the count.
 *
 * The reasoning is about viewer-visible state. Draft episodes were never
 * reachable, so removing them destroys only unshipped work; a published episode
 * may be in someone's continue-watching list, and cascading it away from a
 * single season-level click is too easy an accident to allow. Unpublishing is
 * the reversible action and arrives in Phase 8. The full rationale lives on
 * `deleteSeason` in seriesService.
 */
adminSeriesRouter.delete(
  '/:seriesId/seasons/:seasonId',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { seriesId, seasonId } = parseOrThrow(seasonScopeParam, req.params);

    await deleteSeason(seriesId, seasonId);

    await recordAudit({
      adminUserId: callerId(req),
      action: 'SEASON_DELETE',
      entityType: 'season',
      entityId: seasonId,
    });

    res.status(204).end();
  },
);

// --- episodes --------------------------------------------------------------

adminSeriesRouter.get(
  '/:seriesId/seasons/:seasonId/episodes',
  async (req: Request, res: Response) => {
    const { seriesId, seasonId } = parseOrThrow(seasonScopeParam, req.params);
    res.json({ episodes: await listEpisodesForSeason(seriesId, seasonId) });
  },
);

adminSeriesRouter.post(
  '/:seriesId/seasons/:seasonId/episodes',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { seriesId, seasonId } = parseOrThrow(seasonScopeParam, req.params);
    const input = parseOrThrow(episodeCreateBody, req.body ?? {});

    const created = await createEpisode(seriesId, seasonId, input);

    await recordAudit({
      adminUserId: callerId(req),
      action: 'EPISODE_CREATE',
      entityType: 'episode',
      entityId: created.id,
    });

    res.status(201).json({ episode: created });
  },
);

adminSeriesRouter.get(
  '/:seriesId/seasons/:seasonId/episodes/:episodeId',
  async (req: Request, res: Response) => {
    const { seriesId, seasonId, episodeId } = parseOrThrow(episodeScopeParam, req.params);
    res.json({ episode: await getEpisodeDetail(seriesId, seasonId, episodeId) });
  },
);

adminSeriesRouter.patch(
  '/:seriesId/seasons/:seasonId/episodes/:episodeId',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { seriesId, seasonId, episodeId } = parseOrThrow(episodeScopeParam, req.params);
    const input = parseOrThrow(episodeUpdateBody, req.body ?? {});

    const updated = await updateEpisode(seriesId, seasonId, episodeId, input);

    await recordAudit({
      adminUserId: callerId(req),
      action: 'EPISODE_UPDATE',
      entityType: 'episode',
      entityId: episodeId,
    });

    res.json({ episode: updated });
  },
);

/**
 * Episodes publish individually, under the full season path like every other
 * episode route — `requireEpisode` is what proves the episode actually sits in
 * the named season, so a flat `/episodes/:id` form could not scope the request.
 */
adminSeriesRouter.post(
  '/:seriesId/seasons/:seasonId/episodes/:episodeId/publish',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { seriesId, seasonId, episodeId } = parseOrThrow(episodeScopeParam, req.params);

    await requireEpisode(seriesId, seasonId, episodeId);

    res.json(await publishContent('episode', episodeId, callerId(req)));
  },
);

adminSeriesRouter.post(
  '/:seriesId/seasons/:seasonId/episodes/:episodeId/unpublish',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { seriesId, seasonId, episodeId } = parseOrThrow(episodeScopeParam, req.params);

    await requireEpisode(seriesId, seasonId, episodeId);

    res.json(await unpublishContent('episode', episodeId, callerId(req)));
  },
);

adminSeriesRouter.delete(
  '/:seriesId/seasons/:seasonId/episodes/:episodeId',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { seriesId, seasonId, episodeId } = parseOrThrow(episodeScopeParam, req.params);

    await deleteEpisode(seriesId, seasonId, episodeId);

    await recordAudit({
      adminUserId: callerId(req),
      action: 'EPISODE_DELETE',
      entityType: 'episode',
      entityId: episodeId,
    });

    res.status(204).end();
  },
);
