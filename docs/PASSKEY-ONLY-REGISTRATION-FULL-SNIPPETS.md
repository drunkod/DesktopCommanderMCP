# Passkey-only registration — proposed implementation sketches (not copy-ready)

Parent: `docs/PASSKEY-ONLY-REGISTRATION-TASK-INDEX.md`

Status: **R-01–R-43 + T4-01–T4-12 contract corrections incorporated; sketches remain non-copy-ready until P0/P1/P7A/P8A/P9A/version/evidence gates close** — see `docs/PASSKEY-ONLY-REGISTRATION-TASK-PACK-REVIEW.md`

Date: 2026-09-07

## How to use this file

This catalog translates the P0–P11 task pack into concrete future implementation shapes. It deliberately separates code that is already well-defined by the current repository from code that is **blocked by P1**.

Rules:

- Do not copy any P1-blocked auth snippet into production until P1 records a GO architecture.
- Do not patch `node_modules` or generated Better Auth package files.
- Do not weaken required server-side WebAuthn UV.
- Do not fabricate a user email merely to satisfy Better Auth core 1.7.x.
- Do not infer an OAuth issuer from a per-device tunnel resource.
- Do not reuse a stored refresh token under a different issuer/resource.
- Keep device approval and ChatGPT consent explicit.
- Run all future implementation/tests inside `nix develop` where this repository provides it.

## Snippet status legend

```text
P1-BLOCKED        exact code depends on P1 auth/account/verifier GO
P7A-BLOCKED       depends on approved bootstrap/resource/audience protocol
P8A-BLOCKED       depends on exact datastore/transaction/locking implementation
VERSION-UNVERIFIED exact package/API signature must compile against the pinned version
READY-AFTER-GATE  architecture is corrected, but callers/compile/tests still gate adoption
ILLUSTRATIVE      demonstrates an invariant, not a package/API guarantee
```

No section in this file is "copy-ready" until the named gates are closed and implementation HEAD callers compile. Historical continued-review findings R-25 through R-43 and their remediation evidence are retained in the review document.

## Future file manifest

DesktopCommanderMCP:

```text
src/remote-device/trusted-http-url.ts                   READY-AFTER-GATE shared URL policy
src/remote-device/remote-identity.ts                    READY-AFTER-GATE
src/remote-device/device-oauth.ts                       P7A-BLOCKED / READY-AFTER-GATE
src/remote-device/oauth-endpoint-policy-v1.ts           P1/P7A-BLOCKED exact metadata endpoint paths
src/remote-device/device-oauth-session.ts               READY-AFTER-GATE
src/remote-device/credential-store.ts                   P8A-BLOCKED locking/CAS
src/remote-device/token-manager.ts                      P8A-BLOCKED locking/CAS
src/remote-device/native-credential-store.ts            P8A-BLOCKED OS lock integration
src/remote-device/provisioning-receipt-store.ts         P7A/P8A-BLOCKED durable receipt/CAS
src/remote-device/pairing-lease.ts                      P8A-BLOCKED cross-process lease
src/remote-device/control-plane-client.ts               READY-AFTER-GATE injection refactor
src/remote-device/tunnel/tunnel-health.ts               READY-AFTER-GATE
all Tailscale/zrok provider status()/doctor() callers   READY-AFTER-GATE
test/* remote OAuth/resource suites                     READY-AFTER-GATE
```

Control-plane/auth service:

```text
apps/control-plane/lib/trusted-http-url.ts              READY-AFTER-GATE shared URL policy
apps/control-plane/lib/env.ts                           READY-AFTER-GATE central identity additions only
apps/control-plane/lib/mcp-resource-runtime.ts          P7A-BLOCKED per-device resource identity only
apps/control-plane/lib/oauth-scopes.ts                  P7A-BLOCKED route model
apps/control-plane/lib/auth-callback.ts                 READY-AFTER-GATE
apps/control-plane/lib/auth-client.ts                   P1-BLOCKED / VERSION-UNVERIFIED
apps/control-plane/lib/browser-http.ts                   READY-AFTER-GATE bounded browser response helper
apps/control-plane/lib/auth-plugins.ts                  P1-BLOCKED / VERSION-UNVERIFIED
apps/control-plane/lib/account-identity.ts              P1-BLOCKED
apps/control-plane/lib/passkey-registration-intent.ts   P1/P8A-BLOCKED
apps/control-plane/lib/oauth-resource-provisioning.ts   P7A/P8A-BLOCKED
apps/control-plane/app/device/page.tsx                  VERSION-UNVERIFIED client API
apps/control-plane/app/device/approve/page.tsx          P7A/P8A-BLOCKED mutation policy
apps/control-plane/app/api/mcp/route.ts                 VERSION-UNVERIFIED handler API
```

---

# A. DesktopCommanderMCP snippets

## A0 — shared trusted HTTP URL policy

Status: READY-AFTER-GATE (application-owned helper; no third-party API assumed)

Every issuer, public resource, verification URI, metadata endpoint, and internal loopback origin uses one explicit transport policy. **There is no permissive default mode.** Public production OAuth/resource URLs always require HTTPS. HTTP loopback is legal only for the separately identified local transport or when a caller explicitly selects a non-production profile. A browser-only WebAuthn `http://localhost` secure-context fixture under P2 is separate and never flows through this OAuth/resource helper.

```ts
// src/remote-device/trusted-http-url.ts
export type RuntimeProfile = "production" | "development" | "test";
export type TrustedHttpUrlClass = "publicOAuth" | "publicResource" | "internalLoopback";

export type TrustedHttpUrlOptions = Readonly<{
  urlClass: TrustedHttpUrlClass;
  profile: RuntimeProfile;
  allowQuery?: boolean;
  allowFragment?: boolean;
  requireOrigin?: string;
}>;

export function isApprovedLiteralLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]";
}

export function parseTrustedHttpUrl(
  raw: string,
  label: string,
  options: TrustedHttpUrlOptions,
): URL {
  if (raw.length === 0 || raw !== raw.trim() || /\s/.test(raw)) {
    throw new Error(`${label} must be nonempty and contain no whitespace`);
  }
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error(`${label} must be an absolute URL`); }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${label} must not contain credentials`);
  }

  const literalLoopback = isApprovedLiteralLoopbackHost(url.hostname);
  if (options.urlClass === "internalLoopback") {
    if (!literalLoopback) throw new Error(`${label} must use a literal loopback host`);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`${label} must use HTTP or HTTPS on literal loopback`);
    }
  } else {
    const explicitNonProductionLoopback =
      options.profile !== "production" && url.protocol === "http:" && literalLoopback;
    if (url.protocol !== "https:" && !explicitNonProductionLoopback) {
      throw new Error(`${label} must use HTTPS; HTTP loopback requires an explicit non-production profile`);
    }
  }

  if (!options.allowQuery && url.search !== "") throw new Error(`${label} must not contain a query`);
  if (!options.allowFragment && url.hash !== "") throw new Error(`${label} must not contain a fragment`);
  if (options.requireOrigin !== undefined && url.origin !== options.requireOrigin) {
    throw new Error(`${label} has an unexpected origin`);
  }
  return url;
}
```

The control-plane package owns the same helper contract. Bootstrap/CIMD may add **stricter** production HTTPS + SSRF/address-pinning rules, never weaker ones. Public production identity cannot become HTTP merely because the hostname is loopback.

## A1 — `src/remote-device/remote-identity.ts` — corrected proposed file

Status: READY-AFTER-GATE

The runtime profile is explicit immutable configuration, not inferred from a URL. Persisted issuer/resource values are rejected when noncanonical; they are never trimmed or rewritten.

```ts
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

function required(name: string): string {
  const value = process.env[name];
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

function requireInternalLoopbackOrigin(raw: string, profile: RuntimeProfile): string {
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
  return Object.freeze({
    runtimeProfile: input.runtimeProfile,
    authorizationServerIssuer: requireCanonicalIssuer(input.authorizationServerIssuer, input.runtimeProfile),
    publicMcpResource: requireCanonicalMcpResource(input.publicMcpResource, input.runtimeProfile),
    internalDeviceApiOrigin: requireInternalLoopbackOrigin(input.internalDeviceApiOrigin, input.runtimeProfile),
  });
}

export function loadRemoteIdentityFromEnv(profile: RuntimeProfile): RemoteIdentityConfig {
  return createRemoteIdentity({
    runtimeProfile: profile,
    authorizationServerIssuer: required("DC_REMOTE_AUTH_ISSUER"),
    publicMcpResource: required("REMOTE_MCP_RESOURCE"),
    internalDeviceApiOrigin: process.env.MCP_SERVER_URL === undefined
      ? "http://127.0.0.1:3000"
      : required("MCP_SERVER_URL"),
  });
}
```

One-CLI orchestration passes the explicit release/development profile into `createRemoteIdentity()`. It never mutates `process.env` later to change authorization identity.

## A2 — `src/remote-device/device-oauth.ts` — corrected proposed replacement

Status: P7A-BLOCKED / READY-AFTER-GATE

This is a full **architecture sketch** for the desktop OAuth protocol path. Exact imports/runtime APIs must compile against implementation HEAD.

```ts
import open from "open";
import type { RemoteIdentityConfig } from "./remote-identity.js";
import { parseTrustedHttpUrl } from "./trusted-http-url.js";
import { releaseOAuthEndpointPolicyV1 } from "./oauth-endpoint-policy-v1.js";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const REQUESTED_SCOPES = ["device:sync", "offline_access"] as const;
const REQUIRED_ISSUER_SCOPES = ["mcp:tools", "device:sync", "offline_access"] as const;
const DEVICE_SCOPE = REQUESTED_SCOPES.join(" ");
const HTTP_TIMEOUT_MS = 10_000;
const MAX_METADATA_JSON_BYTES = 64 * 1024;
const MAX_OAUTH_JSON_BYTES = 32 * 1024;
const MAX_RETRY_AFTER_MS = 30_000;
const MAX_DEVICE_FLOW_SECONDS = 15 * 60;
const MAX_POLL_INTERVAL_SECONDS = 60;
const MAX_TRANSIENT_ATTEMPTS = 5;

export type AuthorizationServerMetadata = Readonly<{
  issuer: string;
  authorizationEndpoint: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  responseTypesSupported: readonly string[];
  grantTypesSupported: readonly string[];
  tokenEndpointAuthMethodsSupported: readonly string[];
  codeChallengeMethodsSupported: readonly string[];
  scopesSupported: readonly string[];
}>;

export type VerifiedAccessTokenClaims = Readonly<{
  issuer: string;
  audience: string | readonly string[];
}>;

// Application-owned adapter. P1/P7A must select and verify a real JWT-validation
// or authoritative-introspection implementation before this gate can close.
export interface ProviderTokenVerifier {
  verifyAccessToken(
    accessToken: string,
    metadata: AuthorizationServerMetadata,
    signal?: AbortSignal,
  ): Promise<VerifiedAccessTokenClaims>;
}

export type DeviceOAuthSession = Readonly<{
  version: 2;
  issuer: string;
  resource: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  generation: number;
}>;

export type OAuthErrorCode =
  | "authorization_pending" | "slow_down" | "access_denied" | "expired_token"
  | "invalid_grant" | "invalid_token" | "invalid_target" | "invalid_client"
  | "temporarily_unavailable" | "server_error" | "protocol_error";

export class OAuthProtocolError extends Error {
  constructor(readonly code: OAuthErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = "OAuthProtocolError";
  }
}

type DeviceAuthorizationResponse = Readonly<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}>;

type OAuthTokenResponse = Readonly<{
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope?: string;
  tokenType: string;
}>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown, field: string): string {
  if (typeof v !== "string" || !v) throw new OAuthProtocolError("protocol_error", `missing ${field}`);
  return v;
}
function stringArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.length === 0 ||
      !v.every((x) => typeof x === "string" && x.length > 0 && x === x.trim())) {
    throw new OAuthProtocolError("protocol_error", `invalid ${field}`);
  }
  if (new Set(v).size !== v.length) throw new OAuthProtocolError("protocol_error", `duplicate ${field}`);
  return [...v];
}
function positive(v: unknown, field: string, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > max) {
    throw new OAuthProtocolError("protocol_error", `invalid ${field}`);
  }
  return v;
}

