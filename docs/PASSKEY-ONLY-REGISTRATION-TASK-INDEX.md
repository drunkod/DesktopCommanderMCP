# Passkey-only registration implementation task index

Status: **R-01–R-43 + third-pass contract remediation applied; implementation remains gated by approvals/evidence** — 2026-09-07

Primary architecture: `docs/PASSKEY-ONLY-REGISTRATION-RESEARCH-AND-IMPLEMENTATION-PLAN.md`

First audit: `docs/PASSKEY-ONLY-REGISTRATION-PLAN-AUDIT.md`

Second-pass implementation review: `docs/PASSKEY-ONLY-REGISTRATION-TASK-PACK-REVIEW.md`

Proposed implementation sketches: `docs/PASSKEY-ONLY-REGISTRATION-FULL-SNIPPETS.md`

P0 approval ADR: `docs/PASSKEY-P0-PRODUCT-AND-SECURITY-ADR.md`

Cross-store consistency ADR: `docs/PASSKEY-P8A-CROSS-STORE-CONSISTENCY-ADR.md`

Canonical rollout-state contract: `docs/PASSKEY-P9A-DEPLOYMENT-STATE-CONTRACT.md`

Machine-readable never-log registry: `docs/PASSKEY-NEVER-LOG-REGISTRY-V1.json`

## Readiness statement

The continued review residuals R-25 through R-43 have now been incorporated into the task/snippet contracts. Production implementation is still not approved because external decision/evidence gates remain open:

```text
P0: human/product/security/operations approval required
P1-preflight: optional disposable research only; non-gating and unlocks nothing
P1: formal auth/WebAuthn compatibility gate starts only after approved P0 and must produce GO
```

No document may turn those external decisions into checked acceptance evidence by assertion.

## Ground rules

- Do not start formal P1 before P0 approval is recorded in the signed P0 ADR; optional `P1-preflight` research is disposable, non-gating, and unlocks no downstream task.
- Do not start production passkey implementation before formal P1 produces GO.
- Do not patch `node_modules` or generated Better Auth output.
- Do not fabricate deliverable email identities.
- Do not weaken server-required UV.
- Device approval and ChatGPT consent remain explicit.
- Device refresh credentials stay in the OS vault and are issuer/resource-bound.
- Local tool execution and claim-before-side-effect semantics remain unchanged.
- Auth/OAuth one-time state uses shared durable P8A primitives, not process memory.
- Resource identity is exact; reject noncanonical input rather than silently rewriting it.
- No source implementation is part of this docs-only branch.

## Canonical dependency DAG

The dependency table below is the source of truth. This diagram is a direct rendering of those edges; CI/docs validation must fail if they diverge.

```text
none -> P0
P0 decision work -> P0 ADR
P0 approved (signed P0 ADR) -> P1
P1 GO -> P8A
P0 approved + P1 GO -> P7A
P1 GO + P8A -> P2
P1 GO + P2 + P8A (+ P7A approved for the device-bound callback slice) -> P3
P2 + P3 + P8A -> P4
P1 GO + P7A + P8A -> P7B
P3 + P4 + P7A + P7B + P8A -> P5
P3 + P4 + P7A + P7B + P8A -> P6
P2 + P3 + P4 + P5 + P6 + P7B + P8A -> P8B
P5 + P6 + P7B + P8B -> P9
P8B + P9 implementation/rehearsal -> P9A
P2 + P3 + P4 + P5 + P6 + P7A + P7B + P8A + P8B + P9 + P9A -> P10
P9A + P10 green -> P11
P11 cohort 4 -> production p9_migration_complete + p9_authority_matrix_verified evidence
P11 production transition -> passkey_only only after those predicates are green
```

`P1-preflight` is an optional name for disposable research into candidate P1/P7A/P8A technologies before P0 approval. It is not a canonical task or gate node, cannot produce P1 GO, and unlocks no dependency. The **formal** P1 gate starts only after P0 is approved through the signed P0 ADR.

Practical parallelism after P1 GO:

```text
P7A protocol design
P8A datastore/transaction foundation
```

A1–A9 are P7B implementation sketches and therefore require **P1 GO + P7A approved + P8A primitives selected**.

## Canonical dependency table

