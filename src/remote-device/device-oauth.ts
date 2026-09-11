import open from "open";
import { createPublicKey, createVerify, verify as verifySignature } from "node:crypto";
import {
  DEVICE_OAUTH_SESSION_VERSION,
  DEVICE_SESSION_SCOPE,
  normalizeDeviceScope,
  type DeviceOAuthSession,
} from "./device-oauth-session.js";
import { loadRemoteIdentityFromEnv, type RemoteIdentityConfig } from "./remote-identity.js";
import { parseTrustedHttpUrl } from "./trusted-http-url.js";
import { oauthHttpRequest, RawHttpBodyTooLargeError } from "./oauth-http.js";

export type { DeviceOAuthSession } from "./device-oauth-session.js";

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const REQUESTED_DEVICE_SCOPES = ["device:sync", "offline_access"] as const;
export const REQUIRED_ISSUER_SCOPES = ["mcp:tools", "device:sync", "offline_access"] as const;
/** @deprecated Use REQUESTED_DEVICE_SCOPES for device-token requests. */
export const REQUESTED_SCOPES = REQUESTED_DEVICE_SCOPES;
export const DEVICE_SCOPE = REQUESTED_DEVICE_SCOPES.join(" ");
const HTTP_TIMEOUT_MS = 10_000;
const MAX_METADATA_JSON_BYTES = 64 * 1024;
const MAX_OAUTH_JSON_BYTES = 128 * 1024;
const MAX_DEVICE_FLOW_SECONDS = 900;
const MAX_POLL_INTERVAL_SECONDS = 60;
const MAX_TRANSIENT_ATTEMPTS = 4;

export type AuthorizationServerMetadata = Readonly<{
  issuer: string;
  authorization_endpoint: string;
  registration_endpoint?: string;
  device_authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint: string;
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  response_types_supported: string[];
  code_challenge_methods_supported: string[];
  scopes_supported: string[];
}>;

export type OAuthErrorCode =
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token"
  | "invalid_grant"
  | "invalid_token"
  | "invalid_target"
  | "invalid_client"
  | "temporarily_unavailable"
  | "server_error"
  | "protocol_error";

export class OAuthProtocolError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    message: string = code,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OAuthProtocolError";
  }
}

export class RejectedOAuthTokenResponseError extends OAuthProtocolError {
  constructor(
    code: OAuthErrorCode,
    message: string,
    readonly cleanupSession: DeviceOAuthSession,
  ) {
    super(code, message);
    this.name = "RejectedOAuthTokenResponseError";
  }
}

export type VerifiedAccessToken = Readonly<{
  expiresAt: number;
  notBefore?: number;
  issuer: string;
  audience: string;
  scope: typeof DEVICE_SESSION_SCOPE;
}>;

export type ProviderTokenVerifier = {
  verifyAccessToken(session: DeviceOAuthSession, identity: RemoteIdentityConfig, signal?: AbortSignal): Promise<VerifiedAccessToken>;
};