export function authorizationServerMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  const suffix = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  url.pathname = `/.well-known/oauth-authorization-server${suffix}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

class RequestDeadlineError extends Error {
  constructor() { super("OAuth request deadline exceeded"); this.name = "RequestDeadlineError"; }
}

// Device-flow/request deadlines are relative durations and therefore use a
// monotonic clock. Persisted token `expiresAt` remains wall-clock epoch time.
function monotonicNowMs(): number {
  return performance.now();
}

export function composeRequestSignal(parent: AbortSignal | undefined, totalDeadlineMs: number): {
  signal: AbortSignal; cleanup(): void;
} {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason ?? new Error("cancelled"));
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const remainingMs = totalDeadlineMs - monotonicNowMs();
  if (remainingMs <= 0 && !controller.signal.aborted) controller.abort(new RequestDeadlineError());
  const timer = setTimeout(
    () => controller.abort(new RequestDeadlineError()),
    Math.max(1, Math.min(HTTP_TIMEOUT_MS, remainingMs)),
  );
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

export async function readBoundedJsonObject(
  response: Response,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>> {
  const maxBytes = options.maxBytes ?? MAX_OAUTH_JSON_BYTES;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new OAuthProtocolError("protocol_error", "unexpected OAuth response content type", response.status);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    throw new OAuthProtocolError("protocol_error", "OAuth response exceeded byte limit", response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new OAuthProtocolError("protocol_error", "OAuth response had no body", response.status);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (options.signal?.aborted) throw options.signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("body too large").catch(() => undefined);
        throw new OAuthProtocolError("protocol_error", "OAuth response exceeded byte limit", response.status);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new OAuthProtocolError("protocol_error", "OAuth response was not valid UTF-8", response.status); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new OAuthProtocolError("protocol_error", "OAuth response was not valid JSON", response.status); }
  if (!isRecord(parsed)) throw new OAuthProtocolError("protocol_error", "OAuth response was not an object", response.status);
  return parsed;
}

async function requestJson(
  url: string,
  init: RequestInit,
  parent: AbortSignal | undefined,
  totalDeadlineMs: number,
  maxBytes = MAX_OAUTH_JSON_BYTES,
) {
  const scoped = composeRequestSignal(parent, totalDeadlineMs);
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: scoped.signal });
    const body = await readBoundedJsonObject(response, { maxBytes, signal: scoped.signal });
    return { response, body };
  } finally { scoped.cleanup(); }
}

function trustedEndpoint(
  raw: unknown,
  issuer: string,
  field: keyof typeof releaseOAuthEndpointPolicyV1,
  profile: RemoteIdentityConfig["runtimeProfile"],
): string {
  const value = str(raw, field);
  try {
    const url = parseTrustedHttpUrl(value, field, {
      urlClass: "publicOAuth",
      profile,
      requireOrigin: new URL(issuer).origin,
    });
    if (!releaseOAuthEndpointPolicyV1[field](url, issuer)) {
      throw new Error(`${field} path is outside the release-approved authorization-server profile`);
    }
  } catch (error) {
    throw new OAuthProtocolError("protocol_error", error instanceof Error ? error.message : `invalid ${field}`);
  }
  return value;
}

export function parseAuthorizationServerMetadata(
  body: Record<string, unknown>,
  expectedIssuer: string,
  profile: RemoteIdentityConfig["runtimeProfile"],
): AuthorizationServerMetadata {
  const issuer = str(body.issuer, "issuer");
  if (issuer !== expectedIssuer) throw new OAuthProtocolError("protocol_error", "issuer mismatch");
  const responseTypesSupported = stringArray(body.response_types_supported, "response_types_supported");
  const grantTypesSupported = stringArray(body.grant_types_supported, "grant_types_supported");
  const tokenEndpointAuthMethodsSupported = stringArray(
    body.token_endpoint_auth_methods_supported,
    "token_endpoint_auth_methods_supported",
  );
  const codeChallengeMethodsSupported = stringArray(
    body.code_challenge_methods_supported,
    "code_challenge_methods_supported",
  );
  const scopesSupported = stringArray(body.scopes_supported, "scopes_supported");
  if (!responseTypesSupported.includes("code")) {
    throw new OAuthProtocolError("protocol_error", "authorization-code response type not advertised");
  }
  for (const grant of ["authorization_code", DEVICE_GRANT, "refresh_token"] as const) {
    if (!grantTypesSupported.includes(grant)) {
      throw new OAuthProtocolError("protocol_error", `required grant not advertised: ${grant}`);
    }
  }
  if (!tokenEndpointAuthMethodsSupported.includes("none")) {
    throw new OAuthProtocolError("protocol_error", "public-client token auth method none not advertised");
  }
  if (!codeChallengeMethodsSupported.includes("S256")) {
    throw new OAuthProtocolError("protocol_error", "PKCE S256 not advertised");
  }
  for (const scope of REQUIRED_ISSUER_SCOPES) {
    if (!scopesSupported.includes(scope)) {
      throw new OAuthProtocolError("protocol_error", `required issuer scope not advertised: ${scope}`);
    }
  }
  return {
    issuer,
    authorizationEndpoint: trustedEndpoint(body.authorization_endpoint, issuer, "authorization_endpoint", profile),
    deviceAuthorizationEndpoint: trustedEndpoint(body.device_authorization_endpoint, issuer, "device_authorization_endpoint", profile),
    tokenEndpoint: trustedEndpoint(body.token_endpoint, issuer, "token_endpoint", profile),
    jwksUri: trustedEndpoint(body.jwks_uri, issuer, "jwks_uri", profile),
    responseTypesSupported,
    grantTypesSupported,
    tokenEndpointAuthMethodsSupported,
    codeChallengeMethodsSupported,
    scopesSupported,
  };
}

export async function fetchAuthorizationServerMetadata(identity: RemoteIdentityConfig, signal?: AbortSignal) {
  const deadline = monotonicNowMs() + HTTP_TIMEOUT_MS;
  const { response, body } = await requestJson(
    authorizationServerMetadataUrl(identity.authorizationServerIssuer), {}, signal, deadline, MAX_METADATA_JSON_BYTES,
  );
  if (!response.ok) throw new OAuthProtocolError("protocol_error", `discovery HTTP ${response.status}`, response.status);
  return parseAuthorizationServerMetadata(body, identity.authorizationServerIssuer, identity.runtimeProfile);
}

const DEVICE_VERIFICATION_PATH = "/device"; // immutable release/provider contract

function trustedVerificationUri(
  raw: unknown,
  field: "verification_uri" | "verification_uri_complete",
  trustedOrigin: string,
  profile: RemoteIdentityConfig["runtimeProfile"],
  expectedUserCode?: string,
): string {
  const value = str(raw, field);
  try {
    const parsed = parseTrustedHttpUrl(value, field, {
      urlClass: "publicOAuth",
      profile,
      allowQuery: field === "verification_uri_complete",
      requireOrigin: trustedOrigin,
    });
    if (parsed.pathname !== DEVICE_VERIFICATION_PATH || parsed.hash !== "") {
      throw new Error(`${field} must use the exact approved verification route`);
    }
    const entries = [...parsed.searchParams.entries()];
    if (field === "verification_uri") {
      if (entries.length !== 0 || value !== `${trustedOrigin}${DEVICE_VERIFICATION_PATH}`) {
        throw new Error("verification_uri must have no query and must be canonical");
      }
    } else {
      if (expectedUserCode === undefined || entries.length !== 1 ||
          entries[0][0] !== "user_code" || entries[0][1] !== expectedUserCode) {
        throw new Error("verification_uri_complete query must be exactly one matching user_code");
      }
      const canonical = `${trustedOrigin}${DEVICE_VERIFICATION_PATH}?user_code=${encodeURIComponent(expectedUserCode)}`;
      if (value !== canonical) throw new Error("verification_uri_complete must be canonical");
    }
  } catch (error) {
    throw new OAuthProtocolError("protocol_error", error instanceof Error ? error.message : `invalid ${field}`);
  }
  return value;
}

function parseAuthorization(body: Record<string, unknown>, identity: RemoteIdentityConfig): DeviceAuthorizationResponse {
  const trustedOrigin = new URL(identity.authorizationServerIssuer).origin;
  const userCode = str(body.user_code, "user_code"); // final implementation applies provider alphabet/length parser
  const verificationUri = trustedVerificationUri(body.verification_uri, "verification_uri", trustedOrigin, identity.runtimeProfile);
  const verificationUriComplete = body.verification_uri_complete === undefined
    ? undefined
    : trustedVerificationUri(body.verification_uri_complete, "verification_uri_complete", trustedOrigin, identity.runtimeProfile, userCode);
  return {
    deviceCode: str(body.device_code, "device_code"),
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresIn: positive(body.expires_in, "expires_in", MAX_DEVICE_FLOW_SECONDS),
    interval: body.interval === undefined ? 5 : positive(body.interval, "interval", MAX_POLL_INTERVAL_SECONDS),
  };
}

function parseToken(body: Record<string, unknown>, previousScope?: string): OAuthTokenResponse & { effectiveScope: string } {
  const tokenType = str(body.token_type, "token_type");
  if (tokenType.toLowerCase() !== "bearer") throw new OAuthProtocolError("protocol_error", "unsupported token_type");
  const returned = body.scope === undefined ? undefined : str(body.scope, "scope");
  const effectiveScope = returned ?? previousScope ?? DEVICE_SCOPE;
  const actual = new Set(effectiveScope.split(/\s+/).filter(Boolean));
  if (!actual.has("device:sync")) throw new OAuthProtocolError("protocol_error", "device:sync scope missing");
  for (const scope of actual) if (!REQUESTED_SCOPES.includes(scope as (typeof REQUESTED_SCOPES)[number])) {
    throw new OAuthProtocolError("protocol_error", `unexpected scope expansion: ${scope}`);
  }
  return {
    accessToken: str(body.access_token, "access_token"),
    refreshToken: body.refresh_token === undefined ? undefined : str(body.refresh_token, "refresh_token"),
    expiresIn: positive(body.expires_in, "expires_in", 24 * 60 * 60),
    scope: returned,
    tokenType,
    effectiveScope,
  };
}

function oauthError(body: Record<string, unknown>, status: number): OAuthProtocolError {
  const known = new Set<OAuthErrorCode>([
    "authorization_pending", "slow_down", "access_denied", "expired_token",
    "invalid_grant", "invalid_token", "invalid_target", "invalid_client",
    "temporarily_unavailable", "server_error",
  ]);
  if (typeof body.error !== "string" || body.error.length === 0 || body.error !== body.error.trim()) {
    return new OAuthProtocolError("protocol_error", "malformed OAuth error response", status);
  }
  const code = known.has(body.error as OAuthErrorCode) ? body.error as OAuthErrorCode : "protocol_error";
  return new OAuthProtocolError(code, `OAuth request failed (${body.error})`, status);
}

function transientOAuthErrorForHttp(
  body: Record<string, unknown>,
  status: number,
): OAuthProtocolError | undefined {
  // A gateway/rate limiter may return a bounded JSON object with no OAuth `error`.
  // That is transport-transient. If an `error` member IS present, however, it must
  // be a recognized transient OAuth value; malformed/contradictory values are terminal.
  if (body.error === undefined) return undefined;
  const parsed = oauthError(body, status);
  if (parsed.code === "temporarily_unavailable" || parsed.code === "server_error") return parsed;
  throw new OAuthProtocolError("protocol_error", `transient HTTP ${status} carried a non-transient OAuth error`, status);
}

async function sleepAbortable(ms: number, signal?: AbortSignal, totalDeadlineMs?: number): Promise<void> {
  if (totalDeadlineMs !== undefined && totalDeadlineMs <= monotonicNowMs()) throw new RequestDeadlineError();
  await new Promise<void>((resolve, reject) => {
    const remaining = totalDeadlineMs === undefined ? ms : Math.max(0, totalDeadlineMs - monotonicNowMs());
    const delay = Math.min(ms, remaining);
    const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(done, delay);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("cancelled")); };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
  });
  if (totalDeadlineMs !== undefined && monotonicNowMs() >= totalDeadlineMs) throw new RequestDeadlineError();
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Math.min(MAX_RETRY_AFTER_MS, Number(raw) * 1000);
  const absolute = Date.parse(raw);
  if (!Number.isFinite(absolute)) return undefined;
  const delay = absolute - Date.now(); // Retry-After HTTP-date is wall-clock by definition.
  if (delay <= 0) return 0;
  return Math.min(MAX_RETRY_AFTER_MS, delay);
}

function transientHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function requestJsonWithBoundedRetry(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  totalDeadlineMs: number,
) {
  let attempts = 0;
  while (true) {
    let result: Awaited<ReturnType<typeof requestJson>>;
    try {
      result = await requestJson(url, init, signal, totalDeadlineMs, MAX_OAUTH_JSON_BYTES);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      // Malformed content-type/JSON/oversize is a protocol error even if an
      // intermediary happened to use a 5xx status; do not hide it by retrying.
      if (error instanceof OAuthProtocolError) throw error;
      attempts += 1;
      if (attempts >= MAX_TRANSIENT_ATTEMPTS || monotonicNowMs() >= totalDeadlineMs) throw error;
      const jitterMs = Math.min(5_000, Math.floor(250 * 2 ** Math.min(attempts, 4) + Math.random() * 500));
      await sleepAbortable(jitterMs, signal, totalDeadlineMs);
      continue;
    }

    if (!transientHttpStatus(result.response.status)) return result;
    const parsedError = transientOAuthErrorForHttp(result.body, result.response.status);
    attempts += 1;
    if (attempts >= MAX_TRANSIENT_ATTEMPTS || monotonicNowMs() >= totalDeadlineMs) {
      throw parsedError ?? new OAuthProtocolError(
        "temporarily_unavailable",
        `transient OAuth HTTP ${result.response.status} exhausted retries`,
        result.response.status,
      );
    }
    const retryMs = result.response.status === 429 ? retryAfterMs(result.response) : undefined;
    const jitterMs = Math.min(5_000, Math.floor(250 * 2 ** Math.min(attempts, 4) + Math.random() * 500));
    await sleepAbortable(retryMs ?? jitterMs, signal, totalDeadlineMs);
  }
}

const VERIFIER_REQUEST_TIMEOUT_MS = 10_000;

function composedVerifierSignal(callerSignal: AbortSignal | undefined, operationDeadlineMs: number): {
  signal: AbortSignal;
  timeoutSignal: AbortSignal;
} {
  const remainingMs = operationDeadlineMs - monotonicNowMs();
  if (remainingMs <= 0) throw new RequestDeadlineError();
  const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.min(VERIFIER_REQUEST_TIMEOUT_MS, remainingMs)));
  return {
    signal: callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal,
    timeoutSignal,
  };
}

async function requireProviderTokenGate(
  verifier: ProviderTokenVerifier,
  accessToken: string,
  metadata: AuthorizationServerMetadata,
  identity: RemoteIdentityConfig,
  operationDeadlineMs: number,
  signal?: AbortSignal,
): Promise<void> {
  // JWKS refresh/introspection must receive the composed signal; passing only the
  // caller signal can hang past startup, refresh, or RFC8628 expiry.
  const composed = composedVerifierSignal(signal, operationDeadlineMs);
  let claims: ProviderTokenClaims;
  try {
    claims = await verifier.verifyAccessToken(accessToken, metadata, composed.signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (composed.timeoutSignal.aborted) throw new RequestDeadlineError();
    throw error;
  }
  if (claims.issuer !== identity.authorizationServerIssuer) {
    throw new OAuthProtocolError("invalid_token", "provider token issuer mismatch");
  }
  const audience = Array.isArray(claims.audience) ? [...claims.audience] : [claims.audience];
  if (audience.length !== 1 || audience[0] !== identity.publicMcpResource) {
    throw new OAuthProtocolError("invalid_target", "provider token audience must equal the one requested resource");
  }
}

export async function verifyPersistedDeviceAccessToken(
  session: DeviceOAuthSession,
  identity: RemoteIdentityConfig,
  verifier: ProviderTokenVerifier,
  signal?: AbortSignal,
): Promise<void> {
  if (!isSessionBoundTo(session, identity)) {
    throw new OAuthProtocolError("invalid_target", "persisted credential binding mismatch");
  }
  const operationDeadline = monotonicNowMs() + HTTP_TIMEOUT_MS;
  const metadata = await fetchAuthorizationServerMetadata(identity, signal);
  await requireProviderTokenGate(verifier, session.accessToken, metadata, identity, operationDeadline, signal);
}

export async function pairDevice(
  identity: RemoteIdentityConfig,
  clientId: string,
  verifier: ProviderTokenVerifier,
  signal?: AbortSignal,
): Promise<DeviceOAuthSession> {
  const meta = await fetchAuthorizationServerMetadata(identity, signal);
  const flowDeadline = monotonicNowMs() + MAX_DEVICE_FLOW_SECONDS * 1000;
  const { response, body } = await requestJsonWithBoundedRetry(meta.deviceAuthorizationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: DEVICE_SCOPE, resource: identity.publicMcpResource }),
  }, signal, flowDeadline);
  if (!response.ok) throw oauthError(body, response.status);
  const authorization = parseAuthorization(body, identity);

  // RFC 8628: always show BOTH values; the complete URI is convenience only.
  console.log(`Verification URI: ${authorization.verificationUri}`);
  console.log(`User code: ${authorization.userCode}`);
  if (process.env.DC_DEVICE_NO_BROWSER !== "1") {
    await open(authorization.verificationUriComplete ?? authorization.verificationUri).catch(() => undefined);
  }

  const token = await pollForToken(meta, clientId, authorization, identity, verifier, flowDeadline, signal);
  if (!token.refreshToken) throw new OAuthProtocolError("protocol_error", "offline authorization omitted refresh_token");
  return toSession(identity, clientId, token, token.refreshToken, token.effectiveScope, 1);
}

async function pollForToken(
  metadata: AuthorizationServerMetadata,
  clientId: string,
  auth: DeviceAuthorizationResponse,
  identity: RemoteIdentityConfig,
  verifier: ProviderTokenVerifier,
  flowDeadlineMs: number,
  signal?: AbortSignal,
) {
  const deadline = Math.min(flowDeadlineMs, monotonicNowMs() + auth.expiresIn * 1000);
  let interval = auth.interval;
  let transientFailures = 0;
  while (true) {
    if (signal?.aborted) throw signal.reason;
    const remaining = deadline - monotonicNowMs();
    if (remaining <= 0) throw new OAuthProtocolError("expired_token", "device authorization expired");
    const waitMs = Math.min(remaining, (interval + Math.random() * Math.min(2, interval / 4)) * 1000);
    await sleepAbortable(waitMs, signal, deadline);
    try {
      const { response, body } = await requestJson(metadata.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: auth.deviceCode, client_id: clientId, resource: identity.publicMcpResource }),
      }, signal, deadline);
      if (response.ok) {
        const token = parseToken(body);
        await requireProviderTokenGate(verifier, token.accessToken, metadata, identity, deadline, signal);
        return token;
      }
      if (transientHttpStatus(response.status)) {
        const transientError = transientOAuthErrorForHttp(body, response.status);
        transientFailures += 1;
        if (transientFailures >= MAX_TRANSIENT_ATTEMPTS) {
          throw transientError ?? new OAuthProtocolError(
            "temporarily_unavailable",
            `transient OAuth HTTP ${response.status} exhausted retries`,
            response.status,
          );
        }
        const retryMs = response.status === 429 ? retryAfterMs(response) : undefined;
        const jitterMs = Math.min(5_000, Math.floor(250 * 2 ** Math.min(transientFailures, 4) + Math.random() * 500));
        await sleepAbortable(retryMs ?? jitterMs, signal, deadline);
        continue;
      }
      const error = oauthError(body, response.status);
      if (error.code === "authorization_pending") { transientFailures = 0; continue; }
      if (error.code === "slow_down") {
        transientFailures = 0;
        interval = Math.min(MAX_POLL_INTERVAL_SECONDS, interval + 5);
        continue;
      }
      throw error;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof OAuthProtocolError) throw error; // malformed OAuth is terminal
      transientFailures += 1;
      if (transientFailures >= MAX_TRANSIENT_ATTEMPTS || monotonicNowMs() >= deadline) throw error;
      interval = Math.min(MAX_POLL_INTERVAL_SECONDS, interval + 5);
    }
  }
}

export async function refreshDeviceSession(
  session: DeviceOAuthSession,
  identity: RemoteIdentityConfig,
  verifier: ProviderTokenVerifier,
  signal?: AbortSignal,
): Promise<DeviceOAuthSession> {
  if (!isSessionBoundTo(session, identity)) throw new OAuthProtocolError("invalid_target", "credential binding mismatch");
  const meta = await fetchAuthorizationServerMetadata(identity, signal);
  const deadline = monotonicNowMs() + HTTP_TIMEOUT_MS;
  const { response, body } = await requestJsonWithBoundedRetry(meta.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refreshToken, client_id: session.clientId, resource: identity.publicMcpResource }),
  }, signal, deadline);
  if (!response.ok) throw oauthError(body, response.status);
  const token = parseToken(body, session.scope);
  await requireProviderTokenGate(verifier, token.accessToken, meta, identity, deadline, signal);
  return toSession(identity, session.clientId, token, token.refreshToken ?? session.refreshToken, token.effectiveScope, session.generation + 1);
}

export function isSessionBoundTo(session: DeviceOAuthSession, identity: RemoteIdentityConfig): boolean {
  return session.version === 2 && session.issuer === identity.authorizationServerIssuer && session.resource === identity.publicMcpResource;
}

function toSession(identity: RemoteIdentityConfig, clientId: string, token: OAuthTokenResponse, refreshToken: string, scope: string, generation: number): DeviceOAuthSession {
  return { version: 2, issuer: identity.authorizationServerIssuer, resource: identity.publicMcpResource, clientId, accessToken: token.accessToken, refreshToken, expiresAt: Date.now() + token.expiresIn * 1000, scope, generation };
}
```

