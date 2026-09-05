import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';

import { adminUser } from '../src/db/schema';
import { db, pool } from '../src/db/client';
import { logger } from '../src/logger';

/**
 * Bootstraps the first ADMIN account.
 *
 * Idempotent: if any active ADMIN already exists the script is a no-op, so it
 * is safe to re-run. The password is read from the environment and never logged.
 */
async function main(): Promise<void> {
  const [existing] = await db
    .select({ email: adminUser.email })
    .from(adminUser)
    .where(and(eq(adminUser.role, 'ADMIN'), eq(adminUser.isActive, true)))
    .limit(1);

  if (existing) {
    logger.info({ email: existing.email }, 'An active ADMIN already exists — nothing to seed');
    return;
  }

  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  const name = process.env.SEED_ADMIN_NAME?.trim() || 'Platform Admin';

  if (!email || !password) {
    throw new Error(
      'SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must both be set to seed the first ADMIN user',
    );
  }

  if (password.length < 10) {
    throw new Error('SEED_ADMIN_PASSWORD must be at least 10 characters');
  }

  const [created] = await db
    .insert(adminUser)
    .values({ email, name, role: 'ADMIN', passwordHash: await argon2.hash(password) })
    .returning({ id: adminUser.id, email: adminUser.email });

  logger.info({ id: created?.id, email: created?.email }, 'Seeded first ADMIN user');
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    logger.error(
      { err: error instanceof Error ? error.message : error },
      'Seed failed',
    );
    await pool.end();
    process.exit(1);
  });
