import { defineConfig } from 'tsup';

/**
 * Three CommonJS entry points, all of which the deployed image needs:
 *
 * - `server`  — the HTTP process.
 * - `migrate` — applies `drizzle/*.sql` on release, so a container can bring
 *               the schema up to date without `tsx` or `drizzle-kit`, neither
 *               of which is installed in the production image.
 * - `seed`    — creates the first ADMIN, run once by hand after a deploy.
 *
 * The entries are named rather than passed as bare paths: `scripts/seed.ts`
 * lives outside `src/`, and with positional entries tsup would take the package
 * root as the common base and emit `dist/src/server.js`, breaking `pnpm start`.
 */
export default defineConfig({
  entry: {
    server: 'src/server.ts',
    migrate: 'src/db/migrate.ts',
    seed: 'scripts/seed.ts',
  },
  format: ['cjs'],
  outDir: 'dist',
  target: 'node24',
  sourcemap: true,
  clean: true,
  // Nothing imports this package's types; skipping declarations keeps the
  // container build from paying for a full type emit it would throw away.
  dts: false,
});