`ProviderTokenVerifier` is a mandatory provider gate, not an optional note: initial, refreshed, **and persisted restart** tokens are not used until verified issuer and `aud` equal the configured issuer and the one exact resource (a multi-valued audience is rejected). Its JWT/JWKS or authoritative-introspection implementation remains P1/P7A and package-version gated; sending `resource` is never treated as proof.
The `readBoundedJsonObject` sketch enforces the decoded-body limit visible to Web Streams. P7B additionally requires a **raw transfer-byte** ceiling. If the runtime transparently decompresses before this reader, the final `oauth-http.ts` connector must account raw received bytes separately (or explicitly disable compression for these bounded protocol responses) and test both limits. Do not claim P7B.4 complete from this generic Fetch reader alone.

## A3 — `src/remote-device/credential-store.ts` — persisted clear-generation + expected-generation contract

Status: P8A-BLOCKED for native implementation; READY-AFTER-GATE interface

Refresh-token rotation requires a lock/CAS boundary that works across **multiple Desktop Commander OS processes**. A session generation alone is insufficient after a clear because a fresh pairing may restart at generation 1; the store also persists a monotonically increasing `clearGeneration` tombstone even while no session exists.

```ts
import type { DeviceOAuthSession } from "./device-oauth.js";

export type DeviceCredentialSnapshot = Readonly<{
  clearGeneration: number; // safe integer >= 0; persists even when session is null
  session: DeviceOAuthSession | null;
}>;

export interface LockedDeviceCredentialStore {
  load(): Promise<DeviceCredentialSnapshot>;

  // Save only if no explicit/internal clear occurred since the caller's snapshot
  // and the currently stored session is exactly the generation the caller loaded.
  saveExpected(input: {
    session: DeviceOAuthSession;
    expectedClearGeneration: number;
    expectedSessionGeneration: number | null;
  }): Promise<boolean>;

  // Internal stale-credential cleanup may clear only the exact generation it loaded.
  // Success increments durable clearGeneration in the same locked operation.
  clearExpected(input: {
    expectedClearGeneration: number;
    expectedSessionGeneration: number;
  }): Promise<boolean>;

  // Separate explicit user/admin intent. This may clear the current winner and
  // always increments clearGeneration so in-flight refresh/pair results cannot save.
  clearExplicitly(): Promise<number>;
}

export interface DeviceCredentialStore {
  runExclusive<T>(operation: (locked: LockedDeviceCredentialStore) => Promise<T>): Promise<T>;
}

export class MemoryCredentialStore implements DeviceCredentialStore {
  private state: DeviceCredentialSnapshot = { clearGeneration: 0, session: null };
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: (locked: LockedDeviceCredentialStore) => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation({
        load: async () => ({ ...this.state, session: this.state.session && { ...this.state.session } }),
        saveExpected: async ({ session, expectedClearGeneration, expectedSessionGeneration }) => {
          const currentGeneration = this.state.session?.generation ?? null;
          if (this.state.clearGeneration !== expectedClearGeneration || currentGeneration !== expectedSessionGeneration) return false;
          this.state = { clearGeneration: this.state.clearGeneration, session: { ...session } };
          return true;
        },
        clearExpected: async ({ expectedClearGeneration, expectedSessionGeneration }) => {
          if (this.state.clearGeneration !== expectedClearGeneration || this.state.session?.generation !== expectedSessionGeneration) return false;
          this.state = { clearGeneration: this.state.clearGeneration + 1, session: null };
          return true;
        },
        clearExplicitly: async () => {
          this.state = { clearGeneration: this.state.clearGeneration + 1, session: null };
          return this.state.clearGeneration;
        },
      });
    } finally {
      release();
    }
  }
}
```

`NativeCredentialStore.runExclusive()` uses a real cross-process primitive appropriate to the platform. The serialized vault/tombstone format must preserve `clearGeneration` independently of the token payload and update it atomically with session clear/save metadata. A JavaScript promise mutex alone is insufficient.

Required invariants:

```text
process A loads clear=4/session=10
process B explicit-clears -> clear=5/session=null
A refresh/pair result tries saveExpected(clear=4, session=10 or null) -> reject

process A loads clear=5/session=10
process B waits
A refreshes and saveExpected(clear=5, session=10) -> session=11
B then loads clear=5/session=11
=> B never clears/writes a stale generation 10-derived result
```

## A4 — `src/remote-device/device-oauth-session.ts` — corrected vault parser

Status: READY-AFTER-GATE

```ts
import type { DeviceOAuthSession } from "./device-oauth.js";
import {
  requireCanonicalIssuer,
  requireCanonicalMcpResource,
} from "./remote-identity.js";
import type { RuntimeProfile } from "./trusted-http-url.js";

export function parseDeviceOAuthSession(value: unknown, profile: RuntimeProfile): DeviceOAuthSession | null {
  if (!isRecord(value) || value.version !== 2) return null;
  if (!nonEmpty(value.issuer) || !nonEmpty(value.resource)) return null;
  if (!nonEmpty(value.clientId) || !nonEmpty(value.accessToken) || !nonEmpty(value.refreshToken)) {
    return null;
  }
  if (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt) || value.expiresAt <= 0) {
    return null;
  }
  if (typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1) {
    return null;
  }
  if (typeof value.scope !== "string") return null;

  try {
    // These functions REJECT noncanonical identity; they do not rewrite persisted identity.
    requireCanonicalIssuer(value.issuer, profile);
    requireCanonicalMcpResource(value.resource, profile);
  } catch {
    return null;
  }

  return {
    version: 2,
    issuer: value.issuer,
    resource: value.resource,
    clientId: value.clientId,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
    scope: value.scope,
    generation: value.generation,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
```

`NativeCredentialStore.load()` parses under the native store's cross-process lock. Syntactically valid but unsupported/unversioned data is cleared and triggers fresh authorization. Never log the raw vault payload.

## A5 — `src/remote-device/token-manager.ts` — verified persisted tokens, expected-generation cleanup, pairing outside vault lock

Status: P8A-BLOCKED native lock/lease; READY-AFTER-GATE algorithm

A structurally valid V2 record is **not** sufficient authority. On every process start, the first use of an unexpired persisted access token re-runs the mandatory provider signature/introspection gate and exact issuer/single-audience check before returning the token. Verification happens outside the vault lock; the store is rechecked afterward so a token that changed during verification is never used.

```ts
import {
  isSessionBoundTo,
  OAuthProtocolError,
  refreshDeviceSession,
  verifyPersistedDeviceAccessToken,
  type DeviceOAuthSession,
  type ProviderTokenVerifier,
} from "./device-oauth.js";
import type {
  DeviceCredentialSnapshot,
  DeviceCredentialStore,
  LockedDeviceCredentialStore,
} from "./credential-store.js";
import type { RemoteIdentityConfig } from "./remote-identity.js";

const REFRESH_SKEW_MS = 60_000;
const MAX_STABLE_LOAD_ATTEMPTS = 4;

export class ReauthorizationRequiredError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ReauthorizationRequiredError";
  }
}

export type PairingLeadership = Readonly<{
  attemptId: string;
  signal: AbortSignal;
  assertHeld(): Promise<void>;
}>;

export interface PairingLease {
  runAsLeader<T>(
    key: string,
    callerSignal: AbortSignal | undefined,
    operation: (leadership: PairingLeadership) => Promise<T>,
  ): Promise<T>;
}

export type AuthorizeDevice = (leadership: PairingLeadership) => Promise<DeviceOAuthSession>;
export type DisposeLosingSession = (session: DeviceOAuthSession) => Promise<void>;

function terminalReauth(error: unknown): boolean {
  return error instanceof ReauthorizationRequiredError ||
    (error instanceof OAuthProtocolError && [
      "invalid_grant", "invalid_token", "invalid_target", "invalid_client", "expired_token",
    ].includes(error.code));
}

type Loaded =
  | { kind: "none" }
  | { kind: "refresh_verified"; session: DeviceOAuthSession }
  | { kind: "verify_persisted"; snapshot: DeviceCredentialSnapshot; session: DeviceOAuthSession };

export class DeviceTokenManager {
  private session: DeviceOAuthSession | null = null;
  private verifiedGeneration: number | null = null;
  private epoch = 0;

  constructor(
    private readonly store: DeviceCredentialStore,
    private readonly lease: PairingLease,
    private readonly identity: RemoteIdentityConfig,
    private readonly verifier: ProviderTokenVerifier,
    private readonly authorize: AuthorizeDevice,
    private readonly disposeLosingSession: DisposeLosingSession,
  ) {}

  async initialize(signal?: AbortSignal): Promise<DeviceOAuthSession> {
    const existing = await this.loadOrRefreshAndVerify(signal);
    return existing ?? this.pairOutsideVaultLock(signal);
  }

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    const existing = await this.loadOrRefreshAndVerify(signal);
    return (existing ?? await this.pairOutsideVaultLock(signal)).accessToken;
  }

  async clearExplicitly(): Promise<void> {
    this.epoch += 1;
    this.session = null;
    this.verifiedGeneration = null;
    await this.store.runExclusive(async (locked) => { await locked.clearExplicitly(); });
  }

  private async loadOrRefreshAndVerify(signal?: AbortSignal): Promise<DeviceOAuthSession | null> {
    for (let attempt = 0; attempt < MAX_STABLE_LOAD_ATTEMPTS; attempt += 1) {
      const startEpoch = this.epoch;
      const loaded = await this.store.runExclusive(async (locked): Promise<Loaded> => {
        const snapshot = await locked.load();
        const current = snapshot.session;
        if (!current) return { kind: "none" };
        if (!isSessionBoundTo(current, this.identity)) {
          await this.clearExactOrFail(locked, snapshot);
          return { kind: "none" };
        }

        if (current.expiresAt - Date.now() <= REFRESH_SKEW_MS) {
          try {
            // Provider refresh-token rotation may require this one bounded,
            // non-interactive refresh under the cross-process vault lock.
            const next = await refreshDeviceSession(current, this.identity, this.verifier, signal);
            this.assertEpoch(startEpoch);
            if (next.generation !== current.generation + 1) throw new Error("credential generation invariant failed");
            const saved = await locked.saveExpected({
              session: next,
              expectedClearGeneration: snapshot.clearGeneration,
              expectedSessionGeneration: current.generation,
            });
            if (!saved) throw new ReauthorizationRequiredError("credential changed during refresh");
            return { kind: "refresh_verified", session: next };
          } catch (error) {
            if (!terminalReauth(error)) throw error;
            await this.clearExactOrFail(locked, snapshot);
            return { kind: "none" };
          }
        }

        return { kind: "verify_persisted", snapshot, session: current };
      });

      this.assertEpoch(startEpoch);
      if (loaded.kind === "none") {
        this.session = null;
        this.verifiedGeneration = null;
        return null;
      }
      if (loaded.kind === "refresh_verified") {
        this.session = loaded.session;
        this.verifiedGeneration = loaded.session.generation; // refresh path already verified token claims
        return loaded.session;
      }

      const alreadyVerifiedInThisProcess =
        this.verifiedGeneration === loaded.session.generation &&
        this.session?.generation === loaded.session.generation &&
        this.session.accessToken === loaded.session.accessToken;

      if (!alreadyVerifiedInThisProcess) {
        try {
          // Outside the vault lock. Failure to reach metadata/JWKS is fail-closed but
          // does not erase a credential unless the verifier proves a terminal token/binding error.
          await verifyPersistedDeviceAccessToken(loaded.session, this.identity, this.verifier, signal);
        } catch (error) {
          if (!terminalReauth(error)) throw error;
          const cleared = await this.store.runExclusive(async (locked) => {
            const now = await locked.load();
            if (now.clearGeneration !== loaded.snapshot.clearGeneration ||
                now.session?.generation !== loaded.session.generation ||
                now.session.accessToken !== loaded.session.accessToken) return false;
            return locked.clearExpected({
              expectedClearGeneration: loaded.snapshot.clearGeneration,
              expectedSessionGeneration: loaded.session.generation,
            });
          });
          if (!cleared) continue; // another process won; reload instead of clearing it
          this.session = null;
          this.verifiedGeneration = null;
          return null;
        }
      }

      const stable = await this.store.runExclusive(async (locked) => {
        const now = await locked.load();
        return now.clearGeneration === loaded.snapshot.clearGeneration &&
          now.session?.generation === loaded.session.generation &&
          now.session.accessToken === loaded.session.accessToken &&
          isSessionBoundTo(now.session, this.identity);
      });
      if (!stable) continue;

      this.assertEpoch(startEpoch);
      this.session = loaded.session;
      this.verifiedGeneration = loaded.session.generation;
      return loaded.session;
    }
    throw new ReauthorizationRequiredError("credential changed repeatedly while validating persisted authorization");
  }

  private async clearExactOrFail(
    locked: LockedDeviceCredentialStore,
    snapshot: DeviceCredentialSnapshot,
  ): Promise<void> {
    if (!snapshot.session) return;
    const cleared = await locked.clearExpected({
      expectedClearGeneration: snapshot.clearGeneration,
      expectedSessionGeneration: snapshot.session.generation,
    });
    if (!cleared) throw new ReauthorizationRequiredError("newer credential won stale cleanup race");
  }

  private async pairOutsideVaultLock(signal?: AbortSignal): Promise<DeviceOAuthSession> {
    const key = `${this.identity.authorizationServerIssuer}\n${this.identity.publicMcpResource}`;
    return this.lease.runAsLeader(key, signal, async (leadership) => {
      const winner = await this.loadOrRefreshAndVerify(leadership.signal);
      if (winner) return winner;

      const before = await this.store.runExclusive((locked) => locked.load());
      if (before.session) throw new ReauthorizationRequiredError("credential appeared before pairing");
      const startEpoch = this.epoch;
      const candidate = await this.authorize(leadership); // browser/poll: NO vault lock
      await leadership.assertHeld();
      this.assertEpoch(startEpoch);

      const decision = await this.store.runExclusive(async (locked) => {
        const current = await locked.load();
        if (current.clearGeneration !== before.clearGeneration) return { kind: "cleared" as const };
        if (current.session && isSessionBoundTo(current.session, this.identity)) {
          return { kind: "winner" as const, session: current.session };
        }
        if (current.session) throw new ReauthorizationRequiredError("unexpected credential binding appeared during pairing");
        await leadership.assertHeld();
        this.assertEpoch(startEpoch);
        const saved = await locked.saveExpected({
          session: candidate,
          expectedClearGeneration: before.clearGeneration,
          expectedSessionGeneration: null,
        });
        if (!saved) return { kind: "cleared" as const };
        return { kind: "saved" as const, session: candidate };
      });

      if (decision.kind !== "saved") {
        await this.disposeLosingSession(candidate); // revoke or durably queue cleanup before lease release
        if (decision.kind === "cleared") {
          throw new ReauthorizationRequiredError("authorization was cleared while pairing");
        }
      }
      const session = decision.session;
      this.session = session;
      this.verifiedGeneration = session.generation; // pairDevice already ran provider token gate
      return session;
    });
  }

  private assertEpoch(expected: number): void {
    if (this.epoch !== expected) throw new ReauthorizationRequiredError("authorization changed during operation");
  }
}
```

The provider-token verifier is now on **all** access-token paths: initial issuance, refresh, and persisted-token restart. A restart with a wrong issuer, missing audience, wrong audience, or multi-valued audience cannot reach `RemoteChannel` merely because the serialized issuer/resource strings look correct. Transient verifier/JWKS unavailability fails closed without deleting a potentially valid credential; authenticated terminal token/binding failure clears only the exact stale generation.

The pairing lease remains separate from the vault lock. `runAsLeader` renews durable ownership and aborts `leadership.signal` on lease loss; no browser/poll result is saved without `assertHeld()`, epoch/clear-generation checks, exact binding, and winner checks. Losing candidate authority is revoked or placed in a durable cleanup obligation before leadership is released.

## A6 — `src/remote-device/tunnel/tunnel-health.ts` — corrected OAuth checks

Status: READY-AFTER-GATE

Use the same bounded reader, trusted-URL policy, and full RFC 8414 capability parser as `device-oauth.ts`; compare resource and issuer exactly, without trailing-slash rewriting.

