#!/bin/sh
# Applies pending migrations, then hands the container over to the CMD.
#
# Deploying schema and code together is the point: the image that introduces a
# column is the image that applies it, so there is no window where new code is
# live against an old schema. The migrator takes a Postgres advisory lock, so
# several instances starting at once is safe — the others wait, then find
# nothing pending.
#
# Set RUN_MIGRATIONS_ON_START=false to opt out and run
# `node apps/server/dist/migrate.js` as a separate release step instead.
set -e

if [ "${RUN_MIGRATIONS_ON_START:-true}" = "true" ]; then
  echo "[entrypoint] Applying database migrations"
  node /app/apps/server/dist/migrate.js
else
  echo "[entrypoint] RUN_MIGRATIONS_ON_START=false — skipping migrations"
fi

# exec, so the server is PID 1 and receives SIGTERM directly on shutdown.
exec "$@"
