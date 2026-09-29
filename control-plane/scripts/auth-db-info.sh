#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/apps/control-plane/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Run: just env" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ ! -f "$BETTER_AUTH_DB_PATH" ]]; then
  echo "Better Auth database not created yet: $BETTER_AUTH_DB_PATH"
  echo "Run: just auth-plan, review it, then just auth-migrate"
  exit 1
fi

echo "Better Auth SQLite: $BETTER_AUTH_DB_PATH"
echo "foreign_keys: $(sqlite3 "$BETTER_AUTH_DB_PATH" 'PRAGMA foreign_keys;')"
echo "journal_mode: $(sqlite3 "$BETTER_AUTH_DB_PATH" 'PRAGMA journal_mode;')"
echo "tables:"
sqlite3 "$BETTER_AUTH_DB_PATH" ".tables"