```ts
import {
  fetchAuthorizationServerMetadata,
  readBoundedJsonObject,
} from "../device-oauth.js";
import type { RemoteIdentityConfig } from "../remote-identity.js";
import { parseTrustedHttpUrl } from "../trusted-http-url.js";

const HEALTH_MAX_JSON_BYTES = 64 * 1024;

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
    const timeoutSignal = AbortSignal.timeout(
      Number(process.env.DC_TUNNEL_HEALTH_TIMEOUT_MS) || 5_000,
    );
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(metadataUrl, { redirect: "error", signal });
    if (!response.ok) {
      return { name: "public-oauth-resource", ok: false, detail: `HTTP ${response.status}` };
    }
    const value = await readBoundedJsonObject(response, {
      maxBytes: HEALTH_MAX_JSON_BYTES,
      signal,
    });
    if (value.resource !== identity.publicMcpResource) {
      return { name: "public-oauth-resource", ok: false, detail: "Protected-resource resource mismatch" };
    }
    const servers = value.authorization_servers;
    if (!Array.isArray(servers) || servers.length !== 1 ||
        servers[0] !== identity.authorizationServerIssuer) {
      return { name: "public-oauth-resource", ok: false, detail: "authorization_servers must be the exact configured singleton" };
    }
    if (!Array.isArray(value.bearer_methods_supported) ||
        value.bearer_methods_supported.length !== 1 || value.bearer_methods_supported[0] !== "header") {
      return { name: "public-oauth-resource", ok: false, detail: "Bearer header capability not advertised exactly" };
    }
    const scopes = value.scopes_supported;
    const requiredScopes = ["mcp:tools", "device:sync"] as const; // P7A V1 shared-resource model
    if (!Array.isArray(scopes) || scopes.length !== requiredScopes.length ||
        !requiredScopes.every((scope) => scopes.includes(scope)) ||
        !scopes.every((scope) => typeof scope === "string")) {
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
    const timeoutSignal = AbortSignal.timeout(
      Number(process.env.DC_TUNNEL_HEALTH_TIMEOUT_MS) || 5_000,
    );
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    await fetchAuthorizationServerMetadata(identity, signal); // full issuer/endpoints/grants/auth/scopes/response-types validation
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
```

### Required call-site migration

Do not update only `remote.ts`. Every current Tailscale and zrok provider `status()`/`doctor()` call that invokes these helpers must receive the immutable identity:

```ts
await checkProtectedResourceMetadata(state.publicBaseUrl, identity);
await checkAuthorizationServerMetadata(identity);
```

The implementation PR must search the current HEAD for all helper callers and update them atomically. P10 must retain a regression that fails if any provider again derives the issuer from its tunnel origin.

## A7 — typed control-plane client injected through the real `RemoteChannel` path

Status: READY-AFTER-GATE / current call graph verified at the 2026-09-07 review baseline; re-search implementation HEAD

Current HEAD `RemoteChannel` imports five free functions. The migration keeps all five operations, gives each response a runtime parser, and injects the interface into `RemoteChannel` itself. This is an application-owned interface, not a claim about a package API.

```ts
import { toJsonValue } from "./json.js";
import { composeRequestSignal, readBoundedJsonObject } from "./device-oauth.js";
import { parseTrustedHttpUrl, type RuntimeProfile } from "./trusted-http-url.js";

export type DeviceRegistrationInput = Readonly<{
  stableId: string;
  name: string;
  platform: string;
  appVersion: string;
  capabilities: unknown;
}>;
export type DeviceRegistration = Readonly<{
  deviceId: string;
  oauthClientId: string;
  jazzToken: string;
  expiresIn: number;
}>;
export type DeviceHeartbeatInput = Readonly<{
  deviceId: string;
  status: "online" | "offline";
  lastError?: string | null;
}>;
export type DeviceCallCompletion =
  | Readonly<{ callId: string; deviceId: string; status: "completed"; result: unknown }>
  | Readonly<{ callId: string; deviceId: string; status: "failed"; error: string }>;

export interface DeviceControlPlaneClient {
  register(accessToken: string, input: DeviceRegistrationInput, signal?: AbortSignal): Promise<DeviceRegistration>;
  getJazzToken(accessToken: string, deviceId: string, signal?: AbortSignal): Promise<string>;
  heartbeat(accessToken: string, input: DeviceHeartbeatInput, signal?: AbortSignal): Promise<void>;
  claim(accessToken: string, input: { callId: string; deviceId: string }, signal?: AbortSignal): Promise<boolean>;
  complete(accessToken: string, input: DeviceCallCompletion, signal?: AbortSignal): Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid control-plane response");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${field}`);
  return value;
}
function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${field}`);
  return value;
}
function parseRegistration(value: unknown): DeviceRegistration {
  const v = record(value);
  return {
    deviceId: text(v.deviceId, "deviceId"),
    oauthClientId: text(v.oauthClientId, "oauthClientId"),
    jazzToken: text(v.jazzToken, "jazzToken"),
    expiresIn: positiveNumber(v.expiresIn, "expiresIn"),
  };
}
function parseJazzToken(value: unknown): string {
  const v = record(value);
  text(v.jazzToken, "jazzToken");
  positiveNumber(v.expiresIn, "expiresIn");
  return v.jazzToken as string;
}
function parseClaim(value: unknown): boolean {
  const v = record(value);
  if (typeof v.claimed !== "boolean") throw new Error("Invalid claimed");
  return v.claimed;
}
function parseAck(value: unknown): void {
  record(value);
}

export class HttpDeviceControlPlaneClient implements DeviceControlPlaneClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string, profile: RuntimeProfile) {
    const url = parseTrustedHttpUrl(baseUrl, "control-plane base URL", {
      urlClass: "internalLoopback",
      profile,
    });
    if (url.pathname !== "/") throw new Error("control-plane base URL must be an origin");
    this.baseUrl = url.origin;
  }

  register(token: string, input: DeviceRegistrationInput, signal?: AbortSignal): Promise<DeviceRegistration> {
    return this.post("/api/device/register", token, { ...input, capabilities: toJsonValue(input.capabilities, "device capabilities") }, parseRegistration, signal);
  }
  getJazzToken(token: string, deviceId: string, signal?: AbortSignal): Promise<string> {
    return this.post("/api/device/jazz-token", token, { deviceId }, parseJazzToken, signal);
  }
  async heartbeat(token: string, input: DeviceHeartbeatInput, signal?: AbortSignal): Promise<void> {
    await this.post("/api/device/heartbeat", token, input, parseAck, signal);
  }
  claim(token: string, input: { callId: string; deviceId: string }, signal?: AbortSignal): Promise<boolean> {
    return this.post(`/api/device/calls/${encodeURIComponent(input.callId)}/claim`, token, { deviceId: input.deviceId }, parseClaim, signal);
  }
  async complete(token: string, input: DeviceCallCompletion, signal?: AbortSignal): Promise<void> {
    const { callId, ...body } = input;
    await this.post(`/api/device/calls/${encodeURIComponent(callId)}/complete`, token, toJsonValue(body, "call completion"), parseAck, signal);
  }

  private async post<T>(
    path: string,
    accessToken: string,
    body: unknown,
    parse: (value: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    const scoped = composeRequestSignal(signal, performance.now() + 10_000);
    try {
      const response = await fetch(new URL(path, `${this.baseUrl}/`), {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: scoped.signal,
      });
      const envelope = await readBoundedJsonObject(response, { maxBytes: 32 * 1024, signal: scoped.signal });
      if (!response.ok || envelope.ok !== true) {
        // Do not propagate a free-form server error that might contain a URL/code/token.
        throw new Error(`Control-plane request failed: HTTP ${response.status}`);
      }
      return parse(envelope);
    } finally {
      scoped.cleanup();
    }
  }
}
```

`RemoteChannel` changes from `new RemoteChannel(tokens)` to an injected constructor and replaces every free-function reference:

```ts
constructor(
  private readonly tokens: DeviceTokenManager,
  private readonly controlPlane: DeviceControlPlaneClient,
) {
  this.heartbeat = new DeviceHeartbeat(async () => {
    if (!this.deviceId) throw new Error("Device is not registered");
    await this.controlPlane.heartbeat(await this.tokens.getAccessToken(), {
      deviceId: this.deviceId,
      status: "online",
    });
  });
}
```

| Current symbol | Required injected call |
| --- | --- |
| `registerDeviceWithControlPlane` | `this.controlPlane.register` |
| `getJazzDeviceToken` | `this.controlPlane.getJazzToken` |
| `sendDeviceHeartbeat` | `this.controlPlane.heartbeat` |
| `claimRemoteCall` | `this.controlPlane.claim` |
| `completeRemoteCall` | `this.controlPlane.complete` |

### Complete target/call-site manifest at review baseline

```text
src/remote-device/control-plane-client.ts
src/remote-device/remote-channel.ts
src/remote-device/device.ts                         constructor + standalone main
src/npm-scripts/remote.ts                           runRemote + runTunnelCommand
src/remote-device/tunnel/types.ts
src/remote-device/tunnel/tunnel-provider.ts
src/remote-device/tunnel/create-tunnel-provider.ts
src/remote-device/tunnel/tunnel-supervisor.ts
src/remote-device/tunnel/tailscale-tunnel-provider.ts  status + doctor
src/remote-device/tunnel/zrok-tunnel-provider.ts       status + doctor
test/test-remote-device-supervision.js
test/test-remote-jazz-safety.js
test/test-remote-tunnels.js
test/integration/tailscale-funnel-e2e.js
test/integration/zrok-remote-mcp-e2e.js
```

`MCPDevice` receives immutable identity, credential/receipt/lease dependencies, a `ProviderTokenVerifier`, and a `DeviceControlPlaneClient`, then constructs `new RemoteChannel(this.tokens, controlPlaneClient)`. Preserve claim-before-side-effect behavior and completion ordering unchanged. The implementation PR must re-run a symbol/call-site search on its HEAD; this manifest is complete for the stated baseline, not a promise about future files.

## A8 — read-only tunnel identity -> vault first -> lazy tunnel/bootstrap

Status: P7A/P8A-BLOCKED / READY-AFTER-GATE architecture; receipt/provider APIs are illustrative and version-unverified

Current providers expose `start()/status()/doctor()` and do **not** yet have a read-only durable-identity inspection API. P7B therefore adds one explicitly in `tunnel/types.ts` and both identity stores. Do not pretend current `start()` is read-only, and do not invent `tunnel.prepare()` or `tunnelState.controlProof`.

Proposed additive inspection contract:

```ts
type DurableTunnelIdentity = Readonly<{
  provider: "tailscale" | "zrok";
  publicBaseUrl: string;
  publicMcpUrl: string;
  localTarget: string;
}>;

interface TunnelProvider {
  inspectDurableIdentity(): Promise<DurableTunnelIdentity | null>; // MUST NOT start/repair/mutate transport
  start(): Promise<TunnelState>;                                  // may create/recover runtime mapping
  status(): Promise<TunnelState>;
  doctor(): Promise<TunnelDoctorReport>;
  // ...existing methods...
}
```

Startup construction is **authority-state first**. Stores are opened before any tunnel mutation. The runtime writer/ack client uses the exact P7A acknowledgement shape:

```ts
export type ResourceRuntimeAckV1 = Readonly<{
  version: 1;
  revision: number;
  operation: "apply_resource" | "install_bootstrap_proof" | "remove_bootstrap_proof";
  canonicalDocumentDigest: string;
  resource: string;
  bootstrapId: string | null;
  serverGeneration: number;
  appliedAt: string;
}>;
```

The client verifies every field against the exact canonical input document/removal tombstone. Revisions and `serverGeneration` are durable and monotonic; exact replay may return the old acknowledgement, but stale/lower or same-revision/different-digest input rejects. POSIX writers use same-directory temp + file `fsync` + atomic rename + parent-directory `fsync`; Windows uses owner ACL + `FlushFileBuffers` + write-through same-volume replacement and a flushed generation manifest/equivalent recovery primitive. No mtime/file-absence inference is allowed.

The local receipt shape is the exact P7A receipt contract (no renamed aliases):

```ts
export type ProvisioningReceiptV1 = Readonly<{
  version: 1;
  issuer: string;
  bootstrapId: string;
  resource: string;
  oauthClientId: string;
  receiptId: string;
  receiptSecret: string; // OS credential backend only; never status/log output
  state:
    | "challenge_issued" | "capability_issued" | "provisioning"
    | "provisioned_pending_approval" | "consumed_owned"
    | "expired" | "revoked" | "abandoned" | "provision_denied";
  createdAt: number;
  expiresAt: number;
}>;

export type ProvisioningRecoveryJournalV1 = Readonly<{
  version: 1;
  issuer: string;
  resource: string;
  bootstrapId: string;
  idempotencyKey: string;
  canonicalProvisionRequestDigest: string;
  bootstrapKeyReference: string; // opaque OS-key-store reference, not private key bytes
  createdAt: number;
  expiresAt: number;
}>;

export type BootstrapCleanupObligationV1 = Readonly<{
  version: 1;
  issuer: string;
  resource: string;
  bootstrapId: string;
  receiptId: string;
  state: "pending" | "proof_removed_acked" | "key_removed" | "complete";
}>;

const provider = createTunnelProvider(options.tunnel, {
  ...existingTunnelOptions,
  authorizationServerIssuer: releaseConfig.authorizationServerIssuer,
  // P7A.5A: preflight is a separate loopback-only admin listener/IPC owned by
  // the control-plane HTTP edge. It is NOT the tunneled RFC9728 metadata path.
  privateLocalLiveness: resourceEdgeAdminLiveness,
});

const credentialStore = persistSession
  ? new NativeCredentialStore(nativeLockOptions)
  : new MemoryCredentialStore();
const receiptStore = new ProvisioningReceiptStore(nativeReceiptOptions);
const provisionRecoveryStore = new ProvisioningRecoveryJournalStore(nativeProvisionRecoveryOptions);
const bootstrapCleanupStore = new BootstrapCleanupObligationStore(nativeBootstrapCleanupOptions);
const pairingLease = new NativePairingLease(pairingLeaseOptions);

const durableTunnel = await provider.inspectDurableIdentity(); // read-only
const credentialSnapshot = await credentialStore.runExclusive((locked) => locked.load());
const receiptSummary = await receiptStore.inspectAny(); // metadata only; no receipt secret in logs/output

if (!durableTunnel) {
  // Existing authority with a missing durable tunnel identity is an explicit repair
  // state. Never create a new resource/tunnel and silently strand/rebind it.
  if (credentialSnapshot.session || receiptSummary) {
    throw new ReauthorizationRequiredError("remote authorization exists but durable tunnel identity is missing; repair is required");
  }

  // True first run: only now may start() create/reserve the stable tunnel identity.
  // provider.start() preflights PRIVATE local liveness, never unconfigured RFC9728 metadata.
  const firstState = await provider.start();
  if (!firstState.publicMcpUrl) throw new Error("stable public MCP URL missing");
  await startForKnownIdentity({
    provider,
    publicMcpUrl: firstState.publicMcpUrl,
    tunnelAlreadyStarted: true,
  });
} else {
  await startForKnownIdentity({
    provider,
    publicMcpUrl: durableTunnel.publicMcpUrl,
    tunnelAlreadyStarted: false,
  });
}
```

The per-identity startup then consults/reuses OAuth authority before transport recovery:

