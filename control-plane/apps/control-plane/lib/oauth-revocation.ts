import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";
const MAX_FORM_BYTES = 16 * 1024;
const SECURITY_FIELDS = ["token", "token_type_hint", "client_id"] as const;
const EXTRA_CLIENT_CREDENTIAL_FIELDS = [
  "client_secret", "client_assertion", "client_assertion_type",
] as const;

export type RefreshAuthorityState =
  | "delegate"
  | "missing"
  | "foreign"
  | "active"
  | "revoked";

export type RevocationDependencies = {
  provider: (request: Request) => Promise<Response>;
  inspect: (token: string, clientId: string) => Promise<RefreshAuthorityState>;
};

type ParsedRevocation = {
  token: string;
  tokenTypeHint: string | null;
  clientId: string | null;
  hasExtraClientCredentials: boolean;
};function oauthError(status: number, error: "invalid_request" | "server_error"): Response {
  return Response.json({ error }, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });
}

function success(): Response {
  return new Response(null, {
    status: 200,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });
}

function mediaType(contentType: string | null): string {
  return (contentType ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function malformedPercentEncoding(value: string): boolean {
  return /%(?![0-9A-Fa-f]{2})/.test(value);
}

function exactlyOne(params: URLSearchParams, key: string): string | null | undefined {
  const values = params.getAll(key);
  if (values.length > 1) return undefined;
  return values.length === 1 ? values[0]! : null;
}async function parseRevocationRequest(request: Request): Promise<ParsedRevocation | Response> {
  if (mediaType(request.headers.get("content-type")) !== FORM_MEDIA_TYPE) {
    return oauthError(400, "invalid_request");
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) {
    return oauthError(400, "invalid_request");
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await request.clone().arrayBuffer());
  } catch {
    return oauthError(400, "invalid_request");
  }
  if (bytes.byteLength > MAX_FORM_BYTES) return oauthError(400, "invalid_request");
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return oauthError(400, "invalid_request");
  }
  if (malformedPercentEncoding(body)) return oauthError(400, "invalid_request");

  const params = new URLSearchParams(body);
  for (const field of SECURITY_FIELDS) {
    if (params.getAll(field).length > 1) return oauthError(400, "invalid_request");
  }
  if ([...params].some(([key, value]) => key.includes("\uFFFD") || value.includes("\uFFFD"))) {
    return oauthError(400, "invalid_request");
  }  const token = exactlyOne(params, "token");
  const tokenTypeHint = exactlyOne(params, "token_type_hint");
  const clientId = exactlyOne(params, "client_id");
  if (token === undefined || tokenTypeHint === undefined || clientId === undefined) {
    return oauthError(400, "invalid_request");
  }
  if (token === null || token.trim().length === 0) {
    return oauthError(400, "invalid_request");
  }

  return {
    token,
    tokenTypeHint,
    clientId,
    hasExtraClientCredentials: EXTRA_CLIENT_CREDENTIAL_FIELDS.some((field) => params.has(field)),
  };
}

function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export function inspectPersistedPublicRefresh(
  db: DatabaseSync,
  token: string,
  clientId: string,
): RefreshAuthorityState {
  const client = db.prepare(
    "SELECT disabled, tokenEndpointAuthMethod FROM oauthClient WHERE clientId = ? LIMIT 1",
  ).get(clientId) as { disabled?: unknown; tokenEndpointAuthMethod?: unknown } | undefined;  if (!client
    || Number(client.disabled ?? 0) !== 0
    || client.tokenEndpointAuthMethod !== "none") {
    return "delegate";
  }

  const refresh = db.prepare(
    "SELECT clientId, revoked FROM oauthRefreshToken WHERE token = ? LIMIT 1",
  ).get(hashRefreshToken(token)) as { clientId?: unknown; revoked?: unknown } | undefined;
  if (!refresh) return "missing";
  if (refresh.clientId !== clientId) return "foreign";
  return refresh.revoked === null || refresh.revoked === undefined ? "active" : "revoked";
}

async function providerOrServerError(
  request: Request,
  provider: RevocationDependencies["provider"],
): Promise<Response> {
  try {
    return await provider(request);
  } catch {
    return oauthError(500, "server_error");
  }
}

async function inspectOrServerError(
  inspect: RevocationDependencies["inspect"],
  token: string,
  clientId: string,
): Promise<RefreshAuthorityState | Response> {
  try {
    return await inspect(token, clientId);
  } catch {
    return oauthError(500, "server_error");
  }
}export async function handleIdempotentRefreshRevocation(
  request: Request,
  dependencies: RevocationDependencies,
): Promise<Response> {
  const parsed = await parseRevocationRequest(request);
  if (parsed instanceof Response) return parsed;

  const canSpecialize = parsed.tokenTypeHint === "refresh_token"
    && typeof parsed.clientId === "string"
    && parsed.clientId.length > 0
    && !parsed.hasExtraClientCredentials
    && !request.headers.has("authorization");
  if (!canSpecialize) return providerOrServerError(request, dependencies.provider);

  const before = await inspectOrServerError(
    dependencies.inspect,
    parsed.token,
    parsed.clientId!,
  );
  if (before instanceof Response) return before;
  if (before === "delegate") return providerOrServerError(request, dependencies.provider);

  // RFC 7009: invalid, foreign, and already-revoked tokens are intentionally
  // indistinguishable from successful revocation. Short-circuiting here also
  // prevents Better Auth 1.7.1 from touching a family before its foreign-client
  // check when the submitted refresh token is already revoked.
  if (before === "missing" || before === "foreign" || before === "revoked") {
    return success();
  }

  const response = await providerOrServerError(request, dependencies.provider);
  if (response.status !== 400) return response;

  const after = await inspectOrServerError(
    dependencies.inspect,
    parsed.token,
    parsed.clientId!,
  );
  if (after instanceof Response) return after;
  return after === "missing" || after === "revoked" ? success() : response;
}
