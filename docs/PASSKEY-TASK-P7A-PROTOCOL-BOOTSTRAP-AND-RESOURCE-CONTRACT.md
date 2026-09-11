# P7A — Central issuer, bootstrap, resource, audience, and protocol contract

Parent: `docs/PASSKEY-TASK-P7-CENTRAL-ISSUER-RESOURCE-SEPARATION.md`

Status: architecture gate; must close before P7B device/resource implementation

Depends on: P0 approved, P1 architecture selected

Blocks: P3 callback/device binding details, P5, P7B, P8B, P9, P10

Review corrections: R-25 through R-32. These corrections do not waive the P0/P1 decisions or the P8A datastore, transaction, locking, and revocation-mechanism gate.

## Objective

Freeze the protocol contract that separates one stable authorization server from exact per-device resources without creating a first-device provisioning cycle or allowing arbitrary resource registration.

## P7A.1 Prefer a pathless production issuer

Preferred production value:

```text
https://auth.desktopcommander.app
```

A pathful issuer is allowed only when the selected auth framework requires it and the exact RFC 8414 discovery route is proven.

For issuer `https://auth.desktopcommander.app/api/auth`, RFC 8414 path insertion is:

```text
https://auth.desktopcommander.app/.well-known/oauth-authorization-server/api/auth
```

Do not generate `/api/auth/.well-known/oauth-authorization-server` as the standards discovery URL.

## P7A.2 Standards-correct metadata URL helper

```ts
export function authorizationServerMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  if (url.search || url.hash) throw new Error("issuer must not contain query or fragment");
  const suffix = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  url.pathname = `/.well-known/oauth-authorization-server${suffix}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
