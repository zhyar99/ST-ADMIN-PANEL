import { z } from 'zod';

import { deviceContentType, watchContentType } from '../db/schema';

/**
 * Zod shapes for every untrusted input the personalization routes accept.
 *
 * These mirror `packages/shared/src/schemas/personalization.ts`, which the
 * Admin SPA uses for form validation, and they are not imported from there for
 * the reason `catalogSchemas.ts` sets out at length: @streaming/shared is ESM
 * and this server compiles to CommonJS, so types cross that boundary and
 * runtime values do not.
 *
 * This copy is the one that matters — it is the security boundary. The device
 * surface is unauthenticated, so every field below is hostile input from an
 * anonymous client until it has been through here.
 */

/** Enum values come from the Drizzle schema so they cannot drift from the DB. */
const watchContentTypes = watchContentType.enumValues;
const deviceContentTypes = deviceContentType.enumValues;

/**
 * The longest session a single event may claim: 24 hours.
 *
 * A cap is needed because `watch_seconds` feeds a cumulative total and a
 * completion rate; without one, a client with a runaway counter could dominate
 * every popularity ranking on the platform from a single device.
 */
const MAX_EVENT_SECONDS = 86_400;

export const watchEventBody = z.object({
  content_type: z.enum(watchContentTypes),
  content_id: z.string().uuid('content_id must be a uuid'),
  watch_seconds: z.coerce.number().int().min(0).max(MAX_EVENT_SECONDS),
  /**
   * 0 means "runtime unknown" — a live channel, or a file that has not been
   * probed. The event is still recorded; its completion rate degrades to 0
   * rather than the whole report being rejected.
   */
  content_seconds: z.coerce.number().int().min(0).max(MAX_EVENT_SECONDS).default(0),
  rewatch: z.boolean().default(false),
  started_at: z
    .string()
    .datetime({ offset: true, message: 'started_at must be an ISO 8601 timestamp' })
    .optional()
    // A future timestamp earns a recency weight of 1 and would let a client
    // inflate its own affinity by lying about its clock. A minute of tolerance
    // covers ordinary clock skew on a TV that has just booted.
    .refine(
      (value) => value === undefined || Date.parse(value) <= Date.now() + 60_000,
      'started_at must not be in the future',
    ),
});

export type WatchEventBody = z.infer<typeof watchEventBody>;

/** `?content_types=MOVIE,SERIES`, as a TV client sends it. */
const contentTypeList = z
  .string()
  .optional()
  .transform((value) =>
    value === undefined
      ? undefined
      : value
          .split(',')
          .map((entry) => entry.trim().toUpperCase())
          .filter((entry) => entry.length > 0),
  )
  .pipe(z.array(z.enum(deviceContentTypes)).min(1).max(3).optional());

/** Query strings carry no booleans, so the three truthy spellings are accepted. */
const queryBoolean = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((value) => (value === undefined ? fallback : value === 'true' || value === '1'));

export const recommendationQuery = z.object({
  content_types: contentTypeList,
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(64).optional(),
  exclude_watched: queryBoolean(true),
});

export type RecommendationQueryInput = z.infer<typeof recommendationQuery>;

export const deviceListQuery = z.object({
  content_type: z.enum(deviceContentTypes).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(64).optional(),
});

export const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(64).optional(),
});

export const deviceContentBody = z.object({
  content_type: z.enum(deviceContentTypes),
  content_id: z.string().uuid('content_id must be a uuid'),
});

export const deviceContentParams = z.object({
  content_type: z.enum(deviceContentTypes),
  content_id: z.string().uuid('content_id must be a uuid'),
});

// --- admin ----------------------------------------------------------------

export const analyticsPeriodQuery = z.object({
  period_days: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(64).optional(),
});

export const trendingQuery = z.object({
  period_days: z.coerce.number().int().min(1).max(365).default(7),
  content_type: z.enum(watchContentTypes).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * A device id in an admin URL.
 *
 * Only the shape is checked here — an id that no device ever used is a 404 from
 * the service, not a validation error, because the two are indistinguishable
 * from outside and conflating them tells an attacker nothing either way.
 */
export const deviceIdParam = z.object({
  device_id: z.string().uuid('Not a valid device id'),
});

export const deviceBlockBody = z.object({
  is_blocked: z.boolean(),
});

/**
 * An editorial score delta, bounded to ±1.0.
 *
 * The weighted signals it is added to sum to at most 1.0, so anything outside
 * this range would stop being a thumb on the scale and become the scale.
 * Two decimal places, matching `numeric(4,2)`.
 */
export const boostScore = z.coerce
  .number()
  .min(-1, 'boost_score must be at least -1.0')
  .max(1, 'boost_score must be at most 1.0');

export const recommendationBoostBody = z.object({
  content_type: z.enum(deviceContentTypes),
  content_id: z.string().uuid('content_id must be a uuid'),
  boost_score: boostScore,
  reason: z.string().trim().max(200).optional(),
  expires_at: z
    .string()
    .datetime({ offset: true, message: 'expires_at must be an ISO 8601 timestamp' })
    .nullish(),
});

export const boostIdParam = z.object({
  id: z.string().uuid('Not a valid boost id'),
});
