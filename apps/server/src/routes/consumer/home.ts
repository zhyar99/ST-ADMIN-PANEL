import { Router, type Request, type Response } from 'express';

import { pickLocale } from '../../lib/i18n';
import { getHome } from '../../services/home/homeService';

/**
 * The public Home page.
 *
 * No `adminAuth` — consumer auth is deferred — and no parameters at all: Home
 * is whatever the editors curated, identically for everyone. There is nothing
 * to paginate (the row count is an editorial decision, not a data volume) and
 * nothing to personalise, so the only input is the negotiated language.
 */
export const consumerHomeRouter: Router = Router();

consumerHomeRouter.get('/', async (req: Request, res: Response) => {
  res.json(await getHome(pickLocale(req.get('accept-language'))));
});
