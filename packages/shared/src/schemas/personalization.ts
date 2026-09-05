import { z } from 'zod';

import { DEVICE_CONTENT_TYPES, WATCH_CONTENT_TYPES } from '../enums.js';

/**
 * Input shapes for the device personalization surface (Phase 15).
 *
 * Every field a device sends arrives here first. The rules are deliberately
 * strict about the two things a client gets wrong in the field: a clock that
 * disagrees with the server's (hence the not-in-the-future check on
 * `started_at`) and a retry loop that re-posts a session it already posted
 * (handled by the ±60 s de-duplication in the service, which needs a trustworthy
 * `started_at` to work at all).
 *
 * Wire format is snake_case here, unlike the camelCase admin bodies: these are
 * consumed by the TV client, whose payloads mirror the API documentation
 * one-for-one.
 */

/** A device identity: the raw UUID a client generates once and persists. */
export const DeviceId = z.string().uuid('X-Device-ID must be a UUID');

/**
 * Zod mirrors of the shared enums.
 *
 * Suffixed rather than named after the type they validate: `enums.ts` already
 * exports `WatchContentType` as a *type*, and the package barrel re-exports
 * both files, so a second export under the same name would be ambiguous.
 */
export const WatchContentTypeEnum = z.enum(WATCH_CONTENT_TYPES);

export const DeviceContentTypeEnum = z.enum(DEVICE_CONTENT_TYPES);

/**
 * One reported viewing session.
 *
 * `content_seconds` is allowed to be 0 or absent — a live channel has no
 * runtime, and a VOD file may not have been probed yet. That case is recorded
 * with a completion rate of 0 rather than rejected, because throwing the event
 * away would lose the fact that the device watched *something*.
 */
export const watchEventSchema = z.object({
  content_type: WatchContentTypeEnum,
  content_id: z.string().uuid('content_id must be a uuid'),
  watch_seconds: z.coerce.number().int().min(0).max(86_400),
  // Section 9 of the brief says `>= 1`; the edge-case list two sections later
  // says 0 or null must be *recorded* with a completion rate of 0 rather than
  // rejected. The latter is the specific instruction, so 0 is accepted here and
  // the completion rate is what degrades.
  content_seconds: z.coerce.number().int().min(0).max(86_400).default(0),
  rewatch: z.boolean().default(false),
  started_at: z
    .string()
    .datetime({ offset: true, message: 'started_at must be an ISO 8601 timestamp' })
    .optional()
    // A future timestamp would earn a recency weight above 1 and let a client
    // inflate its own affinity scores by lying about its clock.
    .refine(
      (value) => value === undefined || Date.parse(value) <= Date.now() + 60_000,
      'started_at must not be in the future',
    ),
});

export type WatchEventPayload = z.infer<typeof watchEventSchema>;

/** Comma-separated `content_types=MOVIE,SERIES` as a TV client sends it. */
const contentTypeList = z
  .union([z.string(), z.array(DeviceContentTypeEnum)])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (Array.isArray(value)) return value;
    return value
      .split(',')
      .map((entry) => entry.trim().toUpperCase())
      .filter((entry) => entry.length > 0);
  })
  .pipe(z.array(DeviceContentTypeEnum).min(1).max(3).optional());

/**
 * Query for the recommendation endpoint.
 *
 * `limit` is capped at 50 because each item costs a localisation pass and an
 * artwork join, and `cursor` is base64(offset) rather than a keyset: the sort
 * key is a score computed per request, so there is no stable column to seek on.
 */
export const recommendationQuerySchema = z.object({
  content_types: contentTypeList,
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(64).optional(),
  exclude_watched: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .default(true)
    .transform((value) => value === true || value === 'true' || value === '1'),
});

export type RecommendationQuery = z.infer<typeof recommendationQuerySchema>;

/** Adding or removing a favourite / watchlist entry. */
export const deviceContentRefSchema = z.object({
  content_type: DeviceContentTypeEnum,
  content_id: z.string().uuid('content_id must be a uuid'),
});

export type DeviceContentRef = z.infer<typeof deviceContentRefSchema>;

/**
 * An editorial score delta.
 *
 * Bounded at ±1.0 because it is added to a final score whose weighted parts sum
 * to at most 1.0: a boost outside that range would stop being a thumb on the
 * scale and start being the whole scale. Two decimal places, matching
 * `numeric(4,2)`.
 */
export const boostScoreSchema = z.coerce
  .number()
  .min(-1, 'boost_score must be at least -1.0')
  .max(1, 'boost_score must be at most 1.0')
  .refine(
    (value) => Number.isInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-9,
    'boost_score must be a multiple of 0.01',
  );

export const recommendationBoostBody = z.object({
  content_type: DeviceContentTypeEnum,
  content_id: z.string().uuid('content_id must be a uuid'),
  boost_score: boostScoreSchema,
  reason: z.string().trim().max(200).optional(),
  expires_at: z
    .string()
    .datetime({ offset: true, message: 'expires_at must be an ISO 8601 timestamp' })
    .nullish(),
});

export type RecommendationBoostBody = z.infer<typeof recommendationBoostBody>;