export class JwksProviderTokenVerifier implements ProviderTokenVerifier {
  async verifyAccessToken(session: DeviceOAuthSession, identity: RemoteIdentityConfig, signal?: AbortSignal): Promise<VerifiedAccessToken> {
    const metadata = await fetchAuthorizationServerMetadata(identity, signal);
    const result = await requestJson(
      metadata.jwks_uri,
      { headers: { accept: "application/json" } },
      monotonicNowMs() + HTTP_TIMEOUT_MS,
      MAX_METADATA_JSON_BYTES,
      signal,
    );
    if (!result.response.ok) throw new OAuthProtocolError("protocol_error", "Provider key discovery failed", result.response.status);
    const body = result.body;
    if (!Array.isArray(body.keys)) throw new OAuthProtocolError("protocol_error", "Provider key discovery returned no keys");

    const parts = session.accessToken.split(".");
    if (parts.length !== 3) throw new OAuthProtocolError("invalid_token", "Provider access token is not a JWT");
    const header = parseJwtPart(parts[0], "JWT header");
    const claims = parseJwtPart(parts[1], "JWT claims");
    const signature = decodeBase64Url(parts[2], "JWT signature");
    const alg = typeof header.alg === "string" ? header.alg : "";
    const kid = typeof header.kid === "string" ? header.kid : "";
    if (!kid || !["RS256", "ES256", "EdDSA"].includes(alg)) throw new OAuthProtocolError("invalid_token", "Provider access token uses an unsupported key algorithm");
    const jwk = body.keys.find((key) => isRecord(key) && key.kid === kid);
    if (!isRecord(jwk)) throw new OAuthProtocolError("invalid_token", "Provider signing key was not found");
    if (typeof jwk.alg === "string" && jwk.alg !== alg) throw new OAuthProtocolError("invalid_token", "Provider signing key algorithm is invalid");
    if (jwk.use !== undefined && jwk.use !== "sig") throw new OAuthProtocolError("invalid_token", "Provider signing key use is invalid");
    let publicKey: ReturnType<typeof createPublicKey>;
    try { publicKey = createPublicKey({ key: jwk as unknown as import("node:crypto").JsonWebKey, format: "jwk" }); }
    catch { throw new OAuthProtocolError("invalid_token", "Provider signing key is invalid"); }

    const signingInput = `${parts[0]}.${parts[1]}`;
    const valid = alg === "EdDSA"
      ? verifySignature(null, Buffer.from(signingInput), publicKey, signature)
      : verifyJwtWithKey(alg, signingInput, signature, publicKey);
    if (!valid) throw new OAuthProtocolError("invalid_token", "Provider access-token signature is invalid");

    if (claims.iss !== identity.authorizationServerIssuer) throw new OAuthProtocolError("invalid_target", "Provider access-token issuer is invalid");
    const audience = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
    if (audience.length !== 1 || audience[0] !== identity.publicMcpResource) throw new OAuthProtocolError("invalid_target", "Provider access-token audience is invalid");
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) throw new OAuthProtocolError("invalid_token", "Provider access token is expired");
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > Math.floor(Date.now() / 1000))) throw new OAuthProtocolError("invalid_token", "Provider access token is not active");
    const scope = typeof claims.scope === "string" ? normalizeDeviceScope(claims.scope) : null;
    if (scope !== session.scope) throw new OAuthProtocolError("invalid_target", "Provider access-token scope is invalid");
    return Object.freeze({
      expiresAt: claims.exp * 1000,
      notBefore: typeof claims.nbf === "number" ? claims.nbf * 1000 : undefined,
      issuer: claims.iss,
      audience: audience[0],
      scope,
    });
  }
}

type DeviceAuthorizationResponse = Readonly<{
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}>;

type OAuthTokenResponse = Readonly<{
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}>;

type OAuthWireError = { error?: unknown; error_description?: unknown };

type RequestScope = Readonly<{
  signal: AbortSignal;
  cleanup(): void;
}>;

export function monotonicNowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function composeRequestSignal(parent: AbortSignal | undefined, deadlineMs: number): RequestScope {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const remainingMs = Math.max(0, deadlineMs - monotonicNowMs());
  const timer = setTimeout(() => controller.abort(new Error("request deadline exceeded")), remainingMs);
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
  options: { maxBytes: number; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type");
  if (!contentType || !/^application\/([a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
    throw new OAuthProtocolError("protocol_error", "OAuth response is not JSON", response.status);
  }
  const contentEncoding = response.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    throw new OAuthProtocolError("protocol_error", "OAuth response must use identity content encoding", response.status);
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > options.maxBytes) throw new OAuthProtocolError("protocol_error", "OAuth response is too large", response.status);
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > options.maxBytes) throw new OAuthProtocolError("protocol_error", "OAuth response is too large", response.status);
    return parseJsonObject(text, response.status);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("OAuth response cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > options.maxBytes) {
        await reader.cancel("OAuth response is too large").catch(() => undefined);
        throw new OAuthProtocolError("protocol_error", "OAuth response is too large", response.status);
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
  return parseJsonObject(text, response.status);
}

function parseJsonObject(text: string, status: number): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new OAuthProtocolError("protocol_error", "OAuth response was not valid JSON", status); }
  if (!isRecord(parsed)) throw new OAuthProtocolError("protocol_error", "OAuth response must be a JSON object", status);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeBase64Url(value: string, label: string): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new OAuthProtocolError("invalid_token", `${label} is malformed`);
  }
  try {
    const decoded = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (decoded.length === 0) throw new Error("empty");
    return decoded;
  } catch { throw new OAuthProtocolError("invalid_token", `${label} is malformed`); }
}

