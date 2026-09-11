import { SignJWT, importJWK } from "jose";
import { env } from "./env";

const ALG = "ES256";
const KID = "remote-mcp-jazz-v1";
const issuer = `${env.appOrigin}/.well-known/jazz-capability`;
const audience = `urn:remote-mcp:jazz:${env.jazzAppId}`;

const privateJwk = decodeJwk(env.jazzTokenPrivateJwkB64);
const publicJwk = decodeJwk(env.jazzTokenPublicJwkB64);
const privateKey = importJWK(privateJwk, ALG);

type Kind = "device" | "dashboard";

type MintInput = {
  subject: string;
  kind: Kind;
  deviceId?: string;
  clientId?: string;
};export async function mintJazzDeviceToken(
  subject: string,
  clientId: string,
  deviceId: string,
): Promise<string> {
  return mint({ subject, kind: "device", clientId, deviceId });
}

export async function mintJazzDashboardToken(subject: string): Promise<string> {
  return mint({ subject, kind: "dashboard" });
}


export function jazzJwks() {
  return {
    keys: [{ ...publicJwk, kid: KID, alg: ALG, use: "sig" }],
  };
}async function mint(input: MintInput): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const ttl = input.kind === "device" ? 90 : 120;
  const scope = `jazz:${input.kind}`;
  const nested = {
    scope: [scope],
    token_use: `jazz-${input.kind}`,
    jazz_app_id: env.jazzAppId,
    resource: env.remoteResource,
    jazz_issuer: issuer,
    jazz_audience: audience,
    ...(input.deviceId ? { device_id: input.deviceId } : {}),
    ...(input.clientId ? { client_id: input.clientId } : {}),
  };

  return new SignJWT({ claims: nested })
    .setProtectedHeader({ alg: ALG, kid: KID, typ: "JWT" })
    .setSubject(input.subject)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(await privateKey);
}function decodeJwk(encoded: string): Record<string, unknown> {
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JWK must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Invalid Jazz capability JWK: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}