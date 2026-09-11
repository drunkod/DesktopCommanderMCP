import crypto from "node:crypto";
import { createDb } from "jazz-tools";
import { SignJWT, importJWK } from "jose";
import { app, type RemoteCall } from "../schema";

const origin = required("APP_ORIGIN").replace(/\/$/, "");
const issuer = `${origin}/api/auth`;
const resource = required("REMOTE_MCP_RESOURCE");
const jazzServerUrl = required("JAZZ_SERVER_URL");
const jazzAppId = required("JAZZ_APP_ID");
const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";
const jazzCapabilityIssuer = `${origin}/.well-known/jazz-capability`;
const jazzCapabilityAudience = `urn:remote-mcp:jazz:${jazzAppId}`;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function failure(body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const code = typeof record.error === "string" ? record.error : "request_failed";
    const description = typeof record.error_description === "string"
      ? record.error_description
      : typeof record.message === "string" ? record.message : "";
    return `${code}${description ? `: ${description}` : ""}`;
  }
  return "request_failed";
}
async function jsonRequest(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { message: text.slice(0, 200) }; }
  }
  return { response, body };
}

function expectStatus(label: string, status: number, allowed: number[]) {
  if (!allowed.includes(status)) {
    throw new Error(`${label}: unexpected HTTP ${status}`);
  }
  console.log(`${label}:ok (${status})`);
}

function sessionCookie(headers: Headers): string {
  const getter = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const values = getter ? getter.call(headers) : [headers.get("set-cookie")].filter(Boolean) as string[];
  const cookie = values.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
  if (!cookie) throw new Error("signup: no session cookie returned");
  return cookie;
}

function decodeJwt(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("token is not a JWT");
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
}
function assertDeviceToken(token: string, clientId: string) {
  const payload = decodeJwt(token);
  if (payload.iss !== issuer) throw new Error("device token issuer mismatch");
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(resource)) throw new Error("device token audience mismatch");
  const nested = payload.claims && typeof payload.claims === "object"
    ? payload.claims as Record<string, unknown> : {};
  const tokenClientId = nested.client_id ?? payload.client_id;
  if (tokenClientId !== clientId) throw new Error("device token client_id mismatch");
  const rawScope = nested.scope ?? payload.scope;
  const scopes = Array.isArray(rawScope)
    ? rawScope.map(String)
    : typeof rawScope === "string" ? rawScope.split(/\s+/) : [];
  if (!scopes.includes("device:sync")) throw new Error("device token missing device:sync");
  console.log("device-token-claims:ok");
}

