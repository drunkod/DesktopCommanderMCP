#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/apps/control-plane/.env.local"

if [[ -e "$ENV_FILE" && "${1:-}" != "--force" ]]; then
  echo "$ENV_FILE already exists. Use --force to replace it." >&2
  exit 1
fi

app_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
auth_secret="$(openssl rand -hex 32)"
admin_secret="jazz-admin-$(openssl rand -hex 24)"
backend_secret="jazz-backend-$(openssl rand -hex 24)"
key_material="$(node <<'NODE'
const { generateKeyPairSync } = require("node:crypto");
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const encode = (key) => Buffer.from(JSON.stringify(key.export({ format: "jwk" }))).toString("base64url");
console.log(encode(privateKey));
console.log(encode(publicKey));
NODE
)"
private_jwk_b64="${key_material%%$'\n'*}"
public_jwk_b64="${key_material#*$'\n'}"

umask 077
cat > "$ENV_FILE" <<EOF
APP_ORIGIN=http://127.0.0.1:3000
BETTER_AUTH_SECRET=$auth_secret
BETTER_AUTH_DB_PATH=$ROOT/.data/better-auth.sqlite
REMOTE_MCP_RESOURCE=http://127.0.0.1:3000/mcp

JAZZ_APP_ID=$app_id
JAZZ_SERVER_URL=http://127.0.0.1:1625
JAZZ_INTERNAL_SERVER_URL=http://127.0.0.1:1625
JAZZ_ADMIN_SECRET=$admin_secret
JAZZ_BACKEND_SECRET=$backend_secret
JAZZ_TOKEN_PRIVATE_JWK_B64=$private_jwk_b64
JAZZ_TOKEN_PUBLIC_JWK_B64=$public_jwk_b64
JAZZ_JWKS_URL=http://127.0.0.1:3000/.well-known/jazz-jwks

NEXT_PUBLIC_JAZZ_APP_ID=$app_id
NEXT_PUBLIC_JAZZ_SERVER_URL=http://127.0.0.1:1625
EOF

chmod 600 "$ENV_FILE"
echo "Created $ENV_FILE"
echo "JAZZ_APP_ID=$app_id"
echo "Secrets were written only to the ignored .env.local file."
