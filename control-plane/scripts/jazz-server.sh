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

export JAZZ_DATA_DIR="$ROOT/.data/jazz"
export JAZZ_PORT="${JAZZ_PORT:-1625}"

exec pnpm --dir "$ROOT/apps/control-plane" jazz:serve
