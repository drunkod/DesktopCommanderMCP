#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/apps/control-plane/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Run: just env" >&2
  exit 1
fi

changed=0
if ! grep -q '^BETTER_AUTH_DB_PATH=' "$ENV_FILE"; then
  printf '\nBETTER_AUTH_DB_PATH=%s/.data/better-auth.sqlite\n' "$ROOT" >> "$ENV_FILE"
  changed=1
fi

if ! grep -q '^JAZZ_TOKEN_PRIVATE_JWK_B64=' "$ENV_FILE"; then
  key_material="$(node <<'NODE'
const { generateKeyPairSync } = require("node:crypto");
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const encode = (key) => Buffer.from(JSON.stringify(key.export({ format: "jwk" }))).toString("base64url");
console.log(encode(privateKey));
console.log(encode(publicKey));
NODE
)"  private_jwk_b64="${key_material%%$'\n'*}"
  public_jwk_b64="${key_material#*$'\n'}"
  printf '\nJAZZ_TOKEN_PRIVATE_JWK_B64=%s\n' "$private_jwk_b64" >> "$ENV_FILE"
  printf 'JAZZ_TOKEN_PUBLIC_JWK_B64=%s\n' "$public_jwk_b64" >> "$ENV_FILE"
  changed=1
fi

python3 - "$ENV_FILE" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
text = path.read_text()
old = "JAZZ_JWKS_URL=http://127.0.0.1:3000/api/auth/jwks"
new = "JAZZ_JWKS_URL=http://127.0.0.1:3000/.well-known/jazz-jwks"
if old in text:
    path.write_text(text.replace(old, new))
    print("Updated JAZZ_JWKS_URL to the dedicated capability JWKS.")
PY

chmod 600 "$ENV_FILE"
if [[ "$changed" -eq 1 ]]; then
  echo "Added missing local capability configuration to $ENV_FILE"
else
  echo "Local environment already has capability key material."
fi