import { pino } from 'pino';

import { config } from './config';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (config.isProduction ? 'info' : 'debug'),
  // Defensive: never let a secret reach the log stream.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      // A device id is the whole of a viewer's identity in Phase 15 — anyone
      // holding one can read that device's history — so it is redacted on the
      // same terms as a session token.
      'req.headers["x-device-id"]',
      'DATABASE_URL',
      'JWT_SECRET',
    ],
    censor: '[redacted]',
  },
});
