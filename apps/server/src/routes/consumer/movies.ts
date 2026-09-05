import { Router, type Request, type Response } from 'express';

import { pickLocale } from '../../lib/i18n';
import { parseOrThrow } from '../../lib/validate';
import { listMoviesQuery, movieIdParam } from '../../schemas/consumerSchemas';
import {
  getPublishedMovie,
  listPublishedMovies,
} from '../../services/consumer/consumerMovieService';

/**
 * Public movie catalogue. No `adminAuth` — consumer auth is deferred — so every
 * handler treats its input as hostile and the service it calls can only see
 * published rows.
 */
export const consumerMoviesRouter: Router = Router();

consumerMoviesRouter.get('/', async (req: Request, res: Response) => {
  const { page, limit, genre } = parseOrThrow(listMoviesQuery, req.query);

  res.json(
    await listPublishedMovies({
      page,
      limit,
      genreId: genre,
      lang: pickLocale(req.get('accept-language')),
    }),
  );
});

consumerMoviesRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = parseOrThrow(movieIdParam, req.params);

  res.json(await getPublishedMovie(id, pickLocale(req.get('accept-language'))));
});
