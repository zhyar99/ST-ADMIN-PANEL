import { Router, type Request, type Response } from 'express';

import { pickLocale } from '../../lib/i18n';
import { parseOrThrow } from '../../lib/validate';
import { listSeriesQuery, seriesIdParam } from '../../schemas/consumerSchemas';
import {
  getPublishedSeries,
  listPublishedSeries,
} from '../../services/consumer/consumerSeriesService';

/** Public series catalogue. Same shape and same rules as the movies router. */
export const consumerSeriesRouter: Router = Router();

consumerSeriesRouter.get('/', async (req: Request, res: Response) => {
  const { page, limit } = parseOrThrow(listSeriesQuery, req.query);

  res.json(await listPublishedSeries({ page, limit, lang: pickLocale(req.get('accept-language')) }));
});

consumerSeriesRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = parseOrThrow(seriesIdParam, req.params);

  res.json(await getPublishedSeries(id, pickLocale(req.get('accept-language'))));
});