function parseJwtPart(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(decodeBase64Url(value, label).toString("utf8")); }
  catch { throw new OAuthProtocolError("invalid_token", `${label} is malformed`); }
  if (!isRecord(parsed)) throw new OAuthProtocolError("invalid_token", `${label} is invalid`);
  return parsed;
}

function verifyJwtWithKey(alg: string, signingInput: string, signature: Buffer, key: ReturnType<typeof createPublicKey>): boolean {
  if (alg === "RS256") {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(signingInput);
    verifier.end();
    return verifier.verify(key, signature);
  }
  if (alg === "ES256") {
    if (signature.length !== 64) return false;
    const derSignature = rawEcdsaSignatureToDer(signature);
    const verifier = createVerify("SHA256");
    verifier.update(signingInput);
    verifier.end();
    return verifier.verify(key, derSignature);
  }
  return false;
}

function rawEcdsaSignatureToDer(signature: Buffer): Buffer {
  const integer = (part: Buffer): Buffer => {
    let value = part;
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
    return Buffer.concat([Buffer.from([0x02, value.length]), value]);
  };
  const body = Buffer.concat([integer(signature.subarray(0, 32)), integer(signature.subarray(32))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new OAuthProtocolError("protocol_error", `OAuth response has invalid ${field}`);
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new OAuthProtocolError("protocol_error", `OAuth metadata has invalid ${field}`);
  }
  return [...value] as string[];
}

function positive(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new OAuthProtocolError("protocol_error", `OAuth response has invalid ${field}`);
  }
  return value;
}

export function authorizationServerMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  const suffix = url.pathname === "/" ? "" : url.pathname;
  return `${url.origin}/.well-known/oauth-authorization-server${suffix}`;
}

function trustedEndpoint(value: unknown, label: string, identity: RemoteIdentityConfig): string {
  const endpoint = str(value, label);
  try {
    return parseTrustedHttpUrl(endpoint, label, {
      urlClass: "publicOAuth",
      profile: identity.runtimeProfile,
      requireOrigin: new URL(identity.authorizationServerIssuer).origin,
    }).toString();
  } catch {
    throw new OAuthProtocolError("protocol_error", `${label} violates the authorization-server transport policy`);
  }
}

function endpointWithSuffix(value: unknown, label: string, suffix: string, identity: RemoteIdentityConfig): string {
  const endpoint = trustedEndpoint(value, label, identity);
  const issuerPath = new URL(identity.authorizationServerIssuer).pathname.replace(/\/$/, "");
  const expectedPath = `${issuerPath}${suffix}` || suffix;
  if (new URL(endpoint).pathname !== expectedPath) {
    throw new OAuthProtocolError("protocol_error", `${label} has an unexpected path`);
  }
  return endpoint;
}

