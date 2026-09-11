# P7B — Desktop device and resource-edge issuer/resource implementation

Parent: `docs/PASSKEY-TASK-P7-CENTRAL-ISSUER-RESOURCE-SEPARATION.md`

Depends on: P0 decisions preserved, P1 GO, P7A approved, P8A transaction/locking/cleanup/revocation primitives

Blocks: P5, P8B, P9, P10

Review corrections: R-25 through R-32. This implementation task does not bypass any P0/P1/P7A/P8A gate.

## Objective

Implement the P7A protocol in DesktopCommanderMCP and the per-device resource edge with standards-correct discovery, typed/runtime-validated OAuth messages, exact identity binding, and race-safe refresh-token persistence.

## P7B.1 Immutable remote identity

Construct once:

```ts
type RemoteIdentityConfig = Readonly<{
  runtimeProfile: "production" | "development" | "test";
  authorizationServerIssuer: string;
  publicMcpResource: string;
  internalDeviceApiOrigin: string;
}>;
```

Reject URL credentials, unexpected schemes, query/fragment, and noncanonical resource forms. Do not trim an identifier after provisioning. `runtimeProfile` is mandatory immutable release configuration and is never inferred from a URL or environment hostname. Apply P7A's single profile-aware HTTPS-or-approved-literal-loopback validator to issuer, resource, metadata endpoints, verification URIs, and internal transport; production never downgrades to HTTP and discovered public endpoints are never rewritten to `internalDeviceApiOrigin`.

## P7B.1A Local resource-runtime handshake before public identity use

Implement P7A.5A rather than relying on the current process-start `APP_ORIGIN`/`REMOTE_MCP_RESOURCE` assumption. The local HTTP resource edge may be running before the tunnel identity exists, but it starts `resource_unconfigured`: only the private local health needed by the tunnel may report ready. Public MCP/device routes and RFC 9728 metadata fail closed until an exact acknowledged runtime revision is installed.

Required application-owned interface:

```ts
interface LocalResourceRuntimeConfigurator {
  configureResource(identity: RemoteIdentityConfig, signal?: AbortSignal): Promise<ResourceRuntimeAckV1>;
  assertResourceReady(identity: RemoteIdentityConfig, ack: ResourceRuntimeAckV1, signal?: AbortSignal): Promise<void>;
  installBootstrapProof(proof: BootstrapProofDocumentV1, signal?: AbortSignal): Promise<ResourceRuntimeAckV1>;
  assertBootstrapProofReady(proof: BootstrapProofDocumentV1, ack: ResourceRuntimeAckV1, signal?: AbortSignal): Promise<void>;
  removeBootstrapProof(bootstrapId: string, signal?: AbortSignal): Promise<ResourceRuntimeAckV1>;
}
```

The V1 implementation uses the owner-only atomically watched state/ack files and exact `ResourceRuntimeAckV1` schema from P7A.5A. File ownership/ACL, same-directory atomic replacement, file + parent-directory fsync, canonical document/tombstone digest, monotonic input revision, monotonic server generation, exact operation/resource/bootstrap binding, and acknowledgement are correctness requirements. It must work on macOS/Linux and use the specified ACL + `FlushFileBuffers` + write-through replace + flushed generation-manifest equivalent on Windows; no world-readable state or ambient temp directory is permitted. An exact replay may return its prior acknowledgement, but stale/lower revision or same-revision different digest is rejected to prevent ABA.

Ordering tests must prove:

```text
local health can be ready while resource metadata is intentionally unavailable
resource configure -> ack -> public RFC9728 exact metadata before /challenge
challenge -> signed proof install -> proof ack -> public exact proof before /prove
no CLI environment mutation reconfigures the server
ack requires exact operation/revision/canonical document-or-tombstone digest/resource/bootstrap ID/server generation/applied time
unacknowledged/stale/wrong-resource/lower-generation or same-revision-different-digest blocks bootstrap; A@7 -> B@8 -> replay A@7 cannot cause ABA
expired/removed proof returns 404 only after a higher exact removal-tombstone acknowledgement
crash at POSIX write/file-fsync/rename/parent-fsync and Windows flush/replace/generation-manifest boundaries recovers only the last complete generation
server restart reloads exact acknowledged resource but never expired proof
```

## P7B.2 Discovery and authorization-server capability validation

