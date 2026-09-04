import type { TunnelDoctorCheck, TunnelDoctorReport, TunnelProviderName, TunnelState } from "./types.js";

export function joinHttpUrl(base: string, urlPath: string): string {
  const normalizedPath = urlPath.startsWith("/") ? urlPath : `/${urlPath}`;
  return new URL(normalizedPath, base.endsWith("/") ? base : `${base}/`).toString();
}

export async function checkHttpEndpoint(url: string, name: string): Promise<TunnelDoctorCheck> {
  const timeoutMs = Number(process.env.DC_TUNNEL_HEALTH_TIMEOUT_MS) || 5_000;
  try {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
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

export async function checkProtectedResourceMetadata(publicBaseUrl: string, expectedMcpUrl: string): Promise<TunnelDoctorCheck> {
  const url = joinHttpUrl(publicBaseUrl, "/.well-known/oauth-protected-resource/mcp");
  const timeoutMs = Number(process.env.DC_TUNNEL_HEALTH_TIMEOUT_MS) || 5_000;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { name: "public-oauth-resource", ok: false, detail: `HTTP ${response.status} ${response.statusText}` };
    const value = await response.json() as { resource?: string; authorization_servers?: string[] };
    const actual = value.resource?.replace(/\/$/, "");
    const expected = expectedMcpUrl.replace(/\/$/, "");
    if (actual !== expected) {
      return { name: "public-oauth-resource", ok: false, detail: `Protected-resource metadata advertises ${actual ?? "<missing>"}; expected ${expected}` };
    }
    const expectedIssuer = `${new URL(publicBaseUrl).origin}/api/auth`;
    if (!Array.isArray(value.authorization_servers) || !value.authorization_servers.includes(expectedIssuer)) {
      return { name: "public-oauth-resource", ok: false, detail: `Protected-resource metadata does not advertise authorization server ${expectedIssuer}` };
    }
    return { name: "public-oauth-resource", ok: true, detail: expected };
  } catch (error) {
    return { name: "public-oauth-resource", ok: false, detail: String(error) };
  }
}

export async function checkAuthorizationServerMetadata(publicBaseUrl: string): Promise<TunnelDoctorCheck> {
  const base = new URL(publicBaseUrl);
  const expectedIssuer = `${base.origin}/api/auth`;
  const url = joinHttpUrl(publicBaseUrl, "/api/auth/.well-known/oauth-authorization-server");
  const timeoutMs = Number(process.env.DC_TUNNEL_HEALTH_TIMEOUT_MS) || 5_000;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { name: "public-oauth-authorization-server", ok: false, detail: `HTTP ${response.status} ${response.statusText}` };
    const metadata = await response.json() as Record<string, unknown>;
    if (metadata.issuer !== expectedIssuer) {
      return { name: "public-oauth-authorization-server", ok: false, detail: `OAuth issuer is ${String(metadata.issuer ?? "<missing>")}; expected ${expectedIssuer}` };
    }
    const endpointKeys = ["authorization_endpoint", "registration_endpoint", "device_authorization_endpoint", "token_endpoint", "jwks_uri"];
    for (const key of endpointKeys) {
      const endpoint = metadata[key];
      if (typeof endpoint !== "string") return { name: "public-oauth-authorization-server", ok: false, detail: `OAuth metadata is missing ${key}` };
      if (new URL(endpoint).origin !== base.origin) return { name: "public-oauth-authorization-server", ok: false, detail: `${key} must use public application origin ${base.origin}` };
    }
    return { name: "public-oauth-authorization-server", ok: true, detail: expectedIssuer };
  } catch (error) {
    return { name: "public-oauth-authorization-server", ok: false, detail: String(error) };
  }
}

export function makeDoctorReport(provider: TunnelProviderName, state: TunnelState, checks: TunnelDoctorCheck[]): TunnelDoctorReport {
  return { provider, ok: checks.every((check) => check.ok), checks, state };
}
