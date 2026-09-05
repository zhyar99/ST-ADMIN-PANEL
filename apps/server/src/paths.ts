import path from 'node:path';

/**
 * Absolute path to the `apps/server` package, regardless of how the code runs:
 * - tsx dev  -> __dirname is `apps/server/src`
 * - tsup cjs -> __dirname is `apps/server/dist`
 * - vitest   -> ESM context with no __dirname; falls back to the package cwd.
 */
export const SERVER_ROOT =
  typeof __dirname === 'string' ? path.resolve(__dirname, '..') : process.cwd();

export const REPO_ROOT = path.resolve(SERVER_ROOT, '../..');

/** Resolves a possibly-relative configured path against the server package root. */
export function resolveFromServerRoot(target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(SERVER_ROOT, target);
}
