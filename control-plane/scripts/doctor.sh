#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/apps/control-plane/.env.local"

printf '%-18s %s\n' "system" "$(uname -s)-$(uname -m)"
printf '%-18s %s\n' "nix" "$(nix --version)"
printf '%-18s %s\n' "node" "$(node --version)"
printf '%-18s %s\n' "pnpm" "$(pnpm --version)"
printf '%-18s %s\n' "git" "$(git --version)"
printf '%-18s %s\n' "sqlite" "$(sqlite3 --version | awk '{print $1}')"
printf '%-18s %s\n' "cloudflared" "$(cloudflared --version 2>&1 | head -1)"

if [[ -f "$ENV_FILE" ]]; then
  echo "env                 present ($ENV_FILE)"
else
  echo "env                 MISSING (run: just env)"
fi

if [[ -f "$ROOT/pnpm-lock.yaml" ]]; then
  echo "pnpm lock           present"
else
  echo "pnpm lock           MISSING (run: just bootstrap)"
fi
