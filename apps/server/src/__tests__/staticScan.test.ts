import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT, SERVER_ROOT } from '../paths';

/**
 * Source-level guards.
 *
 * These assert about the text of the repository rather than about its
 * behaviour, and they exist for the failures that behaviour tests cannot see:
 * a migration strategy that only bites on a colleague's machine, a localhost
 * URL that only bites in production, an ignore rule that only bites once a
 * secret is already committed.
 */

const SOURCE_ROOT = path.join(SERVER_ROOT, 'src');

interface SourceFile {
  /** Path relative to the repository root, for readable failure messages. */
  label: string;
  absolute: string;
  contents: string;
}

function collect(root: string): SourceFile[] {
  const files: SourceFile[] = [];

  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(absolute);
        continue;
      }

      if (!entry.name.endsWith('.ts')) continue;

      files.push({
        label: path.relative(REPO_ROOT, absolute),
        absolute,
        contents: fs.readFileSync(absolute, 'utf8'),
      });
    }
  };

  walk(root);
  return files;
}

const sourceFiles = collect(SOURCE_ROOT);

const isTestFile = (file: SourceFile): boolean =>
  file.absolute.includes(`${path.sep}__tests__${path.sep}`) || file.absolute.endsWith('.test.ts');

/** Strips `//` line comments and `/* *\/` blocks so a scan sees code only. */
function stripComments(contents: string): string {
  return contents.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('the source tree', () => {
  it('finds the server sources to scan', () => {
    expect(sourceFiles.length).toBeGreaterThan(40);
  });

  it('never reaches for the push migration strategy', () => {
    // Migrations are generate + committed SQL + migrate. The alternative diffs
    // a live database against the schema and applies the difference, which on
    // a shared database silently drops whatever it does not recognise.
    // Assembled from parts so this file is not itself a hit.
    const forbidden = ['drizzle-kit', 'push'].join(' ');

    const manifests = ['package.json', 'apps/server/package.json', 'apps/server/drizzle.config.ts']
      .map((relative) => ({ label: relative, absolute: path.join(REPO_ROOT, relative) }))
      .filter((entry) => fs.existsSync(entry.absolute))
      .map((entry) => ({ ...entry, contents: fs.readFileSync(entry.absolute, 'utf8') }));

    const offenders = [...sourceFiles, ...manifests]
      .filter((file) => file.contents.includes(forbidden))
      .map((file) => file.label);

    expect(offenders, `"${forbidden}" referenced in:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('hardcodes no localhost URL outside tests', () => {
    /**
     * `src/config/index.ts` is the one exemption, and deliberately so: it holds
     * the documented local-development default for STORAGE_URL_PREFIX, which is
     * overridden by the environment in every other deployment. Keeping the
     * default there is what makes a fresh clone run; the rule this test
     * enforces is that no *other* file may assume where the server lives.
     */
    const EXEMPT = [path.join('apps', 'server', 'src', 'config', 'index.ts')];

    const offenders = sourceFiles
      .filter((file) => !isTestFile(file) && !EXEMPT.includes(file.label))
      .filter((file) => /https?:\/\/localhost:\d+/.test(file.contents))
      .map((file) => file.label);

    expect(offenders, `hardcoded localhost URLs in:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('keeps stream_source out of the consumer routes', () => {
    const consumerRoutes = path.join('apps', 'server', 'src', 'routes', 'consumer');

    const offenders = sourceFiles
      .filter((file) => file.label.startsWith(consumerRoutes) && !isTestFile(file))
      .flatMap((file) =>
        stripComments(file.contents)
          .split('\n')
          .map((line, index) => ({ line, number: index + 1 }))
          .filter(
            ({ line }) => /stream_?[Ss]ource/.test(line) && /\burl\b/i.test(line),
          )
          .map(({ number }) => `${file.label}:${number}`),
      );

    expect(offenders, `stream source URL referenced in:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('reads DATABASE_URL and JWT_SECRET only from the environment', () => {
    // A literal would survive into `dist/` and into git. The config module is
    // the single reader; everything else goes through `config`.
    const offenders = sourceFiles
      .filter((file) => !isTestFile(file))
      .flatMap((file) => {
        const code = stripComments(file.contents);
        return ['DATABASE_URL', 'JWT_SECRET']
          .filter((name) => new RegExp(`${name}\\s*[:=]\\s*['\`"]`).test(code))
          .map((name) => `${file.label} (${name})`);
      });

    expect(offenders, `secret assigned as a literal in:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('contains no copy of the database password', () => {
    /**
     * The needle is read out of `.env` rather than written here, so this test
     * carries no credential of its own and keeps working after a rotation. No
     * .env (a fresh clone, CI) means nothing to look for.
     */
    const envPath = path.join(REPO_ROOT, '.env');
    if (!fs.existsSync(envPath)) return;

    const url = /^DATABASE_URL=(.+)$/m.exec(fs.readFileSync(envPath, 'utf8'))?.[1]?.trim();
    const password = url ? decodeURIComponent(new URL(url).password) : '';
    if (password.length < 6) return;

    const offenders = sourceFiles
      .filter((file) => file.contents.includes(password))
      .map((file) => file.label);

    expect(offenders, `database password found in:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('.gitignore', () => {
  /**
   * Asserted by asking git, not by string-matching the file.
   *
   * The question that matters is "would this path be committed", and the answer
   * depends on rule order and on negations — `apps/server/storage/` is written
   * as a re-including trio precisely so the .gitkeep skeleton survives, and a
   * literal-substring test would have to be wrong about one or the other.
   */
  function ignored(target: string): boolean {
    const result = spawnSync('git', ['check-ignore', '-q', '--no-index', target], {
      cwd: REPO_ROOT,
    });
    return result.status === 0;
  }

  const gitAvailable = spawnSync('git', ['--version']).status === 0;

  it.each([
    '.env',
    'apps/server/storage/posters/uploaded.jpg',
    'apps/server/storage/subtitles/uploaded.vtt',
    'apps/server/storage/stray-file.bin',
    'backups/streaming_backbone_20260101_000000.sql',
    'node_modules/left-pad/index.js',
    'apps/server/dist/server.js',
    'settings.local',
  ])('ignores %s', (target) => {
    if (!gitAvailable) return;
    expect(ignored(target), `.gitignore does not cover ${target}`).toBe(true);
  });

  it('still tracks the storage directory skeleton', () => {
    if (!gitAvailable) return;
    // Ignoring the uploads must not ignore the six directories they live in:
    // a fresh clone needs them for multer, and /ready proves them writable.
    expect(ignored('apps/server/storage/posters/.gitkeep')).toBe(false);
    expect(ignored('.env.example')).toBe(false);
  });

  it('has nothing sensitive in the git index', () => {
    if (!gitAvailable) return;

    const tracked = spawnSync(
      'git',
      ['ls-files', '--', '.env', 'apps/server/storage/', 'backups/'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );

    const committed = (tracked.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.endsWith('.gitkeep'));

    expect(committed, `committed secrets or uploads:\n${committed.join('\n')}`).toEqual([]);
  });
});