```

Returned metadata `issuer` must equal the configured issuer string exactly; do not normalize two different issuer identifiers into equality after discovery.

### Common URL transport policy

Every issuer, OAuth endpoint, verification URI, resource identifier, protected-resource metadata URL, bootstrap URL, proof URL, and CIMD URL uses one shared validator:

- production permits `https:` only;
- development/test may permit `http:` only when an explicit non-production flag is enabled **and** the host is the literal `127.0.0.1` or `[::1]`; `localhost`, wildcard binds, private LAN names/addresses, credentials, fragments, and DNS-derived loopback are not approved loopback identifiers;
- an approved loopback URL remains an exact loopback URL; metadata is never rewritten between public and local origins;
- endpoint-specific path/origin allowlists still apply after scheme validation;
- redirects are disabled unless a later section explicitly defines a narrower redirect rule.

“HTTPS-or-approved-loopback” below always means this policy. Bootstrap resource-control proof and CIMD retrieval remain HTTPS-only in production and retain their additional SSRF rules.

## P7A.3 Exact resource canonicalization contract

Do not silently trim a trailing slash or rewrite path encodings after a resource identifier has been provisioned.

Provisioning accepts only a canonical URL satisfying:

```text
scheme: https in production
credentials: forbidden
query: forbidden
fragment: forbidden
host: URL parser canonical host form; IDNA policy documented
port: explicit default port rejected; caller must use canonical form
path: exact expected MCP path, normally /mcp
percent encoding: no double-decoding; reject ambiguous encodings
loopback/private hosts: development-only policy
```

Preferred behavior is **reject noncanonical input with a corrective error**, persist one exact string, and compare exact strings everywhere.

## P7A.4 Route audience/scope matrix

Proposed V1 shared-resource model pending P0 approval:

| Route family | Audience | Required scope |
| --- | --- | --- |
| `/mcp` | exact `publicMcpResource` | `mcp:tools` |
| `/api/device/**` | exact `publicMcpResource` | `device:sync` |

Consequences:

- protected-resource metadata for that logical resource advertises both scopes;
- `/mcp` rejects a token that only has `device:sync`;
- `/api/device/**` rejects a token that only has `mcp:tools`;
- no route treats possession of one scope as authority for the other.

If a separate device-sync resource is chosen instead, create a second exact audience and a second token; do not mix models implicitly.

## P7A.5 Deployment ownership contract

Central auth artifact owns:

```text
/api/auth/**
OAuth authorization/device/token/DCR endpoints
JWKS and authorization-server metadata
/sign-in and passkey account UX
/consent
device verification + approval browser UX
trusted bootstrap/resource provisioning control endpoint
account/passkey management
```

Per-device resource artifact owns:

```text
/mcp
RFC 9728 protected-resource metadata
MCP bearer challenge
/api/device/** when that transport is local/per-device
resource/tunnel health
```

A packaging test must prove the per-device artifact cannot expose passkey registration, account management, database migrations, generic OAuth resource administration, or central token issuance.

### P7A.5A Executable local resource-runtime configuration boundary

Current HEAD proves that the local HTTP target is already running before `remote` starts, while its public identity is currently read from process-start environment. V1 therefore requires an explicit runtime configuration boundary; changing the CLI process environment is never considered reconfiguration of the already-running resource server.

The selected V1 boundary is an **atomically watched owner-only runtime state directory** shared by the local resource server and the desktop CLI. Equivalent authenticated local IPC may replace it only by a later ADR with the same acknowledgement/integrity properties.

**V1 HTTP resource-edge owner:** the already-running `apps/control-plane` HTTP artifact that is the target of `MCP_SERVER_URL` and is exposed by Tailscale/zrok. `src/server.ts` in DesktopCommanderMCP remains the stdio/MCP SDK server and is **not** the runtime watcher, public proof handler, RFC 9728 metadata owner, or tunneled HTTP listener. The control-plane repository/revision is a P8B release artifact and must be committed before release evidence can freeze it.

The HTTP edge has two readiness surfaces:

```text
private local liveness: loopback-only admin listener/IPC owned by the control-plane process; healthy in resource_unconfigured mode and NEVER exposed through the public tunnel
public resource readiness: /mcp + RFC9728 metadata + /api/device/** + proof handler; 503/fail-closed until exact runtime revision is applied
```

Tunnel-provider **local preflight uses only the private local liveness surface**, not RFC 9728 metadata. The public metadata check occurs only after the CLI has the stable tunnel identity, writes the runtime configuration, receives the matching acknowledgement, and can reach the public URL. Implementations may use a dedicated loopback admin port or equivalent authenticated local IPC; reusing the tunneled public path as the preflight health check does not satisfy V1.

```text
runtime directory: user-owned, mode 0700 or platform ACL equivalent
resource-runtime-v1.json: mode 0600, atomic temp + fsync + rename + parent-directory fsync
bootstrap-proof-v1.json: mode 0600, atomic temp + fsync + rename + parent-directory fsync; no private key/capability/receipt secret
resource-runtime-ack-v1.json: written durably/atomically by the resource server after successful apply
bootstrap-proof-ack-v1.json: written durably/atomically by the resource server after successful proof install/remove
```

The two acknowledgement files use this exact closed schema:

```ts
type ResourceRuntimeAckOperationV1 =
  | "apply_resource"
  | "install_bootstrap_proof"
  | "remove_bootstrap_proof";

type ResourceRuntimeAckV1 = Readonly<{
  version: 1;
  revision: number;                 // exact input document/tombstone revision
  operation: ResourceRuntimeAckOperationV1;
  canonicalDocumentDigest: string; // sha256-base64url of canonical JSON input or removal tombstone
  resource: string;                 // exact canonical public MCP resource
  bootstrapId: string | null;       // null only for apply_resource
  serverGeneration: number;         // durable monotonic generation allocated by server
  appliedAt: string;                // server UTC RFC3339 timestamp
}>;
```

`resource-runtime-ack-v1.json` accepts only `apply_resource` with `bootstrapId=null`. `bootstrap-proof-ack-v1.json` accepts only install/remove operations with the exact bootstrap ID. A removal is an explicit canonical tombstone document `{version,revision,operation:"remove_bootstrap_proof",resource,bootstrapId}`; the acknowledgement hashes that tombstone, not an absent file. Canonical JSON is RFC 8785 JSON Canonicalization Scheme encoded as UTF-8, with golden cross-language vectors; the digest is SHA-256 base64url without padding.

The resource server durably stores the highest accepted input revision and `serverGeneration`. It accepts a higher revision only after schema/binding checks and successful apply; an exact replay of `(revision, operation, digest, resource, bootstrapId)` may return the already-durable acknowledgement; reuse of a revision with different content, any lower revision, a server-generation regression, or an acknowledgement whose fields do not exactly match the requested mutation is rejected. Thus `apply A@7 -> apply B@8 -> replay A@7` cannot cause ABA. The CLI persists its next revision monotonically across process restarts and never infers success from file disappearance or mtime.

POSIX publication writes an owner-only temp file in the same directory, writes all bytes, `fsync`s the file, atomically renames, then `fsync`s the parent directory; acknowledgement publication uses the same sequence. Windows uses an owner-only ACL, a same-volume temp file, `FlushFileBuffers`, and `ReplaceFileW` or `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`. Because directory-flush guarantees differ on Windows, the implementation must additionally use a flushed generation manifest/write-ahead record or another documented equivalent that recovers the last complete generation after power loss. P7B crash tests kill at every write/flush/replace/manifest boundary on each supported OS.

`resource-runtime-v1.json` contains only runtime-parsed non-secret configuration: contract version, monotonic revision, exact `publicMcpResource`, exact `authorizationServerIssuer`, exact approved JWKS URL/config fingerprint, expected local target, and `proofHandlerEnabled=true`. It contains no OAuth token, bootstrap capability, receipt secret, account identity, or private key. The server validates file owner/ACL, schema, monotonic revision, exact canonical URLs, release config, and expected local target before applying it.

The local resource server starts in `resource_unconfigured` mode. A local health endpoint needed by tunnel providers may be healthy, but `/mcp`, RFC 9728 metadata, `/api/device/**`, and bootstrap proof success remain fail-closed/503 until one exact resource runtime revision is acknowledged. Applying a different resource while an owned/V2 authority is active requires explicit P7A deprovision/re-pair semantics; hot rebinding is forbidden.

First-run ordering is executable:

```text
local resource server already running in resource_unconfigured mode
-> tunnel provider verifies PRIVATE local liveness only (not RFC9728 metadata)
-> CLI inspects vault/receipt/durable tunnel identity without tunnel mutation
-> true first run creates/starts stable tunnel only because no authority exists
-> CLI atomically writes resource-runtime-v1.json for that exact tunnel resource
-> resource server validates/applies and atomically writes matching ack revision
-> CLI reads ack and verifies public RFC 9728 metadata == exact resource + central issuer
-> CLI verifies proof handler is registered/ready for an active proof (no challenge material yet)
-> only now POST /api/bootstrap/v1/challenge
-> CLI signs the returned exact challenge with the ephemeral bootstrap key and atomically writes bootstrap-proof-v1.json
-> resource server validates exact resource/bootstrap/expiry/public-key/signature document and writes proof ack
-> CLI reads proof ack and verifies the exact public derived proof URL returns the expected bounded document
-> only then POST /api/bootstrap/v1/prove
```

`bootstrap-proof-v1.json` contains the already-signed public proof document and its exact bootstrap/resource/expiry binding; the Ed25519 private key remains in the local credential backend. Terminal cleanup atomically removes the proof file, waits for a higher acknowledgement revision proving it is no longer served, then removes the ephemeral key when P7A lifecycle rules permit.

Crash/restart behavior is deterministic: the server reloads the latest valid resource revision before public readiness; expired proof state is never served; a partially written/temp file is ignored; an unacknowledged config/proof revision blocks bootstrap progress. The CLI never calls `/challenge` without resource-config acknowledgement/public metadata readiness and never calls `/prove` without proof acknowledgement/public proof readiness.

P7B must implement this boundary in both standalone/test startup paths and prove that the existing `APP_ORIGIN`/`REMOTE_MCP_RESOURCE` process-start assumption has been removed from the per-device resource edge before first-run bootstrap is accepted.

## P7A.6 Cross-repository compatibility contract

Reviewed baseline on 2026-09-07:

```text
DesktopCommanderMCP repository: https://github.com/drunkod/DesktopCommanderMCP.git
DesktopCommanderMCP reviewed HEAD: 19addf3c7fb5af82bb36424ccca3c003030c4832
control-plane review workspace: /Users/test/Documents/RemoteMCP-Jazz/implementation
control-plane immutable revision: NOT AVAILABLE — workspace currently has no commits
contract version: passkey-remote-auth-v1
```

Because the control-plane workspace has **no commit yet**, R-06 cannot honestly record an immutable control-plane revision today. P7A exit therefore requires the implementation to be committed/transferred to its owning repository and this block updated with that repository URL + exact commit SHA. Do not substitute a dirty working-tree timestamp or local path for an immutable revision.

The versioned contract includes issuer, metadata routes, audience serializer, scopes, token claims, bootstrap schemas, approval schemas, resource lifecycle, and compatibility window.

## P7A.7 Bootstrap issuance trust root and wire protocol

V1 deliberately does **not** trust a shipped desktop secret, executable-name claim, ordinary passkey session, source IP, or hostname suffix. The trust root is the combination of:

```text
HTTPS-authenticated central bootstrap service
+ 256-bit server challenge
+ possession of a device-generated Ed25519 bootstrap private key
+ cryptographic proof that the same key controls the exact public MCP resource
+ one-use capability bound to bootstrap ID + resource + key fingerprint
+ explicit authenticated account approval before ownership/token authority
```

The only eligible pre-approval protocol class is `resource-control-bootstrap-v1`. The class means only that this request follows the V1 key-possession + exact-resource-control proof protocol; it is **not** evidence of native software, vendor binary identity, code signing, installation identity, or remote attestation. It receives no privilege from a claimed executable/client name. Authority before account approval comes solely from possession of the generated private key, successful server-fetched control proof for the exact resource, and the one-use bound capability. Browsers, ordinary signed-in sessions, DCR/CIMD clients, and internal service clients cannot call these endpoints to create arbitrary resource links. All endpoints use HTTPS-or-approved-loopback transport to the configured central issuer, accept bounded JSON, disable redirects, and return `Cache-Control: no-store`.

### Step A — challenge issuance

```http
POST /api/bootstrap/v1/challenge
Content-Type: application/json
Idempotency-Key: <128-bit-or-greater CSPRNG base64url value>

{
  "version": 1,
  "resource": "https://device.example/mcp",
  "client_class": "resource-control-bootstrap-v1",
  "device_public_key": "<base64url raw 32-byte Ed25519 public key>"
}
```

Eligibility and abuse controls:

- exact canonical production resource only;
- `client_class` fixed to `resource-control-bootstrap-v1` on this endpoint and grants no software/binary-identity privilege;
- public key is exactly raw Ed25519/32 bytes and its SHA-256 fingerprint is persisted with the reservation;
- no account ID, client ID, scopes, redirect URI, callback URL, or ownership field is accepted;
- challenge and bootstrap IDs come from a CSPRNG: challenge is 256 bits and bootstrap ID is at least 128 bits;
- maximum challenge TTL is 5 minutes;
- durable limits are exactly one active reservation/resource, at most 3 active challenges/key fingerprint, 20 issuances/hour/resource, 10/hour/key fingerprint, and 60/hour/coarse source bucket; deployments may lower the issuance rates/active-key limit but may not permit concurrent resource reservations or remove limits;
- limit checks and insertion are one durable operation; rejection is `429` with a bounded `Retry-After` and creates no reservation;
- the unique active canonical-resource reservation is acquired here; an existing live reservation returns `409 resource_reserved` rather than creating a second bootstrap;
- challenge response contains no OAuth client/resource row and grants no bearer authority.

Challenge record:

```ts
type BootstrapChallengeV1 = {
  version: 1;
  bootstrapId: string;
  challenge: string;
  canonicalResource: string;
  devicePublicKey: string;
  deviceKeyFingerprint: string;
  clientClass: "resource-control-bootstrap-v1";
  challengeIdempotencyKeyHash: string;
  createdAt: Date;
  expiresAt: Date;
  state: BootstrapLifecycleStateV1;
};
```

### Step B — proof exchange and capability issuance

Only a caller that proves possession of the stored private key **and** passes the server-fetched resource-control proof may exchange the challenge:

```http
POST /api/bootstrap/v1/prove
Content-Type: application/json
Idempotency-Key: <128-bit-or-greater CSPRNG base64url value>

{
  "version": 1,
  "bootstrap_id": "<opaque id>",
  "device_key_signature": "<base64url Ed25519 signature>"
}
```

`device_key_signature` covers these exact UTF-8 bytes:

```text
DC-REMOTE-BOOTSTRAP-PROVE-V1\n
<bootstrapId>\n
<Idempotency-Key>\n
```

The server derives and fetches the proof endpoint in P7A.8; the caller may not submit a proof URL, resolved address, or authoritative proof body. Proof verification is an in-transaction event only: in one durable transaction the server locks the challenge/reservation, rechecks expiry/idempotency/key/resource binding, verifies the already-fetched proof result, creates and stores the sealed one-use capability response, and CASes directly `challenge_issued -> capability_issued`. No durable proof-only intermediate state exists and no success is returned unless capability issuance commits.

```json
{
  "version": 1,
  "bootstrap_id": "opaque",
  "bootstrap_capability": "256-bit-or-greater-random-secret",
  "resource": "https://device.example/mcp",
  "device_key_fingerprint": "sha256-base64url",
  "expires_in": 300
}
```

Capability entropy is at least 256 CSPRNG bits, maximum TTL is 5 minutes, and verification uses a keyed hash. To make a lost successful response safely retriable, the server may retain only a KMS-sealed copy of the response secret until expiry, keyed by `(bootstrapId, Idempotency-Key, requestDigest)`; it is erased on consumption/expiry. The same key and digest return the same response, the same key with a different digest returns `409 idempotency_mismatch`, and a different key after issuance returns `409 bootstrap_replay`. There is **no unrestricted anonymous capability issuance endpoint**.

### Step C — idempotent provisioning

```http
POST /api/bootstrap/v1/provision
Authorization: DC-Bootstrap <bootstrap_capability>
Content-Type: application/json
Idempotency-Key: <128-bit-or-greater CSPRNG base64url value>

{
  "version": 1,
  "bootstrap_id": "<opaque id>",
  "device_key_signature": "<base64url Ed25519 signature over the provision domain>"
}
```

The provision signature covers `DC-REMOTE-BOOTSTRAP-PROVISION-V1`, bootstrap ID, and the exact `Idempotency-Key`, each LF-terminated. The server accepts no caller-selected client ID, resource, scopes, redirect URI, or account. It verifies capability hash, unexpired state, exact stored resource/key binding, and signature before invoking the P8A provisioning transaction/state machine. The capability is consumed only by the first successful provisioning commit; failed pre-commit attempts remain retryable until its deadline.

## P7A.8 Resource-control proof — exact V1 format and SSRF controls

The resource edge exposes only this derived path during bootstrap:

```text
https://<canonical-resource-host>/.well-known/desktop-commander/bootstrap-proof/<bootstrapId>
```

The signed byte string is UTF-8 with literal LF separators and no JSON canonicalization ambiguity:

```text
DC-REMOTE-BOOTSTRAP-V1\n
<bootstrapId>\n
<exact canonical resource>\n
<base64url challenge>\n
<expiresAt Unix seconds>\n
```

Response media type: `application/json`; maximum body: 16 KiB.

```json
{
  "version": 1,
  "bootstrap_id": "...",
  "resource": "https://device.example/mcp",
  "challenge": "...",
  "expires_at": 1234567890,
  "device_public_key": "...",
  "signature": "<base64url Ed25519 signature>"
}
```

The central verifier requires every field to equal its stored challenge record and verifies Ed25519 over the exact byte string above.

### SSRF-safe fetch contract

Before connecting, resolve the canonical hostname and reject every address in loopback, RFC1918/private, link-local, carrier-grade NAT, multicast, unspecified, documentation/test, benchmarking, metadata-service, IPv4-mapped private, and IPv6 unique-local/link-local/special ranges according to the platform's maintained IP classification library. Production bootstrap never targets localhost/private addresses.

For the actual HTTPS connection:

- choose only an already-validated public address;
- pin the connection to that address while preserving the original hostname for TLS SNI and HTTP `Host`;
- require normal certificate/hostname verification for the canonical hostname;
- redirects are disabled;
- DNS is re-resolved and revalidated on every retry; a response from an address not in the validated set is rejected;
- connect timeout <= 5 s, total fetch <= 10 s;
- stream at most 16 KiB and abort immediately on overflow;
- require status 200 and `application/json` (optional charset only);
- reject compression bombs by enforcing decoded-byte limit as well as transfer limit;
- no proxy/environment proxy is used unless an explicitly audited production transport supports equivalent address pinning.

The device's bootstrap key is ephemeral for this lifecycle, never leaves the local credential backend, and signs exchange/provision/abandon requests. It is deleted only after `consumed_owned` **and** a V2 session are durably saved, or after a non-owned terminal receipt confirms cleanup.

## P7A.9 Provisioning reservation, receipt, and state machine

P8A determines whether provider/application records share one SQL transaction. P7A defines the required durable states, idempotency anchors, and compensations; no implementation may call a multi-store sequence atomic.

```ts
type BootstrapLifecycleStateV1 =
  | "challenge_issued"
  | "capability_issued"
  | "provisioning"
  | "provisioned_pending_approval"
  | "consumed_owned"
  | "expired"
  | "revoked"
  | "abandoned"
  | "provision_denied";
```

`consumed_owned`, `expired`, `revoked`, `abandoned`, and `provision_denied` are terminal. `provisioning` is externally visible only when P8A requires a durable cross-store roll-forward; a single-store transaction may move directly from `capability_issued` to `provisioned_pending_approval`.

| From/event | Durable action and next state | Required cleanup/response |
| --- | --- | --- |
| no row + valid challenge request | acquire unique active reservation; `challenge_issued` | concurrent resource attempt is `409 resource_reserved` |
| `challenge_issued` + valid caller signature/resource proof | atomically verify proof event + create sealed bound capability response + CAS directly to `capability_issued` | no durable proof-only state; erase proof material at terminal state |
| `capability_issued` + valid provision request | create/reconcile exact OAuth resource, first-party public client, client-resource link, and receipt under P8A; `provisioning` or `provisioned_pending_approval` | consume capability only after successful commit; account remains unset |
| `provisioning` + worker retry | roll forward the same operation ledger | never create a second client/link/receipt |
| `provisioned_pending_approval` + explicit authenticated approval/token commit | bind account, finalize grant/refresh family, release reservation into owned resource; `consumed_owned` | return/reconcile owned receipt |
| pending + user denial | cancel device codes; `provision_denied` | revoke pending grants/families, disable and unlink pending client, GC only resource rows created by this attempt when still unowned |
| any non-owned live state + deadline | CAS to `expired` | same cleanup as denial; release reservation; erase sealed capability |
| any non-owned live state + authenticated receipt abandon | CAS to `abandoned` | same cleanup as denial; idempotent terminal response |
| administrative/security revocation before ownership | `revoked` | same cleanup plus audit/security event |

Cleanup never deletes or mutates a pre-existing owned resource, client, tunnel identity, or another attempt's records. Provider deletion is delayed until its reference count is zero and the audit-retention/tombstone rule selected by P8A permits it. Cleanup retries use the lifecycle/operation ledger until complete; a terminal receipt is not reported as cleanup-confirmed while required compensation is outstanding.

Provisioning response contains a durable local recovery credential:

```ts
type ProvisioningReceiptV1 = {
  version: 1;
  issuer: string;
  bootstrapId: string;
  resource: string;
  oauthClientId: string;
  receiptId: string;             // 128+ random bits
  receiptSecret: string;         // 256+ CSPRNG bits; server stores keyed hash
  state: BootstrapLifecycleStateV1; // initially provisioned_pending_approval
  createdAt: number;
  expiresAt: number;
};
```

The device persists the whole receipt **before** RFC 8628 begins, in the OS credential backend but in a record separate from OAuth tokens. Receipt status and abandonment use only derived central URLs and receipt authentication:

```http
GET  /api/bootstrap/v1/receipts/<receiptId>
POST /api/bootstrap/v1/receipts/<receiptId>/abandon
Authorization: DC-Provisioning-Receipt <receiptSecret>
```

Before a receipt exists, the key holder may explicitly abandon a live attempt through `POST /api/bootstrap/v1/attempts/<bootstrapId>/abandon`, an idempotent request signed over `DC-REMOTE-BOOTSTRAP-ABANDON-V1`, bootstrap ID, and `Idempotency-Key`; when a capability has been issued, it must also authenticate with that capability. This endpoint can only transition the same unowned attempt to `abandoned` and run its cleanup—it cannot affect an owned resource.

The status response is a bounded runtime-validated projection of the lifecycle state and cleanup completion; it never returns capability, tokens, account identity, or a new client ID. A later start reconciles this receipt before issuing a new challenge. `consumed_owned` with no durable local V2 session starts a fresh RFC 8628 authorization against the same receipt client/resource after explicit user approval; it never provisions another client. A new bootstrap is permitted only after the server reports a non-owned terminal state with cleanup complete, or after an explicit P8A recovery procedure resolves an unreachable/ambiguous receipt.

### Retry versus replay

- same endpoint + bootstrap/receipt ID + `Idempotency-Key` + request digest returns the original status/result and creates no new records;
- reuse of an idempotency key with a different digest is `409 idempotency_mismatch`;
- a consumed capability presented with a new idempotency key is `409 bootstrap_replay`, never a second provisioning result;
- wrong capability, key signature, or receipt secret is `401`; a known expired/terminal credential is `410` without disclosing account state;
- a different key/capability against an active resource reservation is `409 resource_reserved` and is security-logged/rate-limited;
- transport retry is permitted only within the original deadline; receipt reconciliation, not capability reuse, resolves an ambiguous successful provisioning response.

The one-use bootstrap capability is consumed at successful provisioning, not retained for OAuth polling.

### P7A.9A Lost-provision-response recovery journal

Before the desktop sends `/api/bootstrap/v1/provision`, it writes an OS-vault-protected `ProvisioningRecoveryJournalV1` **before network I/O**:

```ts
type ProvisioningRecoveryJournalV1 = {
  version: 1;
  issuer: string;
  resource: string;
  bootstrapId: string;
  idempotencyKey: string;
  canonicalProvisionRequestDigest: string;
  bootstrapKeyReference: string; // opaque local key-store reference; not private key bytes
  createdAt: number;
  expiresAt: number;
};
```

The one-use capability itself is still not persisted. If the process loses/crashes after the server may have committed provisioning but before the receipt is durably saved, restart MUST process this journal before asking for a new challenge. The server exposes an idempotent device-key-authenticated recovery operation:

```text
POST /api/bootstrap/v1/recover-provision
DC-REMOTE-BOOTSTRAP-RECOVER-V1\n<bootstrapId>\n<idempotencyKey>\n<canonicalProvisionRequestDigest>\n
-> committed: return the exact original sealed/authenticated provisioning receipt; create nothing new
-> known pre-commit failure + reservation released: explicit safe-to-restart-bootstrap result
-> provisioning/ambiguous: return bounded in-progress/repair state; no new client/resource
-> signature/key/digest mismatch: reject
```

The server verifies the original stored device public key, exact idempotency record/request digest, resource reservation, and lifecycle state. Recovery can only replay/read the **original** provisioning result; it cannot choose a new client/resource/scope or mint a second receipt. After the recovered receipt is durably saved, the recovery journal is atomically cleared. If the journal cannot be reconciled before expiry, the device stays in repair mode rather than issuing a second bootstrap.

### P7A.9B Successful-ownership bootstrap cleanup obligation

Successful token/session persistence does not silently abandon bootstrap material. Before or together with the first durable V2 session save, record a local `BootstrapCleanupObligationV1` keyed by exact issuer/resource/receipt/bootstrap ID. After session persistence, an idempotent worker:

```text
reconcile authenticated receipt status -> require consumed_owned
-> remove bootstrap-proof-v1.json atomically
-> wait for proof-removal acknowledgement proving public proof returns 404
-> delete exact ephemeral bootstrap key reference
-> mark local cleanup obligation complete
```

Crash at any boundary resumes the same obligation. A normal V2 restart with **no pending cleanup obligation** performs zero bootstrap/receipt network calls. A restart with a valid V2 session **and** a pending cleanup obligation resumes cleanup only; it never opens a browser, reprovisions, or changes resource/client identity. The durable consumed-owned receipt may remain as the reauthorization anchor, but its bootstrap proof/key must not remain after cleanup completion.

## P7A.10 Device authorization after provisioning and restart rule

`provisioned_pending_approval` may start the first RFC 8628 flow. A `consumed_owned` receipt may start only a recovery RFC 8628 flow when no valid local V2 session exists; it reuses the same client/resource and still requires explicit authenticated user approval:

```text
client_id=<receipt.oauthClientId>
resource=<exact receipt.resource>
scope=device:sync offline_access
```

The pending device-authorization record stores server-authoritative client ID, resource, requested scopes, bootstrap/receipt ID, and presentation metadata.

Normal startup is **vault-first and bootstrap-lazy**:

```text
open credential store
-> load durable tunnel identity/config without starting or mutating the tunnel
-> derive/validate exact issuer + resource binding when an identity exists
-> load and validate V2 issuer/resource-bound OAuth session
   -> valid + unexpired: start/recover the stable tunnel, then use directly
   -> valid + refresh needed: refresh under the short vault-lock contract, then start/recover tunnel
   -> missing/legacy/revoked: load provisioning receipt before any new bootstrap
       -> reusable pending receipt: start/recover its exact tunnel resource and resume RFC 8628/reconciliation
       -> consumed_owned but token response/session missing: recovery RFC 8628 on the same client/resource
       -> cleanup-confirmed non-owned terminal receipt: remove local receipt/key and continue
       -> no reusable receipt: lazily establish/recover the stable tunnel, expose proof, and bootstrap
-> first run with no durable tunnel identity creates/reserves an identity only after vault/receipt inspection proves authorization work is required
```

A steady-state valid V2 session with no bootstrap cleanup obligation never calls challenge, proof, provision, or receipt endpoints and never opens a browser. A valid V2 session with a pending post-persist cleanup obligation may call only receipt-status/proof-removal cleanup until that obligation completes. Merely checking tunnel health never invokes bootstrap. The receipt is durable before RFC 8628 polling, so process restart resumes rather than reprovisions.

## P7A.11 Browser approval input boundary

Browser mutation input is intentionally small:

```ts
type ApprovePendingDeviceRequest = {
  approvalReference: string; // opaque 128+ bit reference; not provider authorization ID
  decisionNonce: string;
  csrfToken: string;
};
```

Server loads subject from the authenticated session, resolves `approvalReference` through a session-bound, unexpired, one-purpose mapping to the provider `pendingDeviceAuthorizationId`, then loads client/resource/scopes/device presentation from trusted pending state. The reference is single-decision, rotates/expires with the pending request, and cannot be used from another authenticated session. Browser never receives or supplies the provider authorization ID and never supplies authoritative `accountId`, `resource`, `oauthClientId`, or scopes.

## P7A.12 Resource lifecycle

Define operations:

```text
disable resource -> no new issuance immediately; existing-token exposure bounded by token/revocation policy
rotate tunnel/resource -> provision new exact identifier; old tokens are not rebound
transfer/re-pair -> new association transaction, not subject mutation
lost device -> revoke refresh family + disable/unlink client as policy requires
delete -> terminal after grants/tokens/links are revoked or expired
```

## P7A.13 Revocation latency implementation contract — release evidence deferred to P10

The mechanism and release value are intentionally **not closed** in this task. The candidate upper ceiling is:

```text
MAX_POST_REVOCATION_ACCESS_TOKEN_EXPOSURE <= 300 seconds
```

P0/P1 must confirm provider/library capabilities and P8A must choose and document short access-token TTL and/or version, introspection, or denylist enforcement, including cache invalidation and failure behavior. Refresh/grant issuance must be denied immediately after authoritative revocation, but this statement alone does not close already-issued-token exposure.

P7A/P7B handoff requires the enforcement mechanism, failure behavior, numeric configuration source/upper bound, cache invalidation semantics, and observable timing hooks to be frozen and implementation-testable. **P7A/P7B do not depend on future P10 results to exit.** P10 later owns release evidence: it records `revokedAt` and first rejected request time for account, device, resource, client, grant, refresh family, and restored snapshots; tests every revocation class against the configured maximum; and fails release promotion on any sample over it. P8B/P9 pre-production implementation and rehearsal may proceed once the mechanism/test hooks exist, but no production promotion may claim the latency guarantee until P10 evidence is green.

## P7A.14 Server-enforced client-class matrix

| Client class | Registration | Grants | Scopes | Redirect/PKCE policy | Resource authority |
| --- | --- | --- | --- | --- | --- |
| `resource-control-bootstrap-v1` | key-possession + exact-resource-control proof only; no binary-identity privilege; never public DCR/CIMD | device code + refresh | exactly `device:sync offline_access` in V1 | no redirect URI and no authorization-code flow | exactly one server-linked resource; V1 receipt + explicit account approval |
| RFC 7591 third party | public DCR with schema/size/rate limits | authorization code + refresh only | `mcp:tools`; `offline_access` only when provider policy approves | public clients require PKCE S256; exact registered redirect match | no resource admin, bootstrap, device scope, or arbitrary link |
| CIMD URL client | server fetches HTTPS metadata under CIMD SSRF policy | authorization code + refresh only | `mcp:tools`; `offline_access` only when provider policy approves | public clients require PKCE S256; exact metadata redirect match | no resource admin, bootstrap, device scope, or arbitrary link |
| internal client | authenticated server-side registration only | explicit service-principal allowlist | explicit least-privilege allowlist | redirect/auth method fixed by internal policy | explicit RBAC policy; cannot self-select class |

Client class is immutable server metadata. Browser, DCR, or CIMD input cannot promote it. Third-party/CIMD requests for `device:sync`, device-code grant, bootstrap endpoints, or arbitrary resource links fail closed; `resource-control-bootstrap-v1` requests for `mcp:tools` fail closed. No route authorizes a request merely because it claims to be first-party/native desktop software.

For public authorization-code clients, `code_challenge_method=S256` is mandatory (`plain` and omission are rejected). Redirect URIs are absolute, have no credentials or fragment, and are exact-string matched at authorization and token exchange. Production redirects use HTTPS. Native-loopback redirects may use HTTP only with literal `127.0.0.1` or `[::1]`, an explicit port, and an exact registered path; `localhost`, wildcard host/port/path, private LAN addresses, custom-scheme fallback, prefix matching, and open redirectors are forbidden unless P0 separately approves and specifies them.

CIMD retrieval accepts only an HTTPS metadata URL, derives no secondary arbitrary URL, sends no ambient credentials/cookies, and disables redirects in V1. It uses P7A.8 address-class rejection, per-attempt DNS resolution and address pinning with hostname SNI/Host, TLS verification, proxy prohibition, decoded/transfer byte limits, content-type enforcement, timeout/deadline, and retry revalidation. Every redirect URI and endpoint read from CIMD metadata is independently validated; fetched metadata can create only the CIMD class and its matrix permissions.

## P7A.15 Implementation/handoff tests (P10 reruns release-timed evidence later)

```text
unknown resource -> invalid_target
hostname-suffix-only proof -> reject
bootstrap replay -> reject
expired capability -> reject
resource-control redirect to other origin -> reject
private/loopback SSRF target in production -> reject
ordinary passkey session creates resource -> reject
claimed native/first-party binary identity without key + exact resource proof -> no privilege/reject
wrong/unknown/legacy client_class -> reject
browser swaps client/resource/scope/provider authorization ID -> reject
client requests other device resource -> reject
noncanonical resource variant -> reject
resource disable -> future issuance denied
same prove idempotency key/digest -> identical capability response; changed digest -> conflict
crash before direct challenge_issued -> capability_issued commit -> remains challenge_issued; crash after commit -> exact idempotent capability response; no proof-only durable state
lost provisioning response/process crash -> OS-vault recovery journal + device-key-authenticated recover-provision returns original receipt; never second provisioning
receipt denial/expiry/abandon -> pending device code/client/link cleanup + reservation release
CIMD redirect/private/DNS-rebinding/compression target -> reject
metadata missing required device grant/auth method/scope -> fail before pairing
RFC8628 complete URI present -> verification URI and user_code still displayed
poll cancellation/deadline/429/5xx retry -> bounded behavior
exact audience list contains extra audience -> reject
revocation enforcement hook/config fixture proves bounded policy can be measured; P10 owns real timed rollout blocker evidence
```

## P7A.16 Cross-store ownership contract

P8A's cross-store ADR is normative. P7A records participate as follows:

| Record | Authority | Key | Cross-store behavior |
| --- | --- | --- | --- |
| bootstrap challenge/capability hash | auth SQL | `bootstrapId` | SQL CAS |
| OAuth resource/client/link | auth/OAuth SQL | canonical resource/client id | same SQL transaction when adapter permits; otherwise outbox roll-forward |
| provisioning reservation/receipt | application auth SQL | canonical resource + `receiptId` | idempotency anchor |
| account-device ownership | application/Jazz boundary | account + stable device | finalized only after approval event; outbox/inbox if Jazz separate |
| local provisioning receipt | OS credential store | exact issuer/resource | reconciliation hint, never server authority |

No design may label a multi-store operation “atomic”. If records span stores, use durable outbox/inbox and roll-forward/compensation states specified in P8A.

## P7A.17 Concrete implementation/interface targets

Central auth/control-plane side (owned by the control-plane repository and subject to its final P1 layout):

```text
apps/control-plane/app/api/bootstrap/v1/challenge/route.ts
apps/control-plane/app/api/bootstrap/v1/prove/route.ts
apps/control-plane/app/api/bootstrap/v1/provision/route.ts
apps/control-plane/app/api/bootstrap/v1/recover-provision/route.ts
apps/control-plane/app/api/bootstrap/v1/attempts/[bootstrapId]/abandon/route.ts
apps/control-plane/app/api/bootstrap/v1/receipts/[receiptId]/route.ts
apps/control-plane/app/api/bootstrap/v1/receipts/[receiptId]/abandon/route.ts
apps/control-plane/lib/bootstrap-records.ts
apps/control-plane/lib/bootstrap-proof-verifier.ts
apps/control-plane/lib/ssrf-safe-fetch.ts
apps/control-plane/lib/oauth-client-policy.ts
apps/control-plane/app/api/oauth/dcr/v1/route.ts
apps/control-plane/app/api/oauth/cimd/v1/route.ts
apps/control-plane/lib/oauth-resource-provisioning.ts
apps/control-plane/lib/resource-runtime-watcher.ts        # owner/ACL/schema/revision watcher + immutable applied snapshot
apps/control-plane/lib/resource-runtime-store.ts          # acknowledged runtime/proof snapshot + monotonic revision
apps/control-plane/app/api/remote/liveness/route.ts       # private-loopback/admin surface only; not tunneled
apps/control-plane/app/.well-known/oauth-protected-resource/mcp/route.ts
apps/control-plane/app/api/bootstrap/resource-proof/[bootstrapId]/route.ts
apps/control-plane/app/api/mcp/route.ts                   # or final exact HTTP MCP route owner
```

DesktopCommanderMCP orchestration/client side (concrete targets in this repository):

```text
src/remote-device/bootstrap-client.ts                    # challenge/prove/provision/recover/receipt client
src/remote-device/resource-runtime-config.ts             # atomic owner-only config/proof writer + ack reader
src/remote-device/bootstrap-key.ts                       # new Ed25519 lifecycle/signing helper
src/remote-device/provisioning-receipt.ts                # new authenticated receipt parser/reconciler
src/remote-device/token-manager.ts                       # vault-first receipt/pair/bootstrap orchestration
src/remote-device/device.ts                              # inject identity/bootstrap/control-plane dependencies
src/npm-scripts/remote.ts                                # reorder startup; lazy tunnel/bootstrap activation
src/remote-device/tunnel/types.ts                        # stable identity inspection without tunnel mutation
src/remote-device/tunnel/create-tunnel-provider.ts
src/remote-device/tunnel/tunnel-supervisor.ts
src/remote-device/tunnel/tailscale-tunnel-provider.ts
src/remote-device/tunnel/zrok-tunnel-provider.ts
test/test-remote-tunnels.js
new bootstrap proof/receipt/restart integration tests
```

The control-plane HTTP proof handler returns a document only for the exact active `bootstrapId`, challenge, resource, key, and expiry and returns `404` after terminal cleanup. DesktopCommanderMCP never adds this route to `src/server.ts`. Tunnel providers expose the already-running control-plane HTTP target; they do not manufacture or carry an authoritative `resourceControlProof` string. Their preflight checks the separate private local liveness surface, while public RFC 9728/proof readiness is checked only after runtime acknowledgement.

The SSRF-safe fetch implementation requires an HTTP/TLS connector capable of connecting to a prevalidated pinned IP while retaining canonical hostname SNI/Host. A generic `fetch(url)` that re-resolves DNS internally without pinning does not satisfy P7A.8.

## Exit checklist

- [ ] P0 approves issuer, resource model, client classes, and proposed revocation ceiling.
- [ ] P1 proves the selected auth framework can implement the frozen metadata/bootstrap/client-class contract.
- [ ] P8A freezes transaction/outbox, cleanup ledger, receipt, locking, and revocation enforcement primitives.
- [ ] Standards discovery URL is exact.
- [ ] Canonical resource serializer/rejection rules frozen.
- [ ] Route audience/scope matrix frozen.
- [ ] Central/per-device artifact ownership frozen.
- [ ] Cross-repository contract version recorded.
- [ ] Bootstrap capability schema frozen.
- [ ] SSRF-safe resource-control proof specified.
- [ ] Provisioning idempotency/transaction specified.
- [ ] Browser approval input boundary minimized.
- [ ] Client classes specified.
- [ ] Resource lifecycle and stage-specific cleanup specified.
- [ ] Revocation mechanism/configuration source, failure behavior, numeric upper-bound contract, and timing hooks are frozen; P10 timed **release evidence is explicitly downstream and is not a P7A exit dependency**.

## Rollback

Never roll a provisioned central-issuer credential back into an unbound same-origin model. Before production, protocol drafts may be replaced. After provisioning starts, rollback preserves exact resource records, client links, bootstrap audit/tombstone state, receipts, and credential bindings while application behavior is reverted compatibly.

Rollback is stage-specific:

- before provisioning commit: expire/revoke the challenge/capability, release its reservation, erase the served proof, and undo only tunnel runtime state created by that startup attempt;
- during P8A `provisioning`: stop new work and let the durable operation ledger roll forward or compensate; never manually delete one store and call the sequence rolled back;
- pending approval: invoke authenticated receipt abandonment, wait for cleanup-confirmed terminal state, then remove the local receipt/key and attempt-owned runtime mapping;
- `consumed_owned`: use the explicit resource/device deprovisioning flow—deny issuance, revoke grant/refresh family/client link, wait for the frozen access-token exposure bound, then remove resource/tunnel state. Bootstrap rollback must never deprovision an owned device.

Automatic rollback must not run a provider identity/name deletion command. Durable tunnel identity deletion is an explicit destructive user operation governed by P7B safeguards.