```ts
async function startForKnownIdentity(input: {
  provider: TunnelProvider;
  publicMcpUrl: string;
  tunnelAlreadyStarted: boolean;
}): Promise<void> {
  const identity = createRemoteIdentity({
    runtimeProfile: releaseConfig.runtimeProfile,
    authorizationServerIssuer: releaseConfig.authorizationServerIssuer,
    publicMcpResource: requireCanonicalMcpResource(input.publicMcpUrl, releaseConfig.runtimeProfile),
    internalDeviceApiOrigin: localControlPlaneOrigin,
  });
  const verifier = new ReleaseConfiguredProviderTokenVerifier(releaseTokenVerificationOptions);
  const controlPlane = new HttpDeviceControlPlaneClient(identity.internalDeviceApiOrigin, identity.runtimeProfile);
  const resourceRuntime = new AtomicWatchedResourceRuntimeConfigurator(resourceRuntimePaths);

  let tunnelStarted = input.tunnelAlreadyStarted;
  const ensureExactTunnelStarted = async (): Promise<TunnelState> => {
    const state = tunnelStarted ? await input.provider.status() : await input.provider.start();
    tunnelStarted = true;
    if (!state.publicMcpUrl || state.publicMcpUrl !== identity.publicMcpResource) {
      throw new Error("started tunnel identity differs from durable exact MCP resource");
    }
    return state;
  };

  const authorize: AuthorizeDevice = async (leadership) => {
    // Interactive authorization is the only path that may need the public tunnel.
    // The apps/control-plane HTTP resource edge was already running in
    // resource_unconfigured mode; DesktopCommander's src/server.ts is not this listener.
    await ensureExactTunnelStarted();

    // P7A.5A: install exact resource/issuer runtime config into the already-running
    // local server, wait for its monotonic ack, then prove public RFC9728 readiness.
    // No CLI process.env mutation is treated as server configuration.
    const resourceAck = await resourceRuntime.configureResource(identity, leadership.signal);
    await resourceRuntime.assertResourceReady(identity, resourceAck, leadership.signal);

    // A crash may occur after /provision committed but before the receipt was saved.
    // Recover that exact idempotent result BEFORE receipt lookup/new bootstrap. The
    // recovery journal contains no bootstrap capability; it authenticates recovery
    // with the original device key and exact request digest/idempotency key.
    const recoveryJournal = await provisionRecoveryStore.loadExact(identity);
    if (recoveryJournal) {
      const recovered = await recoverProvisioningResultByDeviceKeyV1({
        identity,
        journal: recoveryJournal,
        leadership,
      });
      if (recovered.kind === "committed") {
        await receiptStore.saveAtomic(recovered.receipt);
        await provisionRecoveryStore.clearExpected(recoveryJournal);
      } else if (recovered.kind === "safe_to_restart_bootstrap") {
        await provisionRecoveryStore.clearExpected(recoveryJournal);
        await bootstrapKeyStore.clearExpected(recoveryJournal.bootstrapId);
      } else {
        throw new ReauthorizationRequiredError("provisioning recovery remains in progress or ambiguous; repair required");
      }
    }

    let receipt = await receiptStore.loadExact(identity);
    if (receipt) {
      const reconciled = await reconcileProvisioningReceiptV1({ receipt, identity, leadership });
      receipt = reconciled.receipt;

      if (receipt.version !== 1 || receipt.issuer !== identity.authorizationServerIssuer ||
          receipt.resource !== identity.publicMcpResource) {
        throw new ReauthorizationRequiredError("provisioning receipt binding mismatch");
      }

      switch (receipt.state) {
        case "provisioned_pending_approval":
        case "consumed_owned": {
          const session = await pairDevice(identity, receipt.oauthClientId, verifier, leadership.signal);
          // Must exist before DeviceTokenManager can persist the new V2 session.
          await bootstrapCleanupStore.ensurePendingFromReceipt(receipt);
          return session;
        }

        case "expired":
        case "revoked":
        case "abandoned":
        case "provision_denied":
          if (!reconciled.cleanupComplete) {
            throw new ReauthorizationRequiredError("terminal provisioning receipt cleanup is incomplete; repair required");
          }
          // Server-authenticated reconciliation proved this non-owned attempt is terminal
          // and fully cleaned up. Archive/remove exact local recovery state atomically,
          // remove any terminal proof/key only after proof-removal acknowledgement, then
          // continue to ONE new bootstrap rather than rediscovering this receipt forever.
          await resourceRuntime.removeBootstrapProof(receipt.bootstrapId, leadership.signal);
          await bootstrapKeyStore.clearExpected(receipt.bootstrapId);
          await receiptStore.archiveAndClearExpected(receipt);
          receipt = null;
          break;

        case "provisioning":
          throw new ReauthorizationRequiredError("provisioning roll-forward is still in progress; repair/reconcile before authorization");

        case "challenge_issued":
        case "capability_issued":
          throw new ReauthorizationRequiredError("invalid local receipt phase; pre-provision bootstrap state requires explicit repair");
      }
    }

    if (!receipt) {
      if (await receiptStore.inspectAny()) {
        throw new ReauthorizationRequiredError("non-matching provisioning receipt requires repair");
      }

      // Resource config is already acknowledged. The bootstrap client may now call
      // /challenge. After receiving the challenge it writes the signed proof document
      // through resourceRuntime, waits for proof ack + public exact proof readiness,
      // and only then calls /prove. The private Ed25519 key never enters the state file.
      receipt = await reconcileOrProvisionBootstrapV1({
        identity,
        provider: input.provider,
        resourceRuntime,
        provisionRecoveryStore, // writes journal BEFORE /provision network I/O
        leadership,
      });
      await receiptStore.saveAtomic(receipt); // BEFORE RFC 8628 starts
      await provisionRecoveryStore.clearForCommittedReceipt(receipt);
    }

    if (receipt.state !== "provisioned_pending_approval" && receipt.state !== "consumed_owned") {
      throw new ReauthorizationRequiredError("new provisioning receipt is not reusable for authorization");
    }
    const session = await pairDevice(identity, receipt.oauthClientId, verifier, leadership.signal);
    // Persist cleanup obligation before returning the candidate to DeviceTokenManager;
    // a crash immediately after vault save still leaves a durable cleanup task.
    await bootstrapCleanupStore.ensurePendingFromReceipt(receipt);
    return session;
  };

  const tokens = new DeviceTokenManager(
    credentialStore,
    pairingLease,
    identity,
    verifier,
    authorize,
    revokeOrQueueLosingSessionCleanup,
  );

  // Mandatory order: exact durable identity is known, then vault load/refresh.
  const session = await tokens.initialize(startupSignal);

  // Normal steady-state V2 with no cleanup obligation does zero receipt/bootstrap/browser calls.
  // If a crash left a post-session bootstrap cleanup obligation, resume ONLY that cleanup:
  // require consumed_owned, remove/ack proof, clear exact bootstrap key, mark obligation complete.
  await reconcileOwnedBootstrapCleanupIfNeededV1({
    identity,
    session,
    receiptStore,
    bootstrapCleanupStore,
    resourceRuntime,
    bootstrapKeyStore,
    signal: startupSignal,
  });

  // Transport may be recovered only after the authorization decision above. For a
  // valid V2 session this is the first tunnel mutation in the process.
  await ensureExactTunnelStarted();

  const device = new MCPDevice(options, {
    identity,
    tokens,
    controlPlaneClient: controlPlane,
  });
  await device.start();
}
```

`ProvisioningRecoveryJournalStore`, `ProvisioningReceiptStore`, and `BootstrapCleanupObligationStore` are durable and cross-process safe. The recovery journal stores only bootstrap ID, exact idempotency key/request digest, and an opaque bootstrap-key reference before `/provision`; it never stores the one-use capability. `ProvisioningReceiptStore` it **does** store the P7A `receiptSecret` in the OS credential backend because that secret authenticates receipt reconciliation/abandonment. The runtime parser validates the complete canonical P7A receipt, keys by exact issuer + resource, and retains it after pairing denial/timeout so restart reconciles the same provisioned client. `inspectAny()` returns only bounded non-secret local metadata sufficient to detect an orphan/mismatched authority record; it never exposes `receiptSecret` to generic status/log output.

`AtomicWatchedResourceRuntimeConfigurator` is the Desktop-side writer/ack client for P7A.5A. The watcher, private local admin-liveness listener, RFC9728/MCP HTTP routes, and public proof handler are owned by the already-running `apps/control-plane` HTTP artifact—not `src/server.ts`. `assertResourceReady()` verifies both the local acknowledgement and public RFC 9728 metadata before `/challenge`; the bootstrap client installs/acks the exact signed proof and confirms the public derived proof URL before `/prove`. The current server's process-start `APP_ORIGIN`/`REMOTE_MCP_RESOURCE` assumption is therefore a migration target, not an implicit prerequisite.

A terminal non-owned receipt is not a permanent dead end. After authenticated reconciliation reports `cleanupComplete=true`, the client removes/archives the exact receipt and bootstrap key/proof under CAS/ack semantics and continues to a new bootstrap. `provisioning` or terminal cleanup-incomplete remains an explicit repair state. `consumed_owned` is never discarded merely because the local V2 token is missing; it reuses the same client/resource for a fresh explicit RFC 8628 authorization.

### Mandatory startup cases

```text
durable tunnel + valid V2 session + no cleanup obligation
-> inspect tunnel identity read-only -> verify persisted token -> start/recover tunnel -> no receipt/bootstrap/browser

durable tunnel + valid V2 session + pending bootstrap cleanup obligation
-> no browser/provision -> reconcile consumed_owned -> remove+ack proof -> clear bootstrap key -> mark cleanup complete

durable tunnel + refreshable V2
-> inspect -> refresh under short vault lock -> start/recover tunnel -> no bootstrap/browser

durable tunnel + missing/terminal credential + matching reusable receipt
-> inspect -> vault says authorization required -> pairing lease -> start/recover exact tunnel -> resource config ack -> reconcile receipt -> RFC8628

durable tunnel + terminal non-owned receipt with cleanup complete
-> reconcile authenticated status -> remove proof/key + archive/clear receipt atomically -> one fresh bootstrap

durable tunnel + terminal receipt cleanup incomplete or provisioning ambiguous
-> explicit repair; no fresh bootstrap/client/resource

durable tunnel + provisioning recovery journal
-> recover exact original /provision result by device-key signature before any new challenge; committed -> persist original receipt; ambiguous -> repair

durable tunnel + no credential/receipt/recovery journal
-> inspect -> vault/receipt prove authorization required -> pairing lease -> start/recover exact tunnel using private liveness preflight -> install+ack resource config -> public metadata ready -> challenge -> proof install/ack/public-ready -> prove -> write recovery journal -> provision -> persist receipt -> clear recovery journal -> RFC8628

no durable tunnel + no credential/receipt
-> inspect all authority state first -> create stable tunnel identity -> install+ack runtime resource config -> verify public metadata -> bootstrap path

no durable tunnel + credential or receipt exists
-> fail closed into explicit repair; never create a new resource identity silently
```

### Tunnel health migration

Add central issuer configuration and read-only durable-identity inspection to the tunnel provider/factory contract rather than changing only CLI direct calls. Tailscale/zrok `status()` and `doctor()` retain their current no-argument public interface; internally they use the durable identity plus configured central issuer and call the health helpers with exact issuer/resource context. `status`, `doctor`, and `inspectDurableIdentity` must never initiate bootstrap or create/repair the tunnel.

The complete target/call-site manifest is in A7/P7B. It includes `tunnel/types.ts`, both identity stores, `create-tunnel-provider.ts`, both provider `status()`/`doctor()` paths, `tunnel-supervisor.ts`, `src/npm-scripts/remote.ts`, direct provider/integration tests, and standalone/test `MCPDevice` constructors.

## A9 — device-side security/regression tests

Status: READY-AFTER-GATE

Representative required coverage:

```text
canonical issuer accepted; credentials/query/fragment/noncanonical form rejected
production public OAuth/resource http://127.0.0.1 and http://[::1] -> reject
explicit development/test public loopback may accept literal loopback HTTP; localhost still rejected
internalLoopback class accepts only literal loopback and never makes it a public identity
canonical resource exact /mcp accepted; trailing slash/default-port/query/fragment variants rejected
RFC8414 pathless issuer -> /.well-known/oauth-authorization-server
RFC8414 pathful issuer -> /.well-known/oauth-authorization-server/<issuer-path>
metadata wrong issuer -> reject
metadata endpoint other origin -> reject
metadata malformed JSON/object/field -> reject
verification_uri evil origin/alternate same-origin route/query/fragment -> reject
verification_uri_complete evil origin/alternate route/duplicate or unknown query/mismatched user_code/fragment -> reject
hanging JWKS or introspection -> abort at composed verifier + remaining-operation deadline; no token use/save
HTTP timeout -> bounded safe error
non-aborting caller signal + hanging health response -> independent health timeout still aborts
caller cancellation earlier than health timeout -> caller abort wins
access_denied / expired_token -> terminal
slow_down -> bounded interval increase
transport 5xx/error -> bounded retry until total deadline
initial offline_access response without refresh token -> reject
refresh response without new refresh token -> retain previous when provider permits
refresh response without scope -> retain previous scope
unsupported token_type -> reject
v2 matching issuer/resource + persisted token verified exact issuer/single aud -> use
persisted V2 token wrong issuer/missing aud/wrong aud/extra aud -> reject before first protected request
v2 wrong issuer/resource -> reauthorize before refresh
unversioned vault -> clear + reauthorize
vault expiresAt unknown/string/NaN -> reject
same-process clear during refresh -> result never saved
TWO OS processes refresh -> one serialized generation chain
stale process cannot overwrite or clear newer generation
crash after rotation before save -> next startup follows documented reauth path
resource server unconfigured -> local health only; public MCP/metadata fail closed
resource/proof ack exact operation+revision+canonical document/tombstone digest+resource+bootstrap+monotonic serverGeneration; stale/same-revision-different-digest/ABA reject
POSIX temp/write/file-fsync/rename/parent-fsync and Windows flush/replace/generation-manifest crash boundaries recover only the last complete generation
resource runtime config ack + exact public metadata required before /challenge
bootstrap proof ack + exact public proof required before /prove
terminal non-owned receipt cleanup complete -> proof/key/receipt cleared then one new bootstrap
terminal receipt cleanup incomplete/provisioning ambiguous -> repair, no new bootstrap
all Tailscale/zrok status/doctor calls use central issuer health
MCP_SERVER_URL cannot become issuer/resource identity
control-plane-client has no module-load env capture
```

Illustrative exact-binding assertion:

```js
assert.equal(isSessionBoundTo(session, identity), true);
assert.equal(isSessionBoundTo({ ...session, issuer: "https://wrong.example" }, identity), false);
assert.equal(isSessionBoundTo({ ...session, resource: "https://other.example/mcp" }, identity), false);
```

The multi-process tests must launch separate OS processes against the native credential backend/lock implementation; two async calls in one JavaScript process are not sufficient evidence.

---

# B. Control-plane/auth snippets


Additional mandatory cases:

```text
valid V2 restart -> bootstrap call count 0
pairing failure after provisioning -> receipt reused/reconciled
user_code always displayed with verification_uri_complete
metadata required grants/token-auth/scopes missing -> reject
5xx/429/transport retry stays within total deadline
caller abort cancels sleep/request/poll
effective scope missing device:sync or expanded -> reject
RemoteChannel uses injected five-method client; no free-function imports
all supervisor/provider status/doctor paths use central issuer configuration
```

## B1 — `apps/control-plane/lib/oauth-scopes.ts` — route-aware proposed file

Status: P7A-BLOCKED until P0 approves the shared-resource route model

```ts
export const DEVICE_SCOPES = ["device:sync", "offline_access"] as const;
export const MCP_SCOPES = ["mcp:tools"] as const;

// P7A proposed V1: one exact per-device resource, route-specific scopes.
export const DEVICE_RESOURCE_SUPPORTED_SCOPES = [
  "mcp:tools",
  "device:sync",
] as const;

export const OAUTH_PROVIDER_SCOPES = [
  "offline_access",
  "mcp:tools",
  "device:sync",
] as const;

export function requireMcpScope(scopes: readonly string[]): void {
  if (!scopes.includes("mcp:tools")) throw new Error("insufficient_scope");
}

export function requireDeviceSyncScope(scopes: readonly string[]): void {
  if (!scopes.includes("device:sync")) throw new Error("insufficient_scope");
}
```

If P0 selects separate MCP and device-sync audiences, replace this file with two resource contracts and issue separate tokens. Do not advertise one model while enforcing another.

## B2 — `apps/control-plane/lib/env.ts` — consistent targeted identity additions

Status: READY-AFTER-GATE / preserve all current existing env consumers; release-artifact module is illustrative until P0/P8B freeze it

P0 supplies release-approved exact **production** identity values. The same package-local OAuth trusted-URL helper used by bootstrap/CIMD parses issuer/JWKS URLs. RP ID is exact release data—not suffix logic—and JWKS is exact release data on the approved issuer origin. WebAuthn-only `http://localhost` development, if used, belongs to a separate P2 test fixture and never loosens the OAuth URL helper shown here.

```ts
import { releaseIdentityV1 } from "./release-identity-v1.js"; // immutable P8B artifact config
import { parseTrustedHttpUrl } from "./trusted-http-url.js";

function requiredRaw(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  if (value !== value.trim() || /\s/.test(value)) throw new Error(`${name} must not contain whitespace`);
  return value;
}

function exactCanonicalUrl(
  name: string,
  raw: string,
  options: { originOnly?: boolean; sameOriginAs?: string } = {},
): string {
  const url = parseTrustedHttpUrl(raw, name, {
    urlClass: "publicOAuth",
    profile: "production",
    requireOrigin: options.sameOriginAs === undefined ? undefined : new URL(options.sameOriginAs).origin,
  });
  if (options.originOnly && url.pathname !== "/") throw new Error(`${name} must be an origin`);
  const canonical = options.originOnly
    ? url.origin
    : url.pathname === "/" ? url.origin : `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  if (raw !== canonical) throw new Error(`${name} is noncanonical; expected ${canonical}`);
  return raw;
}

