import { Router, type Request, type Response } from 'express';

import { pickLocale } from '../../lib/i18n';
import { parseOrThrow } from '../../lib/validate';
import { deviceIdOf, deviceIdentity } from '../../middleware/deviceIdentity';
import { deviceWatchLimiter } from '../../middleware/rateLimit';
import {
  deviceContentBody,
  deviceContentParams,
  deviceListQuery,
  historyQuery,
  recommendationQuery,
  watchEventBody,
} from '../../schemas/personalizationSchemas';
import {
  addToList,
  favoriteTable,
  listFavorites,
  listHistory,
  listWatchlist,
  removeFromList,
  watchlistTable,
} from '../../services/personalization/deviceListService';
import {
  getRecommendations,
  toConsumerItem,
} from '../../services/personalization/recommendationService';
import { recordWatchEvent } from '../../services/personalization/watchEventService';

/**
 * The anonymous device surface (Phase 15).
 *
 * No `adminAuth`, and no consumer auth either — identity here is a UUID the
 * client generates for itself and sends as `X-Device-ID`. That has two
 * consequences this router is built around:
 *
 *  1. **The header is the only accepted source of a device id.** No handler
 *     below reads a device id from a body, a query parameter or a path segment.
 *     A client that could name a device would be able to read any device's
 *     history by guessing, and a guessable id is all this surface has.
 *  2. **Nothing here requires the header.** A request without one is answered
 *     anonymously: recommendations fall back to a global popularity ranking,
 *     and the personal lists come back empty rather than 401. Phase 9 built
 *     this API to work with no identity at all, and personalization is additive
 *     to that, not a precondition for it.
 *
 * No response from this router carries a stream URL. Resuming an in-progress
 * title still goes through `POST /api/v1/playback/session`, which is the single
 * door Phase 9 left for that.
 */
export const consumerDevicesRouter: Router = Router();

consumerDevicesRouter.use(deviceIdentity);

/** The empty answer for every personal list when no device identified itself. */
const EMPTY_LIST = { items: [], next_cursor: null, total_available: 0 } as const;

/**
 * Reports a viewing session.
 *
 * 204, and deliberately so: a set-top box posts this constantly, has nothing to
 * do with a body, and should not be paying for one on a metered connection.
 */
consumerDevicesRouter.post(
  '/watch',
  deviceWatchLimiter,
  async (req: Request, res: Response) => {
    const payload = parseOrThrow(watchEventBody, req.body ?? {});
    const deviceId = deviceIdOf(res);

    // Without an id there is no profile to attribute the event to. Silently
    // accepted rather than rejected: an anonymous client is a supported client,
    // and failing its telemetry would make it retry forever.
    if (deviceId) await recordWatchEvent(deviceId, payload);

    res.status(204).end();
  },
);

/**
 * Ranked recommendations for the calling device.
 *
 * `Cache-Control: private, max-age=60` — private because the response is
 * specific to one device and must never be held by a shared proxy, and a minute
 * because that is long enough to absorb a TV's re-renders while still letting a
 * freshly-watched title change the list on the next screen the viewer opens.
 */
consumerDevicesRouter.get('/recommendations', async (req: Request, res: Response) => {
  const query = parseOrThrow(recommendationQuery, req.query);

  const result = await getRecommendations(deviceIdOf(res), {
    contentTypes: query.content_types,
    limit: query.limit,
    cursor: query.cursor,
    excludeWatched: query.exclude_watched,
    lang: pickLocale(req.get('accept-language')),
  });

  res.set('Cache-Control', 'private, max-age=60');
  res.json({
    // The numeric scores stay server-side. A client that could read them could
    // reconstruct the ranking model; the `reason` string is the part that is
    // actually useful to render.
    items: result.items.map(toConsumerItem),
    next_cursor: result.nextCursor,
    total_available: result.totalAvailable,
  });
});

consumerDevicesRouter.post('/favorites', async (req: Request, res: Response) => {
  const body = parseOrThrow(deviceContentBody, req.body ?? {});
  const deviceId = deviceIdOf(res);

  if (deviceId) await addToList(favoriteTable, deviceId, body.content_type, body.content_id);

  res.status(201).json({ ok: true });
});

consumerDevicesRouter.delete(
  '/favorites/:content_type/:content_id',
  async (req: Request, res: Response) => {
    const params = parseOrThrow(deviceContentParams, req.params);
    const deviceId = deviceIdOf(res);

    if (deviceId) {
      await removeFromList(favoriteTable, deviceId, params.content_type, params.content_id);
    }

    // 204 whether or not a row was there: a delete that has already happened
    // is a delete that succeeded, and telling the caller which of the two it
    // was would leak the existence of another device's rows.
    res.status(204).end();
  },
);

consumerDevicesRouter.get('/favorites', async (req: Request, res: Response) => {
  const query = parseOrThrow(deviceListQuery, req.query);
  const deviceId = deviceIdOf(res);

  if (!deviceId) {
    res.json(EMPTY_LIST);
    return;
  }

  res.json(
    await listFavorites(deviceId, {
      contentType: query.content_type,
      limit: query.limit,
      cursor: query.cursor,
      lang: pickLocale(req.get('accept-language')),
    }),
  );
});

consumerDevicesRouter.post('/watchlist', async (req: Request, res: Response) => {
  const body = parseOrThrow(deviceContentBody, req.body ?? {});
  const deviceId = deviceIdOf(res);

  if (deviceId) await addToList(watchlistTable, deviceId, body.content_type, body.content_id);

  res.status(201).json({ ok: true });
});

consumerDevicesRouter.delete(
  '/watchlist/:content_type/:content_id',
  async (req: Request, res: Response) => {
    const params = parseOrThrow(deviceContentParams, req.params);
    const deviceId = deviceIdOf(res);

    if (deviceId) {
      await removeFromList(watchlistTable, deviceId, params.content_type, params.content_id);
    }

    res.status(204).end();
  },
);

consumerDevicesRouter.get('/watchlist', async (req: Request, res: Response) => {
  const query = parseOrThrow(deviceListQuery, req.query);
  const deviceId = deviceIdOf(res);

  if (!deviceId) {
    res.json(EMPTY_LIST);
    return;
  }

  res.json(
    await listWatchlist(deviceId, {
      contentType: query.content_type,
      limit: query.limit,
      cursor: query.cursor,
      lang: pickLocale(req.get('accept-language')),
    }),
  );
});

/**
 * This device's watch history, newest first.
 *
 * Scoped to the header's device and nothing else — see the router note. There
 * is no parameter that could widen it.
 */
consumerDevicesRouter.get('/history', async (req: Request, res: Response) => {
  const query = parseOrThrow(historyQuery, req.query);
  const deviceId = deviceIdOf(res);

  if (!deviceId) {
    res.json(EMPTY_LIST);
    return;
  }

  res.set('Cache-Control', 'private, max-age=60');
  res.json(
    await listHistory(deviceId, {
      limit: query.limit,
      cursor: query.cursor,
      lang: pickLocale(req.get('accept-language')),
    }),
  );
});