Use the P7A RFC 8414 helper and fetch metadata directly from the central issuer. Read at most 64 KiB transfer bytes and 64 KiB decoded bytes, require `application/json` with optional charset, parse unknown JSON through a runtime schema, and require exact issuer equality.

The selected V1 issuer profile is validated as one whole capability set before pairing:

```text
issuer                                  exact configured authorizationServerIssuer
authorization_endpoint                  present, trusted, exact allowed central origin/path
response_types_supported                nonempty string array containing code
grant_types_supported                   contains authorization_code, refresh_token,
                                         and urn:ietf:params:oauth:grant-type:device_code
token_endpoint_auth_methods_supported   contains none for the public desktop client
code_challenge_methods_supported        contains S256; plain is not relied upon
scopes_supported                        contains mcp:tools, device:sync, and offline_access
device_authorization_endpoint           present, trusted, exact allowed central origin/path
token_endpoint                          present, trusted, exact allowed central origin/path
jwks_uri                                present, trusted, exact allowed central origin/path
registration_endpoint                   present/trusted only when the P0/P1 profile enables RFC 7591 DCR
revocation_endpoint                     required if P8A chooses revocation to dispose duplicate/losing families
```

Fields declared as arrays contain only bounded strings and are deduplicated before set comparison. Unknown fields are ignored only after size/schema validation. Missing, malformed, contradictory, or duplicate-sensitive capability is a typed protocol/configuration error, not a fallback.

Every endpoint applies HTTPS-or-approved-loopback plus its exact central-origin/path allowlist; credentials and fragments are forbidden and redirects are disabled. No endpoint is rewritten to localhost or `internalDeviceApiOrigin`.

Also fetch and validate RFC 9728 metadata from the exact public resource: `resource` equals `publicMcpResource`, `authorization_servers` contains the one exact issuer and no unapproved issuer, and `scopes_supported` contains the P7A route scopes. Internal origins must not appear in either metadata document.

## P7B.3 Verification URL and user-code presentation

Runtime validation requires:

```text
verification_uri exact trusted central-auth origin **and exact release-approved route**, with no query or fragment
verification_uri_complete, when present, same exact route and exactly the provider-approved query schema (V1: one `user_code` key)
user_code non-empty and provider-format valid; complete-URI `user_code` exactly matches the separately returned value
expires_in positive and bounded by server/client policy
interval finite and bounded
```

RFC 8628 presentation invariant:

```text
ALWAYS display verification_uri
ALWAYS display user_code
optionally open verification_uri_complete in the external browser
```

Opening the complete URI is convenience only; it never suppresses the code display that lets the user compare possession context. The parser rejects alternate same-origin paths, path normalization changes, fragments, credentials, missing/empty/mismatched complete-URI code, duplicate `user_code`, and every unknown query key. Release configuration pins the exact verification path and query-key grammar; origin equality alone is insufficient.

## P7B.4 Polling, cancellation, deadlines, and transport hardening

All metadata, bootstrap, receipt, pairing, polling, refresh, and control-plane HTTP functions accept a caller `AbortSignal`. Each request combines:

```text
caller cancellation
+ per-request timeout
+ remaining total device-flow deadline
```

Requirements:

- shared bounded streaming JSON reader limits **transfer and decoded bytes before allocation growth**: 64 KiB for metadata and 32 KiB for challenge, token, bootstrap, and receipt responses;
- content type must be the expected JSON media type for protocol responses, including error responses before their safe fields are parsed;
- redirects are disabled for metadata, bootstrap, device-authorization, token, refresh, and receipt calls;
- metadata/bootstrap/device-authorization/refresh requests have a maximum 10-second request timeout; token polling requests use `min(10 seconds, remaining total deadline)`;
- device-flow total deadline is `min(server expires_in, client maximum 15 minutes)` measured from receipt-authorized device-flow start with a monotonic clock;
- caller abort propagates into fetch/body streaming and throws a typed cancellation result; it is never converted into retry or reauthorization;
- sleep accepts the caller signal and remaining deadline and clears its timer/listener on every outcome;
- `authorization_pending` waits current interval;
- `slow_down` increases interval by at least 5 seconds for this and subsequent requests as RFC 8628 requires;
- HTTP 429 honors a valid bounded `Retry-After`; HTTP 500–599 and retryable transport failures use capped exponential backoff with jitter while total deadline remains;
- non-429 4xx and `access_denied`, `expired_token`, `invalid_client`, `invalid_target`, malformed protocol responses are terminal; protocol errors are not hidden by generic 5xx retry;
- each loop checks remaining deadline before calculating delay, before sleep, after sleep, before request, and while streaming the response, so retry/backoff cannot exceed authorization expiry;
- every retry has a fixed attempt cap in addition to the total deadline; receipt reconciliation handles an ambiguous successful provisioning response.

