import { Router, type Request, type Response } from 'express';

import { parseOrThrow } from '../../lib/validate';
import { playbackSessionBody } from '../../schemas/consumerSchemas';
import { createPlaybackSession } from '../../services/consumer/playbackService';

/**
 * Playback session issuance — the one endpoint that returns a stream URL.
 *
 * POST rather than GET, deliberately. A session is not a cacheable resource: it
 * picks a source based on current health, and putting the response anywhere a
 * GET might be cached or logged (proxies, browser history, access logs that
 * record query strings) is how a URL that never appears in a catalogue payload
 * ends up in one anyway.
 *
 * Nothing in this handler logs the response.
 */
export const consumerPlaybackRouter: Router = Router();

consumerPlaybackRouter.post('/session', async (req: Request, res: Response) => {
  // `language` is validated and then deliberately unused: nothing in a session
  // response is localised. It stays in the contract because the ad creative
  // Phase 11 adds will be chosen by language, and clients sending it from day
  // one means that arrives as a behaviour change rather than a breaking one.
  const { contentType, contentId } = parseOrThrow(playbackSessionBody, req.body ?? {});

  res.json(await createPlaybackSession({ contentType, contentId }));
});
