import { Router, type Request, type Response } from 'express';

import { parseOrThrow } from '../../lib/validate';
import { searchQuery } from '../../schemas/consumerSchemas';
import { searchCatalog } from '../../services/consumer/searchService';

/**
 * Cross-type search.
 *
 * The language comes from the `lang` query parameter rather than
 * `Accept-Language`, because here it selects which *column* is searched, not
 * merely which translation is rendered — it is part of the query, so it belongs
 * in the URL where a client can vary it and a cache can key on it.
 */
export const consumerSearchRouter: Router = Router();

consumerSearchRouter.get('/', async (req: Request, res: Response) => {
  const { q, lang, limit } = parseOrThrow(searchQuery, req.query);

  res.json({ data: await searchCatalog({ q, lang, limit }) });
});