No retry logs raw bodies, authorization/device/user codes, bootstrap/receipt secrets, or tokens.

The final `oauth-http.ts` implementation must prove **both** a raw transfer-byte cap and a decoded-body cap. A generic Fetch/Web Streams example that sees only already-decompressed bytes proves the decoded limit but is insufficient by itself for the raw transfer limit; use a connector/HTTP layer whose transfer accounting and decompression policy are testable, or disable compression on these small protocol responses and enforce the received-byte ceiling there.

## P7B.5 Token response, scope, and audience parsing

Parse unknown JSON into a runtime schema before use. Require bearer token policy, bounded positive `expires_in`, nonempty access token, and provider-approved refresh behavior.

Effective scope is computed as:

```text
returned scope when present
else previously/requested scope according to OAuth semantics
```

Then enforce:

- effective scope contains `device:sync`;
- every effective scope is a member of the originally requested/allowed `resource-control-bootstrap-v1` scope set;
- no unexpected `mcp:tools`, admin, or third-party scope expansion;
- refresh cannot expand scope;
- initial offline authorization requires a refresh token;
- refresh may retain the previous refresh token when the provider validly omits rotation.

Before any token is used, including an unexpired token loaded from the OS vault after process restart, the provider/resource conformance path must verify an authenticated JWT or authoritative introspection result. `aud` must normalize to **exactly one** audience string equal byte-for-byte to `publicMcpResource`; a missing audience, URI normalization variant, array with an extra audience, or issuer mismatch fails closed. Initial issuance and refresh perform this gate before persistence/use. The restart fast path must re-run the gate before first use in each process (or force a verified refresh); serialized issuer/resource strings alone are never sufficient. P10 proves this for initial issuance, every refresh, and persisted-token restart.

Verifier network I/O is under the same composed-deadline rule as OAuth requests. Each JWT/JWKS refresh or introspection call receives a child signal combining caller cancellation, `VERIFIER_REQUEST_TIMEOUT_MS <= 10_000`, and the remaining enclosing startup/refresh/device-flow deadline. JWKS/introspection redirects are disabled, bodies have raw-transfer and decoded limits, and timeout/cancellation remain typed control flow. A cached key lookup may complete locally, but cache miss/revalidation cannot escape the enclosing deadline. Passing only the caller signal to `verifyAccessToken` is nonconforming.

## P7B.6 Versioned credential

```ts
type DeviceOAuthSessionV2 = {
  version: 2;
  issuer: string;
  resource: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  generation: number;
};
```

`issuer` and `resource` must exactly equal immutable runtime identity before token use or refresh.

## P7B.7 Vault parser

Check `typeof expiresAt === "number"` before `Number.isFinite`. Validate issuer/resource through the same exact helpers used at runtime. Unsupported/unversioned payload triggers clear + fresh authorization; never stamp current identity onto old tokens.

## P7B.8 Short vault locks plus durable pairing lease

Use two different concurrency primitives:

### Vault lock

A native cross-process lock/CAS covers only short operations:

```text
load
compare binding/generation
refresh HTTP request only if provider rotation semantics require serialization
save/clear
```

If the refresh HTTP request must stay serialized to prevent refresh-token rotation races, the lock timeout is bounded and the operation remains non-interactive. It must never include browser/device authorization polling.

### Pairing lease

Interactive reauthorization uses a separate durable local pairing lease keyed by exact issuer + resource. The lease stores a random owner ID, attempt ID, acquired/renewed timestamps, bounded expiry, and receipt ID when available; it contains no token, device code, user code, private key, capability, or receipt secret. One process becomes pairing leader. Followers poll the vault/lease with caller cancellation and a bounded wait, then reuse the winner or exit safely with “authorization already in progress”; they never open another browser.

The leader renews the lease while active. Stale takeover is allowed only after expiry plus OS-liveness/compare-and-swap checks defined by P8A. Browser opening and RFC 8628 polling happen outside the vault lock. Lease loss aborts polling and prevents save.

After successful pairing, reacquire the vault lock and save only if:

```text
pairing lease still belongs to this exact attempt
in-memory epoch and durable clear generation are unchanged
loaded vault generation is still the expected generation
runtime issuer/resource and receipt client/resource are unchanged
no newer valid V2 session was stored by another process
```

Release the lease by compare-and-delete after save or terminal cleanup. A duplicate successful pairing result that loses the race is explicitly revoked server-side when P8A/provider support it; otherwise its refresh family is durably queued for cleanup and never used or allowed to overwrite the winner. This disposal dependency is part of the open revocation gate, not a best-effort log message.

## P7B.9 Same-startup reauthorization and clear/refresh races

`initialize(signal)` explicitly catches both typed terminal OAuth errors **and** `ReauthorizationRequiredError`. If load/refresh concludes that reauthorization is required, it clears only the exact stale generation it loaded, then proceeds to receipt reconciliation and pairing/bootstrap in the same run; it does not fail startup merely to require a second invocation.

Explicit user/admin `clearExplicitly()` increments the in-memory epoch before waiting for the store lock and advances a durable `clearGeneration` tombstone under lock. Internal binding/refresh cleanup is different: it may clear only the exact `(clearGeneration, sessionGeneration)` snapshot it actually loaded. Any in-flight refresh/pair attempt checks epoch + durable clear generation + expected session generation before save. A stale process may not clear or overwrite a newer generation it did not load. Caller cancellation exits without clearing a still-valid credential or abandoning a receipt owned by another pairing attempt.

## P7B.10 Crash after server rotation

Document provider contract and recovery. If refresh rotation invalidates the old token before durable save and the process crashes, the next startup may require browser reauthorization. Do not risk stale-writer token resurrection to mask this failure.

## P7B.10A Provision-result recovery and owned-bootstrap cleanup

Before `/provision`, persist P7A `ProvisioningRecoveryJournalV1` in the OS credential backend. Restart with that journal calls only the device-key-authenticated recover-provision endpoint for the exact bootstrap/idempotency/request digest; it cannot start a new bootstrap until recovery proves the original operation did not commit and its reservation is safely released.

Before a newly authorized V2 session can be saved, persist `BootstrapCleanupObligationV1`. After save, reconcile `consumed_owned`, remove the public proof and wait for removal acknowledgement, delete the exact ephemeral bootstrap key, then mark cleanup complete. Every boundary is idempotent/resumable. A valid V2 session with a pending cleanup obligation performs cleanup only; a steady-state V2 session with cleanup complete performs no receipt/bootstrap calls.

## P7B.11 Typed OAuth errors

Use a class carrying safe fields only:

```ts
type OAuthErrorCode =
  | "authorization_pending" | "slow_down" | "access_denied"
  | "expired_token" | "invalid_grant" | "invalid_token"
  | "invalid_target" | "invalid_client"
  | "temporarily_unavailable" | "server_error" | "protocol_error";
```

Caller cancellation and total/request deadline expiry are separate typed transport/control-flow errors, not OAuth `error` codes. Do not classify by regex over arbitrary `error_description` strings. Retry classification uses HTTP status plus the validated safe OAuth `error` member; free-form descriptions are never authority or telemetry.

## P7B.12 Update every health caller

Changing tunnel health/identity signatures requires updating the actual callers: `TailscaleTunnelProvider.status()`/`doctor()`, `ZrokTunnelProvider.status()`/`doctor()`, `TunnelSupervisor.start()`/monitor/recovery/rollback, both `createTunnelProvider()` calls in `src/npm-scripts/remote.ts`, and direct provider construction in the Tailscale/zrok integration tests. Health receives immutable issuer/resource context and never infers issuer as `<tunnel>/api/auth`.

Tests must fail compilation/coverage if a provider or CLI direct check still infers the issuer, mutates a tunnel merely to inspect durable identity, or initiates bootstrap as a health side effect.

## P7B.13 Remove module-load environment capture

Refactor `src/remote-device/control-plane-client.ts` and every consumer that captures `MCP_SERVER_URL`, `APP_ORIGIN`, or resource identity at import time. Construct immutable identity and local transport explicitly in `src/npm-scripts/remote.ts`/the standalone entry, then inject them through `MCPDevice` into OAuth/bootstrap/resource health and `RemoteChannel`.

Do not rely on constructor-time `process.env` mutation, import order, or rewriting central OAuth endpoints to a local server.

## P7B.14 Protected-resource metadata and challenge