| Task | File | Depends on | Result |
| --- | --- | --- | --- |
| P0 | `docs/PASSKEY-TASK-P0-PRODUCT-CONTRACT.md` | none | approved product/security contract |
| P0 ADR | `docs/PASSKEY-P0-PRODUCT-AND-SECURITY-ADR.md` | P0 decision work | actual approval/sign-off record |
| P1 | `docs/PASSKEY-TASK-P1-BETTER-AUTH-COMPATIBILITY-GATE.md` | P0 approved (signed P0 ADR) | evidence-backed auth/WebAuthn GO/NO-GO |
| P8A | `docs/PASSKEY-TASK-P8A-DATASTORE-AND-TRANSACTION-FOUNDATION.md` | P1 GO | exact DB/adapter/transaction/locking foundation |
| P7A | `docs/PASSKEY-TASK-P7A-PROTOCOL-BOOTSTRAP-AND-RESOURCE-CONTRACT.md` | P0 approved + P1 GO | issuer/bootstrap/resource/audience protocol |
| P2 | `docs/PASSKEY-TASK-P2-SCHEMA-AUTH-AND-OAUTH-CONFIG.md` | P1 GO + P8A | durable passkey/auth schema and provider config |
| P3 | `docs/PASSKEY-TASK-P3-REGISTRATION-INTENTS-AND-ACCOUNT-CREATION.md` | P1 GO + P2 + P8A (+ P7A approved for the device-bound callback slice) | replay-safe verified registration |
| P4 | `docs/PASSKEY-TASK-P4-PASSKEY-ONLY-SIGN-IN.md` | P2 + P3 + P8A | username-less passkey sign-in |
| P7B | `docs/PASSKEY-TASK-P7B-DEVICE-RESOURCE-IMPLEMENTATION.md` | P1 GO + P7A + P8A | device/resource central-issuer implementation |
| P5 | `docs/PASSKEY-TASK-P5-DEVICE-APPROVAL-INTEGRATION.md` | P3 + P4 + P7A + P7B + P8A | CSRF-safe explicit device approval |
| P6 | `docs/PASSKEY-TASK-P6-CREDENTIAL-MANAGEMENT-AND-RECOVERY.md` | P3 + P4 + P7A + P7B + P8A | transactional passkey management/re-pair/account-deletion semantics |
| P8B | `docs/PASSKEY-TASK-P8B-SERVERLESS-DEPLOYMENT-AND-OPERATIONS-VALIDATION.md` | P2 + P3 + P4 + P5 + P6 + P7B + P8A | production-shaped deployment validation |
| P9 | `docs/PASSKEY-TASK-P9-DEVELOPMENT-ACCOUNT-MIGRATION.md` | P5 + P6 + P7B + P8B | migration implementation + development/staging rehearsal; NO production cohort completion |
| P9A | `docs/PASSKEY-TASK-P9A-DEPLOYMENT-STATE-FOUNDATION.md` | P8B + P9 implementation/rehearsal | executable deployment-state/threshold/cohort-policy/mutation/telemetry foundation |
| P10 | `docs/PASSKEY-TASK-P10-VERIFICATION-AND-SECURITY-MATRIX.md` | P2 + P3 + P4 + P5 + P6 + P7A + P7B + P8A + P8B + P9 + P9A | acceptance/security evidence against implemented P9A artifacts |
| P11 | `docs/PASSKEY-TASK-P11-ROLLOUT-OBSERVABILITY-AND-ROLLBACK.md` | P9A + P10 green | controlled production rollout/rollback using tested state engine |

Umbrella references:

- `docs/PASSKEY-TASK-P7-CENTRAL-ISSUER-RESOURCE-SEPARATION.md`
- `docs/PASSKEY-TASK-P8-DURABLE-AUTH-AND-SERVERLESS-SPLIT.md`

## Gate ownership

### G0 — approved product/security identity

Owned by P0 + P0 ADR.

Must contain approved exact values for:

```text
PASSKEY_RP_ID
PASSKEY_ORIGIN
AUTHORIZATION_SERVER_ISSUER
WEBAUTHN_USER_VERIFICATION=required
FRESH_AUTH_MAX_AGE
ACCOUNT_IDENTITY policy
RESOURCE_MODEL and route audience/scope model
lost-all-passkeys/re-pair behavior
minimum browser/OS versions
```

Current state: **OPEN — approval fields remain intentionally TBD**.

### G1 — server-required WebAuthn UV + acceptable identity schema

Owned by P1.

