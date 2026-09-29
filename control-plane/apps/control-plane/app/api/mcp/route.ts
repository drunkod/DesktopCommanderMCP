import { createMcpProtectedRequestHandler } from "@better-auth/mcp";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { env } from "../../../lib/env";
import { buildServer } from "../../../lib/mcp-server";

const POST = createMcpProtectedRequestHandler({
  issuer: env.authIssuer,
  audience: env.remoteResource,
  jwksUrl: env.authJwksUrl,
  requiredScopes: ["mcp:tools"],
}, async (verifiedRequest, claims) => {
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    return new Response("OAuth token has no subject", { status: 401 });
  }
  const handler = createMcpHandler(
    () => buildServer(claims.sub as string),
    { legacy: "reject" },
  );
  return handler.fetch(verifiedRequest);
});

export { POST };
