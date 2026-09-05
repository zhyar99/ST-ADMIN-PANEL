import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { config } from '../config';
import { logger } from '../logger';
import * as schema from './schema';

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.DATABASE_POOL_MAX,
  /**
   * TLS is decided by config rather than left to the `sslmode` in the DSN, so a
   * managed database is reached over TLS even when someone pastes a connection
   * string without the query parameter. `rejectUnauthorized` is left at its
   * default: Neon's certificate chains to a public CA, so the server is really
   * verified instead of merely encrypted-to-whoever-answers.
   */
  ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
  /**
   * Serverless Postgres drops idle connections on its own schedule, and a
   * client that is closed at both ends is cheaper to notice here than to
   * discover mid-query. Retiring ours first keeps the pool's idle members
   * younger than the provider's idle timeout.
   */
  idleTimeoutMillis: 30_000,
  /**
   * A cold Neon compute takes a few hundred milliseconds to wake. Ten seconds
   * is far past that but still short enough that a genuinely unreachable
   * database fails the request instead of holding it open.
   */
  connectionTimeoutMillis: 10_000,
});

/**
 * Idle-client errors are emitted on the pool, not on a request's promise.
 *
 * `pg` re-emits them as an `error` event, and an `error` event with no listener
 * is an uncaught exception in Node — so without this handler a routine
 * server-side disconnect (exactly what a serverless database does to idle
 * connections) would take the whole process down. The pool discards the broken
 * client by itself; there is nothing to do here but record it.
 */
pool.on('error', (error) => {
  logger.error({ err: error }, 'Idle Postgres client error');
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;