Per-device resource advertises the exact central issuer and the scopes approved in P7A. MCP `401` responses contain the exact RFC 9728 metadata reference. Internal hostnames must never leak in public metadata/challenges.

## P7B.15 Token route isolation

With the proposed shared resource:

```text
mcp:tools token -> /mcp allowed, /api/device/** denied without device:sync
device:sync token -> /api/device/** allowed, /mcp denied without mcp:tools
```

## P7B.16 Concrete source/interface targets and actual callsites

The HTTP runtime owner is the **apps/control-plane tunneled HTTP artifact**. DesktopCommander's `src/server.ts` remains stdio and is not part of the HTTP resource-edge migration. Cross-repository HTTP targets include `apps/control-plane/lib/resource-runtime-watcher.ts`, the private loopback/admin liveness surface, RFC9728/MCP routes, and the public bootstrap-proof route. DesktopCommanderMCP requires migration through this real client/orchestration call graph:

```text
src/remote-device/remote-identity.ts                 # new immutable identity + common URL policy
src/remote-device/device-oauth.ts
src/remote-device/device-oauth-session.ts            # new runtime schemas/types
src/remote-device/oauth-http.ts                      # new bounded/cancellable transport
src/remote-device/credential-store.ts
src/remote-device/native-credential-store.ts
src/remote-device/token-manager.ts
src/remote-device/pairing-lease.ts                   # new cross-process interactive lease
src/remote-device/provisioning-receipt.ts            # authenticated receipt/reconcile + recovery journal + cleanup obligation
src/remote-device/bootstrap-key.ts                   # new ephemeral Ed25519 lifecycle
src/remote-device/bootstrap-client.ts                # challenge/prove/provision/recover-provision/receipt client
src/remote-device/resource-runtime-config.ts         # owner-only atomic config/proof + acknowledgement client
src/remote-device/control-plane-client.ts
src/remote-device/remote-channel.ts                  # inject typed client; remove five free-function imports
src/remote-device/device.ts                          # construct RemoteChannel(tokens, client)
src/remote-device/tunnel/types.ts                    # identity inspection/health/rollback contract
src/remote-device/tunnel/create-tunnel-provider.ts
src/remote-device/tunnel/tunnel-supervisor.ts
src/remote-device/tunnel/tunnel-health.ts
src/remote-device/tunnel/tailscale-cli.ts
src/remote-device/tunnel/tailscale-tunnel-provider.ts
src/remote-device/tunnel/zrok-cli.ts
src/remote-device/tunnel/zrok-tunnel-provider.ts
src/remote-device/tunnel/tailscale-identity-store.ts
src/remote-device/tunnel/zrok-name-store.ts
src/npm-scripts/remote-options.ts
src/npm-scripts/remote.ts                            # runRemote + runTunnelCommand constructors/order
test/test-remote-device-supervision.js               # MCPDevice constructor/test double
test/test-remote-jazz-safety.js                      # MCPDevice/RemoteChannel test double
test/test-remote-tunnels.js
test/integration/tailscale-funnel-e2e.js             # direct provider constructor
test/integration/zrok-remote-mcp-e2e.js              # direct provider constructor
```

Control-plane client interface required by `RemoteChannel`:

```ts
interface DeviceControlPlaneClient {
  register(accessToken: string, input: DeviceRegistrationInput, signal?: AbortSignal): Promise<DeviceRegistration>;
  getJazzToken(accessToken: string, deviceId: string, signal?: AbortSignal): Promise<string>;
  heartbeat(accessToken: string, input: DeviceHeartbeatInput, signal?: AbortSignal): Promise<void>;
  claim(accessToken: string, input: ClaimRemoteCallInput, signal?: AbortSignal): Promise<boolean>;
  complete(accessToken: string, input: CompleteRemoteCallInput, signal?: AbortSignal): Promise<void>;
}
```

`MCPDevice` receives or constructs one typed client from immutable configuration and passes it to `new RemoteChannel(tokens, controlPlaneClient)`. `RemoteChannel` uses it at every current callsite:

| Current `RemoteChannel` path | Required method |
| --- | --- |
| heartbeat callback and `setOnlineStatus()`/shutdown offline update | `heartbeat` |
| `connectOnce()` registration | `register` |
| Jazz `onAuthChanged(expired)` refresh | `getJazzToken` |
| `markCallExecuting()` | `claim` |
| both branches of `updateCallResult()` | `complete` |

