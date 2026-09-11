# P10 — Verification, security, and platform acceptance matrix

Parent: `docs/PASSKEY-ONLY-REGISTRATION-TASK-INDEX.md`

Owner: auth/control-plane + DesktopCommanderMCP + security/release engineering

Depends on: P2, P3, P4, P5, P6, P7A, P7B, P8A, P8B, P9, P9A executable deployment-state/telemetry foundation

Blocks: P11 production rollout

## Objective

Prove the complete passkey-only registration, sign-in, device authorization, central-issuer/per-device-resource, persistence, migration, and recovery contract under positive, negative, concurrent, replay, browser, and restart conditions.

P10 is an evidence gate. A feature is not considered complete because a happy-path browser demo works. Each invariant below must have an automated or explicitly documented manual proof, and every security-sensitive success path must have a paired rejection case.

## P10.1 Freeze the test contract

Before writing tests, copy the accepted values from P0/P1 into the test environment:

```text
PASSKEY_RP_ID
PASSKEY_ORIGIN
AUTHORIZATION_SERVER_ISSUER
required UV policy
supported browser/platform matrix
recovery policy
credential session schema version
resource provisioning policy
P7A.MAX_POST_REVOCATION_ACCESS_TOKEN_EXPOSURE_SECONDS (numeric; proposed V1 300, pending security approval)
P9A canonical deployment-state/threshold/mutation/telemetry artifact digest
application schema compatibility min/max + required/known-incompatible capabilities
```

Tests must fail fast if these values are absent or accidentally point at production.

## P10.2 Test layers

Run all five layers:

1. pure unit tests;
2. auth/control-plane integration tests;
3. DesktopCommanderMCP device integration tests;
4. browser/WebAuthn end-to-end tests;
5. manual real-platform acceptance.

No layer substitutes for another. Virtual authenticators are ideal for deterministic security tests; real platform authenticators are required for final UX acceptance.

## P10.3 Unit tests — registration intent

Test the registration-intent primitive from P3:

```text
create -> valid before expiry
consume -> succeeds exactly once
consume twice -> reject
expired -> reject
wrong purpose -> reject
wrong callback binding -> reject
tampered opaque id/token -> reject
unknown id -> reject
```

If the intent is database-backed, also test two concurrent consume operations and require exactly one commit.

## P10.4 Unit tests — callback safety

For every helper that accepts a callback/return URL:

```text
/device/approve?request=<opaque> -> accept
/consent?request=<opaque> -> accept
/dashboard/devices -> accept
/dashboard/passkeys -> accept
/dashboard/passkeys/child -> reject
/dashboard/passkeys?x=1 -> reject
https://evil.example -> reject
//evil.example/path -> reject
\\evil.example -> reject
/%2f%2fevil.example -> reject where decoding would become network-path reference
javascript:... -> reject
data:... -> reject
```

Canonicalize exactly once and test encoded edge cases.

## P10.5 Unit tests — WebAuthn user handles

Required assertions:

- generated user handle is opaque random bytes/identifier;
- handle length is within WebAuthn implementation limits;
- no email/name/device hostname appears in the handle;
- handle is stable for the account after creation;
- two accounts do not share a handle;
- logs never print the raw handle unless a deliberate non-secret policy says otherwise.

## P10.6 Unit tests — RP/origin configuration

Reject invalid production configuration:

```text
RP ID contains scheme
origin contains path when exact origin expected
PASSKEY_ORIGIN hostname is not exactly the release-approved PASSKEY_RP_ID in V1
production origin uses http
issuer has unexpected trailing/path mutation
issuer and RP origin drift unexpectedly
```

The V1 production profile uses exact RP-ID/origin-host equality, not generic suffix logic. If P0 later approves a parent-domain RP ID, P0/P2/P10 must change together and use a public-suffix-aware policy with dedicated negative tests. WebAuthn `http://localhost` development is an explicit browser-only exception; it must not loosen P7A OAuth/resource/bootstrap URL policy.

## P10.7 Unit tests — credential binding

For the P7 versioned vault object, test:

```text
version supported + issuer exact + resource exact -> usable
wrong version -> reauthorize
wrong issuer -> reauthorize
wrong resource -> reauthorize
missing issuer/resource -> legacy unbound -> reauthorize
malformed JSON -> clear + reauthorize
expired access token + valid refresh binding -> refresh
unexpired persisted token + matching serialized issuer/resource but wrong token iss -> reject before use
unexpired persisted token + missing/wrong/multiple aud -> reject before use
```

Never "repair" a mismatch by stamping runtime values onto stored tokens.

## P10.8 Unit tests — final-passkey guard

Test management policy from P6:

```text
2 passkeys -> delete one allowed
1 passkey -> delete rejected
2 concurrent deletes with count=2 -> exactly one succeeds
fresh-auth requirement missing -> reject
account-A session + account-B passkey during reauth -> reject; no marker/session privilege transfer
fresh-auth marker account != current session account -> reject
fresh-auth marker sessionId != current session ID after rotation/sign-out -> reject
client-supplied fresh-auth account/session/timestamp -> ignored/reject
wrong account passkey id -> reject
```

The invariant must be transactional, not count-then-delete in separate unprotected operations.

## P10.8A Fresh-auth account/session binding

Create two accounts A and B with discoverable credentials. Start a sensitive-operation reauthentication from an authenticated A session and deliberately select B's passkey. The verifier may successfully authenticate B's credential cryptographically, but the fresh-auth layer must reject because `assertedCredentialOwner != preReauthSession.accountId`. It must not switch the browser account, rotate into B, or mint any fresh-auth marker.

Positive case: A session + A passkey rotates/refreshes to current session S1 and yields only `FreshAuth(accountId=A, sessionId=S1.id, verifiedAt=serverNow)`. Then prove old S0, a later rotated S2, sign-out, account switch, expired age, and forged client timestamp/account/session values cannot authorize P6 mutations.

## P10.9 Unit tests — resource allowlist/provisioning

For P7/P8 resource registry logic:

```text
known owned device resource -> provision/link allowed
unknown arbitrary https URL -> reject
resource owned by another account/device -> reject
non-https production URL -> reject
fragment/query where policy forbids -> reject
disabled resource -> reject
client not linked when per-client enforcement on -> invalid_target
```

Administrative Better Auth resource CRUD must not be reachable through ordinary user privilege by default.

## P10.10 Auth integration — passkey registration

Using a virtual authenticator, prove:

```text
new account -> one verified passkey -> authenticated session
no email/password/social input
resident/discoverable credential requested
UV required by authenticator options
UV required by server verification
exact RP ID
exact origin
```

The test must inspect durable rows after success.

## P10.11 Auth integration — negative UV

This is a release blocker inherited from P1.

Required matrix:

| Ceremony | UP | UV | Expected |
| --- | ---: | ---: | --- |
| registration | 1 | 1 | success |
| registration | 1 | 0 | reject |
| authentication | 1 | 1 | success |
| authentication | 1 | 0 | reject |

A browser-side `userVerification: "required"` setting is not sufficient proof. The trusted verifier must reject the missing-UV fixture/assertion.

## P10.12 Auth integration — challenge/origin/RP negatives

Reject:

- wrong challenge;
- expired challenge;
- replayed consumed challenge;
- registration challenge used as authentication challenge;
- wrong origin;
- wrong RP ID hash;
- malformed clientDataJSON;
- invalid signature;
- unknown credential ID;
- credential associated with another account where relevant.

## P10.13 Auth integration — terminal registration/authentication state and fault injection

Inject failures immediately before/after each boundary in the P8A terminal model:

```text
challenge CAS/consume
verifier success -> verified_pending_commit transition
registration-intent CAS/consume
account activation
credential unique insert
initial credential counter/backup metadata write
session/fresh-auth state write
database commit
Set-Cookie/header emission
connection drop after commit
```

For authentication also inject around challenge CAS, credential counter/backup update, session rotation/fresh-auth write, commit, and cookie emission.

Acceptance:

- the selected P8A Model A proves challenge CAS, intent CAS, account, credential/initial counter+backup metadata, and session/fresh-auth state commit or roll back together; or Model B has the required P1 library-boundary proof and durable `verified_pending_commit`/repair behavior;
- no active orphan account survives failed registration and no counter/session/fresh-auth side effect survives a rolled-back authentication;
- no consumed challenge is replayed to repair an application failure;
- if library-internal challenge consumption precedes application commit, retry uses a fresh challenge against the same legal pending state;
- no authenticated success or `Set-Cookie` is emitted before commit;
- commit followed by process death, connection loss, or cookie loss records `completed_cookie_unknown` and is recovered by fresh passkey sign-in, never by intent/challenge/idempotency-key possession;
- credential counter/session state cannot report success from a transaction that did not commit;
- all forced saga failures reach the named manual-repair state with an executable operator query/runbook.

## P10.14 Auth integration — credential uniqueness race

Fire two verification requests attempting the same credential association.

Acceptance:

```text
exactly one passkey row owns credentialID
second commit fails deterministically
no two accounts reference same credential
no duplicate active session/account side effect survives
```

The database constraint is part of the test, not only application pre-check logic.

## P10.15 Auth integration — username-less sign-in

Test returning users with no identifier input:

- visible passkey button succeeds;
- discoverable credential resolves account;
- conditional mediation path succeeds when supported;
- conditional mediation unavailable -> visible button remains usable;
- cancellation is treated as cancellation, not "create a new account";
- unknown credential does not enumerate account details.

## P10.16 Auth integration — multiple passkeys

Prove:

```text
add second passkey after fresh auth
both credentials sign in to same subject
rename changes label only
remove one leaves account usable
remove final credential rejected
revoked/deleted credential no longer signs in
```

Include synchronized multi-device credential behavior where counters may not monotonically behave like a single hardware key.

## P10.17 Device-code callback continuity

Start with a real pending RFC 8628 request:

```text
verification_uri_complete
-> /device?user_code=...
-> unauthenticated redirect
-> passkey registration/sign-in
-> server validation replaces code with opaque request reference
-> same pending request approval screen
```

Verify the code/resource/client shown after auth matches the original durable device request.

## P10.18 Device approval semantics

Acceptance:

- prefilled valid code auto-advances without a redundant Continue click;
- manually entered code still has an explicit submission path;
- explicit Approve and Deny remain;
- approval page shows safe account display identity, not required email;
- resource/client/scope details are trustworthy server-loaded values;
- approve after expiration fails;
- deny causes device polling to fail appropriately;
- another user cannot approve a request already bound contrary to server policy.

## P10.19 ChatGPT consent continuity

Start a real authorization-code/CIMD flow requiring sign-in.

After passkey auth verify:

```text
client_id unchanged
resource unchanged
redirect_uri unchanged
state unchanged
PKCE/challenge unchanged where applicable
requested scopes unchanged
explicit consent page shown
issued token subject correct
```

Consent copy must not claim an email identity when none exists.

## P10.20 OAuth scope regression tests

Once P2 removes legacy identity scopes, assert metadata and grants do not silently reintroduce them.

Expected passkey-only product scopes should be explicit, e.g.:

```text
offline_access
mcp:tools
device:sync
```

`openid` may remain only if the selected OAuth/OIDC architecture requires it and its claims are documented. `email` and `profile` must not remain merely from Better Auth defaults.

## P10.21 Central issuer discovery tests

From DesktopCommanderMCP:

```text
resource URL = https://device.example/mcp
protected-resource metadata URL = https://device.example/.well-known/oauth-protected-resource/mcp
authorization_servers = [https://auth.example]
```

Then fetch authorization-server discovery from the central issuer, not by rewriting paths onto the device tunnel.

Reject protected-resource metadata that advertises an untrusted or malformed issuer. Import the MCP/metadata route while no runtime resource is configured: module import/boot must succeed, requests return fail-closed `503`, then an acknowledged runtime revision becomes visible without process restart. A module-scope stale runtime snapshot is a test failure.

## P10.22 OAuth endpoint validation

Every discovered endpoint must satisfy the selected issuer policy:

- HTTPS in production;
- expected issuer metadata exact match;
- endpoints belong to allowed authorization-server origin(s);
- no silent internalization to `MCP_SERVER_URL`;
- no redirect downgrade;
- JWKS URI validated before token verification use.

## P10.23 Device OAuth session tests

Test full RFC 8628 flow with central issuer and per-device resource:

```text
P7A proof-gated bootstrap/provisioned first-party client
resource-bound device authorization
human passkey auth
explicit approval
polling pending/slow_down behavior
token success
refresh rotation
normal restart with persisted token re-verification
revocation
```

Token assertions:

```text
iss == configured central issuer
aud == exact resource (single canonical audience unless P0 explicitly approves otherwise)
sub == stable account subject
scope contains device:sync
```

## P10.24 Device startup/restart/bootstrap-receipt tests

DesktopCommanderMCP acceptance:

```text
first authorization -> proof-gated bootstrap once -> receipt persisted -> browser opens once
normal restart with valid bound V2 credential -> persisted access token is cryptographically/introspection verified for exact issuer + single audience BEFORE first use; ZERO bootstrap calls + ZERO browser
expired access token + valid refresh -> refresh only; ZERO bootstrap
revoked refresh -> same-startup reauthorization
issuer/resource serialized binding mismatch -> no old refresh; inspect receipt/bootstrap then reauthorize
persisted token signed by wrong issuer with otherwise matching serialized V2 fields -> reject before any protected request
persisted token missing aud / wrong aud / aud array containing exact resource plus another audience -> reject before any protected request
legacy v1/unbound credential -> reauthorize
pairing failed after provisioning -> restart reuses/reconciles durable receipt, not a new capability
/provision committed + response lost + process crash before receipt save -> recovery journal + device-key recover-provision returns exact original receipt/client
recover-provision request digest/key/idempotency mismatch -> reject; no new provisioning
V2 session saved + crash before proof removal -> next startup resumes cleanup obligation, removes/acks proof, clears exact bootstrap key, no browser/reprovision
crash after proof-removal ack before key deletion -> resume exact cleanup idempotently
steady-state V2 + cleanup complete -> zero receipt/bootstrap network calls
second OS process during pairing -> no second browser; pairing lease behavior deterministic
```

