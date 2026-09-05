#!/usr/bin/env bash
#
# Local logical backup of the Postgres database.
#
# The repository root is derived from this script's own location rather than
# from `git rev-parse --show-toplevel`: the enclosing git repository is not
# necessarily this project (a checkout nested inside a larger workspace resolves
# to the outer root), and a backup that writes to the wrong tree is worse than
# one that fails.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

# An already-exported DATABASE_URL wins, so this works in CI without a .env.
if [ -z "${DATABASE_URL:-}" ] && [ -f "${REPO_ROOT}/.env" ]; then
  # Read only the one variable, and only its first definition, so nothing else
  # in .env is evaluated by the shell.
  DATABASE_URL="$(grep -m1 -E '^[[:space:]]*DATABASE_URL=' "${REPO_ROOT}/.env" | cut -d= -f2-)"
  export DATABASE_URL
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "backup: DATABASE_URL is not set and ${REPO_ROOT}/.env does not define it" >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "backup: pg_dump is not on PATH" >&2
  exit 1
fi

BACKUP_DIR="${REPO_ROOT}/backups"
mkdir -p "${BACKUP_DIR}"

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
OUTFILE="${BACKUP_DIR}/streaming_backbone_${TIMESTAMP}.sql"

# Written to a partial file first: an interrupted dump then leaves a *.partial
# behind instead of a truncated .sql that looks like a usable backup.
pg_dump --no-owner --no-privileges "${DATABASE_URL}" > "${OUTFILE}.partial"
mv "${OUTFILE}.partial" "${OUTFILE}"

echo "Backup written to ${OUTFILE}"
