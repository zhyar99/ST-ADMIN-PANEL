import './instrument';

import { app } from './app';
import { config } from './config';
import { pool } from './db/client';
import { logger } from './logger';
import { ensureStorageDirectories } from './storage/ensureStorage';

/**
 * Bind address.
 *
 * Container platforms route to the container's own IP, not to loopback, so the
 * listener has to accept on every interface or the health check never connects.
 */
const HOST = '0.0.0.0';

/** How long in-flight requests get to finish before the process is forced down. */
const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  // Before the listener opens: a deployed instance keeps media on a volume that
  // starts empty, and multer will not create its own destination.
  await ensureStorageDirectories();

  const server = app.listen(config.PORT, HOST, () => {
    logger.info(
      {
        host: HOST,
        port: config.PORT,
        env: config.NODE_ENV,
        storageDir: config.storageDir,
        adminDir: config.adminDir,
        databaseSsl: config.databaseSsl,
        trustProxy: config.trustProxy,
      },
      'Server listening',
    );
  });

  let shuttingDown = false;

  /**
   * Graceful shutdown.
   *
   * A rolling deploy sends SIGTERM and then waits; draining the listener and
   * the Postgres pool in that window means in-flight admin writes commit
   * instead of being cut off mid-transaction. The timer is the backstop for a
   * connection that will not close on its own — and it is unref'd so it cannot
   * itself be the reason the process stays alive.
   */
  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Shutting down');

    const force = setTimeout(() => {
      logger.warn({ graceMs: SHUTDOWN_GRACE_MS }, 'Forcing shutdown; connections still open');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();

    server.close(() => {
      pool
        .end()
        .catch((error: unknown) => logger.error({ err: error }, 'Failed to close the database pool'))
        .finally(() => process.exit(0));
    });
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'Server failed to start');
  process.exit(1);
});
