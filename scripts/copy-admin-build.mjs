#!/usr/bin/env node
/**
 * Copies the built Admin SPA (apps/admin/dist) into the directory Express
 * serves it from (apps/server/public/admin), so a single Node process can
 * serve the SPA, the API and static storage.
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(repoRoot, 'apps/admin/dist');
const destination = resolve(repoRoot, 'apps/server/public/admin');

try {
  const sourceStat = await stat(source);
  if (!sourceStat.isDirectory()) {
    throw new Error(`${source} is not a directory`);
  }
} catch {
  console.error(`[copy-admin-build] Missing Admin build at ${source}. Run "pnpm build:admin" first.`);
  process.exit(1);
}

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });

console.log(`[copy-admin-build] Copied ${source} -> ${destination}`);
