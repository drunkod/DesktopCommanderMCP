function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalBoolean(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be a boolean`);
}

function optionalPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const appOrigin = required("APP_ORIGIN").replace(/\/$/, "");
const authIssuer = `${appOrigin}/api/auth`;
const jazzServerUrl = required("JAZZ_SERVER_URL").replace(/\/$/, "");
const jazzInternalServerUrl = (
  process.env.JAZZ_INTERNAL_SERVER_URL?.trim() || jazzServerUrl
).replace(/\/$/, "");
const jazzBackendDataPath =
  process.env.JAZZ_BACKEND_DATA_PATH?.trim() || ".data/jazz-backend-runtime.db";

export const env = {
  appOrigin,
  authIssuer,
  authJwksUrl: `${authIssuer}/jwks`,
  betterAuthSecret: required("BETTER_AUTH_SECRET"),
  betterAuthDbPath: required("BETTER_AUTH_DB_PATH"),
  allowUnauthenticatedOAuthClientRegistration: optionalBoolean(
    "ALLOW_UNAUTHENTICATED_OAUTH_CLIENT_REGISTRATION",
  ),
  oauthAccessTokenExpiresIn: optionalPositiveInteger("OAUTH_ACCESS_TOKEN_EXPIRES_IN", 300),
  jazzAppId: required("JAZZ_APP_ID"),
  jazzServerUrl,
  jazzInternalServerUrl,
  jazzBackendDataPath,
  jazzAdminSecret: required("JAZZ_ADMIN_SECRET"),
  jazzBackendSecret: required("JAZZ_BACKEND_SECRET"),
  jazzJwksUrl: required("JAZZ_JWKS_URL"),
  jazzTokenPrivateJwkB64: required("JAZZ_TOKEN_PRIVATE_JWK_B64"),
  jazzTokenPublicJwkB64: required("JAZZ_TOKEN_PUBLIC_JWK_B64"),
  remoteResource: required("REMOTE_MCP_RESOURCE"),
};