Keep `stableId` and stable tunnel identity across OAuth credential replacement. Verify losing a pairing race cannot overwrite a newer vault generation and the losing token family is disposed/revoked according to policy.

## P10.25 Native vault backend matrix

Exercise serialization/rotation semantics for:

- macOS Keychain chunked storage;
- Linux Secret Service;
- Windows DPAPI file.

Tests must ensure tokens never appear in argv, environment diagnostics, ordinary logs, or world-readable files.

For platform-specific CI gaps, maintain a manual acceptance item rather than claiming coverage.

## P10.26 Tunnel/resource health tests

The future tunnel doctor must distinguish:

```text
transport health
protected MCP resource metadata health
central authorization server health
```

Do not require the central auth issuer to share the device tunnel origin.

Health timeout composition is explicit: pass a **non-aborting caller signal** while the protected-resource or authorization-metadata response hangs, and require the per-request health timeout to abort anyway. Separately verify caller cancellation aborts earlier than the timeout. This catches the forbidden `callerSignal ?? timeoutSignal` implementation that silently disables timeout whenever a caller signal exists.

Add regression coverage to `test/test-remote-tunnels.js` for external authorization server metadata, caller-signal + timeout composition, and the P7A.5A unconfigured/configured runtime boundary.

## P10.27 DesktopCommanderMCP regression targets

Future implementation branch should extend at least:

```text
test/test-remote-device-supervision.js
test/test-remote-jazz-safety.js
test/test-remote-tunnels.js
test/integration/tailscale-funnel-e2e.js
test/integration/zrok-remote-mcp-e2e.js
```

Also add focused tests around `device-oauth.ts`, `token-manager.ts`, `remote-channel.ts`, the typed control-plane client, provisioning receipt, and pairing lease. Re-run a call-site search on implementation HEAD so new constructors/providers cannot escape the migration manifest.

## P10.28 Local-execution safety regression

Passkey/OAuth work must not weaken the existing remote command invariant:

```text
authority/claim succeeds before local side effect
```

Regression cases:

- claim fails -> tool not executed;
- duplicate call id -> not executed twice;
- completion persistence failure -> no unsafe replay;
- revoked device/account -> remote tool execution denied/fails closed.

## P10.29 Durable-storage concurrency tests

Against the P8 production-shaped database adapter, run concurrent workers/instances for:

```text
registration-intent consume
WebAuthn challenge consume
credential insert
session creation
refresh-token rotation
passkey counter update
final-passkey delete guard
resource provisioning/linking
revocation
```

Run these against the real database engine chosen for deployment, not an in-memory substitute only.

## P10.30 Cold-start/serverless tests

Simulate multiple fresh function instances with shared durable state.

Verify:

- challenge generated by instance A verifies on B;
- intent generated by A consumes on B;
- session generated by A reads on B;
- signing/JWKS identity stays stable;
- refresh rotation survives instance replacement;
- resource registry does not depend on boot-time singleton mutation.

## P10.31 Replay suite

Explicitly test replay of:

```text
registration intent
registration challenge
authentication challenge
device code / raw user-code lookup
opaque approval reference and one-time decision nonce
bootstrap challenge/capability/prove/provision idempotency keys
provisioning receipt reconciliation/abandon request
authorization code
refresh token outside configured reuse window
passkey deletion request where CSRF applies
resource provisioning request/idempotency key
```

Record expected error class/status without leaking secrets.

## P10.32 Web security suite

At minimum test/review:

- CSRF on state-changing browser endpoints;
- session fixation across registration/sign-in;
- open redirects;
- clickjacking/frame policy;
- strict CSP on stable passkey RP;
- XSS sinks on account/passkey labels;
- Origin/Referer validation where used;
- secure/HttpOnly/SameSite cookie attributes;
- cache-control on auth/consent pages;
- account enumeration behavior;
- rate limits on registration/auth/device endpoints.

## P10.33 Generated never-log and sink-serialization tests

`docs/PASSKEY-NEVER-LOG-REGISTRY-V1.json` is the only V1 deny registry. Load it through the exact P9A parser and generate sentinel tests for **every rule × every required sink**; P10 cannot keep a shorter hand-written list. Required sinks are application logs, structured traces, analytics/`captureRemote`, error reporting, operator diagnostics, ingress access logs, reverse-proxy/CDN/WAF access logs, and audit/outbox/dead-letter diagnostics.

Generated fixtures place unique sentinel secrets in:

```text
Authorization / Proxy-Authorization headers
Cookie and Set-Cookie headers
request-target/query strings carrying code/state/device_code/user_code/code_verifier/tokens
Location/Referer URL query values
access/refresh/client/session/Better-Auth secrets
device/user/authorization codes
WebAuthn challenge + attestationObject + clientDataJSON + authenticatorData + signature + userHandle + rawId
credential public key + full credential ID
private JWK
bootstrap capability/device-key signature/provisioning receipt secret
verification_uri_complete
biometric/PIN material
nested Error.cause/response/request/header objects and unknown runtime-any payloads
```

