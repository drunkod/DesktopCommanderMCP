import { createMcpProtectedRequestHandler } from "@better-auth/mcp";
import { env } from "./env";
import { requireActiveOAuthClient } from "./authorization-service";

export type DevicePrincipal = {
  subject: string;
  clientId: string;
};

type DeviceHandler = (
  request: Request,
  principal: DevicePrincipal,
) => Promise<Response>;

export function createDeviceProtectedHandler(handler: DeviceHandler) {
  return createMcpProtectedRequestHandler({
    issuer: env.authIssuer,
    audience: env.remoteResource,
    jwksUrl: env.authJwksUrl,
    requiredScopes: ["device:sync"],
  }, async (request, claims) => {
    const principal = devicePrincipal(claims as Record<string, unknown>);
    if (!principal) {
      return Response.json({ ok: false, error: "Device token is missing subject/client identity" }, { status: 401 });
    }
    try {
      await requireActiveOAuthClient(principal.clientId);
    } catch {
      return Response.json({ ok: false, error: "Device OAuth client is not active" }, { status: 401 });
    }
    return handler(request, principal);
  });
}

function devicePrincipal(claims: Record<string, unknown>): DevicePrincipal | null {
  const subject = typeof claims.sub === "string" ? claims.sub : null;
  const nested = isRecord(claims.claims) ? claims.claims : {};
  const clientId = typeof claims.client_id === "string"
    ? claims.client_id
    : typeof nested.client_id === "string"
      ? nested.client_id
      : null;
  return subject && clientId ? { subject, clientId } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
