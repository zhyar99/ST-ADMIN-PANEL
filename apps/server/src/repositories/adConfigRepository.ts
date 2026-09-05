import { eq } from 'drizzle-orm';

import type {
  AdConfigDto,
  AdConfigUpdateInput,
} from '@streaming/shared' with { 'resolution-mode': 'import' };

import { db } from '../db/client';
import { adConfig, type AdConfig } from '../db/schema';

/**
 * Persistence for the single `ad_config` row.
 *
 * "Single" is a database fact, not a convention this file maintains: the table
 * carries a unique, check-constrained `singleton` column, so the get-or-create
 * below cannot produce a second config even if two admins open the page at the
 * same instant. That is what lets `getAdConfig` be a plain read for every call
 * after the first rather than a transaction.
 */

const columns = {
  preRollMinSeconds: adConfig.preRollMinSeconds,
  preRollMaxSeconds: adConfig.preRollMaxSeconds,
  midRollIntervalMinutes: adConfig.midRollIntervalMinutes,
  midRollMaxSeconds: adConfig.midRollMaxSeconds,
  skipAfterSeconds: adConfig.skipAfterSeconds,
  updatedAt: adConfig.updatedAt,
};

type Row = Pick<AdConfig, keyof typeof columns>;

function toDto(row: Row): AdConfigDto {
  return {
    preRollMinSeconds: row.preRollMinSeconds,
    preRollMaxSeconds: row.preRollMaxSeconds,
    midRollIntervalMinutes: row.midRollIntervalMinutes,
    midRollMaxSeconds: row.midRollMaxSeconds,
    skipAfterSeconds: row.skipAfterSeconds,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The current config, creating it with the schema defaults on first call.
 *
 * The insert is `ON CONFLICT DO NOTHING` followed by a re-read rather than
 * `RETURNING`: under a concurrent first call one of the two inserts is the
 * conflict and returns nothing, and the loser still has to end up with the
 * winner's row rather than an error. The defaults come from the column
 * definitions, so this function does not restate them — there is one place a
 * default lives, and it is the schema.
 */
export async function getAdConfig(): Promise<AdConfigDto> {
  const existing = await db.select(columns).from(adConfig).limit(1);
  if (existing[0]) return toDto(existing[0]);

  await db.insert(adConfig).values({}).onConflictDoNothing();

  const [row] = await db.select(columns).from(adConfig).limit(1);

  // Unreachable: the insert either wrote the row or lost to one that exists.
  if (!row) throw new Error('ad_config is missing after an insert that did not fail');

  return toDto(row);
}

/**
 * Applies a partial update to the config.
 *
 * The caller has already validated the patch against the merged result, so the
 * ordering rule is checked before this runs. The table's own CHECK constraints
 * are the backstop for anything that reaches the database another way.
 */
export async function updateAdConfig(patch: AdConfigUpdateInput): Promise<AdConfigDto> {
  // Guarantees a row exists to update, and is a single SELECT once it does.
  await getAdConfig();

  const [row] = await db
    .update(adConfig)
    .set({
      ...(patch.preRollMinSeconds !== undefined && {
        preRollMinSeconds: patch.preRollMinSeconds,
      }),
      ...(patch.preRollMaxSeconds !== undefined && {
        preRollMaxSeconds: patch.preRollMaxSeconds,
      }),
      ...(patch.midRollIntervalMinutes !== undefined && {
        midRollIntervalMinutes: patch.midRollIntervalMinutes,
      }),
      ...(patch.midRollMaxSeconds !== undefined && {
        midRollMaxSeconds: patch.midRollMaxSeconds,
      }),
      ...(patch.skipAfterSeconds !== undefined && {
        skipAfterSeconds: patch.skipAfterSeconds,
      }),
      updatedAt: new Date(),
    })
    .where(eq(adConfig.singleton, true))
    .returning(columns);

  if (!row) throw new Error('ad_config disappeared between the read and the update');

  return toDto(row);
}