For each sink, inspect the **final serialized output** after framework/transport formatting, not just an intermediate sanitized object. HTTP ingress/proxy tests inspect emitted access-log lines; traces inspect exported spans; audit/outbox/dead-letter tests inspect persisted diagnostic envelopes. A sentinel appearing anywhere is a failure. Unknown registry selectors, duplicate rule IDs, missing required sinks, or any untested rule/sink pair fail the gate.

C3/C4 event-name channels are tested separately with arbitrary secret-bearing strings supplied through JavaScript/`any`; unknown event names must reject before `captureRemote`/metrics invocation. Include exact accepted-name round trips plus token/code/URL-looking sentinel event names so the event-name channel itself cannot exfiltrate secrets. Accepted event property bags are reconstructed from exact runtime allowlists.

## P10.34 Browser virtual-authenticator matrix

Automated browser suite should cover Chromium with CDP virtual authenticators at minimum, including:

```text
resident key + UV
resident key + no UV
credential add/remove
username-less assertion
cancellation
wrong RP/origin fixtures where harness permits
```

If Playwright is selected, keep authenticator setup isolated in a helper so tests remain readable.

## P10.35 Real platform acceptance matrix

Manual release checklist:

| Platform | Browser | Authenticator path | Register | Sign in | Second passkey | Device approve | ChatGPT consent |
| --- | --- | --- | --- | --- | --- | --- | --- |
| macOS | Safari | Touch ID/iCloud Keychain | ☐ | ☐ | ☐ | ☐ | ☐ |
| macOS | Chrome | platform/password manager | ☐ | ☐ | ☐ | ☐ | ☐ |
| Windows | Edge | Windows Hello | ☐ | ☐ | ☐ | ☐ | ☐ |
| Windows | Chrome | Windows Hello/password manager | ☐ | ☐ | ☐ | ☐ | ☐ |
| Linux | Chrome/Firefox | phone/security key | ☐ | ☐ | ☐ | ☐ | ☐ |
| cross-device | supported browser | hybrid/phone | ☐ | ☐ | ☐ | ☐ | ☐ |
| roaming key | supported browser | hardware security key | ☐ | ☐ | ☐ | ☐ | ☐ |

Record exact OS/browser versions used for release evidence.

## P10.36 Unsupported-platform behavior

Where WebAuthn/passkeys are unavailable:

- no password/social fallback appears;
- user receives a clear unsupported-platform message;
- no partial account is created;
- pending device request remains safe until expiry;
- support documentation points to supported device/security-key options.

## P10.37 Migration acceptance

For every retained test/operator account from P9:

```text
subject unchanged or explicit approved migration path executed
passkey sign-in independently verified
owned devices visible
new device can be approved
legacy unbound device credential reauthorizes safely
old password login retired only after proof
ChatGPT grant either works under same contract or is explicitly reauthorized
```

## P10.38 Isolated backup/restore + revocation-watermark drill

Before P11:

1. create production-shaped accounts, sessions, passkeys, grants, resources, clients, immutable migration evidence, login entitlements, and verifier-retirement state;
2. take a DB backup, then revoke/disable representative authority and advance migration/cutover state **after** that backup point;
3. restore into an isolated environment with issuance disabled and no production ingress/load-balancer/failover path;
4. assert readiness and traffic attachment are false while either restored `revocationWatermark` or `migrationWatermark` trails its independently retained target;
5. replay every later event from both append-only streams idempotently through the durable inbox/dedupe mechanism, including duplicate and interrupted replay cases;
6. prove revoked accounts, sessions, devices, grants, refresh families, clients, resources, legacy-login entitlements, and destructive-retirement markers remain revoked/current;
7. verify signing/JWKS compromise/retirement state and artifact-declared schema range/capabilities;
8. persist signed non-secret source-backup, target-watermark, artifact-digest, verifier, and result evidence;
9. only then allow readiness true, and require a separate audited operator action before traffic attachment.

Record restore RPO/RTO and both watermark streams without secrets. Application rollback is not database/security-control rollback.

## P10.39 Clean-checkout Nix/Just and dedicated passkey CI gate

A clean checkout must bootstrap dependencies first. Required repository sequence:

```bash
nix develop -c just bootstrap
nix develop -c just test
nix develop -c just remote-gate
```

Before P10 can exit, the implementation branch must add a dedicated reproducible target:

```bash
nix develop -c just passkey-auth-gate
```

`passkey-auth-gate` owns deterministic non-production dependencies and runs at least:

```text
P1 UV-negative compatibility proof
passkey registration/sign-in integration
callback/user-code parser negatives
P7A bootstrap proof/SSRF fixtures without public network access
OAuth malformed/timeout/scope tests
MCP bearer-challenge conformance
multi-process vault/pairing-lease tests feasible on the CI platform
rollout-state generated legal/illegal transitions
telemetry runtime-parser + generated never-log-registry negatives across every sink
```