Remove imports of `registerDeviceWithControlPlane`, `getJazzDeviceToken`, `sendDeviceHeartbeat`, `claimRemoteCall`, and `completeRemoteCall` from `remote-channel.ts`. Constructor/test doubles must implement the typed interface rather than monkey-patching around hidden free functions. No module-level origin capture remains.

## P7B.17 Tests

```text
RFC8414 pathless/pathful metadata URL
metadata wrong issuer/origin/scheme/path/media type/oversize/malformed arrays
metadata missing code/device-code/refresh/S256/none/required scopes or required endpoint
approved literal loopback accepted only in explicit development; localhost/private/production HTTP rejected
protected-resource metadata exact resource/issuer/scopes and no internal hostname
HTTP request timeout, caller cancellation, abortable sleep, decoded/transfer overflow
all protocol redirects rejected
verification_uri alternate same-origin path/query/fragment and verification_uri_complete alternate path/duplicate-or-unknown query/mismatched user_code rejected
verification_uri + user_code displayed even when exact complete URI opens
access_denied/expired_token handled terminally
429/5xx/transport retry is attempt-capped, jittered, Retry-After bounded, and total-deadline bounded
refresh response without replacement refresh_token retains old token only when provider permits
scope omitted on refresh inherits old scope
effective scope requires device:sync and rejects expansion/mcp:tools
initial, refreshed, and persisted-restart token prove exact issuer + single resource audience before use
hanging JWKS refresh/introspection aborts at min(verifier timeout, remaining operation/device-flow deadline); caller cancellation wins and no token is saved/used
persisted restart token with wrong issuer, missing aud, wrong aud, or extra audience -> reject before RemoteChannel/control-plane request
v2 binding mismatch triggers same-startup reauthorization before refresh
v1 vault triggers same-startup reauthorization
same-process and multi-process clear beat in-flight refresh/pair save
true multi-process refresh serializes and pairing lease opens one browser
stale lease/epoch/generation cannot overwrite newer credential
lost provisioning response/crash recovers original receipt through durable recovery journal + device-key recovery endpoint; no second client
successful V2 persistence resumes consumed_owned proof-removal/bootstrap-key cleanup after crashes
challenge/capability/provision replay and idempotent retry matrix; proof verification commits atomically with direct capability issuance and no durable proof-only state
receipt denial/expiry/abandon cleanup and reservation release
resource-control-bootstrap-v1 has no binary-identity privilege; resource proof signature bytes, expiry, body limit, TLS/SNI/Host address pinning, DNS-rebinding retry
CIMD redirect/private/special-address/DNS-rebinding/compression/oversize rejection
all Tailscale/zrok status/doctor/supervisor/direct constructors use central issuer
resource server starts unconfigured; PRIVATE loopback/admin liveness is healthy and is the only tunnel preflight; RFC9728 remains 503 until exact config ack
exact config ack + public metadata precede /challenge
active proof ack + exact public proof readiness precede /prove; expired/removed proof is not served
startup rollback removes only attempt-created runtime mapping and preserves durable identity
owned-device rollback requires explicit staged deprovisioning
public resource metadata exact
route scope isolation
configured revocation exposure measured for every P7A class; gate stays open until passing
```

## P7B.18 Bootstrap/restart acceptance sequence

Required executable startup cases, all beginning by opening the vault and reading durable tunnel identity **without starting/mutating the tunnel**:

```text
valid V2 session -> verify persisted access-token signature/introspection + exact issuer/single audience -> start/recover tunnel; no bootstrap/receipt endpoint call, no browser
valid V2 expired access token -> refresh, then start/recover tunnel; no bootstrap
legacy/missing session + reusable pending receipt -> start its exact tunnel and resume/reconcile without new challenge
consumed_owned receipt + missing local V2 session -> recovery RFC8628 on the same client/resource, no reprovision
missing session + no receipt -> lazily establish/recover tunnel, bootstrap, persist receipt, then start RFC8628
first run + no tunnel identity -> create stable identity only after vault/receipt inspection shows authorization is needed
refresh terminal reauth error -> same-startup receipt/bootstrap/pair path
second OS process while pairing -> waits/reuses winner; no second browser and no interactive vault lock
ambiguous provisioning response -> authenticated receipt reconciliation; never new client/resource reservation
```

The device always displays validated `verification_uri` + `user_code`, even when it also opens validated `verification_uri_complete`.

## P7B.19 Stage-specific rollback, deprovisioning, and tunnel command safety

