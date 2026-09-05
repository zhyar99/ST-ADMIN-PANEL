import path from 'node:path';
import * as dotenv from 'dotenv';
import { z } from 'zod';

import { REPO_ROOT, resolveFromServerRoot } from '../paths';

dotenv.config({ path: path.join(REPO_ROOT, '.env') });

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /**
   * TLS policy for the Postgres connection.
   *
   * `auto` — the default — turns TLS on for every host except the loopback
   * ones, which is exactly the split between a managed provider (Neon, which
   * refuses plaintext) and a Postgres running on the developer's own machine.
   * The certificate is verified against the system CA store in every mode but
   * `disable`; Neon presents a publicly trusted certificate, so no bundled root
   * is needed and `rejectUnauthorized` is never turned off.
   */
  DATABASE_SSL: z.enum(['auto', 'require', 'disable']).default('auto'),
  /**
   * Connection string used by the migration runner, when it differs.
   *
   * Neon's pooled endpoint is PgBouncer in transaction mode, which hands a
   * different backend to every statement — so the session-scoped advisory lock
   * the migrator takes would be acquired on one connection and looked for on
   * another. Point this at the project's *direct* (non `-pooler`) host and the
   * lock behaves; the application keeps using the pooled endpoint, which is
   * what it wants for many short requests.
   *
   * Unset — the normal case for a plain Postgres — means "same as DATABASE_URL".
   */
  MIGRATION_DATABASE_URL: z.string().optional(),
  /**
   * Upper bound on pooled Postgres connections held by one instance.
   *
   * Neon's connection limit is per-project, not per-service, so this has to
   * leave room for the other instances of this service plus anything else
   * pointing at the same database. Ten is comfortable behind Neon's own PgBouncer
   * (the `-pooler` host); lower it if several instances share a small project.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  PORT: z.coerce.number().int().positive().default(3000),
  /**
   * How many reverse proxies sit in front of this process.
   *
   * Koyeb terminates TLS and forwards through one edge proxy, so every request
   * arrives from a datacentre address with the real client in
   * `X-Forwarded-For`. Without this, `req.ip` is that single proxy address and
   * every IP-keyed rate limiter in the app degenerates into one global bucket —
   * the first noisy client would lock out the whole platform.
   *
   * A number is a hop count and is what a known topology should use. `false`
   * (the local default) trusts nothing.
   */
  TRUST_PROXY: z
    .union([z.coerce.number().int().min(0).max(10), z.enum(['true', 'false'])])
    .default('false'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  STORAGE_DIR: z.string().min(1).default('./storage'),
  /**
   * Public origin+path that uploaded files are served from.
   *
   * A relative value ("/storage") is same-origin and the right choice on a
   * platform that assigns the hostname, which is why the deployed default is
   * relative rather than the localhost URL used in development.
   */
  STORAGE_URL_PREFIX: z.string().min(1).default('http://localhost:3000/storage'),
  SENTRY_DSN: z.string().optional().default(''),
  /**
   * Ceiling for a playlist upload (Phase 14), in megabytes.
   *
   * A real provider `.m3u` with tens of thousands of channels is a few MB, so
   * 50 is generous. It is the *first* of two guards: this one aborts the body
   * mid-stream, and the 200 000-entry cap in the import service stops a
   * pathological but small file from monopolising a request.
   */
  IMPORT_MAX_FILE_SIZE_MB: z.coerce.number().int().min(1).max(500).default(50),
  /**
   * How long a watch event is kept, in days (Phase 15).
   *
   * Enforced by a DELETE that runs inside the same transaction as every
   * ingestion rather than by a scheduled job — this phase adds no scheduler —
   * so the window is a rolling one and the table cannot outgrow it between
   * maintenance runs. 180 days is the default: long enough that the 35-day
   * half-life of the affinity model has fully decayed away, short enough that
   * the platform is not sitting on years of viewing behaviour it never reads.
   */
  WATCH_EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Only the variable names and validation messages are printed — never values.
  const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
}

/** Hosts that are reachable without TLS because they never leave the machine. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Resolves DATABASE_SSL=auto against the host in DATABASE_URL. */
function databaseUsesTls(url: string, mode: 'auto' | 'require' | 'disable'): boolean {
  if (mode !== 'auto') return mode === 'require';

  try {
    return !LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    // A unix-socket or otherwise unparseable DSN is local by construction.
    return false;
  }
}

/** Normalises TRUST_PROXY into the shape Express's `trust proxy` setting takes. */
function trustProxySetting(value: number | 'true' | 'false'): number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

export const config = {
  ...parsed.data,
  /** Whether the Postgres connection must be made over TLS. */
  databaseSsl: databaseUsesTls(parsed.data.DATABASE_URL, parsed.data.DATABASE_SSL),
  /** Connection string the migrator should use, falling back to the app's. */
  migrationDatabaseUrl: parsed.data.MIGRATION_DATABASE_URL || parsed.data.DATABASE_URL,
  /** Value handed to `app.set('trust proxy', …)`. */
  trustProxy: trustProxySetting(parsed.data.TRUST_PROXY),
  /** Absolute path to the local media storage root. */
  storageDir: resolveFromServerRoot(parsed.data.STORAGE_DIR),
  /** Absolute path to the copied Admin SPA build served by Express. */
  adminDir: resolveFromServerRoot('./public/admin'),
  /** {@link IMPORT_MAX_FILE_SIZE_MB} in bytes, which is what multer wants. */
  importMaxFileBytes: parsed.data.IMPORT_MAX_FILE_SIZE_MB * 1024 * 1024,
  isProduction: parsed.data.NODE_ENV === 'production',
} as const;

export type Config = typeof config;