CI must start from a clean checkout with no pre-existing generated files or services, provision a disposable non-production auth DB/issuer/rate-limiter fixture, run migrations only through the frozen one-shot migration artifact and CI-scoped executor identity, run the canonical deployment-state/threshold conformance suite, and tear down idempotently. The future `passkey-auth-gate` becomes mandatory before P10 exit; a missing, skipped, allowed-to-fail, or conditionally bypassed gate is not green.

The CI job definition and action/container dependencies must be revision-pinned. It publishes a retained, non-secret artifact containing repository/lockfile hashes, central/device/IaC/migration/parser artifact digests, migration identity and result, test manifest with versions/seeds/timings, revocation timing results, restore source/target watermarks, deployment-state exhaustive-test result, never-log registry/sink coverage result, and skip/failure counts. Artifact path, retention, and owner remain `TBD-RELEASE` and block P10/P11 until frozen.

Tunnel E2E remains separately provisioned through the existing guarded Just targets; it is not a prerequisite for every unit/auth PR. Control-plane commands must come from that repository's actual committed Nix/package definitions once it has an immutable revision.

## P10.40 Evidence bundle

Produce a release artifact containing no secrets:

```text
commit SHAs and immutable central/device/IaC/migration/parser artifact digests
lockfile and CI workflow/action hashes
schema compatibility min/max, required capabilities, and migration identifiers/executor identity
automated test commands, versions, seeds, timings, skip/failure counts, and results
security negative-test and terminal-state fault-injection results
P7A numeric revocation maximum plus per-authority timed results
canonical deployment-state/threshold exhaustive-test result
browser/platform matrix
migration rehearsal result with evidence/entitlement/verifier axes
isolated backup/restore result with revocation and migration source/target watermarks
known limitations and every still-gated TBD
P1/P7/P8 gate references
```

## Proposed virtual-authenticator helper

Illustrative Playwright/CDP shape with explicit cleanup; exact import/version belongs to the implementation harness:

```ts
import type { Page } from "@playwright/test";

export async function withVirtualAuthenticator<T>(
  page: Page,
  options: { userVerified: boolean },
  run: (authenticatorId: string) => Promise<T>,
): Promise<T> {
  const cdp = await page.context().newCDPSession(page);
  let authenticatorId: string | null = null;
  try {
    await cdp.send("WebAuthn.enable");
    const created = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: options.userVerified,
        automaticPresenceSimulation: true,
      },
    });
    authenticatorId = created.authenticatorId;
    return await run(authenticatorId);
  } finally {
    try {
      if (authenticatorId) {
        await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
      }
    } finally {
      try { await cdp.send("WebAuthn.disable"); } finally { await cdp.detach(); }
    }
  }
}
```

The missing-UV test must inspect the actual authenticator flags/assertion and prove the trusted server rejects UP=1/UV=0.

## Proposed Desktop credential-binding assertion

```ts
export function isSessionBoundTo(
  session: DeviceOAuthSession,
  identity: RemoteIdentityConfig,
): boolean {
  return session.version === 2
    && session.issuer === identity.authorizationServerIssuer
    && session.resource === identity.publicMcpResource;
}
```

A false result leads to credential discard + reauthorization, never token refresh.

## P10.41 Mandatory MCP bearer-challenge conformance

Run HTTP-level tests against the actual `/mcp` edge:

| Request | Expected |
| --- | --- |
| no `Authorization` | `401` |
| malformed bearer token | `401` |
| expired token | `401` |
| wrong issuer | `401` |
| wrong audience | `401` |
| valid token, missing `mcp:tools` | `403` |
| valid exact issuer/audience/scope | application response |

Every applicable `401` must contain `WWW-Authenticate: Bearer` with the MCP-required `resource_metadata` parameter referencing the **exact** RFC 9728 metadata URL for that resource.

Also test header quoting/escaping, duplicate challenges, redirect behavior, caching, and absence of localhost/internal hostnames.

## P10.42 Bootstrap, SSRF, and approval mutation suite

Required P7A/P5 negatives:

```text
bootstrap capability replay -> reject
expired bootstrap -> reject
resource-control proof redirects to different origin -> reject
production proof target loopback/private/metadata-service address -> reject
hostname suffix without cryptographic control proof -> reject
browser submits different client/resource/scope than pending state -> reject
approve mutation GET -> no side effect
missing/invalid CSRF -> reject
wrong Origin/Sec-Fetch-Site -> reject
consumed decision nonce -> reject
user-code guess limit exceeded -> generic terminal response
pre-auth code lookup does not disclose device metadata
local resource server unconfigured -> private health may pass but /mcp + RFC9728 public readiness fail closed
resource runtime config atomic write -> ack exact operation/revision/canonical-document digest/resource/null bootstrap ID/monotonic server generation/applied time -> public metadata exact resource/issuer before /challenge
unacknowledged/stale/wrong-resource/lower-generation acknowledgement, same-revision different digest, and A@7 -> B@8 -> replay A@7 ABA -> /challenge not attempted
challenge success -> signed proof atomic install -> ack exact install operation/revision/digest/resource/bootstrap ID/server generation + public exact proof before /prove
expired/removed proof -> explicit canonical removal tombstone digest + higher removal acknowledgement -> public derived path 404
kill at POSIX temp-write/file-fsync/rename/parent-directory-fsync and Windows FlushFileBuffers/write-through-replace/generation-manifest boundaries -> recover only last complete monotonic generation
server restart -> reload acknowledged resource config but never expired proof
```

## P10.43 OAuth runtime/multi-process protocol suite

```text
metadata JSON non-object/missing required fields
persisted restart token issuer/audience verification before fast-path use
metadata issuer mismatch
verification_uri exact approved route/no query; reject alternate same-origin route, query, fragment, credentials, and normalization variants
verification_uri_complete exact same route + one provider-approved user_code; reject duplicate/unknown keys, empty/mismatched code, fragment, and alternate path
hanging JWKS refresh or introspection aborts at min(verifier timeout, remaining startup/refresh/device-flow deadline); caller abort wins
expires_in or interval NaN/zero/negative/excessive
access_denied / expired_token / invalid_target / invalid_client
5xx/transport retry with bounded jitter/deadline
refresh omits replacement refresh_token -> retain old when provider permits
refresh omits scope -> inherit previous scope
unsupported token_type -> reject
same-process clear while refresh in flight -> result discarded
TWO OS processes refresh simultaneously -> serialized/CAS
stale generation cannot overwrite or clear newer vault generation
crash after server-side rotation before save -> documented reauth behavior
```

## P10.44 Completed-intent and callback security regression

```text
stolen consumed registration-intent ID cannot create/restore a session
/device/approve-evil rejected
/consent-evil rejected
encoded slash/backslash/dot-segment variants rejected
fragment removed
nested callback parameter cannot escape allowlist
duplicate user_code query substitution cannot change server-bound request
```

## P10.45 Rollout-state validator tests

Import the already-implemented P9A runtime parser/validator from `docs/PASSKEY-P9A-DEPLOYMENT-STATE-CONTRACT.md`; P10 must not implement a missing rollout parser. Exhaustively generate all named snapshots, single-field-invalid variants, and ordered snapshot pairs. Accept only the listed capability tuples and directed transitions. Remove/fail/stale each evidence predicate in turn; verify exact rollback targets, destructive rollback rejection, same-snapshot threshold/cohort revision changes, unknown/duplicate fields, future versions, stale/mismatched revision+ETag, idempotent identical mutation IDs, conflicting reuse, server-derived operator attribution, and threshold/cohort cross-field constraints. Also cover the exact emergency registration-pause target for every production snapshot, paused-migration -> paused-passkey-only and paused-passkey-only -> paused-legacy-removed progression without transient registration enablement, the invariant that no state after password-signup disablement can transition to a password-signup-enabled tuple, resource enforcement before link backfill, password disable before migration/recovery, v2-only before legacy reauthorization, central routing before verifier/resource readiness, runtime issuer mutation, and expired dual-issuer exceptions. Publish the seed and generated case count.

For **every legal directed edge**, test carrying the source `thresholdsRevision` into the target and installing a replacement revision; carryover must reject whenever any required rule's `appliesToSnapshots` or rollback/pause action is invalid for the target. Threshold publication tests require authenticated server-derived principal, `If-None-Match: *`, canonical digest vectors, exact idempotent replay, revision no-overwrite, atomic document/audit/outbox failure, and `thresholds_green` exact revision+digest binding. Reject an `actor` body field and prove audit/outbox attribution comes only from authenticated IAM context.

Generate cohort-policy tests for immutable publication, reference/digest mismatch, every explicit eligibility mode, 0/1/9999/10000 basis points, HMAC golden vectors, stable assignment across instances/cache refreshes/revisions using the same assignment key, explicit reshuffle on approved key rotation, wrong environment/release/subject source, unavailable key or stale cache fail-closed, and deployment-state `cohortPolicyRevision` binding. Activate `freeze_cohort_expansion` and prove it blocks percentage, non-subset allowlist, broader-mode, key, or other eligibility expansion while allowing strict contraction, emergency registration pause, and approved rollback. `device_v2_reauthorization_path_ready` is required for `internal -> new_accounts_plus_migration`; it must not satisfy either passkey-only edge, which continues to require `device_v2_reauthorization_complete`. Also reject unknown evidence predicate IDs and envelopes with wrong signer role, stale freshness, wrong environment/release, or wrong artifact digest.

