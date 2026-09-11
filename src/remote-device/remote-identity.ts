import {
  isApprovedLiteralLoopbackHost,
  parseTrustedHttpUrl,
  type RuntimeProfile,
} from "./trusted-http-url.js";

export type RemoteIdentityConfig = Readonly<{
  runtimeProfile: RuntimeProfile;
  authorizationServerIssuer: string;
  publicMcpResource: string;
  internalDeviceApiOrigin: string;
}>;

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  if (value !== value.trim() || /\s/.test(value)) throw new Error(`${name} must not contain whitespace`);
  return value;
}

function requireCanonicalPublic(
  raw: string,
  label: string,
  urlClass: "publicOAuth" | "publicResource",
  profile: RuntimeProfile,
  exactPath?: string,
): string {
  const url = parseTrustedHttpUrl(raw, label, { urlClass, profile });
  if (exactPath !== undefined && url.pathname !== exactPath) {
    throw new Error(`${label} must use the exact ${exactPath} path`);
  }
  const canonical = url.pathname === "/" ? url.origin : `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  if (raw !== canonical) throw new Error(`${label} is noncanonical; expected ${canonical}`);
  return raw;
}

export function requireCanonicalIssuer(raw: string, profile: RuntimeProfile): string {
  return requireCanonicalPublic(raw, "authorization issuer", "publicOAuth", profile);
}

export function requireCanonicalMcpResource(raw: string, profile: RuntimeProfile): string {
  return requireCanonicalPublic(raw, "MCP resource", "publicResource", profile, "/mcp");
}

export function requireInternalLoopbackOrigin(raw: string, profile: RuntimeProfile): string {
  const url = parseTrustedHttpUrl(raw, "internal device API origin", {
    urlClass: "internalLoopback",
    profile,
  });
  if (!isApprovedLiteralLoopbackHost(url.hostname)) throw new Error("MCP_SERVER_URL must be literal loopback");
  if (url.pathname !== "/") throw new Error("MCP_SERVER_URL must be an origin without a path");
  if (raw !== url.origin) throw new Error(`MCP_SERVER_URL is noncanonical; expected ${url.origin}`);
  return raw;
}

export function createRemoteIdentity(input: RemoteIdentityConfig): RemoteIdentityConfig {
  if (input.runtimeProfile !== "production" && input.runtimeProfile !== "development" && input.runtimeProfile !== "test") {
    throw new Error(`Unsupported remote runtime profile: ${input.runtimeProfile}`);
  }
  return Object.freeze({
    runtimeProfile: input.runtimeProfile,
    authorizationServerIssuer: requireCanonicalIssuer(input.authorizationServerIssuer, input.runtimeProfile),
    publicMcpResource: requireCanonicalMcpResource(input.publicMcpResource, input.runtimeProfile),
    internalDeviceApiOrigin: requireInternalLoopbackOrigin(input.internalDeviceApiOrigin, input.runtimeProfile),
  });
}

export function loadRemoteIdentityFromEnv(
  profile: RuntimeProfile = (process.env.DC_REMOTE_RUNTIME_PROFILE as RuntimeProfile | undefined) ?? "development",
  env: NodeJS.ProcessEnv = process.env,
): RemoteIdentityConfig {
  if (profile !== "production" && profile !== "development" && profile !== "test") {
    throw new Error(`Unsupported remote runtime profile: ${profile}`);
  }

  const resource = env.REMOTE_MCP_RESOURCE
    ?? (profile === "production" ? undefined : `${env.APP_ORIGIN ?? "http://127.0.0.1:3000"}/mcp`);
  if (!resource) throw new Error("REMOTE_MCP_RESOURCE is required in production");

  const issuer = env.DC_REMOTE_AUTH_ISSUER
    ?? env.AUTHORIZATION_SERVER_ISSUER
    ?? (profile === "production" ? undefined : `${new URL(resource).origin}/api/auth`);
  if (!issuer) throw new Error("DC_REMOTE_AUTH_ISSUER is required in production");

  return createRemoteIdentity({
    runtimeProfile: profile,
    authorizationServerIssuer: issuer,
    publicMcpResource: resource,
    internalDeviceApiOrigin: env.MCP_SERVER_URL ?? "http://127.0.0.1:3000",
  });
}