function parseAuthorizationServerMetadata(value: Record<string, unknown>, identity: RemoteIdentityConfig): AuthorizationServerMetadata {
  const issuer = str(value.issuer, "issuer");
  if (issuer !== identity.authorizationServerIssuer) throw new OAuthProtocolError("protocol_error", "OAuth issuer does not match configured identity");
  const grantTypes = stringArray(value.grant_types_supported, "grant_types_supported");
  if (!grantTypes.includes("authorization_code") || !grantTypes.includes(DEVICE_GRANT) || !grantTypes.includes("refresh_token")) {
    throw new OAuthProtocolError("protocol_error", "OAuth server does not advertise the required grants");
  }
  const authMethods = stringArray(value.token_endpoint_auth_methods_supported, "token_endpoint_auth_methods_supported");
  if (!authMethods.includes("none")) throw new OAuthProtocolError("protocol_error", "OAuth server does not support public desktop clients");
  const responseTypes = stringArray(value.response_types_supported, "response_types_supported");
  if (!responseTypes.includes("code")) throw new OAuthProtocolError("protocol_error", "OAuth server does not advertise authorization-code responses");
  const codeChallengeMethods = stringArray(value.code_challenge_methods_supported, "code_challenge_methods_supported");
  if (!codeChallengeMethods.includes("S256")) throw new OAuthProtocolError("protocol_error", "OAuth server does not advertise PKCE S256");
  const scopes = stringArray(value.scopes_supported, "scopes_supported");
  for (const requiredScope of REQUIRED_ISSUER_SCOPES) {
    if (!scopes.includes(requiredScope)) throw new OAuthProtocolError("protocol_error", `OAuth metadata is missing required scope ${requiredScope}`);
  }
  return {
    issuer,
    authorization_endpoint: endpointWithSuffix(value.authorization_endpoint, "authorization_endpoint", "/authorize", identity),
    registration_endpoint: value.registration_endpoint === undefined
      ? undefined
      : endpointWithSuffix(value.registration_endpoint, "registration_endpoint", "/oauth2/register", identity),
    device_authorization_endpoint: endpointWithSuffix(value.device_authorization_endpoint, "device_authorization_endpoint", "/oauth2/device-authorization", identity),
    token_endpoint: endpointWithSuffix(value.token_endpoint, "token_endpoint", "/oauth2/token", identity),
    jwks_uri: endpointWithSuffix(value.jwks_uri, "jwks_uri", "/jwks", identity),
    revocation_endpoint: endpointWithSuffix(value.revocation_endpoint, "revocation_endpoint", "/oauth2/revoke", identity),
    grant_types_supported: grantTypes,
    token_endpoint_auth_methods_supported: authMethods,
    response_types_supported: responseTypes,
    code_challenge_methods_supported: codeChallengeMethods,
    scopes_supported: scopes,
  };
}

async function requestJson(url: string, init: RequestInit, deadlineMs: number, maxBytes: number, parent?: AbortSignal): Promise<{ response: Response; body: Record<string, unknown> }> {
  const scoped = composeRequestSignal(parent, deadlineMs);
  try {
    const headers = new Headers(init.headers);
    headers.set("accept-encoding", "identity");
    const response = await oauthHttpRequest(url, { ...init, headers, redirect: "error", signal: scoped.signal }, maxBytes);
    const body = await readBoundedJsonObject(response, { maxBytes, signal: scoped.signal });
    return { response, body };
  } catch (error) {
    if (parent?.aborted) throw parent.reason ?? error;
    if (error instanceof OAuthProtocolError) throw error;
    if (error instanceof RawHttpBodyTooLargeError) throw new OAuthProtocolError("protocol_error", "OAuth response is too large");
    throw new OAuthProtocolError("protocol_error", "OAuth network request failed");
  } finally {
    scoped.cleanup();
  }
}

export async function fetchAuthorizationServerMetadata(identity: RemoteIdentityConfig, signal?: AbortSignal): Promise<AuthorizationServerMetadata> {
  const result = await requestJson(
    authorizationServerMetadataUrl(identity.authorizationServerIssuer),
    { headers: { accept: "application/json" } },
    monotonicNowMs() + HTTP_TIMEOUT_MS,
    MAX_METADATA_JSON_BYTES,
    signal,
  );
  if (!result.response.ok) throw new OAuthProtocolError("protocol_error", "OAuth discovery failed", result.response.status);
  return parseAuthorizationServerMetadata(result.body, identity);
}

const DEVICE_VERIFICATION_PATH = "/device";