const passkeyOrigin = exactCanonicalUrl("PASSKEY_ORIGIN", requiredRaw("PASSKEY_ORIGIN"), { originOnly: true });
const authorizationServerIssuer = exactCanonicalUrl(
  "AUTHORIZATION_SERVER_ISSUER", requiredRaw("AUTHORIZATION_SERVER_ISSUER"),
);
const authorizationServerJwksUrl = exactCanonicalUrl(
  "AUTHORIZATION_SERVER_JWKS_URL",
  requiredRaw("AUTHORIZATION_SERVER_JWKS_URL"),
  { sameOriginAs: authorizationServerIssuer },
);
const passkeyRpId = requiredRaw("PASSKEY_RP_ID");

if (passkeyRpId !== releaseIdentityV1.passkeyRpId) throw new Error("PASSKEY_RP_ID differs from release-approved identity");
if (passkeyOrigin !== releaseIdentityV1.passkeyOrigin) throw new Error("PASSKEY_ORIGIN differs from release-approved identity");
if (new URL(passkeyOrigin).hostname !== passkeyRpId) throw new Error("PASSKEY_ORIGIN host must equal the approved RP ID");
if (authorizationServerIssuer !== releaseIdentityV1.authorizationServerIssuer) throw new Error("issuer differs from release-approved identity");
if (authorizationServerJwksUrl !== releaseIdentityV1.authorizationServerJwksUrl) throw new Error("JWKS URL differs from release-approved identity");

export const passkeyIdentityEnv = Object.freeze({
  passkeyOrigin,
  passkeyRpId,
  authorizationServerIssuer,
  authorizationServerJwksUrl,
});
```

B5 imports `passkeyIdentityEnv` explicitly. The existing `env` object keeps all Jazz/database/development fields until their consumers are migrated; this snippet is not a replacement for unrelated configuration.

The per-device resource artifact must **not** import passkey/RP/account configuration or process-start `REMOTE_MCP_RESOURCE` merely to verify MCP tokens. It consumes the exact **acknowledged P7A.5A runtime snapshot** applied by the already-running local server:

```ts
// apps/control-plane/lib/mcp-resource-runtime.ts (or final per-device artifact equivalent)
import { releaseAuthorizationServerV1 } from "./release-authorization-server-v1.js";
import { getAppliedResourceRuntimeV1 } from "./resource-runtime-store.js";

export function loadMcpResourceRuntime() {
  const applied = getAppliedResourceRuntimeV1();
  if (!applied) throw new ResourceRuntimeUnavailableError("resource_unconfigured");
  if (applied.authorizationServerIssuer !== releaseAuthorizationServerV1.issuer ||
      applied.authorizationServerJwksUrl !== releaseAuthorizationServerV1.jwksUrl) {
    throw new ResourceRuntimeUnavailableError("authorization verifier identity mismatch");
  }
  return Object.freeze({
    runtimeRevision: applied.revision,
    publicMcpResource: applied.publicMcpResource,
    authorizationServerIssuer: applied.authorizationServerIssuer,
    authorizationServerJwksUrl: applied.authorizationServerJwksUrl,
  });
}
```

`getAppliedResourceRuntimeV1()` returns only a schema-validated, owner/ACL-validated, monotonically acknowledged in-memory snapshot loaded from the atomic P7A.5A state boundary. Before configuration, `/mcp`, RFC 9728 metadata, and device protected routes fail closed/503 while the separate private local health endpoint may remain ready for tunnel creation. Environment mutation in the CLI cannot change this snapshot.

`releaseAuthorizationServerV1` contains only public verifier identity (exact issuer/JWKS URL and contract version), not RP/passkey routes, private signing keys, account configuration, or migration authority. It is runtime parsed and release-digest checked. P8B's packaging-negative test proves the resource artifact stays isolated.

## B3 — `apps/control-plane/lib/auth-callback.ts` — route-specific canonical parser

Status: READY-AFTER-GATE

```ts
const DEFAULT_CALLBACK = "/dashboard/devices";
const OPAQUE_REF = /^[A-Za-z0-9_-]{22,128}$/;
const QUERYLESS_CALLBACKS = new Set(["/dashboard", "/dashboard/passkeys", "/dashboard/devices"]);

