# Deploying to Koyeb + Neon

This app deploys as **one container**: a single Node process serves the Admin SPA
(`/admin`), the API (`/api/v1`) and uploaded media (`/storage`). Koyeb builds the
`Dockerfile` in this repository straight from GitHub; Neon is the Postgres.

| Piece            | Where it lives                                          |
| ---------------- | ------------------------------------------------------- |
| Container image  | Built by Koyeb from `Dockerfile` on every push to `main` |
| Database         | Neon (Postgres 16+), reached over TLS                    |
| Schema           | `apps/server/drizzle/*.sql`, applied on container start  |
| Uploaded media   | A Koyeb **volume** mounted at `/data` — see [Media storage](#media-storage) |
| Secrets          | Koyeb secrets, injected as environment variables         |

---

## 1. Create the Neon database

1. Create a project at <https://console.neon.tech> — pick the region you will
   also run Koyeb in. Every request that touches the database pays this round
   trip, and a mismatched pair (say Neon in `us-east` and Koyeb in `fra`) adds
   roughly 100 ms to each one.
2. From the project dashboard, copy **both** connection strings:

   | Neon calls it | Host looks like              | Used for                     |
   | ------------- | ---------------------------- | ---------------------------- |
   | Pooled        | `ep-xxx-**pooler**.…`        | `DATABASE_URL` — the app     |
   | Direct        | `ep-xxx.…` (no `-pooler`)    | `MIGRATION_DATABASE_URL`     |

   Both need `?sslmode=require` on the end.

   **Why two.** The pooled endpoint is PgBouncer in transaction mode, which is
   the right thing for an API making many short queries — but it hands a
   different backend to every statement, so the session-scoped advisory lock the
   migration runner takes would be acquired on one connection and looked for on
   another. Migrations therefore use the direct host. If you only set
   `DATABASE_URL`, the migrator uses it too, which is fine for a single instance
   but will race if you ever scale past one.

3. Nothing else to do in Neon. The schema is created by the migrations in step 4.

---

## 2. Push this repository to GitHub

```bash
git push -u origin main
```

Koyeb reads the repository directly; there is no image to build or push by hand.

---

## 3. Create the Koyeb service

In the [Koyeb control panel](https://app.koyeb.com), **Create Service → GitHub**.

**Source**

- Repository `zhyar99/ST-ADMIN-PANEL`, branch `main`, autodeploy on.
- Builder: **Dockerfile**, path `Dockerfile` (Koyeb detects it).

**Instance**

- Size **Small** or larger. `sharp` decodes uploaded artwork in-process, and the
  nano/micro instances are tight for that.
- Regions: the one matching your Neon project.
- Scaling: **min 1, max 1** while media lives on a volume (see below).

**Exposed port**

- Port `8000`, path `/`. The image defaults `PORT` to 8000 and binds `0.0.0.0`;
  Koyeb's own `PORT` injection is also honoured.

**Health check**

- HTTP, port `8000`, path **`/health`**.
- Not `/ready`: `/ready` reports on Postgres and disk, so pointing the
  restart-er at it turns a transient database blip into a restart loop. Use
  `/ready` from your own monitoring instead — it tells you *which* dependency is
  down.

**Volume**

- Create a volume and mount it at **`/data`**. Skipping this is the single most
  common way to lose data here: without it, every uploaded poster disappears on
  the next deploy.

**Environment variables**

| Variable                 | Value                              | Type    |
| ------------------------ | ---------------------------------- | ------- |
| `DATABASE_URL`           | Neon **pooled** string              | Secret  |
| `MIGRATION_DATABASE_URL` | Neon **direct** string              | Secret  |
| `JWT_SECRET`             | `openssl rand -hex 32`              | Secret  |
| `NODE_ENV`               | `production`                        | Plain   |
| `TRUST_PROXY`            | `1`                                 | Plain   |
| `STORAGE_DIR`            | `/data/storage`                     | Plain   |
| `STORAGE_URL_PREFIX`     | `/storage`                          | Plain   |
| `DATABASE_SSL`           | `require`                           | Plain   |
| `DATABASE_POOL_MAX`      | `10`                                | Plain   |
| `SENTRY_DSN`             | your DSN, or leave unset            | Secret  |

`NODE_ENV`, `PORT`, `TRUST_PROXY`, `STORAGE_DIR` and `STORAGE_URL_PREFIX` already
have these values baked into the image — they are listed so the service page
shows what the app is running with, and so overriding one is a visible change.

Two of them matter more than they look:

- **`JWT_SECRET`** — must be at least 32 characters, and must *not* be the value
  in `.env.example`. That one is published in this repository; anyone could mint
  an admin token with it. Changing it later logs every session out, which is the
  correct behaviour but worth doing before you have users.
- **`TRUST_PROXY=1`** — Koyeb terminates TLS and forwards through one edge proxy.
  Without this, Express sees the proxy's address as `req.ip` and every rate
  limiter collapses into a single global bucket, so one busy client would lock
  out everyone.

Deploy. The first build takes a few minutes; later ones reuse the dependency
layer and are much quicker.

---

## 4. What happens on every deploy

The container entrypoint applies pending migrations, then starts the server:

```
[entrypoint] Applying database migrations
{"msg":"Migrations applied"}
{"msg":"Storage directories ready"}
{"msg":"Server listening","port":8000,"env":"production","trustProxy":1}
```

Schema and code ship together, so there is no window where new code runs against
an old schema. The runner takes a Postgres advisory lock, so simultaneous starts
are safe — the second one waits and finds nothing pending.

To run migrations as a separate release step instead, set
`RUN_MIGRATIONS_ON_START=false` and run `node apps/server/dist/migrate.js`
yourself.

---

## 5. Create the first admin account

The seed is a one-off. Set `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` on the
service, redeploy, then run in the Koyeb console shell:

```bash
node /app/apps/server/dist/seed.js
```

It is idempotent — if an active ADMIN already exists it does nothing. **Remove
both variables from the service afterwards**; they are only read by this script,
and a password sitting in the service configuration is a password waiting to be
read by whoever gets dashboard access next.

Then sign in at `https://<your-app>.koyeb.app/admin` and change the password.

---

## 6. Verify

```bash
curl https://<your-app>.koyeb.app/health   # {"status":"ok"}
curl https://<your-app>.koyeb.app/ready    # {"status":"ready"}
```

A `503` from `/ready` names the failing dependency and nothing else:

```json
{ "status": "not_ready", "details": ["database"] }
```

- `database` — check `DATABASE_URL`, that `?sslmode=require` is present, and that
  the Neon project is not suspended.
- `storage/...` — the volume is not mounted at `/data`, or `STORAGE_DIR` does not
  point inside it.

Then open `/admin`, sign in, and upload a poster — that exercises the database,
the volume and `sharp` in one go.

---

## Media storage

Uploaded posters, backdrops, logos, ad creatives and subtitles are written to
`STORAGE_DIR` on local disk. **A container filesystem does not survive a deploy**,
so this needs a Koyeb volume mounted at `/data`, and a Koyeb volume attaches to
exactly one instance — which is why the service is pinned to a single instance
above.

That is the real ceiling on this deployment. Scaling out means moving media to
object storage (S3, R2, Backblaze B2). The code is already shaped for it: every
public media URL is built in one place (`apps/server/src/lib/assetUrl.ts`) from
`STORAGE_URL_PREFIX`, so the URL side is a config change. The write side —
`apps/server/src/services/assets/assetService.ts` and the multer disk storage in
`uploadMiddleware.ts` — is what would need an S3 client.

Until then: **back up the volume**, or accept that losing it means re-uploading
every image. The catalogue rows survive in Neon either way; Neon's own
point-in-time restore covers the database.

---

## Routine operations

**A schema change**

```bash
pnpm db:generate                       # writes apps/server/drizzle/NNNN_*.sql
git add apps/server/drizzle && git commit -m "..."
git push                               # Koyeb deploys; the entrypoint applies it
```

Never `drizzle-kit push` against the deployed database — migrations are files, so
that every environment gets the same statements in the same order.

**Rotating `JWT_SECRET`** — change the secret and redeploy. Every issued token
becomes invalid, so everyone signs in again.

**Rolling back** — redeploy the previous deployment from the Koyeb dashboard.
Note that this rolls back *code only*: a migration that has already run stays
run, so a rollback across a destructive migration needs a Neon restore too.

**Logs** — structured JSON from pino, visible in the Koyeb log tab. Request
bodies are not logged; `Authorization` headers and cookies are redacted.

---

## Cost

Roughly, at the entry tiers: Neon has a free plan that suits a staging database
(it suspends when idle, so the first request after a quiet period is slow), and
Koyeb's Small instance plus a small volume is the paid part. Check both providers'
current pricing pages — these change.