function parseAuthorization(value: Record<string, unknown>, identity: RemoteIdentityConfig): DeviceAuthorizationResponse {
  const trustedOrigin = new URL(identity.authorizationServerIssuer).origin;
  const verificationUri = str(value.verification_uri, "verification_uri");
let verification: URL;
  try { verification = new URL(verificationUri); }
  catch { throw new OAuthProtocolError("protocol_error", "verification_uri is not trusted"); }
  if (verification.origin !== trustedOrigin || verification.protocol !== new URL(identity.authorizationServerIssuer).protocol
    || verification.pathname !== DEVICE_VERIFICATION_PATH || verification.username || verification.password
    || verification.search || verification.hash) {
    throw new OAuthProtocolError("protocol_error", "verification_uri is not trusted");
  }
  const userCode = str(value.user_code, "user_code");
  if (/[^\x21-\x7e]/.test(userCode) || userCode.length > 128) throw new OAuthProtocolError("protocol_error", "user_code has invalid characters");
  const complete = value.verification_uri_complete === undefined ? undefined : str(value.verification_uri_complete, "verification_uri_complete");
  if (complete) {
    let completeUrl: URL;
    try { completeUrl = new URL(complete); }
    catch { throw new OAuthProtocolError("protocol_error", "verification_uri_complete is not trusted"); }
    const codeValues = completeUrl.searchParams.getAll("user_code");
    if (completeUrl.origin !== trustedOrigin || completeUrl.protocol !== verification.protocol
      || completeUrl.pathname !== DEVICE_VERIFICATION_PATH || completeUrl.username || completeUrl.password
      || completeUrl.hash || codeValues.length !== 1 || codeValues[0] !== userCode
      || [...completeUrl.searchParams.keys()].some((key) => key !== "user_code")) {
      throw new OAuthProtocolError("protocol_error", "verification_uri_complete is not trusted");
    }
  }
  return {
    device_code: str(value.device_code, "device_code"),
    user_code: userCode,
    verification_uri: verification.toString(),
    verification_uri_complete: complete,
    expires_in: positive(value.expires_in, "expires_in", MAX_DEVICE_FLOW_SECONDS),
    interval: value.interval === undefined ? 5 : Math.min(positive(value.interval, "interval", MAX_POLL_INTERVAL_SECONDS), MAX_POLL_INTERVAL_SECONDS),
  };
}

function parseToken(
  value: Record<string, unknown>,
  requestedScope: string,
  previousRefreshToken?: string,
  cleanupContext?: { identity: RemoteIdentityConfig; clientId: string; generation: number },
): { accessToken: string; refreshToken: string; expiresAt: number; scope: typeof DEVICE_SESSION_SCOPE } {
  const tokenType = str(value.token_type, "token_type");
  if (tokenType.toLowerCase() !== "bearer") throw new OAuthProtocolError("protocol_error", "OAuth token_type must be Bearer");
  const accessToken = str(value.access_token, "access_token");
  const refreshToken = value.refresh_token === undefined ? previousRefreshToken : str(value.refresh_token, "refresh_token");
  if (!refreshToken) throw new OAuthProtocolError("protocol_error", "OAuth response omitted refresh_token");
  const expiresAt = Date.now() + positive(value.expires_in, "expires_in") * 1000;
  const requested = normalizeDeviceScope(requestedScope);
  const effectiveScope = value.scope === undefined ? requested : normalizeDeviceScope(str(value.scope, "scope"));
  if (!requested || !effectiveScope || effectiveScope !== requested) {
    if (requested && cleanupContext) {
      const cleanupSession: DeviceOAuthSession = Object.freeze({
        version: DEVICE_OAUTH_SESSION_VERSION,
        issuer: cleanupContext.identity.authorizationServerIssuer,
        resource: cleanupContext.identity.publicMcpResource,
        clientId: cleanupContext.clientId,
        accessToken,
        refreshToken,
        expiresAt,
        scope: requested,
        generation: cleanupContext.generation,
      });
      throw new RejectedOAuthTokenResponseError("invalid_target", "OAuth token scope set is not exactly the requested device scope", cleanupSession);
    }
    throw new OAuthProtocolError("invalid_target", "OAuth token scope set is not exactly the requested device scope");
  }
  return { accessToken, refreshToken, expiresAt, scope: effectiveScope };
}