async function createUser(label: string) {
  const nonce = `${Date.now()}-${crypto.randomUUID()}`;
  const email = `${label}-${nonce}@example.test`;
  const password = `Sm0ke!-${crypto.randomUUID()}-${nonce}`;
  const result = await jsonRequest(`${issuer}/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ name: `Smoke ${label}`, email, password }),
  });
  expectStatus(`${label}-signup`, result.response.status, [200, 201]);
  return { cookie: sessionCookie(result.response.headers) };
}
async function dashboardToken(cookie: string): Promise<string> {
  const result = await jsonRequest(`${issuer}/token`, {
    method: "GET",
    headers: { cookie },
  });
  expectStatus("dashboard-token", result.response.status, [200]);
  const token = (result.body as { token?: unknown })?.token;
  if (typeof token !== "string") throw new Error(`dashboard-token: ${failure(result.body)}`);
  return token;
}

async function dashboardJazzToken(cookie: string): Promise<string> {
  const result = await jsonRequest(`${origin}/api/jazz/dashboard-token`, {
    method: "POST",
    headers: { cookie, origin },
  });
  expectStatus("dashboard-jazz-token", result.response.status, [200]);
  const token = (result.body as { token?: unknown })?.token;
  if (typeof token !== "string") throw new Error(`dashboard-jazz-token: ${failure(result.body)}`);
  return token;
}

async function registerPublicDeviceClient(): Promise<string> {
  const result = await jsonRequest(`${issuer}/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      client_name: `Remote MCP smoke ${Date.now()}`,
      token_endpoint_auth_method: "none",
      grant_types: [deviceGrant, "refresh_token"],
      scope: "device:sync offline_access",
      resources: [resource],
    }),
  });
  expectStatus("dcr", result.response.status, [201]);
  const clientId = (result.body as { client_id?: unknown })?.client_id;
  if (typeof clientId !== "string") throw new Error(`dcr: ${failure(result.body)}`);
  return clientId;
}
async function beginDeviceGrant(clientId: string) {
  const body = new URLSearchParams({
    client_id: clientId,
    scope: "device:sync offline_access",
    resource,
  });
  const result = await jsonRequest(`${issuer}/device/code`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  expectStatus("device-code", result.response.status, [200]);
  const record = result.body as Record<string, unknown>;
  if (typeof record.device_code !== "string" || typeof record.user_code !== "string") {
    throw new Error(`device-code: ${failure(result.body)}`);
  }
  return {
    deviceCode: record.device_code,
    userCode: record.user_code,
    interval: typeof record.interval === "number" ? record.interval : 5,
  };
}

async function verifyDeviceRequest(cookie: string, userCode: string) {
  const url = new URL(`${issuer}/device`);
  url.searchParams.set("user_code", userCode);
  const result = await jsonRequest(url.toString(), {
    method: "GET",
    headers: { cookie, origin },
  });
  expectStatus("device-verify", result.response.status, [200]);
}

async function approveDevice(cookie: string, userCode: string) {
  const result = await jsonRequest(`${issuer}/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ userCode }),
  });
  expectStatus("device-approve", result.response.status, [200]);
}
async function redeemDeviceCode(clientId: string, deviceCode: string, interval: number) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const body = new URLSearchParams({
      grant_type: deviceGrant,
      device_code: deviceCode,
      client_id: clientId,
      resource,
    });
    const result = await jsonRequest(`${issuer}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (result.response.status === 200) {
      const token = (result.body as { access_token?: unknown })?.access_token;
      if (typeof token !== "string") throw new Error("device-token: missing access_token");
      console.log("device-token:ok (200)");
      return token;
    }
    const code = (result.body as { error?: unknown })?.error;
    if (code !== "authorization_pending" && code !== "slow_down") {
      throw new Error(`device-token: ${failure(result.body)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(interval, 1) * 1_000 + 200));
  }
  throw new Error("device-token: timed out waiting for approval");
}
async function registerDevice(accessToken: string, stableId: string) {
  return jsonRequest(`${origin}/api/device/register`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      stableId,
      name: "Smoke Device",
      platform: "smoke-os",
      appVersion: "smoke-1",
      capabilities: { tools: ["ping"] },
    }),
  });
}

async function heartbeat(accessToken: string, deviceId: string) {
  return jsonRequest(`${origin}/api/device/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId, status: "online" }),
  });
}