Current evidence for examined `@better-auth/passkey` 1.7.1/1.7.3 remains no-go because verification uses `requireUserVerification: false`; Better Auth core 1.7.1 also requires unique email.

Current state: **BLOCKED / spike required**.

### G2 — executable durable datastore

Owned by P8A.

Must pin exact DB, driver, adapter, transaction API, locks/CAS, rate limiter, and migration strategy before higher-level atomicity claims are accepted.

### G3 — bootstrap/resource/audience contract

Owned by P7A.

Must eliminate first-device provisioning circularity and freeze canonical resource identity, SSRF-safe control proof, client/resource links, route scopes, lifecycle, and revocation exposure.

### G4 — bound/race-safe device credential

Owned by P7B.

Usable only when stored issuer/resource equal immutable runtime identity. Cross-process refresh must serialize or CAS; clear must invalidate in-flight refresh.

### G5 — deployment/package isolation

Owned by P8B.

Per-device artifact must not expose central passkey/session/migration/resource-admin routes. Cross-instance/cold-start/restore tests must pass.

### G6 — migration authority cleanup

Owned by P9 implementation/rehearsal + P10 conformance + P11 production migration execution.

P9 implements and rehearses the complete authority-disposition matrix without requiring production completion. P10 proves the mechanisms/timing. P11 cohort 4 applies them to real retained accounts and emits the production `p9_migration_complete` / `p9_authority_matrix_verified` predicates before later cutover.

### G7 — rollout safety

Owned by P9A foundation + P10 evidence + P11 operations.

P9A implements legal deployment states, transition/emergency-target logic, server-principal mutation CAS, immutable threshold/cohort-policy publication and assignment, evidence parsers, and telemetry/never-log schemas before P10. P10 proves them. P11 fills release numeric thresholds/incident ownership and operates only the tested artifact before production cohort enablement.

## Cross-repository ownership

### DesktopCommanderMCP

Primary implementation: P7B plus P9A state/telemetry foundation and P10 device/security evidence. P11 is operational rollout, not a place to implement missing runtime parsers.

Expected future targets include:

```text
src/remote-device/remote-identity.ts
src/remote-device/device-oauth.ts
src/remote-device/device-oauth-session.ts
src/remote-device/token-manager.ts
src/remote-device/credential-store.ts
src/remote-device/native-credential-store.ts
src/remote-device/control-plane-client.ts
src/remote-device/remote-channel.ts
src/remote-device/tunnel/types.ts
src/remote-device/tunnel/create-tunnel-provider.ts
src/remote-device/tunnel/tunnel-supervisor.ts
src/remote-device/tunnel/tunnel-health.ts
all Tailscale/zrok provider status()/doctor() callers
src/npm-scripts/remote-options.ts
src/npm-scripts/remote.ts
src/remote-device/device.ts
```

### Control-plane/auth service

Primary implementation: P1–P6, P7A provisioning side, P8A/P8B, P9–P11.

Before implementation, P7A/P8B must record exact repository URL and immutable revision rather than relying on a local workspace nickname.

## Definition of done for each task

Every implementation PR must provide:

1. implemented invariant;
2. exact files changed;
3. positive tests;
4. security-negative tests;
5. transaction/concurrency behavior where applicable;
6. migration/backward compatibility;
7. telemetry/redaction review;
8. operator-visible safe failure behavior;
9. rollback instructions;
10. evidence unrelated local execution semantics are unchanged.

## Recommended implementation slices

### Slice 0 — decisions and compatibility

```text
optional P1-preflight (disposable research; unlocks nothing)
P0 ADR approval
formal P1 compatibility gate
```

Formal P1 follows P0 approval. No production credential creation occurs in this slice.

### Slice 1 — foundations

```text
P7A + P8A
```

Freeze protocol and datastore/transaction contracts.

### Slice 2 — auth identity/schema

```text
P2
```

Compile/migrate only against exact P1/P8A-selected versions.

### Slice 3 — account UX

```text
P3 + P4
```

Verified registration and username-less sign-in with exact callback rules.

### Slice 4 — device/resource implementation

```text
P7B + P5
```

Race-safe OAuth client plus CSRF-safe explicit approval.

### Slice 5 — credential management/recovery

```text
P6
```

Transactional final-passkey guard and explicit new-association re-pair behavior.

### Slice 6 — production-shaped deployment

```text
P8B
```

Packaging, cold start, cross-instance, restore, keys, rate limiter.

### Slice 7 — migration