function oauthError(value: Record<string, unknown>, status?: number): OAuthProtocolError {
  const raw = typeof value.error === "string" ? value.error : "protocol_error";
  const known: OAuthErrorCode[] = ["authorization_pending", "slow_down", "access_denied", "expired_token", "invalid_grant", "invalid_token", "invalid_target", "invalid_client", "temporarily_unavailable", "server_error", "protocol_error"];
  const code = known.includes(raw as OAuthErrorCode) ? raw as OAuthErrorCode : "protocol_error";
  return new OAuthProtocolError(code, code, status);
}

function sleepAbortable(seconds: number, deadlineMs: number, signal?: AbortSignal): Promise<void> {
  const delay = Math.min(seconds * 1000, Math.max(0, deadlineMs - monotonicNowMs()));
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("operation cancelled"));
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("operation cancelled"));
    };
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    timer = setTimeout(done, delay);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return !!value && typeof value === "object" && typeof (value as AbortSignal).aborted === "boolean" && typeof (value as AbortSignal).addEventListener === "function";
}

function identityAndClient(
  first?: string | RemoteIdentityConfig,
  second?: string | AbortSignal,
  third?: AbortSignal,
): { identity: RemoteIdentityConfig; clientId?: string; signal?: AbortSignal } {
  if (typeof first === "object") return { identity: first, clientId: typeof second === "string" ? second : undefined, signal: third ?? (isAbortSignal(second) ? second : undefined) };
  return { identity: loadRemoteIdentityFromEnv(), clientId: first, signal: isAbortSignal(second) ? second : third };
}

export async function registerDeviceClient(identity?: RemoteIdentityConfig): Promise<string> {
  const resolved = identity ?? loadRemoteIdentityFromEnv();
  if (resolved.runtimeProfile !== "test") {
    throw new OAuthProtocolError("invalid_client", "Device client provisioning requires the control-plane bootstrap boundary");
  }
  const meta = await fetchAuthorizationServerMetadata(resolved);
  if (!meta.registration_endpoint) throw new OAuthProtocolError("invalid_client", "Authorization server does not expose public device-client registration");
  const result = await requestJson(meta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Desktop Commander Device",
      token_endpoint_auth_method: "none",
      grant_types: [DEVICE_GRANT, "refresh_token"],
      scope: DEVICE_SCOPE,
      resources: [resolved.publicMcpResource],
    }),
  }, monotonicNowMs() + HTTP_TIMEOUT_MS, MAX_OAUTH_JSON_BYTES);
  if (!result.response.ok) throw oauthError(result.body, result.response.status);
  return str(result.body.client_id, "client_id");
}

export function pairDevice(existingClientId?: string): Promise<DeviceOAuthSession>;
export function pairDevice(identity: RemoteIdentityConfig, existingClientId?: string, signal?: AbortSignal): Promise<DeviceOAuthSession>;
export async function pairDevice(first?: string | RemoteIdentityConfig, second?: string, signal?: AbortSignal): Promise<DeviceOAuthSession> {
  const { identity, clientId: suppliedClientId } = identityAndClient(first, second, signal);
  const meta = await fetchAuthorizationServerMetadata(identity, signal);
  const configuredClientId = process.env.DC_REMOTE_DEVICE_CLIENT_ID;
  const clientId = suppliedClientId ?? configuredClientId ?? (identity.runtimeProfile === "test" ? await registerDeviceClient(identity) : undefined);
  if (!clientId) throw new OAuthProtocolError("invalid_client", "A pre-provisioned device client ID is required");
  const result = await requestJson(meta.device_authorization_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: clientId, scope: DEVICE_SCOPE, resource: identity.publicMcpResource }),
  }, monotonicNowMs() + HTTP_TIMEOUT_MS, MAX_OAUTH_JSON_BYTES, signal);
  if (!result.response.ok) throw oauthError(result.body, result.response.status);
  const authorization = parseAuthorization(result.body, identity);
  console.log(`Open ${authorization.verification_uri}`);
  console.log(`Enter code ${authorization.user_code}`);
  if (process.env.DC_DEVICE_NO_BROWSER !== "1") await open(authorization.verification_uri_complete ?? authorization.verification_uri).catch(() => undefined);
  const token = await pollForToken(meta.token_endpoint, clientId, identity, authorization, signal);
  return Object.freeze({
    version: DEVICE_OAUTH_SESSION_VERSION,
    issuer: identity.authorizationServerIssuer,
    resource: identity.publicMcpResource,
    clientId,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    scope: token.scope,
    generation: 1,
  });
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_POLL_INTERVAL_SECONDS * 1000);
  const absolute = Date.parse(raw);
  if (!Number.isFinite(absolute)) return undefined;
  return Math.min(Math.max(0, absolute - Date.now()), MAX_POLL_INTERVAL_SECONDS * 1000);
}

