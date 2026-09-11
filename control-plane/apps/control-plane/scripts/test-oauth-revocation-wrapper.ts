import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  handleIdempotentRefreshRevocation,
  inspectPersistedPublicRefresh,
  type RevocationDependencies,
} from "../lib/oauth-revocation";

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE oauthClient (
    clientId TEXT PRIMARY KEY,
    disabled INTEGER,
    tokenEndpointAuthMethod TEXT
  );
  CREATE TABLE oauthRefreshToken (
    token TEXT PRIMARY KEY,
    clientId TEXT NOT NULL,
    revoked TEXT
  );
`);

function stored(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function addClient(clientId: string, method = "none", disabled = 0): void {
  db.prepare("INSERT INTO oauthClient VALUES (?, ?, ?)").run(clientId, disabled, method);
}function addRefresh(token: string, clientId: string, revoked: string | null = null): void {
  db.prepare("INSERT INTO oauthRefreshToken VALUES (?, ?, ?)").run(stored(token), clientId, revoked);
}

function reset(): void {
  db.exec("DELETE FROM oauthRefreshToken; DELETE FROM oauthClient;");
}

function formRequest(
  body: string | URLSearchParams,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://example.test/api/auth/oauth2/revoke", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: typeof body === "string" ? body : body.toString(),
  });
}

function params(token: string, clientId = "client-a", hint = "refresh_token"): URLSearchParams {
  return new URLSearchParams({ token, token_type_hint: hint, client_id: clientId });
}

function inspect(token: string, clientId: string) {
  return Promise.resolve(inspectPersistedPublicRefresh(db, token, clientId));
}async function bodyCode(response: Response): Promise<string | null> {
  const text = await response.clone().text();
  if (!text) return null;
  try {
    const body = JSON.parse(text) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

async function expectStatus(
  label: string,
  operation: () => Promise<Response>,
  status: number,
  code?: string,
): Promise<Response> {
  const response = await operation();
  assert.equal(response.status, status, `${label}: wrong status`);
  if (code !== undefined) assert.equal(await bodyCode(response), code, `${label}: wrong OAuth code`);
  console.log(`✓ ${label}`);
  return response;
}

function deps(provider: RevocationDependencies["provider"]): RevocationDependencies {
  return { provider, inspect };
}

addClient("client-a");
addClient("client-b");let providerCalls = 0;
addRefresh("active-token", "client-a");
const activeProvider: RevocationDependencies["provider"] = async () => {
  providerCalls += 1;
  db.prepare("UPDATE oauthRefreshToken SET revoked = ? WHERE token = ?")
    .run(new Date().toISOString(), stored("active-token"));
  return new Response(null, { status: 200 });
};
await expectStatus(
  "active same-client refresh token is revoked by provider",
  () => handleIdempotentRefreshRevocation(formRequest(params("active-token")), deps(activeProvider)),
  200,
);
assert.equal(providerCalls, 1);
assert.equal(inspectPersistedPublicRefresh(db, "active-token", "client-a"), "revoked");

await expectStatus(
  "repeated revoke is idempotent without provider re-entry",
  () => handleIdempotentRefreshRevocation(formRequest(params("active-token")), deps(activeProvider)),
  200,
);
assert.equal(providerCalls, 1);

await expectStatus(
  "nonexistent token is indistinguishable success",
  () => handleIdempotentRefreshRevocation(
    formRequest(params("random-nonexistent")),
    deps(async () => { throw new Error("provider must not see nonexistent public refresh token"); }),
  ),
  200,
);addRefresh("foreign-active", "client-a");
await expectStatus(
  "foreign-client token is a no-op success",
  () => handleIdempotentRefreshRevocation(
    formRequest(params("foreign-active", "client-b")),
    deps(async () => { throw new Error("provider must not receive foreign refresh authority"); }),
  ),
  200,
);
assert.equal(inspectPersistedPublicRefresh(db, "foreign-active", "client-a"), "active");

addRefresh("foreign-revoked", "client-a", new Date().toISOString());
await expectStatus(
  "foreign revoked token does not enter provider family invalidation",
  () => handleIdempotentRefreshRevocation(
    formRequest(params("foreign-revoked", "client-b")),
    deps(async () => { throw new Error("provider must not receive foreign revoked token"); }),
  ),
  200,
);
assert.equal(inspectPersistedPublicRefresh(db, "foreign-revoked", "client-a"), "revoked");

const indistinguishable = await Promise.all([
  handleIdempotentRefreshRevocation(formRequest(params("active-token")), deps(activeProvider)),
  handleIdempotentRefreshRevocation(formRequest(params("random-two")), deps(activeProvider)),
  handleIdempotentRefreshRevocation(formRequest(params("foreign-active", "client-b")), deps(activeProvider)),
]);
assert.deepEqual(indistinguishable.map((response) => response.status), [200, 200, 200]);
assert.deepEqual(await Promise.all(indistinguishable.map((response) => response.text())), ["", "", ""]);const neverProvider: RevocationDependencies["provider"] = async () => {
  throw new Error("provider should not be called");
};
await expectStatus(
  "missing token is invalid_request",
  () => handleIdempotentRefreshRevocation(
    formRequest("token_type_hint=refresh_token&client_id=client-a"), deps(neverProvider),
  ),
  400,
  "invalid_request",
);
await expectStatus(
  "empty token is invalid_request",
  () => handleIdempotentRefreshRevocation(
    formRequest("token=&token_type_hint=refresh_token&client_id=client-a"), deps(neverProvider),
  ),
  400,
  "invalid_request",
);
await expectStatus(
  "duplicate token parameter is invalid_request",
  () => handleIdempotentRefreshRevocation(
    formRequest("token=one&token=two&token_type_hint=refresh_token&client_id=client-a"),
    deps(neverProvider),
  ),
  400,
  "invalid_request",
);await expectStatus(
  "malformed content type is invalid_request",
  () => handleIdempotentRefreshRevocation(new Request(
    "https://example.test/api/auth/oauth2/revoke",
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  ), deps(neverProvider)),
  400,
  "invalid_request",
);
await expectStatus(
  "malformed percent encoding is invalid_request",
  () => handleIdempotentRefreshRevocation(
    formRequest("token=%GG&token_type_hint=refresh_token&client_id=client-a"),
    deps(neverProvider),
  ),
  400,
  "invalid_request",
);
await expectStatus(
  "duplicate client_id is invalid_request",
  () => handleIdempotentRefreshRevocation(
    formRequest("token=x&token_type_hint=refresh_token&client_id=client-a&client_id=client-b"),
    deps(neverProvider),
  ),
  400,
  "invalid_request",
);const invalidClientProvider: RevocationDependencies["provider"] = async () =>
  Response.json({ error: "invalid_client" }, { status: 401 });
await expectStatus(
  "missing client_id preserves provider authentication failure",
  () => handleIdempotentRefreshRevocation(
    formRequest("token=x&token_type_hint=refresh_token"), deps(invalidClientProvider),
  ),
  401,
  "invalid_client",
);
await expectStatus(
  "unknown client_id preserves provider authentication failure",
  () => handleIdempotentRefreshRevocation(
    formRequest(params("x", "unknown-client")), deps(invalidClientProvider),
  ),
  401,
  "invalid_client",
);
await expectStatus(
  "client_secret form credential bypasses specialization",
  () => handleIdempotentRefreshRevocation(
    formRequest("token=x&token_type_hint=refresh_token&client_id=client-a&client_secret=wrong"),
    deps(invalidClientProvider),
  ),
  401,
  "invalid_client",
);await expectStatus(
  "Authorization header bypasses public-client specialization",
  () => handleIdempotentRefreshRevocation(
    formRequest(params("x"), { authorization: "Basic Zm9vOmJhcg==" }),
    deps(invalidClientProvider),
  ),
  401,
  "invalid_client",
);
const unsupportedProvider: RevocationDependencies["provider"] = async () =>
  Response.json({ error: "unsupported_token_type" }, { status: 400 });
await expectStatus(
  "access-token hint preserves provider protocol result",
  () => handleIdempotentRefreshRevocation(
    formRequest(params("not-an-access-token", "client-a", "access_token")),
    deps(unsupportedProvider),
  ),
  400,
  "unsupported_token_type",
);
await expectStatus(
  "unknown token hint preserves provider protocol result",
  () => handleIdempotentRefreshRevocation(
    formRequest(params("opaque", "client-a", "future_token_type")),
    deps(unsupportedProvider),
  ),
  400,
  "unsupported_token_type",
);addRefresh("poststate-token", "client-a");
const poststateProvider: RevocationDependencies["provider"] = async () => {
  db.prepare("UPDATE oauthRefreshToken SET revoked = ? WHERE token = ?")
    .run(new Date().toISOString(), stored("poststate-token"));
  return Response.json({
    error: "invalid_request",
    error_description: "mutable provider text that must not control normalization",
  }, { status: 400 });
};
await expectStatus(
  "authoritative revoked post-state normalizes provider 400",
  () => handleIdempotentRefreshRevocation(
    formRequest(params("poststate-token")), deps(poststateProvider),
  ),
  200,
);

addRefresh("still-active-token", "client-a");
await expectStatus(
  "provider 400 is preserved while authority remains active",
  () => handleIdempotentRefreshRevocation(
    formRequest(params("still-active-token")),
    deps(async () => Response.json({ error: "invalid_request" }, { status: 400 })),
  ),
  400,
  "invalid_request",
);addRefresh("provider-outage-token", "client-a");
await expectStatus(
  "provider outage becomes server_error and is never normalized",
  () => handleIdempotentRefreshRevocation(
    formRequest(params("provider-outage-token")),
    deps(async () => { throw new Error("provider unavailable"); }),
  ),
  500,
  "server_error",
);
assert.equal(inspectPersistedPublicRefresh(db, "provider-outage-token", "client-a"), "active");

addRefresh("failed-transaction-token", "client-a");
await expectStatus(
  "failed revocation transaction 5xx is preserved",
  () => handleIdempotentRefreshRevocation(
    formRequest(params("failed-transaction-token")),
    deps(async () => Response.json({ error: "server_error" }, { status: 503 })),
  ),
  503,
  "server_error",
);
assert.equal(inspectPersistedPublicRefresh(db, "failed-transaction-token", "client-a"), "active");

await expectStatus(
  "database inspection outage becomes server_error",
  () => handleIdempotentRefreshRevocation(formRequest(params("db-outage-token")), {
    provider: neverProvider,
    inspect: async () => { throw new Error("database unavailable"); },
  }),
  500,
  "server_error",
);const brokenBody = new ReadableStream<Uint8Array>({
  start(controller) { controller.error(new Error("broken request body")); },
});
const brokenRequest = new Request("https://example.test/api/auth/oauth2/revoke", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: brokenBody,
  duplex: "half",
} as RequestInit & { duplex: "half" });
await expectStatus(
  "request body read failure is invalid_request",
  () => handleIdempotentRefreshRevocation(brokenRequest, deps(neverProvider)),
  400,
  "invalid_request",
);

addClient("disabled-client", "none", 1);
await expectStatus(
  "disabled public client is delegated to provider authentication",
  () => handleIdempotentRefreshRevocation(
    formRequest(params("x", "disabled-client")), deps(invalidClientProvider),
  ),
  401,
  "invalid_client",
);
addClient("confidential-client", "client_secret_basic");
await expectStatus(
  "confidential client is not handled by public-client compatibility path",
  () => handleIdempotentRefreshRevocation(
    formRequest(params("x", "confidential-client")), deps(invalidClientProvider),
  ),
  401,
  "invalid_client",
);

reset();
db.close();
console.log("REVOCATION_WRAPPER_TEST=PASS");
