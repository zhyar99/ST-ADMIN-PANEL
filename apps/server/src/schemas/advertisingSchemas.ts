import { z } from 'zod';

import { HttpError } from '../middleware/errorHandler';

/**
 * Zod shapes for every untrusted input the advertising routes accept.
 *
 * Two rules are expressed here and nowhere else in the request path: the
 * timing values are positive integers, and a pre-roll's maximum is not below
 * its minimum. The second is checked against the *merged* config rather than
 * the patch, because a body that lowers only `preRollMaxSeconds` is a valid
 * patch and an invalid config — the route resolves the merge and calls
 * {@link assertPreRollOrder}.
 */

/** Seconds and minutes alike: whole, positive, and small enough to be a break. */
const positiveInt = (label: string) =>
  z
    .number({ invalid_type_error: `${label} must be a whole number of seconds` })
    .int(`${label} must be a whole number`)
    .min(1, `${label} must be at least 1`)
    // An upper bound because every external input is bounded. An hour-long
    // pre-roll is not a configuration anyone means, and unbounded integers are
    // how a typo becomes an unplayable session.
    .max(3600, `${label} must be at most 3600`);

export const adConfigUpdateBody = z
  .object({
    preRollMinSeconds: positiveInt('preRollMinSeconds').optional(),
    preRollMaxSeconds: positiveInt('preRollMaxSeconds').optional(),
    midRollIntervalMinutes: positiveInt('midRollIntervalMinutes').optional(),
    midRollMaxSeconds: positiveInt('midRollMaxSeconds').optional(),
    skipAfterSeconds: positiveInt('skipAfterSeconds').optional(),
  })
  // An empty body is a no-op the caller almost certainly did not mean, and
  // silently returning the unchanged config would read as a successful save.
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'At least one field must be provided',
  });

export type AdConfigUpdateBody = z.infer<typeof adConfigUpdateBody>;

export const adCreativeCreateBody = z.object({
  assetId: z.string().uuid('assetId must be an asset id'),
  durationSeconds: positiveInt('durationSeconds'),
});

export const adCreativeUpdateBody = z
  .object({
    durationSeconds: positiveInt('durationSeconds').optional(),
    isActive: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'At least one field must be provided',
  });

export const adCreativeIdParam = z.object({
  id: z.string().uuid('Not a valid ad creative id'),
});

/**
 * The one rule a per-field schema cannot express.
 *
 * `preRollMaxSeconds >= preRollMinSeconds` is a property of the config, not of
 * either field, so it is checked after the patch is merged onto the stored row.
 * A 400 with the same `VALIDATION_ERROR` code `parseOrThrow` produces, so a
 * client handles both the same way.
 */
export function assertPreRollOrder(merged: {
  preRollMinSeconds: number;
  preRollMaxSeconds: number;
}): void {
  if (merged.preRollMaxSeconds < merged.preRollMinSeconds) {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      `preRollMaxSeconds (${merged.preRollMaxSeconds}) must be at least preRollMinSeconds (${merged.preRollMinSeconds})`,
    );
  }
}