function retryBackoffSeconds(attempt: number, current: number): number {
  const exponential = Math.min(MAX_POLL_INTERVAL_SECONDS, Math.max(current + 1, 2 ** Math.min(attempt, 6)));
  return Math.min(MAX_POLL_INTERVAL_SECONDS, exponential + Math.random());
}

async function pollForToken(tokenEndpoint: string, clientId: string, identity: RemoteIdentityConfig, authorization: DeviceAuthorizationResponse, signal?: AbortSignal): Promise<{ accessToken: string; refreshToken: string; expiresAt: number; scope: typeof DEVICE_SESSION_SCOPE }> {
  const deadline = monotonicNowMs() + authorization.expires_in * 1000;
  let interval = authorization.interval ?? 5;
  let transientFailures = 0;
  while (monotonicNowMs() < deadline) {
    await sleepAbortable(interval, deadline, signal);
    let result: { response: Response; body: Record<string, unknown> };
    try {
      result = await requestJson(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: authorization.device_code, client_id: clientId, resource: identity.publicMcpResource }),
      }, Math.min(monotonicNowMs() + HTTP_TIMEOUT_MS, deadline), MAX_OAUTH_JSON_BYTES, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (transientFailures++ >= MAX_TRANSIENT_ATTEMPTS) throw error;
      interval = retryBackoffSeconds(transientFailures, interval);
      continue;
    }
    if (result.response.ok) return parseToken(result.body, DEVICE_SCOPE, undefined, { identity, clientId, generation: 1 });
    const error = oauthError(result.body, result.response.status);
    if (error.code === "authorization_pending") { transientFailures = 0; continue; }
    if (error.code === "slow_down") {
      interval = Math.min(MAX_POLL_INTERVAL_SECONDS, Math.max(interval + 5, (retryAfterMs(result.response) ?? 0) / 1000));
      continue;
    }
    if (result.response.status === 429 || result.response.status >= 500
      || error.code === "temporarily_unavailable" || error.code === "server_error") {
      if (transientFailures++ >= MAX_TRANSIENT_ATTEMPTS) throw error;
      const retryAfter = retryAfterMs(result.response);
      interval = retryAfter === undefined ? retryBackoffSeconds(transientFailures, interval) : Math.max(0, retryAfter / 1000);
      continue;
    }
    throw error;
  }
  throw new OAuthProtocolError("expired_token", "Device authorization expired");
}

export async function requestRefreshDeviceSessionCandidate(session: DeviceOAuthSession, identity?: RemoteIdentityConfig, signal?: AbortSignal): Promise<DeviceOAuthSession> {
  const resolved = identity ?? loadRemoteIdentityFromEnv();
  if (session.issuer !== resolved.authorizationServerIssuer || session.resource !== resolved.publicMcpResource) throw new OAuthProtocolError("invalid_target", "Stored device session is bound to another issuer/resource");
  const meta = await fetchAuthorizationServerMetadata(resolved, signal);
  const result = await requestJson(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refreshToken, client_id: session.clientId, resource: resolved.publicMcpResource }),
  }, monotonicNowMs() + HTTP_TIMEOUT_MS, MAX_OAUTH_JSON_BYTES, signal);
  if (!result.response.ok) throw oauthError(result.body, result.response.status);
  const token = parseToken(result.body, session.scope, session.refreshToken, { identity: resolved, clientId: session.clientId, generation: session.generation + 1 });
  return Object.freeze({ ...session, accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt: token.expiresAt, scope: token.scope, generation: session.generation + 1 });
}

