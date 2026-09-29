import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { auth } from "../../../../../lib/auth";
import { env } from "../../../../../lib/env";

const upstreamMetadata = oauthProviderAuthServerMetadata(auth);

export async function GET(request: Request) {
  const upstream = await upstreamMetadata(request);
  if (!upstream.ok) return upstream;
  const value = await upstream.json() as Record<string, unknown>;
  const metadata = {
    ...value,
    issuer: env.authIssuer,
    authorization_endpoint: `${env.authIssuer}/authorize`,
    device_authorization_endpoint: `${env.authIssuer}/oauth2/device-authorization`,
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["openid", "profile", "email", "offline_access", "mcp:tools", "device:sync"],
  };
  return Response.json(metadata, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}
