import { Router, type Request, type Response } from 'express';

import { adminAuth } from '../../middleware/adminAuth';
import { requireRole } from '../../middleware/rbac';
import { HttpError } from '../../middleware/errorHandler';
import { parseOrThrow } from '../../lib/validate';
import { recordAudit } from '../../lib/audit';
import {
  listMoviesQuery,
  movieCreateBody,
  movieIdParam,
  movieUpdateBody,
} from '../../schemas/catalogSchemas';
import {
  createMovie,
  deleteMovie,
  getMovieDetail,
  listMovies,
  requireMovie,
  updateMovie,
} from '../../services/content/movieService';
import { publishContent, unpublishContent } from '../../services/content/publishService';
import { movieSourcesRouter } from './movieSources';
import { movieSubtitlesRouter } from './movieSubtitles';

export const adminMoviesRouter: Router = Router();

// A VIEWER may browse the catalogue; every mutation below is ADMIN-gated.
adminMoviesRouter.use(adminAuth);

function callerId(req: Request): string {
  const id = req.admin?.adminUserId;
  if (!id) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  return id;
}

// Sub-resources are mounted first: Express matches in declaration order, and
// "/:id" would otherwise swallow "/:movieId/sources".
adminMoviesRouter.use('/:movieId/sources', movieSourcesRouter);
adminMoviesRouter.use('/:movieId/subtitles', movieSubtitlesRouter);

adminMoviesRouter.get('/', async (req: Request, res: Response) => {
  const query = parseOrThrow(listMoviesQuery, req.query);
  res.json(await listMovies(query));
});

adminMoviesRouter.post('/', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const input = parseOrThrow(movieCreateBody, req.body ?? {});

  const created = await createMovie(input);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'MOVIE_CREATE',
    entityType: 'movie',
    entityId: created.id,
  });

  res.status(201).json({ movie: created });
});

adminMoviesRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = parseOrThrow(movieIdParam, req.params);
  res.json({ movie: await getMovieDetail(id) });
});

adminMoviesRouter.patch('/:id', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const { id } = parseOrThrow(movieIdParam, req.params);
  const input = parseOrThrow(movieUpdateBody, req.body ?? {});

  const updated = await updateMovie(id, input);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'MOVIE_UPDATE',
    entityType: 'movie',
    entityId: id,
  });

  res.json({ movie: updated });
});

// Publication. Declared before the DELETE only for readability — Express keys
// on the path, and "/:id/publish" cannot collide with "/:id".
adminMoviesRouter.post('/:id/publish', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const { id } = parseOrThrow(movieIdParam, req.params);

  // 404 before validating, so a bad id reads as "no such movie" rather than as
  // a movie that failed every check.
  await requireMovie(id);

  res.json(await publishContent('movie', id, callerId(req)));
});

adminMoviesRouter.post(
  '/:id/unpublish',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { id } = parseOrThrow(movieIdParam, req.params);

    await requireMovie(id);

    res.json(await unpublishContent('movie', id, callerId(req)));
  },
);

adminMoviesRouter.delete('/:id', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const { id } = parseOrThrow(movieIdParam, req.params);

  await deleteMovie(id);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'MOVIE_DELETE',
    entityType: 'movie',
    entityId: id,
  });

  res.status(204).end();
});
