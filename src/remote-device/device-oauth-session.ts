import type { RemoteIdentityConfig } from "./remote-identity.js";

export const DEVICE_OAUTH_SESSION_VERSION = 2 as const;
export const DEVICE_SESSION_SCOPE = "device:sync offline_access" as const;

export type DeviceOAuthSession = Readonly<{
  version: typeof DEVICE_OAUTH_SESSION_VERSION;
  issuer: string;
  resource: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: typeof DEVICE_SESSION_SCOPE;
  generation: number;
}>;

export function normalizeDeviceScope(value: string): typeof DEVICE_SESSION_SCOPE | null {
  const parts = value.split(/\s+/).filter(Boolean);
  const unique = new Set(parts);
  if (unique.size !== 2 || !unique.has("device:sync") || !unique.has("offline_access")) return null;
  return DEVICE_SESSION_SCOPE;
}

export function isSessionBoundTo(session: DeviceOAuthSession, identity: RemoteIdentityConfig): boolean {
  return session.version === DEVICE_OAUTH_SESSION_VERSION
    && session.issuer === identity.authorizationServerIssuer
    && session.resource === identity.publicMcpResource
    && session.scope === DEVICE_SESSION_SCOPE;
}

export function parseDeviceOAuthSessionStructure(value: unknown): DeviceOAuthSession | null {
  if (!isRecord(value) || value.version !== DEVICE_OAUTH_SESSION_VERSION) return null;
  if (!nonEmpty(value.issuer) || !nonEmpty(value.resource) || !nonEmpty(value.clientId)
    || !nonEmpty(value.accessToken) || !nonEmpty(value.refreshToken) || !nonEmpty(value.scope)) return null;
  const scope = normalizeDeviceScope(value.scope);
  if (!scope) return null;
  if (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt) || value.expiresAt <= 0) return null;
  if (typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1) return null;
  return Object.freeze({
    version: DEVICE_OAUTH_SESSION_VERSION,
    issuer: value.issuer,
    resource: value.resource,
    clientId: value.clientId,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
    scope,
    generation: value.generation,
  });
}

export function parseDeviceOAuthSession(value: unknown, identity: RemoteIdentityConfig): DeviceOAuthSession | null {
  const session = parseDeviceOAuthSessionStructure(value);
  return session && isSessionBoundTo(session, identity) ? session : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