## P10.46 Revocation-deadline and client-class conformance

Import the security-approved numeric `P7A.MAX_POST_REVOCATION_ACCESS_TOKEN_EXPOSURE_SECONDS`; the proposed V1 value is **300 seconds** and remains a blocking `TBD-SECURITY-APPROVAL`. Use synchronized clocks and record `revokedAt`, authoritative `revocationCommittedAt`, probe timestamps, `firstRejectedAt`, and the approved maximum for account, browser session, device association, refresh family, OAuth grant, OAuth client, and OAuth resource revocation.

For every class, prove refresh and new issuance denial immediately after the revocation commit, then repeatedly present a token issued before revocation across at least the boundary minus/at/plus timing points. Fail if any accepted request occurs after `revocationCommittedAt + MAX_POST_REVOCATION_ACCESS_TOKEN_EXPOSURE_SECONDS`. Exercise every enforcement path/instance and publish bounded non-secret timing evidence. A missing sample, clock-skew violation, timeout, skipped class, or deadline miss fails the test; P11's allowed deadline-miss threshold is zero.

Client-class tests:

```text
resource-control-bootstrap-v1 obtains device:sync only after key + exact-resource proof; a claimed native/first-party binary identity alone receives no privilege
RFC7591 third party cannot request device_code or device:sync
CIMD client cannot use bootstrap/device scope
public authorization-code clients require PKCE S256 and exact redirect URI
CIMD SSRF: redirects/private/special/DNS-rebind/oversize/wrong content-type rejected
metadata missing required grant/token-auth/scope capability -> desktop refuses flow
exact-route verification_uri_complete opened AND user_code remains displayed; alternate-path/duplicate-or-unknown-query variants reject
```

The P9 **development/staging rehearsal** legacy-authority matrix must be complete and every disposition mechanism verified before P10 exit. This is not the production `p9_authority_matrix_verified` predicate; only P11 cohort 4 may emit that predicate after applying and verifying the matrix against retained production accounts.

## Exit checklist

- [ ] P1 UV negative tests pass.
- [ ] Email-less/domain-identity invariant is proven for selected architecture.
- [ ] Registration/authentication terminal transaction or forced-boundary state machine passes challenge/intent/credential-counter/session/fresh-auth/commit/cookie fault injection.
- [ ] Credential ID uniqueness race passes.
- [ ] Challenge and intent replay suites pass.
- [ ] Username-less sign-in passes.
- [ ] Final-passkey concurrent-delete guard passes.
- [ ] Device-code callback continuity passes.
- [ ] Explicit device approval and ChatGPT consent pass.
- [ ] OAuth scopes/claims contain no accidental email/profile semantics.
- [ ] Central issuer/per-device resource discovery passes.
- [ ] Versioned credential binding/restart/revocation passes.
- [ ] Resource provisioning and per-client authorization are fail-closed.
- [ ] Durable cross-instance concurrency passes.
- [ ] Logging/redaction suite passes.
- [ ] Web security review/tests pass.
- [ ] Real browser/platform matrix completed.
- [ ] Migration rehearsal and isolated backup/restore + revocation-watermark replay completed.
- [ ] P9 complete development/staging legacy-authority revocation rehearsal matrix is verified; no production `p9_authority_matrix_verified` claim is emitted by P10.
- [ ] P7A's numeric maximum is security-approved; immediate refresh/new-issuance denial and timed rejection tests cover every authority with zero deadline misses.
- [ ] Existing local execution safety tests remain green.
- [ ] MCP bearer-challenge conformance passes.
- [ ] Bootstrap/SSRF and approval mutation suite passes.
- [ ] OAuth malformed-response/timeout/verification-URL suite passes.
- [ ] True multi-process refresh serialization/clear-race suite passes.
- [ ] Consumed-intent theft and callback-substitution suite passes.
- [ ] Exact P9A runtime deployment-state/threshold/cohort/mutation parser and immutable publication artifact is already implemented; exhaustive generated legality/CAS/evidence/revision+digest/server-principal/sticky-assignment/freeze/emergency-target/action-target tests pass against it.
- [ ] Clean-checkout `just bootstrap` + normal gates pass with no ambient services/generated state.
- [ ] Dedicated `just passkey-auth-gate` exists, cannot be skipped/allowed-to-fail, and passes in pinned CI.
- [ ] CI publishes the required immutable non-secret test/revocation/restore/artifact evidence bundle with frozen owner and retention.
- [ ] Client-class/PKCE/CIMD SSRF conformance passes.
- [ ] Evidence bundle is stored without secrets.

## Rollback

P10 itself performs no production cutover. If any release-blocking test fails, stop and return ownership to the responsible P-task. Do not mark failures as flaky without a root-cause record, and do not weaken UV, callback, resource-binding, credential-binding, or final-passkey invariants to obtain a green matrix.
