import open from "open";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEVICE_SCOPE = "device:sync offline_access";

export type AuthorizationServerMetadata = {
  issuer: string;
  registration_endpoint: string;
  device_authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

export type DeviceOAuthSession = {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
};

type DeviceAuthorizationResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
};

type OAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
};

function internalOrigin(): string {
  return (process.env.MCP_SERVER_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
}

function publicOrigin(): string {
  const configured = process.env.APP_ORIGIN?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const configuredResource = process.env.REMOTE_MCP_RESOURCE?.trim();
  if (configuredResource) return new URL(configuredResource).origin;
  return internalOrigin();
}

function authIssuer(): string { return `${publicOrigin()}/api/auth`; }
function resource(): string {
  const configured = process.env.REMOTE_MCP_RESOURCE?.trim();
  const value = configured ?? `${publicOrigin()}/mcp`;
  const parsed = new URL(value);
  if (parsed.origin !== new URL(publicOrigin()).origin) {
    throw new Error(`REMOTE_MCP_RESOURCE must use the public application origin ${publicOrigin()}: ${value}`);
  }
  return value.replace(/\/$/, "");
}

/** Keep device HTTP calls local while requiring the public control plane identity. */
function internalizeOAuthEndpoint(endpoint: string, label: string): string {
  const value = new URL(endpoint);
  const expectedPublicOrigin = new URL(publicOrigin());
  if (value.origin !== expectedPublicOrigin.origin) {
    throw new Error(`${label} must use public application origin ${publicOrigin()}: ${endpoint}`);
  }
  return new URL(`${value.pathname}${value.search}`, `${internalOrigin()}/`).toString();
}

async function metadata(): Promise<AuthorizationServerMetadata> {
  const response = await fetch(`${internalOrigin()}/api/auth/.well-known/oauth-authorization-server`);
  if (!response.ok) throw new Error(`OAuth discovery failed: ${response.status}`);
  const wire = await response.json() as AuthorizationServerMetadata;
  if (wire.issuer !== authIssuer()) {
    throw new Error(`Unexpected OAuth issuer: ${wire.issuer}; expected ${authIssuer()}`);
  }
  return {
    ...wire,
    registration_endpoint: internalizeOAuthEndpoint(wire.registration_endpoint, "registration_endpoint"),
    device_authorization_endpoint: internalizeOAuthEndpoint(wire.device_authorization_endpoint, "device_authorization_endpoint"),
    token_endpoint: internalizeOAuthEndpoint(wire.token_endpoint, "token_endpoint"),
    jwks_uri: internalizeOAuthEndpoint(wire.jwks_uri, "jwks_uri"),
  };
}

export async function registerDeviceClient(): Promise<string> {
  const meta = await metadata();
  const response = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Desktop Commander Device",
      token_endpoint_auth_method: "none",
      grant_types: [DEVICE_GRANT, "refresh_token"],
      scope: DEVICE_SCOPE,
      resources: [resource()],
    }),
  });
  if (!response.ok) throw new Error(`Device client registration failed: ${response.status} ${await response.text()}`);
  const value = await response.json() as { client_id?: string };
  if (!value.client_id) throw new Error("DCR returned no client_id");
  return value.client_id;
}

export async function pairDevice(existingClientId?: string): Promise<DeviceOAuthSession> {
  const meta = await metadata();
  const clientId = existingClientId ?? await registerDeviceClient();
  const response = await fetch(meta.device_authorization_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: DEVICE_SCOPE, resource: resource() }),
  });
  if (!response.ok) throw new Error(`Device authorization failed: ${response.status} ${await response.text()}`);

  const authorization = await response.json() as DeviceAuthorizationResponse;
  console.log(`Open ${authorization.verification_uri}`);
  console.log(`Enter code ${authorization.user_code}`);
  if (process.env.DC_DEVICE_NO_BROWSER !== "1") {
    await open(authorization.verification_uri_complete ?? authorization.verification_uri).catch(() => undefined);
  }

  const token = await pollForToken(meta.token_endpoint, clientId, authorization);
  if (!token.refresh_token) throw new Error("Device token response omitted refresh_token");
  return {
    clientId,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    scope: token.scope,
  };
}

async function pollForToken(tokenEndpoint: string, clientId: string, authorization: DeviceAuthorizationResponse): Promise<OAuthTokenResponse> {
  const deadline = Date.now() + authorization.expires_in * 1000;
  let interval = authorization.interval ?? 5;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: authorization.device_code, client_id: clientId, resource: resource() }),
    });
    const body = await response.json() as OAuthTokenResponse & { error?: string; error_description?: string };
    if (response.ok) return body;
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") { interval += 5; continue; }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("x-retry-after") ?? response.headers.get("retry-after"));
      interval = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.max(interval, Math.ceil(retryAfter)) : interval + 5;
      continue;
    }
    throw new Error(body.error_description ?? body.error ?? "Device token exchange failed");
  }
  throw new Error("Device authorization expired");
}

export async function refreshDeviceSession(session: DeviceOAuthSession): Promise<DeviceOAuthSession> {
  const meta = await metadata();
  const response = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refreshToken, client_id: session.clientId, scope: DEVICE_SCOPE, resource: resource() }),
  });
  const body = await response.json() as OAuthTokenResponse & { error?: string; error_description?: string };
  if (!response.ok) throw new Error(body.error_description ?? body.error ?? "Device token refresh failed");
  if (!body.refresh_token) throw new Error("Refresh response omitted rotated refresh_token");
  return {
    clientId: session.clientId,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + body.expires_in * 1000,
    scope: body.scope,
  };
}