async function refreshJazzDeviceToken(accessToken: string, deviceId: string): Promise<string> {
  const result = await jsonRequest(`${origin}/api/device/jazz-token`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId }),
  });
  expectStatus("device-jazz-token", result.response.status, [200]);
  const token = (result.body as { jazzToken?: unknown })?.jazzToken;
  if (typeof token !== "string") throw new Error(`device-jazz-token: ${failure(result.body)}`);
  return token;
}
async function expectAuthorizationPending(clientId: string, deviceCode: string) {
  const body = new URLSearchParams({
    grant_type: deviceGrant,
    device_code: deviceCode,
    client_id: clientId,
    resource,
  });
  const result = await jsonRequest(`${issuer}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (
    result.response.status !== 400
    || (result.body as { error?: unknown })?.error !== "authorization_pending"
  ) {
    throw new Error(`pre-approval-poll: ${failure(result.body)}`);
  }
  console.log("pre-approval-poll:ok (authorization_pending)");
}

function tokenSubject(token: string): string {
  const subject = decodeJwt(token).sub;
  if (typeof subject !== "string" || !subject) {
    throw new Error("device token missing subject");
  }
  return subject;
}

async function claimCall(
  accessToken: string,
  callId: string,
  deviceId: string,
  extra: Record<string, unknown> = {},
) {
  return jsonRequest(`${origin}/api/device/calls/${encodeURIComponent(callId)}/claim`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId, ...extra }),
  });
}

async function completeCall(
  accessToken: string,
  callId: string,
  body: Record<string, unknown>,
) {
  return jsonRequest(`${origin}/api/device/calls/${encodeURIComponent(callId)}/complete`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function expectJazzWriteDenied(label: string, operation: () => Promise<void>) {
  let denied = false;
  try { await operation(); } catch { denied = true; }
  if (!denied) throw new Error(`${label}: Jazz write unexpectedly succeeded`);
  console.log(`${label}:ok (denied)`);
}
async function expectJazzDeviceHidden(
  label: string,
  token: string,
  deviceId: string,
): Promise<void> {
  let visible = false;
  let db: Awaited<ReturnType<typeof createDb>> | null = null;
  try {
    db = await createDb({ appId: jazzAppId, serverUrl: jazzServerUrl, jwtToken: token });
    const row = await Promise.race([
      db.one(app.devices.where({ id: deviceId }), { tier: "global" }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_500)),
    ]);
    visible = Boolean(row);
  } catch {
    visible = false;
  } finally {
    await db?.shutdown().catch(() => undefined);
  }
  if (visible) throw new Error(`${label}: device unexpectedly visible`);
  console.log(`${label}:ok (denied)`);
}

async function mintWrongAudienceJazzCapability(
  subject: string,
  clientId: string,
  deviceId: string,
): Promise<string> {
  const encoded = required("JAZZ_TOKEN_PRIVATE_JWK_B64");
  const jwk = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  const key = await importJWK(jwk, "ES256");
  const wrongIssuer = "https://wrong-issuer.invalid/jazz";
  const wrongAudience = "urn:wrong:jazz:audience";
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    claims: {
      scope: ["jazz:device"], token_use: "jazz-device",
      jazz_app_id: jazzAppId, resource,
      jazz_issuer: wrongIssuer, jazz_audience: wrongAudience,
      device_id: deviceId, client_id: clientId,
    },
  })
    .setProtectedHeader({ alg: "ES256", kid: "remote-mcp-jazz-v1", typ: "JWT" })
    .setSubject(subject).setIssuer(wrongIssuer).setAudience(wrongAudience)
    .setIssuedAt(now).setExpirationTime(now + 90).sign(key);
}

async function main() {
  const primary = await createUser("primary");
  const dashboardJwt = await dashboardToken(primary.cookie);
  const dashboardJazzJwt = await dashboardJazzToken(primary.cookie);
  const clientId = await registerPublicDeviceClient();
  const grant = await beginDeviceGrant(clientId);
  await expectAuthorizationPending(clientId, grant.deviceCode);
  await verifyDeviceRequest(primary.cookie, grant.userCode);
  await approveDevice(primary.cookie, grant.userCode);
  await new Promise((resolve) => setTimeout(resolve, Math.max(grant.interval, 1) * 1_000 + 200));
  const deviceToken = await redeemDeviceCode(clientId, grant.deviceCode, grant.interval);
  assertDeviceToken(deviceToken, clientId);

  const stableId = `smoke-device-${crypto.randomUUID()}`;
  const firstRegistration = await registerDevice(deviceToken, stableId);
  expectStatus("device-register", firstRegistration.response.status, [201]);
  const registrationBody = firstRegistration.body as { deviceId?: unknown; jazzToken?: unknown };
  const deviceId = registrationBody.deviceId;
  const deviceJazzToken = registrationBody.jazzToken;
  if (typeof deviceId !== "string") throw new Error("device-register: missing deviceId");
  if (typeof deviceJazzToken !== "string") throw new Error("device-register: missing jazzToken");

  const subject = tokenSubject(deviceToken);
  const dashboardSubject = tokenSubject(dashboardJwt);
  if (dashboardSubject !== subject) throw new Error("primary dashboard/device subjects differ");

  await expectJazzDeviceHidden("better-auth-dashboard-direct-jazz", dashboardJwt, deviceId);
  await expectJazzDeviceHidden("oauth-device-direct-jazz", deviceToken, deviceId);
  const wrongAudience = await mintWrongAudienceJazzCapability(subject, clientId, deviceId);
  await expectJazzDeviceHidden("wrong-audience-capability", wrongAudience, deviceId);


  const heartbeatResult = await heartbeat(deviceToken, deviceId);
  expectStatus("device-heartbeat", heartbeatResult.response.status, [200]);
  const repeatRegistration = await registerDevice(deviceToken, stableId);
  expectStatus("device-register-idempotent", repeatRegistration.response.status, [200]);
  const changedIdentity = await registerDevice(deviceToken, `${stableId}-changed`);
  expectStatus("device-register-rebind", changedIdentity.response.status, [409]);
  await refreshJazzDeviceToken(deviceToken, deviceId);

  const dashboardDb = await createDb({ appId: jazzAppId, serverUrl: jazzServerUrl, jwtToken: dashboardJazzJwt });
  const dashboardVisible = await dashboardDb.one(app.devices.where({ id: deviceId }), { tier: "global" });
  if (!dashboardVisible) throw new Error("dashboard-jazz-read: registered row is not visible");
  console.log("dashboard-jazz-read:ok");
  await dashboardDb.shutdown();

  const deviceDb = await createDb({ appId: jazzAppId, serverUrl: jazzServerUrl, jwtToken: deviceJazzToken });
  const ownedDevice = await deviceDb.one(app.devices.where({ id: deviceId }), { tier: "global" });
  if (!ownedDevice) throw new Error("device-jazz-read: registered row is not visible");
  console.log("device-jazz-read:ok");
  await expectJazzWriteDenied("device-registry-update", async () => {
    const write = deviceDb.update(app.devices, deviceId, { status: "offline" });
    await write.wait({ tier: "global" });
  });
  await expectJazzWriteDenied("device-registry-insert", async () => {
    const write = deviceDb.insert(app.devices, {
      ownerId: subject,
      stableId: `forged-${crypto.randomUUID()}`,
      oauthClientId: clientId,
      name: "Forged Device",
      platform: "smoke-os",
      appVersion: "smoke-1",
      capabilities: {},
      status: "online",
      lastSeenAt: new Date(),
      reconnectGeneration: 0,
    });
    await write.wait({ tier: "global" });
  });
  const pendingCallPromise = new Promise<RemoteCall>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let unsubscribe: (() => void) | null = null;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
      const dispose = unsubscribe;
      if (dispose) queueMicrotask(dispose);
    };
    unsubscribe = deviceDb.subscribeAll(
      app.remoteCalls.where({ deviceId, status: "pending" }),
      (delta) => {
        const row = delta.all.find((candidate) => candidate.toolName === "__control.reconnect");
        if (row) finish(() => resolve(row));
      },
      { tier: "global" },
    );
    timer = setTimeout(
      () => finish(() => reject(new Error("production-call-subscription: timed out"))),
      8_000,
    );
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const reconnectRequest = jsonRequest(`${origin}/api/devices/${encodeURIComponent(deviceId)}/reconnect`, {
    method: "POST",
    headers: { cookie: primary.cookie, origin },
  });
  const visibleCall = await pendingCallPromise;
  const callId = visibleCall.id;
  console.log("production-call-subscription:ok");

  await expectJazzWriteDenied("remote-call-direct-update", async () => {
    const write = deviceDb.update(app.remoteCalls, callId, {
      toolName: "tampered.tool",
      toolArgs: { tampered: true },
    });
    await write.wait({ tier: "global" });
  });

  const firstClaim = await claimCall(deviceToken, callId, deviceId);
  expectStatus("remote-call-claim", firstClaim.response.status, [200]);
  if ((firstClaim.body as { claimed?: unknown })?.claimed !== true) {
    throw new Error("remote-call-claim: expected claimed=true");
  }
  const secondClaim = await claimCall(deviceToken, callId, deviceId);
  expectStatus("remote-call-second-claim", secondClaim.response.status, [200]);
  if ((secondClaim.body as { claimed?: unknown })?.claimed !== false) {
    throw new Error("remote-call-second-claim: expected claimed=false");
  }

  const strictCompletion = await completeCall(deviceToken, callId, {
    deviceId,
    status: "completed",
    result: { pong: true },
    toolName: "tampered.tool",
  });
  expectStatus("remote-call-complete-strict", strictCompletion.response.status, [400]);

  if (visibleCall.toolName !== "__control.reconnect") {
    throw new Error("production-call-subscription: wrong toolName");
  }
  const visibleArgs = visibleCall.toolArgs as Record<string, unknown>;
  if ("tampered" in visibleArgs) {
    throw new Error("remote-call-immutable: toolArgs were mutated");
  }

  const completion = await completeCall(deviceToken, callId, {
    deviceId,
    status: "completed",
    result: { reconnecting: true },
  });
  expectStatus("remote-call-complete", completion.response.status, [200]);
  const reconnectResponse = await reconnectRequest;
  expectStatus("production-reconnect-request", reconnectResponse.response.status, [200]);
  console.log("remote-call-immutable:ok");

  await deviceDb.shutdown();
  const secondary = await createUser("secondary");
  const secondaryJwt = await dashboardToken(secondary.cookie);
  const secondaryJazzJwt = await dashboardJazzToken(secondary.cookie);
  await expectJazzDeviceHidden("secondary-better-auth-direct-jazz", secondaryJwt, deviceId);
  const secondaryDb = await createDb({ appId: jazzAppId, serverUrl: jazzServerUrl, jwtToken: secondaryJazzJwt });
  const crossUserDevice = await secondaryDb.one(
    app.devices.where({ id: deviceId }),
    { tier: "global" },
  );
  if (crossUserDevice) throw new Error("cross-user-read: foreign device became visible");
  console.log("cross-user-read:ok (hidden)");
  await secondaryDb.shutdown();

  const revoke = await jsonRequest(`${origin}/api/devices/${encodeURIComponent(deviceId)}/revoke`, {
    method: "POST",
    headers: { cookie: primary.cookie, origin },
  });
  expectStatus("device-revoke", revoke.response.status, [200]);

  const staleHeartbeat = await heartbeat(deviceToken, deviceId);
  expectStatus("revoked-heartbeat", staleHeartbeat.response.status, [401]);
  const staleRegistration = await registerDevice(deviceToken, stableId);
  expectStatus("revoked-register", staleRegistration.response.status, [401]);

  const revokedDb = await createDb({ appId: jazzAppId, serverUrl: jazzServerUrl, jwtToken: deviceJazzToken });
  const revokedVisible = await revokedDb.one(app.devices.where({ id: deviceId }), { tier: "global" });
  if (revokedVisible) throw new Error("revoked-jazz-read: revoked device remained visible");
  console.log("revoked-jazz-read:ok (hidden)");
  await revokedDb.shutdown();
  console.log("SMOKE_DEVICE_FLOW=PASS");
}

main().catch((error) => {
  console.error(`SMOKE_DEVICE_FLOW=FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
