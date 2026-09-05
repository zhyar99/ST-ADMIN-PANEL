import type { NextFunction, Request, Response } from 'express';

import { config } from '../config';
import { logger } from '../logger';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

interface ErrorLike {
  status?: number;
  statusCode?: number;
  code?: string;
  message?: string;
  /** Set by `PublishValidationError`; see the note in `errorHandler`. */
  reasons?: unknown;
}

function statusOf(error: ErrorLike): number {
  const status = error.status ?? error.statusCode;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}

/**
 * Terminal Express 5 error handler. Logs the full error server-side and returns
 * a stable `{ error: { code, message } }` body — never a stack trace.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const error = (err ?? {}) as ErrorLike;
  const status = statusOf(error);

  logger.error({ err, requestId: req.id, path: req.originalUrl }, 'Request failed');

  if (res.headersSent) {
    res.end();
    return;
  }

  const isClientError = status < 500;
  const code = error.code ?? (isClientError ? 'BAD_REQUEST' : 'INTERNAL_ERROR');
  const message =
    isClientError || !config.isProduction
      ? (error.message ?? 'Request failed')
      : 'Internal server error';

  // A few client errors carry a machine-readable list alongside the prose — a
  // failed publish reports every unmet requirement so the UI can render them as
  // a checklist instead of re-parsing `message`. It is only ever forwarded on a
  // client error, so a 500's internals cannot ride out on it.
  const reasons =
    isClientError && Array.isArray(error.reasons)
      ? { reasons: error.reasons.filter((reason): reason is string => typeof reason === 'string') }
      : undefined;

  res.status(status).json({ error: { code, message, ...reasons } });
}
