import { Router, type Request, type Response } from 'express';

import { recordAudit } from '../../lib/audit';
import { pickLocale } from '../../lib/i18n';
import { parseOrThrow } from '../../lib/validate';
import { adminAuth } from '../../middleware/adminAuth';
import { HttpError } from '../../middleware/errorHandler';
import { requireRole } from '../../middleware/rbac';
import {
  analyticsPeriodQuery,
  deviceBlockBody,
  deviceIdParam,
  recommendationQuery,
  trendingQuery,
} from '../../schemas/personalizationSchemas';
import {
  getDeviceDetail,
  getDeviceOverview,
  getTrending,
  setDeviceBlocked,
} from '../../services/personalization/analyticsService';
import { getRecommendations } from '../../services/personalization/recommendationService';

/**
 * Device analytics for the Admin panel (Phase 15).
 *
 * The role split here is sharper than elsewhere in the admin API, and it is
 * about aggregation rather than about writes. A VIEWER may read the
 * platform-wide numbers — how many devices, what is trending — because those
 * describe the service. Anything addressed to a *single* device is ADMIN-only,
 * because a device id plus this data is one household's viewing history, and
 * the reasons to read one are moderation reasons.
 *
 * There is deliberately no endpoint that lists or searches device ids. An
 * operator investigating a device has to already know which device they are
 * investigating, which is what keeps "look up a device" from becoming "browse
 * everyone's history".
 */
export const adminAnalyticsRouter: Router = Router();

adminAnalyticsRouter.use(adminAuth);

function callerId(req: Request): string {
  const id = req.admin?.adminUserId;
  if (!id) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  return id;
}

adminAnalyticsRouter.get('/devices', async (req: Request, res: Response) => {
  const { period_days: periodDays } = parseOrThrow(analyticsPeriodQuery, req.query);

  res.json(await getDeviceOverview(periodDays, pickLocale(req.get('accept-language'))));
});

adminAnalyticsRouter.get('/trending', async (req: Request, res: Response) => {
  const query = parseOrThrow(trendingQuery, req.query);

  res.json({
    period_days: query.period_days,
    items: await getTrending(query.period_days, {
      contentType: query.content_type,
      limit: query.limit,
      lang: pickLocale(req.get('accept-language')),
    }),
  });
});

adminAnalyticsRouter.get(
  '/devices/:device_id',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { device_id: deviceId } = parseOrThrow(deviceIdParam, req.params);

    res.json({ device: await getDeviceDetail(deviceId, pickLocale(req.get('accept-language'))) });
  },
);

/**
 * What this device would be shown right now, with the scoring attached.
 *
 * The one place numeric scores leave the server. It exists because "why is this
 * device seeing that" is otherwise unanswerable — the ranking is derived from a
 * vector nobody can read by hand — and answering it is how an operator tells a
 * broken recommender from a working one they disagree with.
 */
adminAnalyticsRouter.get(
  '/devices/:device_id/recommendations',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { device_id: deviceId } = parseOrThrow(deviceIdParam, req.params);
    const query = parseOrThrow(recommendationQuery, req.query);

    // Confirms the device exists before scoring for it: `getRecommendations`
    // treats an unknown id as a cold start, which would make a typo look like a
    // real, if uninteresting, answer.
    await getDeviceDetail(deviceId, 'en');

    const result = await getRecommendations(deviceId, {
      contentTypes: query.content_types,
      limit: query.limit,
      cursor: query.cursor,
      excludeWatched: query.exclude_watched,
      lang: pickLocale(req.get('accept-language')),
    });

    res.json({
      items: result.items,
      next_cursor: result.nextCursor,
      total_available: result.totalAvailable,
      cold_start: result.coldStart,
    });
  },
);

adminAnalyticsRouter.patch(
  '/devices/:device_id/block',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { device_id: deviceId } = parseOrThrow(deviceIdParam, req.params);
    const { is_blocked: isBlocked } = parseOrThrow(deviceBlockBody, req.body ?? {});
    const actorId = callerId(req);

    await setDeviceBlocked(deviceId, isBlocked);

    await recordAudit({
      adminUserId: actorId,
      action: isBlocked ? 'DEVICE_BLOCK' : 'DEVICE_UNBLOCK',
      entityType: 'device_profile',
      entityId: deviceId,
    });

    res.json({ id: deviceId, is_blocked: isBlocked });
  },
);
