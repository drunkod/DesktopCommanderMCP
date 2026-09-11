import { fetchAuthorizationServerMetadata, readBoundedJsonObject } from "../device-oauth.js";
import type { RemoteIdentityConfig } from "../remote-identity.js";
import { parseTrustedHttpUrl } from "../trusted-http-url.js";
import type { TunnelDoctorCheck, TunnelDoctorReport, TunnelProviderName, TunnelState } from "./types.js";

const HEALTH_MAX_JSON_BYTES = 64 * 1024;

export function joinHttpUrl(base: string, urlPath: string): string {
  const normalizedPath = urlPath.startsWith("/") ? urlPath : `/${urlPath}`;
  return new URL(normalizedPath, base.endsWith("/") ? base : `${base}/`).toString();
}

export async function checkHttpEndpoint(url: string, name: string): Promise<TunnelDoctorCheck> {
  const timeoutMs = Number(process.env.DC_TUNNEL_HEALTH_TIMEOUT_MS) || 5_000;
  try {
    const response = await fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    return { name, ok: response.status === 200, detail: `HTTP ${response.status} ${response.statusText}` };
  } catch (error) {
    return { name, ok: false, detail: String(error) };
  }
}

export function publicMcpUrl(publicBaseUrl: string, mcpPath = "/mcp"): string {
  const base = new URL(publicBaseUrl);
  if (base.protocol !== "https:") throw new Error(`Public MCP origin must use HTTPS: ${publicBaseUrl}`);
  return joinHttpUrl(base.origin, mcpPath).replace(/\/$/, "");
}

export async function checkProtectedResourceMetadata(
  publicBaseUrl: string,
  identity: RemoteIdentityConfig,
  callerSignal?: AbortSignal,
): Promise<TunnelDoctorCheck> {
  try {
    const base = parseTrustedHttpUrl(publicBaseUrl, "public tunnel base URL", {
      urlClass: "publicResource",
      profile: identity.runtimeProfile,
    });
    if (base.pathname !== "/" || base.origin !== new URL(identity.publicMcpResource).origin) {
      throw new Error("public tunnel base/resource origin mismatch");
    }
    const metadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", base).toString();
    const timeoutSignal = AbortSignal.timeout(Number(process.env.DC_TUNNEL_HEALTH_TIMEOUT_MS) || 5_000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(metadataUrl, { redirect: "error", signal });
    if (!response.ok) return { name: "public-oauth-resource", ok: false, detail: `HTTP ${response.status}` };
    const value = await readBoundedJsonObject(response, { maxBytes: HEALTH_MAX_JSON_BYTES, signal });
    if (value.resource !== identity.publicMcpResource) {
      return { name: "public-oauth-resource", ok: false, detail: "Protected-resource resource mismatch" };
    }
    const servers = value.authorization_servers;
    if (!Array.isArray(servers) || servers.length !== 1 || servers[0] !== identity.authorizationServerIssuer) {
      return { name: "public-oauth-resource", ok: false, detail: "authorization_servers must be the exact configured singleton" };
    }
    const bearerMethods = value.bearer_methods_supported;
    if (!Array.isArray(bearerMethods) || bearerMethods.length !== 1 || bearerMethods[0] !== "header") {
      return { name: "public-oauth-resource", ok: false, detail: "Bearer header capability not advertised exactly" };
    }
    const scopes = value.scopes_supported;
    const requiredScopes = ["mcp:tools", "device:sync"] as const;
    if (!Array.isArray(scopes) || scopes.length !== requiredScopes.length
      || !scopes.every((scope) => typeof scope === "string")
      || !requiredScopes.every((scope) => scopes.includes(scope))) {
      return { name: "public-oauth-resource", ok: false, detail: "Protected-resource scope profile mismatch" };
    }
    return { name: "public-oauth-resource", ok: true, detail: identity.publicMcpResource };
  } catch (error) {
    return { name: "public-oauth-resource", ok: false, detail: safeErrorClass(error) };
  }
}

export async function checkAuthorizationServerMetadata(
  identity: RemoteIdentityConfig,
  callerSignal?: AbortSignal,
): Promise<TunnelDoctorCheck> {
  try {
    const timeoutSignal = AbortSignal.timeout(Number(process.env.DC_TUNNEL_HEALTH_TIMEOUT_MS) || 5_000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    await fetchAuthorizationServerMetadata(identity, signal);
    return { name: "central-oauth-authorization-server", ok: true, detail: identity.authorizationServerIssuer };
  } catch (error) {
    return { name: "central-oauth-authorization-server", ok: false, detail: safeErrorClass(error) };
  }
}

function safeErrorClass(error: unknown): string {
  return error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name)
    ? "request cancelled or timed out"
    : "metadata check failed";
}

export function makeDoctorReport(provider: TunnelProviderName, state: TunnelState, checks: TunnelDoctorCheck[]): TunnelDoctorReport {
  return { provider, ok: checks.every((check) => check.ok), checks, state };
}