```text
P9
```

Full legacy-authority cleanup and retained-account evidence.

### Slice 8 — executable deployment-state/telemetry foundation

```text
P9A
```

Implement the canonical parser/transition/threshold/mutation/telemetry artifacts and never-log registry before P10.

### Slice 9 — acceptance proof

```text
P10
```

Run the full security/platform/concurrency/restart/restore matrix against the already-implemented P9A artifacts.

### Slice 10 — rollout

```text
P11
```

Only after numeric gates/owners are filled and P10 is green.

## Final product acceptance

First computer:

```text
desktop-commander remote connect
-> stable resource identity + bootstrap control proof
-> RFC8628 request to stable central issuer
-> Create account with a passkey
-> server-required UV ceremony
-> explicit device approval
-> explicit ChatGPT consent
-> ready
```

Normal restart:

```text
desktop-commander remote
-> load exact issuer/resource-bound vault generation
-> serialize/CAS refresh if required
-> ready without browser when credential remains valid
```

Lost-all-passkeys V1, if P0 approves it:

```text
old cloud account is not recovered
-> local control proof
-> create new passkey account
-> create new device association
-> revoke/reconcile old authority according to P6/P9/P7A
```

## Review remediation coverage

The second-pass findings R-01 through R-24 are mapped as follows:

| Review findings | Remediated in |
| --- | --- |
| R-01 | P0 ADR + P0 task |
| R-02 | P1 hard gate |
| R-03, R-04, R-06, R-07, R-18 | P7A |
| R-05, R-21 | P8A/P8B split + this DAG |
| R-08 | snippet pack statuses/replacements |
| R-09, R-10, R-14 | P5 |
| R-11, R-12, R-15 | P3/P4 + callback snippet |
| R-13, R-19 | P6/P9/P7A |
| R-16, R-17 | P7B + device snippets |
| R-20, R-24 | P9A deployment-state/threshold foundation + P11 rollout operations |
| R-22, R-23 | P10 HTTP challenge + runnable test command matrix |

## Continued-review remediation coverage (R-25–R-43)

| Findings | Remediated contract |
| --- | --- |
| R-25, R-26 | P7A proof-gated challenge/capability issuance, full lifecycle/reservation, provisioning receipt, lazy restart ordering |
| R-27 | P7A exact Ed25519 proof bytes + pinned-address SSRF/DNS-rebinding fetch + concrete source targets |
| R-28 | P7A/B5 server-enforced client-class matrix, PKCE S256, SSRF-safe CIMD |
| R-29, R-30 | P7B/A2 capability metadata checks, always-displayed code, bounded byte streaming, cancellation/deadline/5xx retry/effective scope |
| R-31 | P7B/A7 typed five-method control-plane client injected into real `RemoteChannel`; tunnel factory/types/supervisor included |
| R-32 | P7B/A5 short vault lock + separate pairing lease + same-startup reauth + duplicate-result disposal |
| R-33 | P3/P8A/P10 terminal challenge/account/credential/counter/session/cookie state and fault injection |
| R-34 | P8A cross-store consistency ADR with explicit transaction vs durable saga ledger |
| R-35 | V1 300-second maximum revocation exposure + timed P10 tests + isolated restore watermark replay |
| R-36 | P9 separates immutable migration evidence, reversible login entitlement, destructive verifier retirement |
| R-37 | Index DAG regenerated from dependency table; snippet implementation order follows it |
| R-38 | P3/P5 obsolete intent/callback/presentation examples replaced in place |
| R-39 | A1/P2/B2/B3/B10 strict schemes/raw identity/canonical callback/full device-code validation |
| R-40 | B2/B4/B5/B14 consistent env/JWKS/RP/runtime parse/client policy/Request-bound CSRF contracts |
| R-41 | P9A owns the single `PASSKEY-P9A-DEPLOYMENT-STATE-CONTRACT.md`; C2/P10 import its implementation before P10; P11 only operates it |
| R-42 | P8B deployment ownership/migration identity/artifact fields + P10 clean bootstrap and proposed dedicated CI gate |
| R-43 | C1 typed nested cleanup; C3/C4 runtime reconstruction with resource-metadata event |

External P0/P1/P8A technology selection and release-time P11 owner/threshold values remain gates, not documentation defects.

## No source changes in this task pack

All current remediation work is documentation only. Implementation occurs later on a separate source branch after gates close.
