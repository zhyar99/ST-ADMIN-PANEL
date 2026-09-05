# streaming-backbone

A pnpm monorepo for the streaming platform's Admin Panel and API. One Node process
serves the Admin SPA, the API, and uploaded media.

Local development needs nothing but Node and Postgres. For hosting, the same
process ships as a single container — see **[DEPLOYMENT.md](DEPLOYMENT.md)** for
Koyeb + Neon.

| Package             | What it is                                        |
| ------------------- | ------------------------------------------------- |
| `apps/admin`        | React 19 + Vite + Tailwind 4 Admin SPA (`/admin`) |
| `apps/server`       | Express 5 + Drizzle ORM API (`/api/v1`)           |
| `packages/shared`   | Types/enums/constants shared by both              |

## Local setup

1. Install **Node 24 LTS** and **pnpm**:

   ```bash
   nvm install 24 && nvm use 24
   corepack enable && corepack prepare pnpm@latest --activate
   node --version   # v24.x
   ```

2. Install **PostgreSQL** (Homebrew, the native installer, or Docker):

   ```bash
   brew install postgresql@16 && brew services start postgresql@16
   # or: docker run --name pg -e POSTGRES_PASSWORD=... -p 5432:5432 -d postgres
   ```

3. Create the database:

   ```bash
   createdb -U postgres streaming_backbone
   # or: psql -U postgres -c "CREATE DATABASE streaming_backbone;"
   ```

4. Install dependencies:

   ```bash
   pnpm install
   ```

5. Create your env file and fill in any blanks:

   ```bash
   cp .env.example .env
   ```

6. Apply migrations:

   ```bash
   pnpm --filter @streaming/server db:migrate
   ```

7. Start both dev servers:

   ```bash
   pnpm dev
   ```

8. Open <http://localhost:5173/admin> (Vite dev server, proxies `/api` and `/storage`
   to Express) or <http://localhost:3000/admin> after a production build.

## Scripts

| Command                | What it does                                                        |
| ---------------------- | ------------------------------------------------------------------- |
| `pnpm dev`             | Vite dev server (5173) + Express with hot reload (3000)             |
| `pnpm build`           | Builds Admin + server, then copies the SPA into `apps/server/public/admin` |
| `pnpm start`           | Runs the built server (`node dist/server.js`)                       |
| `pnpm typecheck`       | `tsc --noEmit` in every workspace                                    |
| `pnpm test`            | Vitest in every workspace                                            |
| `pnpm lint`            | ESLint in every workspace                                            |
| `pnpm db:generate`     | Generates a migration SQL file from the Drizzle schema               |
| `pnpm db:migrate`      | Applies pending migrations                                           |
| `pnpm db:studio`       | Opens Drizzle Studio                                                 |
| `pnpm db:seed`         | Creates the first ADMIN account (idempotent)                        |
| `pnpm db:migrate:prod` | Applies migrations from the built bundle (no `tsx`)                 |
| `pnpm db:seed:prod`    | Seeds from the built bundle (no `tsx`)                              |

## Endpoints

| Method | Path            | Description                                        |
| ------ | --------------- | -------------------------------------------------- |
| GET    | `/health`       | Liveness — `{"status":"ok"}`                        |
| GET    | `/ready`        | Readiness — checks Postgres and storage writability |
| ALL    | `/api/v1/*`     | API router (stub; returns JSON 404 in Phase 1)      |
| GET    | `/storage/*`    | Uploaded media from `apps/server/storage`           |
| GET    | `/admin/*`      | Admin SPA with history fallback                     |

## Conventions

- **Migrations are files, never pushes.** Run `db:generate`, commit the SQL in
  `apps/server/drizzle/`, then `db:migrate`. Never `drizzle-kit push`.
- **All external input is validated with Zod** at the route boundary.
- `.env` is git-ignored; only `.env.example` is committed. `JWT_SECRET` in
  `.env.example` is a local-dev value — regenerate it before any shared deployment
  (`openssl rand -hex 32`).
- Uploaded files live in `apps/server/storage/`; the folders are committed via
  `.gitkeep`, their contents are ignored. Deployed, this is a mounted volume that
  starts empty, so the server creates the subdirectories itself on boot.

## Deployment

`Dockerfile` builds the whole thing into one image: the Admin SPA, the server
bundle and production dependencies only. It applies pending migrations on start
and runs as a non-root user.

```bash
docker build -t streaming-backbone .
docker run -p 8000:8000 \
  -e DATABASE_URL='postgresql://…' \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -v streaming-media:/data \
  streaming-backbone
```

`GET /health` is liveness (no dependencies) and `GET /ready` is readiness (names
the failing dependency). **[DEPLOYMENT.md](DEPLOYMENT.md)** covers Koyeb + Neon
end to end, including the two Neon connection strings and why media needs a
volume.