Startup tracks an attempt ledger containing pre-existing durable tunnel identity, pre-existing runtime mapping, resource, bootstrap/receipt IDs, and each stage reached. Cleanup is idempotent and may remove only artifacts proven to have been created by that attempt:

| Failure stage | Required action |
| --- | --- |
| before tunnel mutation | release local lease/temporary key only |
| tunnel mapping created, no challenge | `rollbackStartup()` may remove that exact runtime mapping; preserve Tailscale identity/zrok reserved name and stores |
| challenge/proof/capability live | call the signed P7A attempt-abandon endpoint (capability-authenticated after issuance), remove proof/key only after cleanup confirmation, release only attempt-created runtime mapping |
| provisioning ambiguous/`provisioning` | retain receipt/key/tunnel and reconcile P8A ledger; do not guess rollback or issue another bootstrap |
| `provisioned_pending_approval` | call authenticated receipt abandon, wait for cleanup-confirmed terminal state, then remove receipt/key and attempt-created mapping |
| `consumed_owned`/V2 saved | never use startup rollback; run explicit staged deprovisioning |

Explicit deprovisioning order is: disable new issuance/approval, revoke device grant + refresh family + client/resource link, wait until P7A's frozen and tested access-token exposure bound has elapsed or stronger enforcement confirms rejection, mark resource deprovisioned/tombstoned, stop the runtime mapping, and only then optionally delete durable provider identity. Failure at any stage records resumable state and defaults to disabled/fail-closed; it does not silently recreate or rebind a resource.

Tunnel commands enforce:

- `status`, `doctor`, and durable-identity inspection are read-only;
- `rollbackStartup` and automatic error cleanup never delete a Tailscale identity, zrok reserved name, identity-store file, provisioning receipt, or V2 credential;
- `stop`/`restart` first query provider state and require exact expected provider identity, public base URL/resource, and local target; uncertainty or drift fails closed;
- zrok `delete-name` and any future identity deletion are explicit user-only operations, never supervisor recovery. They require no active bootstrap/pairing lease, a deprovisioned/tombstoned central resource, and either interactive typed confirmation of the exact resource or noninteractive `--force --confirm-resource <exact-publicMcpResource>`;
- `--force` alone never authorizes durable identity deletion or bypasses central deprovisioning; automatic code never supplies force/confirmation;
- command output names the provider identity, exact public resource, local target, and whether OAuth deprovisioning is confirmed, without printing secrets;
- if central state is unreachable, destructive deletion is refused. A separately approved break-glass flow must create a durable local cleanup tombstone and is outside P7B until P0/P8A specify it.

Required implementation points are `src/npm-scripts/remote.ts` (`runRemote`, `runTunnelCommand`), `remote-options.ts`, tunnel `types.ts`, `tunnel-supervisor.ts`, both provider/CLI/identity-store implementations, and `test/test-remote-tunnels.js`.

## Exit checklist

- [ ] P0/P1/P7A decisions remain approved and P8A primitives are implemented.
- [ ] P7A contract implemented exactly.
- [ ] OAuth JSON is runtime validated.
- [ ] Every HTTP request is bounded/cancellable.
- [ ] Verification URL is origin-validated.
- [ ] Typed errors replace regex classification.
- [ ] Vault numeric/type validation is correct.
- [ ] Cross-process refresh is serialized/CAS-protected.
- [ ] Clear cannot be undone by in-flight refresh.
- [ ] All tunnel-provider callers updated.
- [ ] Module-load environment capture removed.
- [ ] MCP metadata/challenge exact.
- [ ] Route scopes isolated.
- [ ] Stage-specific rollback/deprovisioning and destructive tunnel safeguards pass.
- [ ] Revocation mechanism/value is frozen and all P10 latency tests pass; this gate is currently OPEN.

## Rollback

Preserve V2 bound vault records, provisioning receipts, durable tunnel identities, and server tombstones. Roll application logic back only to a version that understands the exact issuer/resource binding and receipt state; never silently reinterpret credentials or replay bootstrap. A legacy unbound credential remains invalid and requires same-startup receipt reconciliation or reauthorization.

Use P7B.19 for stage cleanup. If the deployed predecessor cannot understand a nonterminal P7A receipt or P8A operation ledger, halt rollout and complete/compensate that state before binary rollback rather than deleting it. Owned-resource removal always uses staged deprovisioning and remains blocked on the open revocation-exposure gate.