function hasRecursiveOrAmbiguousEncoding(value: string): boolean {
  // Allowed callback routes and opaque references require no percent encoding.
  // Rejecting every '%' also rejects double/recursive encodings before URL normalization.
  if (value.includes("%")) return true;
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    let decoded: string;
    try { decoded = decodeURIComponent(current); }
    catch { return true; }
    if (decoded === current) return false;
    if (/[\\/\u0000-\u001f\u007f#?]/.test(decoded) || decoded.includes("..")) return true;
    current = decoded;
  }
  return current !== value;
}

export function safeAuthCallback(value: string | null | undefined): string {
  if (!value || value !== value.trim() || /\s/.test(value)) return DEFAULT_CALLBACK;
  if (!value.startsWith("/") || value.startsWith("//")) return DEFAULT_CALLBACK;
  if (/[\\\u0000-\u001f\u007f#]/.test(value) || hasRecursiveOrAmbiguousEncoding(value)) return DEFAULT_CALLBACK;

  const queryIndex = value.indexOf("?");
  const rawPath = queryIndex === -1 ? value : value.slice(0, queryIndex);
  const segments = rawPath.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return DEFAULT_CALLBACK;

  let parsed: URL;
  try { parsed = new URL(value, "https://callback.invalid"); }
  catch { return DEFAULT_CALLBACK; }
  if (parsed.origin !== "https://callback.invalid" || parsed.pathname !== rawPath) return DEFAULT_CALLBACK;

  const entries = [...parsed.searchParams.entries()];
  if (parsed.pathname === "/device/approve" || parsed.pathname === "/consent") {
    if (entries.length !== 1 || entries[0][0] !== "request" || !OPAQUE_REF.test(entries[0][1])) {
      return DEFAULT_CALLBACK;
    }
    return `${parsed.pathname}?request=${entries[0][1]}`;
  }
  if (QUERYLESS_CALLBACKS.has(parsed.pathname) && entries.length === 0) return parsed.pathname;
  return DEFAULT_CALLBACK;
}
```

Nested callback/return parameters, duplicate `request`, arbitrary extra query keys, normalized dot segments, recursive encodings, and fragments are rejected rather than preserved.

## B4 — `apps/control-plane/lib/auth-client.ts` — runtime-parsed capability response

Status: P1-BLOCKED exact plugin APIs

```ts
"use client";
import { createAuthClient } from "better-auth/react";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { deviceAuthorizationClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import { readBoundedJsonObject } from "./browser-http.js";

export const authClient = createAuthClient({
  baseURL: typeof window === "undefined" ? undefined : window.location.origin,
  plugins: [passkeyClient(), oauthProviderClient(), deviceAuthorizationClient()],
});

function parseJazzCapability(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid capability response");
  const v = value as Record<string, unknown>;
  if (v.ok !== true || typeof v.token !== "string" || v.token.length < 16 || v.token.length > 16_384) {
    throw new Error(typeof v.error === "string" && v.error.length <= 200 ? v.error : "Unable to mint dashboard Jazz capability");
  }
  return v.token;
}

export async function getDashboardJazzToken(): Promise<string> {
  const response = await fetch("/api/jazz/dashboard-token", {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Unable to mint dashboard Jazz capability (HTTP ${response.status})`);
  const body = await readBoundedJsonObject(response, { maxBytes: 32 * 1024 });
  return parseJazzCapability(body);
}
```

`browser-http.ts` is an application-owned browser-safe bounded reader (32 KiB here), not the Node/tunnel helper. It enforces media type/UTF-8/body limit and caller timeout without importing server-only modules. The server side separately enforces session, Origin/CSRF policy, and emits only bounded safe error codes; the browser never logs the capability or raw response body.

## B5 — central auth plugin/client-class policy skeleton (P1 version-unverified)

Status: P1/P7A-BLOCKED / VERSION-UNVERIFIED

Do **not** expose one generic unauthenticated DCR path that can mint resource-control bootstrap privileges. The provider composition keeps generic resource administration fail-closed, while application-owned registration paths enforce the P7A class matrix before creating provider records.

```ts
import { passkeyIdentityEnv as identity } from "./env";
import { OAUTH_PROVIDER_SCOPES } from "./oauth-scopes";

export function buildAuthPlugins() {
  return pluginTuple(
    bearer(),
    jwt({
      jwks: { keyPairConfig: { alg: "ES256" } },
      jwt: {
        issuer: identity.authorizationServerIssuer,
        expirationTime: "5m",
        getSubject: ({ user }) => user.id,
      },
    }),
    passkey({
      rpID: identity.passkeyRpId,
      rpName: "Desktop Commander",
      origin: identity.passkeyOrigin,
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      registration: {
        requireSession: false,
        resolveUser: async ({ context }) => resolvePendingPasskeyUser(context),
        afterVerification: async (args) => persistVerifiedAccountIdentity(args),
      },
    }),
    oauthProvider({
      loginPage: "/sign-in",
      consentPage: "/consent",
      scopes: [...OAUTH_PROVIDER_SCOPES],
      enforcePerClientResources: true,
      resourcePrivileges: async () => false,
      // Generic unauthenticated DCR is disabled in this composition.
      // App-owned P7A routes create restricted provider client records after class-policy validation.
      allowDynamicClientRegistration: false,
      allowUnauthenticatedClientRegistration: false,
      extensions: [jazzClaimsExtension],
    }),
    oauthDeviceAuthorization({ expiresIn: "10min", interval: "5s" }),
    nextCookies(),
  );
}
```

Application-owned client onboarding routes:

```text
/api/bootstrap/v1/**           -> resource-control-bootstrap-v1 only after key + exact-resource proof; no binary-identity privilege
/api/oauth/dcr/v1              -> RFC7591 third party, authorization-code + PKCE S256, mcp:tools only
/api/oauth/cimd/v1             -> SSRF-safe CIMD fetch, authorization-code + PKCE S256, mcp:tools only
internal service registration  -> authenticated service principal/RBAC
```

Those routes call supported provider server APIs/adapter methods verified in P1; they cannot set a stronger client class than their route. `resource-control-bootstrap-v1` describes only the enforceable key/resource-control protocol and never attests native/vendor software identity. Third-party/CIMD input requesting `device:sync`, device-code grant, bootstrap privilege, or resource-admin authority is rejected before provider persistence.

**DO NOT APPLY passkey calls until P1 GO.** The examined 1.7.1/1.7.3 UV and email-schema blockers remain hard gates.

## B6 — registration intent domain object matching canonical P3/P8A state

Status: P1/P8A-BLOCKED storage; READY-AFTER-GATE semantics

B6 uses the same complete pending-device snapshot and retry/repair states as P3; it does not reduce the binding to only an authorization ID.

```ts
export type AuthCallbackBinding =
  | { kind: "device"; route: "/device/approve"; query: { request: string } }
  | { kind: "consent"; route: "/consent"; query: { request: string } }
  | { kind: "dashboard"; route: "/dashboard" | "/dashboard/passkeys" | "/dashboard/devices"; query: {} };

export type RegistrationIntentState =
  | "pending"
  | "verified_pending_commit"
  | "retry_new_challenge"
  | "repair_required"
  | "completed"
  | "expired"
  | "revoked";

export type PasskeyRegistrationIntent = Readonly<{
  id: string;
  ceremony: "registration";
  accountId: string;
  webauthnUserHandle: string;
  displayLabel: string | null;
  callback: AuthCallbackBinding;
  challenge: Readonly<{
    recordId: string;
    valueHash: string;
    issuedAt: Date;
    expiresAt: Date;
    consumedAt: Date | null;
  }>;
  expectedRpId: string;
  expectedOrigin: string;
  browserBindingHash: string;
  pendingDevice: null | Readonly<{
    authorizationId: string;
    bootstrapId: string;
    clientId: string;
    resource: string;
    requestedScopesHash: string;
  }>;
  state: RegistrationIntentState;
  version: number;
  createdAt: Date;
  expiresAt: Date;
  verifiedAt: Date | null;
  consumedAt: Date | null;
}>;
```

Completion reloads the server-authoritative P7A/P8A pending authorization and compares authorization ID, bootstrap ID, client ID, exact resource, and requested-scope hash before any account/session commit. Browser callback/query data cannot replace those fields.

The browser binding is a real possession secret, not an IP/User-Agent fingerprint:

```ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BROWSER_BINDING_COOKIE = "__Host-dc-registration-binding";
const BROWSER_BINDING_BYTES = 32;

type BrowserBindingRecordV1 = Readonly<{
  version: 1;
  intentId: string;
  challengeRecordId: string;
  bindingMac: string;
  issuedAt: Date;
  expiresAt: Date;
}>;

function browserBindingMac(
  serverBindingKey: Uint8Array,
  intentId: string,
  challengeRecordId: string,
  nonce: Uint8Array,
): Buffer {
  return createHmac("sha256", serverBindingKey)
    .update(`DC-PASSKEY-REGISTRATION-BINDING-V1\n${intentId}\n${challengeRecordId}\n${Buffer.from(nonce).toString("base64url")}\n`, "utf8")
    .digest();
}

export function issueBrowserBindingV1(input: {
  serverBindingKey: Uint8Array;
  intentId: string;
  challengeRecordId: string;
  issuedAt: Date;
  expiresAt: Date;
}) {
  const nonce = randomBytes(BROWSER_BINDING_BYTES);
  const mac = browserBindingMac(input.serverBindingKey, input.intentId, input.challengeRecordId, nonce);
  return {
    record: {
      version: 1 as const,
      intentId: input.intentId,
      challengeRecordId: input.challengeRecordId,
      bindingMac: mac.toString("base64url"),
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    },
    cookie: {
      name: BROWSER_BINDING_COOKIE,
      value: nonce.toString("base64url"),
      options: { secure: true, httpOnly: true, sameSite: "lax" as const, path: "/" },
    },
  };
}

export function verifyBrowserBindingV1(
  record: BrowserBindingRecordV1,
  cookieValue: string | undefined,
  serverBindingKey: Uint8Array,
  now: Date,
): void {
  if (!cookieValue || !/^[A-Za-z0-9_-]{43}$/.test(cookieValue)) throw new Error("browser_binding_missing");
  const nonce = Buffer.from(cookieValue, "base64url");
  if (nonce.length !== BROWSER_BINDING_BYTES || nonce.toString("base64url") !== cookieValue) throw new Error("browser_binding_malformed");
  if (record.expiresAt.getTime() <= now.getTime()) throw new Error("browser_binding_expired");
  const expected = browserBindingMac(serverBindingKey, record.intentId, record.challengeRecordId, nonce);
  const actual = Buffer.from(record.bindingMac, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("browser_binding_mismatch");
}
```

Production emits exactly `Secure; HttpOnly; SameSite=Lax; Path=/` with the `__Host-` name and no `Domain`. An explicit HTTP-loopback test profile uses a separately named host-only cookie and can never select production. Verification runs before challenge/intent consumption. Terminal completion/expiry/revocation/repair clears the cookie; Model-B retry keeps the same nonce but stores a new MAC bound to the replacement challenge record. Missing, malformed, cross-browser, swapped-challenge, expired, and replay-after-terminal cases create no account/session.

B6 follows P3's two-model contract. **Model A is preferred:** challenge CAS, intent predicate, account/credential/counter/session writes, and `pending -> completed` occur in one physical transaction, so `verified_pending_commit` is never durably observed. **Model B is conditional** on P1 boundary proof plus the P8A saga/repair ledger; only then may a separately consumed challenge move the intent to `verified_pending_commit`. A side-effect-free failure may CAS to `retry_new_challenge`, replace only the challenge slot with a brand-new durable challenge, increment the version, and return to `pending`. Any ambiguous/external side effect moves to terminal `repair_required`. Completed intent possession never restores or recreates a session.

## B7 — opaque account/user-handle generation

Status: READY-AFTER-GATE

```ts
import { randomBytes, randomUUID } from "node:crypto";

export function newPasskeyAccountIdentity() {
  return {
    accountId: randomUUID(),
    webauthnUserHandle: randomBytes(32).toString("base64url"),
    // Independent presentation value; not derived from OAuth sub/user handle/credential id.
    displayLabel: `Desktop Commander ${randomBytes(4).toString("hex")}`,
  };
}
```

The label is optional presentation metadata and may be omitted entirely. Do not derive it from the OAuth subject prefix, email, hostname, stable device ID, client ID, IP, or credential ID.

## B8 — sign-in page core action

Status: P1-BLOCKED exact client API

```tsx
async function signInWithPasskey() {
  setBusy(true);
  setError(null);
  try {
    const callbackURL = safeAuthCallback(params.get("callbackURL"));
    const result = await authClient.signIn.passkey();
    if (result.error) {
      setError(normalizeWebAuthnError(result.error));
      return;
    }
    router.push(callbackURL);
    router.refresh();
  } catch (error) {
    setError(normalizeWebAuthnError(error));
  } finally {
    setBusy(false);
  }
}
```

Visible UI must always retain a passkey button even if conditional mediation/autofill is also enabled.

## B9 — create-account action with opaque context

Status: P1/P8-BLOCKED exact orchestration

```tsx
async function createAccountWithPasskey() {
  setBusy(true);
  setError(null);
  try {
    const callbackURL = safeAuthCallback(params.get("callbackURL"));
    const intent = await createRegistrationIntent(callbackURL);
    const result = await authClient.passkey.addPasskey({
      context: intent.id,
      createSession: true,
    });
    if (result.error) {
      setError(normalizeWebAuthnError(result.error));
      return;
    }
    // Navigation uses the same canonical callback captured before intent creation.
    // It is convenience only: the destination resolves/revalidates its opaque
    // approval/consent reference against authenticated durable server state.
    router.push(callbackURL);
    router.refresh();
  } catch (error) {
    setError(normalizeWebAuthnError(error));
  } finally {
    setBusy(false);
  }
}
```

The browser-provided `context` is only a lookup key. Server state owns account identity and callback binding. The browser's canonical `callbackURL` is navigation only and cannot authorize the pending request; `/device/approve` or `/consent` resolves the opaque reference and reloads the durable binding after sign-in.

## B10 — strict device-code validation and opaque auto-advance

Status: VERSION-UNVERIFIED client API; READY-AFTER-GATE behavior

The selected provider contract supplies one exact alphabet, length, and optional display separator. This helper rejects rather than strips/truncates unexpected input.

```tsx
import { useCallback, useEffect, useRef } from "react";

const DEVICE_CODE_LENGTH = providerDeviceCodePolicy.length;
const DEVICE_CODE_RE = providerDeviceCodePolicy.canonicalPattern; // anchored ASCII RegExp, verified in P1
const DISPLAY_SEPARATOR = providerDeviceCodePolicy.displaySeparator; // e.g. "-" or null

function canonicalDeviceCode(raw: string): string | null {
  if (raw !== raw.trim()) return null;
  if (/[^\x20-\x7E]/.test(raw)) return null;
  let candidate = raw;
  if (DISPLAY_SEPARATOR !== null && candidate.includes(DISPLAY_SEPARATOR)) {
    const expectedDisplay = providerDeviceCodePolicy.displayPattern; // anchored, non-global RegExp verified in P1
    if (!expectedDisplay.test(candidate)) return null;
    candidate = candidate.split(DISPLAY_SEPARATOR).join("");
  }
  // No case folding, arbitrary character stripping, Unicode normalization, or truncation.
  if (candidate.length !== DEVICE_CODE_LENGTH || !DEVICE_CODE_RE.test(candidate)) return null;
  return candidate;
}

const initial = params.get("user_code");
const canonicalInitialCode = initial === null ? null : canonicalDeviceCode(initial);
const autoAdvanced = useRef(false);

const checkCode = useCallback(async (code: string) => {
  setBusy(true); setError(null);
  try {
    const response = await authClient.device({ query: { user_code: code } });
    const approvalRef = response.data?.approval_ref;
    if (response.error || typeof approvalRef !== "string" || !/^[A-Za-z0-9_-]{22,128}$/.test(approvalRef)) {
      setError("That device request is unavailable or expired."); return;
    }
    router.replace(`/device/approve?request=${encodeURIComponent(approvalRef)}`);
  } catch { setError("The device request could not be checked. Try again."); }
  finally { setBusy(false); }
}, [router]);

useEffect(() => {
  if (initial === null || autoAdvanced.current) return;
  autoAdvanced.current = true;
  if (!canonicalInitialCode) { setError("That device request is unavailable or expired."); return; }
  void checkCode(canonicalInitialCode);
}, [initial, canonicalInitialCode, checkCode]);
```

The server applies durable attempt limits and immediately replaces a successful raw-code lookup with the opaque pending request reference. Full code never goes to analytics/logs.

## B11 — approval/consent identity and device presentation copy

Status: READY-AFTER-GATE

Account copy must not depend on a nonexistent email identity:

```tsx
<p>Signed in to your Desktop Commander account.</p>
```

Device name/platform are **self-asserted presentation metadata**, even when integrity-bound to the pending request. Use wording such as:

```tsx
<p>
  A computer identifying itself as <strong>{safeDeviceName}</strong> requests access.
</p>
<p>{safePlatformLabel}</p>
<p>Confirmation code: <strong>{safePossessionConfirmation}</strong></p>
```

Before rendering, server-side normalization must length-limit fields, escape as text, reject control characters and bidirectional-confusing characters, and supply a generic fallback. Keep the normalized user code or equivalent possession confirmation in the primary approval summary. Put client ID, exact resource, and requested scopes under advanced details, but load them from trusted pending state rather than browser input.

Consent likewise uses a P1-approved pseudonymous label only if useful and never reintroduces an `email` claim unless P0/P1 deliberately change the product contract.

## B12 — protected-resource metadata on each device MCP origin

Status: P7A-BLOCKED route model; READY-AFTER-GATE shape

For the proposed P7A V1 **shared resource / route-specific scope** model, the resource advertises every scope supported by that logical resource:

```ts
export function protectedResourceMetadata(
  resource: string,
  authorizationServerIssuer: string,
  head = false,
): Response {
  const metadata = {
    resource,
    authorization_servers: [authorizationServerIssuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp:tools", "device:sync"],
  };
  return new Response(head ? null : JSON.stringify(metadata), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
```

`/mcp` still requires only `mcp:tools`; `/api/device/**` requires `device:sync`. If P0 approves separate audiences instead, emit separate protected-resource metadata/contracts rather than using this shared-resource snippet.

## B13 — MCP resource-server route and required bearer challenge

Status: VERSION-UNVERIFIED handler API; READY-AFTER-GATE HTTP contract

```ts
import {
  loadMcpResourceRuntime,
  ResourceRuntimeUnavailableError,
} from "./mcp-resource-runtime.js";

function unavailable(): Response {
  return new Response("Resource not configured", {
    status: 503,
    headers: { "cache-control": "no-store" },
  });
}

function buildHandler(resourceRuntime: McpResourceRuntimeV1) {
  const metadataUrl = new URL(
    "/.well-known/oauth-protected-resource/mcp",
    `${new URL(resourceRuntime.publicMcpResource).origin}/`,
  ).toString();

  const protectedHandler = createMcpProtectedRequestHandler({
    issuer: resourceRuntime.authorizationServerIssuer,
    audience: resourceRuntime.publicMcpResource,
    jwksUrl: resourceRuntime.authorizationServerJwksUrl,
    requiredScopes: ["mcp:tools"],
  }, async (verifiedRequest, claims) => {
    if (typeof claims.sub !== "string" || claims.sub.length === 0) {
      return new Response("Unauthorized", { status: 401 });
    }
    return handleMcpForSubject(verifiedRequest, claims.sub);
  });

  return { protectedHandler, metadataUrl };
}

function withCanonicalBearerChallenge(response: Response, metadataUrl: string): Response {
  if (response.status !== 401) return response;
  const headers = new Headers(response.headers);
  if (headers.get("WWW-Authenticate") !== null) {
    throw new Error("MCP helper challenge must be verified/configured natively before fallback wrapping");
  }
  headers.set("WWW-Authenticate", `Bearer resource_metadata="${metadataUrl.replaceAll('"', '%22')}"`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function POST(request: Request): Promise<Response> {
  // IMPORTANT: runtime is resolved per request (or by an equivalent revision-keyed
  // atomic cache updated by the watcher). Never load it at module scope. This keeps
  // the HTTP artifact bootable in resource_unconfigured mode and prevents stale
  // issuer/resource snapshots after a later acknowledged revision.
  let runtime: McpResourceRuntimeV1;
  try {
    runtime = loadMcpResourceRuntime();
  } catch (error) {
    if (error instanceof ResourceRuntimeUnavailableError) return unavailable();
    throw error;
  }
  const { protectedHandler, metadataUrl } = buildHandler(runtime);
  return withCanonicalBearerChallenge(await protectedHandler(request), metadataUrl);
}
```

The RFC9728 metadata route follows the same per-request/revision-keyed snapshot rule and returns fail-closed `503` while `resource_unconfigured`; importing either route must never require a configured resource. Preferred implementation configures the selected MCP helper to emit the canonical challenge itself. The fallback above is legal only when the verified helper emits **no** challenge; it deliberately refuses to overwrite or concatenate an unknown existing `WWW-Authenticate` value. P10 owns HTTP-level conformance tests for missing/malformed/expired/wrong-issuer/wrong-audience tokens, duplicate-challenge absence, and exact `resource_metadata` quoting. A thrown integration guard is a development/configuration failure, not an intended production 500 path.

## B14 — exact bootstrap signatures, proof-gated provisioning, and approval-reference mutation

Status: P7A/P8A-BLOCKED exact provider/DB APIs; security input boundary fixed

The desktop never submits a caller-authored proof URL/body. The central `/challenge` route creates only the P7A challenge/reservation. `/prove` verifies the stored device key signature, derives and fetches the proof endpoint itself with the P7A SSRF-safe connector, and only then returns a one-use capability. `/provision` verifies the independent provision-domain signature and consumes that capability only after its successful durable provisioning commit.

```ts
export type BootstrapProveRequestV1 = Readonly<{
  version: 1;
  bootstrapId: string;
  idempotencyKey: string;      // 128+ CSPRNG bits; exact request header/body binding
  deviceKeySignature: string;  // Ed25519 over DC-REMOTE-BOOTSTRAP-PROVE-V1 bytes
}>;

export async function proveBootstrapAndIssueCapability(
  input: BootstrapProveRequestV1,
): Promise<{
  version: 1;
  bootstrapId: string;
  bootstrapCapability: string;
  resource: string;
  deviceKeyFingerprint: string;
  expiresIn: number;
}> {
  const record = await loadActiveBootstrapChallenge(input.bootstrapId);
  await verifyBootstrapProveSignature({
    record,
    idempotencyKey: input.idempotencyKey,
    signature: input.deviceKeySignature,
  });
  const proofEvent = await fetchAndVerifyBootstrapResourceProofSsrfSafe(record); // ephemeral; URL/body derived by server
  return commitProofAndCapabilityAtomically({
    bootstrapId: record.bootstrapId,
    expectedState: "challenge_issued",
    expectedRevision: record.revision,
    idempotencyKey: input.idempotencyKey,
    proofEvent,
    // Transaction rechecks challenge expiry, reservation, key/resource/digest binding,
    // seals the idempotent response, and CASes directly to capability_issued.
    // There is no durable proof-only lifecycle state.
  });
}

export type BootstrapProvisionRequestV1 = Readonly<{
  version: 1;
  bootstrapId: string;
  bootstrapCapability: string;
  idempotencyKey: string;
  deviceKeySignature: string; // Ed25519 over DC-REMOTE-BOOTSTRAP-PROVISION-V1 bytes
}>;

export async function provisionFirstPartyDeviceBootstrap(
  input: BootstrapProvisionRequestV1,
): Promise<ProvisioningReceiptV1> {
  const bootstrap = await verifyProvisionCapabilityAndSignature({
    bootstrapId: input.bootstrapId,
    capability: input.bootstrapCapability,
    idempotencyKey: input.idempotencyKey,
    signature: input.deviceKeySignature,
  });
  // Exact implementation is SINGLE_STORE_TRANSACTION or DURABLE_SAGA from the
  // canonical P8A ledger. Capability consumption occurs only with successful commit.
  return advanceProvisioningStateIdempotently(bootstrap, input.idempotencyKey);
}

export type RecoverProvisionRequestV1 = Readonly<{
  version: 1;
  bootstrapId: string;
  idempotencyKey: string;
  canonicalProvisionRequestDigest: string;
  deviceKeySignature: string; // signature over DC-REMOTE-BOOTSTRAP-RECOVER-V1 bytes
}>;

export async function recoverCommittedProvisioning(
  input: RecoverProvisionRequestV1,
): Promise<ProvisionRecoveryResultV1> {
  const original = await loadProvisioningIdempotencyRecord(input.bootstrapId, input.idempotencyKey);
  await verifyRecoverySignatureAndExactRequestDigest(original, input);
  // Recovery only reads/replays the original operation result. It cannot create a
  // new client, resource, receipt, capability, or idempotency record.
  return projectOriginalProvisioningResultOrRepairState(original);
}

export type ApprovalBody = Readonly<{
  approvalReference: string; // browser-visible high-entropy reference, NOT provider pending ID
  decisionNonce: string;
  csrfToken: string;
  decision: "approve" | "deny";
}>;

export async function decideProvisionedDevice(
  httpRequest: Request,
  authenticatedSession: AuthenticatedSession,
  body: ApprovalBody,
): Promise<void> {
  if (httpRequest.method !== "POST") throw new Error("method_not_allowed");
  await requireValidCsrfOriginHostAndFetchSite({
    request: httpRequest,
    csrfToken: body.csrfToken,
    sessionId: authenticatedSession.id,
  });

  // Browser supplies only approvalReference. Server resolves it to the provider's
  // pendingDeviceAuthorizationId and reloads all authoritative P7A/P8A state.
  const mapping = await resolveActiveApprovalReference(body.approvalReference, authenticatedSession.id);
  await withPendingAuthorizationLock(mapping.pendingDeviceAuthorizationId, async (pending) => {
    await requireApprovalReferenceStillBound(mapping, pending);
    await consumeDecisionNonce(pending.id, body.decisionNonce, authenticatedSession.id);
    await requirePendingClientClassResourceAndScopesActive(pending);
    if (body.decision === "deny") {
      await denyAndCleanupPendingProvisioning(pending);
      return;
    }
    await finalizeApprovedOwnershipSaga({
      authenticatedSubject: authenticatedSession.user.id,
      pending,
    });
  });
}
```

The exact prove/provision/recover signing bytes, challenge/capability entropy, TTL, response-sealing/idempotency, recovery-journal fields, receipt authentication, reservation lifecycle, and post-session cleanup states are normative in P7A.7–P7A.10; this snippet does not redefine them. The challenge route accepts only `client_class="resource-control-bootstrap-v1"`, which proves key/resource control but conveys no native binary identity or privilege by software claim. The server loads client ID, exact resource, scopes, bootstrap/receipt record, provider pending ID, and presentation from trusted state. Approval is POST-only and receives the real HTTP `Request`, so method, Origin, Host, `Sec-Fetch-Site`, session cookies, and CSRF binding are checked together.

## B15 — revocation-first account-deletion saga

Status: P6/P7A/P7B/P8A-BLOCKED physical APIs; durable ordering fixed

```ts
type AccountDeletionStateV1 =
  | "requested"
  | "authority_revocation_committed"
  | "remote_cleanup_pending"
  | "credential_erasure_pending"
  | "completed"
  | "repair_required";

type AccountDeletionOperationV1 = Readonly<{
  version: 1;
  operationId: string;
  accountId: string;
  initiatingSessionId: string;
  expectedAccountRevision: number;
  state: AccountDeletionStateV1;
  revocationWatermark: number | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export async function requestAccountDeletionV1(input: {
  operationId: string;
  authenticatedSession: AuthenticatedSession;
  freshAuth: FreshAuthV1;
  expectedAccountRevision: number;
  explicitConfirmation: true;
}): Promise<AccountDeletionOperationV1> {
  requireFreshAuthForExactCurrentSession({
    accountId: input.authenticatedSession.user.id,
    sessionId: input.authenticatedSession.id,
    freshAuth: input.freshAuth,
  });

  // This anchor transaction denies all new authority and writes the immutable outbox
  // event. Completion is not reported until the independent revocation stream durably
  // appends/acknowledges that event (or the journal is the ordered authority).
  const operation = await beginDeletionAndRevokeAuthorityTransaction({
    operationId: input.operationId,
    accountId: input.authenticatedSession.user.id,
    initiatingSessionId: input.authenticatedSession.id,
    expectedAccountRevision: input.expectedAccountRevision,
    revoke: ["browser_sessions", "oauth_grants", "refresh_families", "device_associations", "resource_clients"],
  });
  return await awaitIndependentRevocationAppendOrReturnPending(operation.operationId);
}

export async function resumeAccountDeletionV1(operationId: string): Promise<AccountDeletionOperationV1> {
  const operation = await loadDeletionOperationForUpdate(operationId);
  if (operation.state === "completed") return operation;
  await requireIndependentRevocationWatermarkAcknowledged(operation);
  await rollForwardRemoteAuthorityCleanupIdempotently(operation);
  await erasePasskeysAndDeletableAccountDataIdempotently(operation);
  return retainAntiResurrectionTombstoneAndComplete(operation);
}
```

The operation ID is the idempotency anchor. Same canonical request returns the same operation; conflicting reuse rejects. Crashes before/after anchor commit, outbox visibility, independent append/ack, each remote cleanup, credential erasure, tombstone commit, and final response are injected in tests. Once revocation starts, recovery only rolls forward—no compensation restores authority. `remote_cleanup_pending`, `credential_erasure_pending`, and `repair_required` are durable/operator-queryable; local Desktop Commander files are outside this server deletion unless separately requested.

---

# C. P9A/P10/P11 foundation, test, and rollout helpers

## C1 — Playwright/CDP virtual authenticator helper with nested cleanup

Status: ILLUSTRATIVE

```ts
import type { Page } from "@playwright/test";

export async function withVirtualAuthenticator<T>(
  page: Page,
  userVerified: boolean,
  run: (authenticatorId: string) => Promise<T>,
): Promise<T> {
  const cdp = await page.context().newCDPSession(page);
  let authenticatorId: string | null = null;
  try {
    await cdp.send("WebAuthn.enable");
    authenticatorId = (await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: userVerified, automaticPresenceSimulation: true },
    })).authenticatorId;
    return await run(authenticatorId);
  } finally {
    try {
      if (authenticatorId) await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    } finally {
      try { await cdp.send("WebAuthn.disable"); }
      finally { await cdp.detach(); }
    }
  }
}
```

UP=1/UV=0 tests must prove the verifier receives UV absent, not merely observe browser cancellation.

## C2 — P9A canonical state, immutable threshold/cohort publication, and operator mutation

Status: READY-AFTER-GATE

P9A implements this parser/type before P10. P10 and P11 import the same artifact corresponding to `docs/PASSKEY-P9A-DEPLOYMENT-STATE-CONTRACT.md`; no later task redefines V1:

```ts
import { createHmac } from "node:crypto";
import {
  parsePasskeyDeploymentStateV1,
  parsePasskeyDeploymentMutationV1,
  parsePasskeyThresholdSetV1,
  parsePasskeyCohortPolicyV1,
  assertLegalDeploymentTransition,
  canonicalJsonBytes, // RFC 8785 JCS UTF-8 with golden vectors
  sha256Base64url,
  type AuthenticatedOperatorPrincipalV1,
  type PasskeyDeploymentStateV1,
  type PasskeyThresholdSetV1,
  type PasskeyCohortPolicyV1,
} from "./passkey-deployment-state";

export function loadDeploymentState(raw: unknown, expectedRevision?: number): PasskeyDeploymentStateV1 {
  const state = parsePasskeyDeploymentStateV1(raw); // rejects unknown fields/types
  if (expectedRevision !== undefined && state.revision !== expectedRevision) throw new Error("deployment state revision conflict");
  return state; // includes exact thresholdsRevision + cohortPolicyRevision
}

type Published<T> = Readonly<{
  document: T;
  canonicalDigest: string;
  publishedAt: string;
  publishedBySubject: string;
}>;

async function publishImmutableArtifact<T extends { revision: number; environmentId: string; releaseId: string }>(input: {
  kind: "thresholds" | "cohort_policy";
  request: Request;
  rawBody: unknown;
  parse: (raw: unknown) => T;
  authenticatedContext: AuthenticatedIamContext;
}): Promise<Published<T>> {
  if (input.request.method !== "PUT") throw new HttpError(405, "method_not_allowed");
  if (input.request.headers.get("if-none-match") !== "*") throw new HttpError(428, "create_only_precondition_required");
  const idempotencyKey = requireCsprngIdempotencyKey(input.request.headers.get("idempotency-key"));
  const principal: AuthenticatedOperatorPrincipalV1 = deriveOperatorPrincipal(input.authenticatedContext);
  requireArtifactPublisherRole(principal, input.kind);
  const document = input.parse(input.rawBody); // body actor/approver and unknown fields reject
  requireCurrentEnvironmentAndRelease(document);
  requireRevisionAddressedArtifactPathMatchesBody(input.request.url, input.kind, document.environmentId, document.revision);
  const canonicalDigest = sha256Base64url(canonicalJsonBytes(document));

  return db.transaction(async (tx) => {
    const replay = await tx.publicationByIdempotencyKey(input.kind, idempotencyKey);
    if (replay) {
      if (replay.canonicalDigest !== canonicalDigest) throw new HttpError(409, "idempotency_mismatch");
      return replay.result as Published<T>;
    }
    if (await tx.artifactRevisionExists(input.kind, document.environmentId, document.revision)) {
      throw new HttpError(409, "immutable_revision_exists");
    }
    const result: Published<T> = {
      document,
      canonicalDigest,
      publishedAt: new Date().toISOString(),
      publishedBySubject: principal.subjectId,
    };
    await tx.insertImmutableArtifact(input.kind, result);
    await tx.insertAuditAndOutbox({ principal, idempotencyKey, kind: input.kind, canonicalDigest, revision: document.revision });
    return result;
  });
}

export const publishThresholdsV1 = (request: Request, body: unknown, auth: AuthenticatedIamContext) =>
  publishImmutableArtifact<PasskeyThresholdSetV1>({
    kind: "thresholds", request, rawBody: body, parse: parsePasskeyThresholdSetV1, authenticatedContext: auth,
  });

export const publishCohortPolicyV1 = (request: Request, body: unknown, auth: AuthenticatedIamContext) =>
  publishImmutableArtifact<PasskeyCohortPolicyV1>({
    kind: "cohort_policy", request, rawBody: body, parse: parsePasskeyCohortPolicyV1, authenticatedContext: auth,
  });

export function assignedToPercentageCohort(input: {
  policy: PasskeyCohortPolicyV1;
  opaqueAuthenticatedSubjectId: string;
  assignmentKey: Uint8Array;
}): boolean {
  const bytes = createHmac("sha256", input.assignmentKey)
    .update(`DC-PASSKEY-COHORT-V1\n${input.policy.environmentId}\n${input.opaqueAuthenticatedSubjectId}\n`, "utf8")
    .digest();
  const bucket = Number(bytes.readBigUInt64BE(0) % 10_000n);
  return bucket < input.policy.percentageBasisPoints;
}

export async function mutateDeploymentV1(input: {
  request: Request;
  rawBody: unknown;
  authenticatedContext: AuthenticatedIamContext;
}): Promise<PasskeyDeploymentStateV1> {
  const mutation = parsePasskeyDeploymentMutationV1(input.rawBody); // closed schema; no actor field
  requireExactIfMatch(input.request, `"passkey-deployment-state-v1:${mutation.expectedRevision}"`);
  const principal = deriveOperatorPrincipal(input.authenticatedContext);
  requireDeploymentOperatorRole(principal);
  const mutationDigest = sha256Base64url(canonicalJsonBytes(mutation));

  return db.transaction(async (tx) => {
    const replay = await tx.deploymentMutationById(mutation.mutationId);
    if (replay) {
      if (replay.mutationDigest !== mutationDigest) throw new HttpError(409, "mutation_id_conflict");
      return replay.result;
    }
    const current = await tx.lockDeploymentState();
    const thresholds = await tx.requireImmutableThresholds(mutation.thresholdsRevision);
    const cohort = await tx.requireImmutableCohortPolicy(mutation.cohortPolicyRevision);
    assertThresholdsGreenEvidenceUsesExactRevisionAndDigest(mutation.evidence, thresholds);
    await assertCohortPolicyAllowedByActiveFreeze(tx, current, cohort);
    assertLegalDeploymentTransition({ current, mutation, thresholds, cohort });
    return tx.commitDeploymentStateAuditAndOutbox({ current, mutation, mutationDigest, principal, thresholds, cohort });
  });
}
```

Both publication routes require authenticated server-derived principal, `If-None-Match: *`, canonical digest, immutable revision, idempotent replay, and one document/audit/outbox transaction. Revision overwrite and body-controlled actor/approver fields reject. Caches key threshold/cohort data by environment + revision + digest and fail closed rather than serving a stale revision.

The internal allowlist is an immutable referenced artifact with a verified digest. Percentage assignment uses only the authenticated opaque subject and the exact HMAC algorithm above; all instances share the KMS/HSM key selected by `assignmentKeyId`. The policy carries an explicit `eligibilityMode` (`internal_allowlist`, `percentage`, or `allowlist_or_percentage`). `freeze_cohort_expansion` blocks basis-point, non-subset-allowlist, broader-mode, assignment-key, or other eligibility expansion but permits strict contraction and emergency pause/approved rollback.

The closed transition registry requires `device_v2_reauthorization_path_ready` for `internal -> new_accounts_plus_migration`. Only the later P11 production inventory predicate `device_v2_reauthorization_complete` can satisfy the transition to `passkey_only`; the readiness predicate cannot substitute. P10 tests this artifact before P11 can operate it.

## C3 — P9A runtime-safe auth event allowlist

Status: P9A FOUNDATION / READY-AFTER-GATE

```ts
const STAGES = new Set(["options", "browser", "verify", "session"]);
const ERRORS = new Set(["cancelled","unsupported","expired","missing_uv","origin_mismatch","rp_mismatch","challenge_mismatch","persistence","rate_limited","unknown"]);

export function safeAuthEventProps(input: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) return out;
  const v = input as Record<string, unknown>;
  if (typeof v.stage === "string" && STAGES.has(v.stage)) out.stage = v.stage;
  if (typeof v.errorClass === "string" && ERRORS.has(v.errorClass)) out.error_class = v.errorClass;
  if (v.rolloutStateVersion === 1) out.rollout_state_version = 1;
  if (typeof v.rolloutSnapshot === "string" && ["disabled","internal","new_accounts_plus_migration","registration_paused_migration","passkey_only","registration_paused_passkey_only","legacy_removed","registration_paused_legacy_removed"].includes(v.rolloutSnapshot)) out.rollout_snapshot = v.rolloutSnapshot;
  return out; // fresh object; unknown/runtime-any properties are dropped
}
```

No callback URL, raw error, code, credential/token material, or arbitrary property bag survives. This sanitizer is implemented alongside the machine-readable never-log registry in P9A and tested against nested runtime `any` inputs in P10.

## C4 — P9A Desktop remote OAuth telemetry with strict runtime per-event reconstruction

Status: P9A FOUNDATION / READY-AFTER-GATE concept

```ts
import { captureRemote } from "../utils/capture.js";

const REMOTE_OAUTH_EVENTS = [
  "remote_oauth_pairing_started", "remote_oauth_pairing_completed",
  "remote_oauth_refresh_completed", "remote_oauth_reauthorization_required",
  "remote_oauth_credential_binding_mismatch", "remote_oauth_legacy_credential_detected",
  "remote_oauth_discovery_failed", "remote_oauth_resource_metadata_failed",
] as const;
type Event = (typeof REMOTE_OAUTH_EVENTS)[number];

function parseRemoteOAuthEvent(value: unknown): Event {
  if (typeof value !== "string" || !REMOTE_OAUTH_EVENTS.includes(value as Event)) {
    throw new Error("unsupported remote OAuth telemetry event");
  }
  return value as Event;
}

function record(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
}
function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
}

function safeRemoteProps(event: Event, input: unknown): Record<string, string | number> {
  const v = record(input);
  const out: Record<string, string | number> = {};
  switch (event) {
    case "remote_oauth_pairing_started":
    case "remote_oauth_pairing_completed": {
      const tunnel = enumValue(v.tunnel, ["tailscale", "zrok", "other"] as const);
      if (tunnel) out.tunnel = tunnel;
      break;
    }
    case "remote_oauth_refresh_completed":
      if (v.session_version === 2) out.session_version = 2;
      break;
    case "remote_oauth_reauthorization_required": {
      const reason = enumValue(v.reason, ["revoked", "issuer_mismatch", "resource_mismatch", "legacy"] as const);
      if (reason) out.reason = reason;
      break;
    }
    case "remote_oauth_credential_binding_mismatch": {
      const reason = enumValue(v.reason, ["issuer_mismatch", "resource_mismatch"] as const);
      if (reason) out.reason = reason;
      break;
    }
    case "remote_oauth_legacy_credential_detected":
      if (v.session_version === 0 || v.session_version === 1) out.session_version = v.session_version;
      break;
    case "remote_oauth_discovery_failed": {
      const reason = enumValue(v.reason, ["timeout", "http", "malformed", "issuer_mismatch", "endpoint_origin"] as const);
      if (reason) out.reason = reason;
      break;
    }
    case "remote_oauth_resource_metadata_failed": {
      const reason = enumValue(v.reason, ["timeout", "http", "malformed", "resource_mismatch", "issuer_mismatch"] as const);
      if (reason) out.reason = reason;
      break;
    }
  }
  return out;
}

export async function captureRemoteOAuth(eventInput: unknown, input: unknown = {}) {
  const event = parseRemoteOAuthEvent(eventInput); // runtime gate; TS union alone is insufficient
  return captureRemote(event, safeRemoteProps(event, input));
}
```

The **event name and its properties** both have runtime allowlists; JavaScript/`any` callers cannot inject arbitrary text into the event-name channel. Each accepted event reconstructs a fresh property object. For example, `legacy`/`revoked` are impossible on the credential-binding-mismatch event, and `resource_mismatch` is not accepted on discovery unless the dedicated resource-metadata event is used. Raw errors, sessions, URLs, codes, tokens, and unknown properties never pass through.

## C5 — proposed clean `passkey-auth-gate` Just/CI shape

Status: ILLUSTRATIVE / to be added on the future implementation branch, **not applied here**

Proposed Justfile target:

```make
passkey-auth-gate: check
  node test/passkey/run-passkey-auth-gate.js
```

The runner starts only disposable local/test dependencies, runs the P1/P10 deterministic suites, writes a non-secret JSON evidence summary, and tears down in `finally`/signal handlers.

Proposed workflow shape:

```yaml
name: passkey-auth-gate
on: [pull_request]
jobs:
  passkey-auth:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<PINNED_COMMIT_SHA>
      - uses: DeterminateSystems/nix-installer-action@<PINNED_COMMIT_SHA>
      - run: nix develop -c just bootstrap
      - run: nix develop -c just test
      - run: nix develop -c just remote-gate
      - run: nix develop -c just passkey-auth-gate
      - uses: actions/upload-artifact@<PINNED_COMMIT_SHA>
        if: always()
        with:
          name: passkey-auth-evidence
          path: .artifacts/passkey-auth-evidence.json
```

`<PINNED_COMMIT_SHA>` is intentionally a placeholder: mutable major/version tags do **not** satisfy P10. Before the workflow exists, freeze exact action commits according to repository supply-chain policy and record them in evidence. The future control-plane repository needs its own committed equivalent and explicit one-shot migration job; cold-start migrations are forbidden.

# D. Implementation order using these snippets

Formal implementation order follows the canonical DAG:

1. **P0 approval ADR** — production identity/recovery/scope decisions approved.
2. **P1 GO** — server-enforced UV and acceptable email-less account/session architecture proven. Disposable research may happen earlier but is not the formal gate.
3. **P7A + P8A foundations** — bootstrap/client/resource protocol and physical transaction/saga/locking primitives approved.
4. **P2** — auth/schema/config on exact P1/P8A versions.
5. **P3 + P4** — registration/sign-in terminal state and canonical callbacks.
6. **P7B / A1–A9** — only now implement device OAuth, receipt, pairing lease, RemoteChannel/client injection, tunnel-health migration.
7. **P5 + P6** — approval and credential/re-pair management.
8. **P8B** — package/deployment/restore/load validation.
9. **P9** — migration/revocation and complete legacy-authority disposition.
10. **P9A / C2–C4** — implement canonical deployment parser/transitions, immutable threshold/cohort publication + assignment/freeze, server-principal mutation, and telemetry/never-log foundation.
11. **P10 / C1 + C5** — run complete security/platform evidence, including `passkey-auth-gate`, against the P9A artifact.
12. **P11** — fill release thresholds/owners and perform staged cutover using only P10-green artifacts.

B12–B14 require P7A/P8A; B4/B5/B8/B9 remain P1-blocked until the selected package APIs compile. No A1–A9 implementation begins merely because the sketches exist.

# E. Explicit non-snippets

This document intentionally does **not** provide code for either of these unresolved shortcuts:

```text
patch @better-auth/passkey node_modules to force requireUserVerification=true
invent fake/random user email addresses to satisfy Better Auth core 1.7.x
```

Both would hide P1 blockers instead of solving them through a supported production architecture.

# F. Definition of snippet-pack completion

Before any future implementation PR claims these snippets as adopted:

- exact dependency versions are recorded;
- P1 GO exists;
- full source changes are reviewed against current HEAD, not blindly pasted;
- generated migrations are inspected;
- tests from P10 are added with negative cases;
- no existing command execution/claim safety behavior is removed;
- docs are updated if actual supported APIs differ from these proposals.
