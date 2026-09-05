import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config';
import { logger } from '../logger';
import { ASSET_POLICY } from '../services/assets/policy';

/**
 * Every subdirectory of STORAGE_DIR the app writes into.
 *
 * Derived from the upload policy rather than listed by hand, so adding an asset
 * kind cannot leave its directory uncreated — or, in `/ready`, unchecked.
 */
export const STORAGE_SUBDIRECTORIES: readonly string[] = [
  ...new Set(Object.values(ASSET_POLICY).map((policy) => policy.directory)),
].sort();

/**
 * Creates STORAGE_DIR and its subdirectories if they are not already there.
 *
 * In a checkout these exist as committed `.gitkeep` folders, but a deployed
 * instance stores media on a mounted volume that starts out completely empty —
 * and multer does not create its own destination, so the first poster upload
 * after a deploy would fail with ENOENT. Running this before the listener opens
 * makes an empty volume and a fresh checkout behave identically, and makes the
 * `/ready` probe's writability check meaningful rather than a foregone failure.
 *
 * Idempotent (`mkdir -p` semantics), so it is safe on every boot.
 */
export async function ensureStorageDirectories(): Promise<void> {
  for (const directory of ['', ...STORAGE_SUBDIRECTORIES]) {
    await fs.mkdir(path.join(config.storageDir, directory), { recursive: true });
  }

  logger.info(
    { storageDir: config.storageDir, subdirectories: STORAGE_SUBDIRECTORIES },
    'Storage directories ready',
  );
}
