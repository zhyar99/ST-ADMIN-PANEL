import type { z } from 'zod';

import { HttpError } from '../middleware/errorHandler';

/**
 * Parses an untrusted payload, converting a Zod failure into a 400 the error
 * handler already knows how to render. Every external input goes through here.
 */
export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);

  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    throw new HttpError(400, 'VALIDATION_ERROR', detail);
  }

  return result.data;
}
