import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { config } from '../config';
import { SERVER_ROOT } from '../paths';
import { logger } from '../logger';

/**
 * Session-level advisory lock id, chosen once and never changed.
 *
 * Postgres advisory locks live in a single global namespace keyed by this
 * number, so it only has to be distinct from any other lock this database
 * takes — the value itself is arbitrary.
 */
const MIGRATION_LOCK_ID = 4_812_395_017;

/**
 * A pool of its own, rather than the application's.
 *
 * Two reasons: the migrator may need a different endpoint from the app (see
 * MIGRATION_DATABASE_URL), and a one-shot script has no use for ten
 * connections. `max: 1` also guarantees the advisory lock and the migrations
 * run over the same backend.
 */
const pool = new Pool({
  connectionString: config.migrationDatabaseUrl,
  max: 1,
  ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
  connectionTimeoutMillis: 15_000,
});

/**
 * Applies every pending SQL file in apps/server/drizzle/ then closes the pool.
 *
 * The whole run is wrapped in an advisory lock because a deploy may start
 * several instances at once, and each one runs this on boot: without the lock
 * two processes read the same "pending" list and both try to apply it, and the
 * loser dies on a duplicate object. With it, the second process waits, then
 * finds nothing left to do. The lock is session-scoped and this process holds
 * exactly one connection for it, so it is released by `pool.end()` even if the
 * migration throws.
 */
async function main(): Promise<void> {
  const migrationsFolder = path.join(SERVER_ROOT, 'drizzle');
  logger.info({ migrationsFolder }, 'Applying database migrations');

  await pool.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);

  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {
      // A lost connection already dropped the lock; nothing to release.
    });
  }

  logger.info('Migrations applied');
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    logger.error({ err: error }, 'Migration failed');
    await pool.end();
    process.exit(1);
  });
