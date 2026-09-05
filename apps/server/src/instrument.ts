import path from 'node:path';
import * as dotenv from 'dotenv';
import * as Sentry from '@sentry/node';

import { REPO_ROOT } from './paths';

// Sentry must be initialised before any instrumented module is imported, so this
// file loads the env itself instead of going through ./config.
dotenv.config({ path: path.join(REPO_ROOT, '.env') });

const dsn = process.env.SENTRY_DSN;

// No DSN in local development -> init is skipped entirely (a no-op, never throws).
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0,
  });
}
