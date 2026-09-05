import { Router, type Request, type Response } from 'express';

import { pickLocale } from '../../lib/i18n';
import { parseOrThrow } from '../../lib/validate';
import { listLiveChannelsQuery } from '../../schemas/consumerSchemas';
import { listPublishedLiveChannels } from '../../services/consumer/consumerLiveChannelService';

/**
 * Public channel list.
 *
 * List only. A channel has no consumer detail view — the list item already
 * carries everything a viewer may see — and the playable URL comes from
 * POST /playback/session.
 */
export const consumerLiveChannelsRouter: Router = Router();

consumerLiveChannelsRouter.get('/', async (req: Request, res: Response) => {
  const { page, limit, category } = parseOrThrow(listLiveChannelsQuery, req.query);

  res.json(
    await listPublishedLiveChannels({
      page,
      limit,
      category,
      lang: pickLocale(req.get('accept-language')),
    }),
  );
});
