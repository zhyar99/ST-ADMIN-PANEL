import { Router } from 'express';

import { adminAdvertisingRouter } from './admin/advertising';
import { adminAnalyticsRouter } from './admin/analytics';
import { adminAssetsRouter } from './admin/assets';
import { adminAuthRouter } from './admin/auth';
import { adminGenresRouter } from './admin/genres';
import { adminHomeRouter } from './admin/home';
import { adminImportRouter } from './admin/import';
import { adminLiveChannelsRouter } from './admin/liveChannels';
import { adminMoviesRouter } from './admin/movies';
import { adminRecommendationBoostsRouter } from './admin/recommendationBoosts';
import { adminSeriesRouter } from './admin/series';
import { adminStreamSourcesRouter } from './admin/streamSources';
import { adminUsersRouter } from './admin/users';
import { consumerDevicesRouter } from './consumer/devices';
import { consumerHomeRouter } from './consumer/home';
import { consumerLiveChannelsRouter } from './consumer/live-channels';
import { consumerMoviesRouter } from './consumer/movies';
import { consumerPlaybackRouter } from './consumer/playback';
import { consumerSearchRouter } from './consumer/search';
import { consumerSeriesRouter } from './consumer/series';

/**
 * `/api/v1` router. Any unmatched path under it falls through to a JSON 404.
 *
 * Two surfaces share this prefix and the split is by path, not by middleware
 * order: everything under `/admin/*` mounts a router that calls `adminAuth`
 * itself, and the consumer routers below mount nothing. Authentication is
 * therefore a property of each admin router rather than of where it sits in
 * this list, so adding a consumer route can never accidentally un-gate an
 * admin one.
 */
export const apiRouter: Router = Router();

apiRouter.use('/admin/auth', adminAuthRouter);
apiRouter.use('/admin/users', adminUsersRouter);
apiRouter.use('/admin/assets', adminAssetsRouter);
apiRouter.use('/admin/genres', adminGenresRouter);
apiRouter.use('/admin/movies', adminMoviesRouter);
apiRouter.use('/admin/series', adminSeriesRouter);
apiRouter.use('/admin/live-channels', adminLiveChannelsRouter);
apiRouter.use('/admin/stream-sources', adminStreamSourcesRouter);
apiRouter.use('/admin/home', adminHomeRouter);
apiRouter.use('/admin/advertising', adminAdvertisingRouter);
apiRouter.use('/admin/import', adminImportRouter);
apiRouter.use('/admin/analytics', adminAnalyticsRouter);
apiRouter.use('/admin/recommendation-boosts', adminRecommendationBoostsRouter);

// Consumer surface (Phase 9). Unauthenticated by design — consumer accounts are
// deferred — and published content only.
apiRouter.use('/movies', consumerMoviesRouter);
apiRouter.use('/series', consumerSeriesRouter);
apiRouter.use('/live-channels', consumerLiveChannelsRouter);
apiRouter.use('/home', consumerHomeRouter);
apiRouter.use('/search', consumerSearchRouter);
apiRouter.use('/playback', consumerPlaybackRouter);
// Device personalization (Phase 15). Unauthenticated like the rest of the
// consumer surface — identity is a client-generated UUID in `X-Device-ID`, and
// every route works without one.
apiRouter.use('/devices', consumerDevicesRouter);

apiRouter.use((req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No API route for ${req.method} ${req.originalUrl}` },
  });
});