export function applyVerifiedAccessTokenExpiry(session: DeviceOAuthSession, verified: VerifiedAccessToken): DeviceOAuthSession {
  const expiresAt = Math.min(session.expiresAt, verified.expiresAt);
  return expiresAt === session.expiresAt ? session : Object.freeze({ ...session, expiresAt });
}

export async function refreshDeviceSession(session: DeviceOAuthSession, identity?: RemoteIdentityConfig, verifier?: ProviderTokenVerifier, signal?: AbortSignal): Promise<DeviceOAuthSession> {
  const resolved = identity ?? loadRemoteIdentityFromEnv();
  if (resolved.runtimeProfile !== "test" && !verifier) throw new Error("A provider token verifier is required outside isolated test fixtures");
  const candidate = await requestRefreshDeviceSessionCandidate(session, resolved, signal);
  if (!verifier) return candidate;
  const verified = await verifier.verifyAccessToken(candidate, resolved, signal);
  return applyVerifiedAccessTokenExpiry(candidate, verified);
}

export async function revokeDeviceSession(session: DeviceOAuthSession, identity?: RemoteIdentityConfig, signal?: AbortSignal): Promise<void> {
  const resolved = identity ?? loadRemoteIdentityFromEnv();
  if (session.issuer !== resolved.authorizationServerIssuer || session.resource !== resolved.publicMcpResource) {
    throw new OAuthProtocolError("invalid_target", "Stored device session is bound to another issuer/resource");
  }
  const meta = await fetchAuthorizationServerMetadata(resolved, signal);
  const scoped = composeRequestSignal(signal, monotonicNowMs() + HTTP_TIMEOUT_MS);
  try {
    const response = await oauthHttpRequest(meta.revocation_endpoint, {
      method: "POST",
      redirect: "error",
      signal: scoped.signal,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "accept-encoding": "identity",
      },
      body: new URLSearchParams({
        token: session.refreshToken,
        token_type_hint: "refresh_token",
        client_id: session.clientId,
        resource: resolved.publicMcpResource,
      }),
    }, 16 * 1024);
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw new OAuthProtocolError("protocol_error", "OAuth device-session revocation failed", response.status);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (error instanceof OAuthProtocolError) throw error;
    if (error instanceof RawHttpBodyTooLargeError) throw new OAuthProtocolError("protocol_error", "OAuth revocation response is too large");
    throw new OAuthProtocolError("protocol_error", "OAuth device-session revocation failed");
  } finally {
    scoped.cleanup();
  }
}

export async function verifyPersistedDeviceAccessToken(session: DeviceOAuthSession, identity: RemoteIdentityConfig, verifier?: ProviderTokenVerifier, signal?: AbortSignal): Promise<VerifiedAccessToken | undefined> {
  if (identity.runtimeProfile !== "test" && !verifier) throw new Error("A provider token verifier is required outside isolated test fixtures");
  if (session.issuer !== identity.authorizationServerIssuer || session.resource !== identity.publicMcpResource) throw new OAuthProtocolError("invalid_target", "Stored device session is bound to another issuer/resource");
  return verifier ? verifier.verifyAccessToken(session, identity, signal) : undefined;
}

export function isSessionBoundTo(session: DeviceOAuthSession, identity: RemoteIdentityConfig): boolean {
  return session.issuer === identity.authorizationServerIssuer && session.resource === identity.publicMcpResource && session.version === DEVICE_OAUTH_SESSION_VERSION;
}
