import * as Sentry from '@sentry/react';

/**
 * Sentry is optional in local development: with an empty VITE_SENTRY_DSN the
 * init call is skipped entirely, so nothing is sent and nothing throws.
 */
export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0,
  });
}
