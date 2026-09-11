# Passkey-only registration task pack — second-pass implementation review

Status: **R-01–R-43 plus third-pass contract review remediation applied; implementation remains gate-blocked by external approvals/evidence** — 2026-09-07

Original reviewed branch: `docs/passkey-only-registration-task-pack`

Current docs-remediation branch: `feat/passkey-only-registration` (same reviewed source baseline `19addf3c7fb5af82bb36424ccca3c003030c4832`)

Primary documents:

- `docs/ONE-CLICK-REGISTRATION-LOCAL-FIRST-RESEARCH.md`
- `docs/PASSKEY-ONLY-REGISTRATION-RESEARCH-AND-IMPLEMENTATION-PLAN.md`
- `docs/PASSKEY-ONLY-REGISTRATION-PLAN-AUDIT.md`
- `docs/PASSKEY-ONLY-REGISTRATION-TASK-INDEX.md`
- `docs/PASSKEY-TASK-P0-PRODUCT-CONTRACT.md` through `docs/PASSKEY-TASK-P11-ROLLOUT-OBSERVABILITY-AND-ROLLBACK.md`
- `docs/PASSKEY-TASK-P9A-DEPLOYMENT-STATE-FOUNDATION.md` + `docs/PASSKEY-P9A-DEPLOYMENT-STATE-CONTRACT.md`
- `docs/PASSKEY-NEVER-LOG-REGISTRY-V1.json`
- `docs/PASSKEY-ONLY-REGISTRATION-FULL-SNIPPETS.md`

## Remediation status — 2026-09-07

The review findings remain in this file as historical evidence. The current docs-only remediation state is below. **Fixed in docs** means the task/ADR/test/snippet contract no longer contains the reviewed contradiction; it does not mean source implementation, human approval, or release evidence exists.

| Finding | Current documentation state | Remaining external gate |
| --- | --- | --- |
| R-01 | FIXED IN DOCS — P0 approval ADR is the single sign-off record | P0 human approvals/TBD values |
| R-02 | FIXED AS HARD GATE — UV/email incompatibility cannot be bypassed | P1 real compatibility spike must GO |
| R-03 | FIXED IN DOCS — RFC 8414 path insertion + pathless preference | P0 issuer approval |
| R-04 | FIXED IN DOCS — proof-gated bootstrap trust root, lifecycle, reservation, receipt | P7A implementation/tests |
| R-05 | FIXED IN DOCS — one canonical acyclic dependency table/diagram/order | none beyond task gates |
| R-06 | FIXED IN DOCS — route/artifact/IaC ownership fields + packaging test | immutable control-plane/IaC revisions and release digests |
| R-07 | FIXED IN DOCS — explicit shared-vs-split resource decision and scope matrix | P0 selects model |
| R-08 | FIXED IN DOCS — catalog is non-copy-ready and corrected against call graph | compile/tests after gates |
| R-09 | FIXED IN DOCS — POST/CSRF/Origin/nonce/policy approval contract | implementation evidence |
| R-10 | FIXED IN DOCS — strict code validation, limits, no-referrer/no-log, opaque request callback | implementation evidence |
| R-11 | FIXED IN DOCS — consumed intent never restores session | implementation evidence |
| R-12 | FIXED IN DOCS — canonical intent binds challenge/RP/origin/request/browser/state | P8A/P1 implementation boundary |
| R-13 | FIXED IN DOCS — lost-all-passkeys creates new association, reconciles old authority | P0 consequence approval |
| R-14 | FIXED IN DOCS — device name/platform explicitly self-asserted presentation | implementation evidence |
| R-15 | FIXED IN DOCS — route-specific canonical callback schemas | implementation tests |
| R-16 | FIXED IN DOCS — native lock/CAS + pairing lease + epoch/generation rules | P7B/native implementation |
| R-17 | FIXED IN DOCS — bounded byte streaming, cancellation/deadline, transient retry, runtime scope/capability parsing | P7B implementation |
| R-18 | FIXED IN DOCS — exact canonical resource rejection/comparison | implementation tests |
| R-19 | FIXED IN DOCS — 300 s V1 ceiling, timed tests, authority matrix, isolated restore watermark | security sign-off + implementation evidence |
| R-20 | FIXED IN DOCS — one canonical revisioned deployment state + directed transitions | release-state values/evidence |
| R-21 | FIXED IN DOCS — terminal auth state + explicit transaction-vs-saga ledger | exact P8A datastore/adapter choices |
| R-22 | FIXED IN DOCS — mandatory MCP 401/403 challenge conformance | implementation tests |
| R-23 | FIXED IN DOCS — clean `just bootstrap` sequence + dedicated `passkey-auth-gate`/CI sketch | implementation branch must add/run gate |
| R-24 | FIXED IN DOCS — threshold measurement schema includes samples/windows/actions/rollback targets/JWKS/revocation | actual release numeric values/owners |

The implementation-start criteria remain active. Documentation remediation never overrides P0/P1/P7A/P8A/P9A/P10/P11 evidence gates.

## Post-remediation cross-file consistency audit

After the R-25–R-43 task slices were applied, the consolidated snippet catalog was rechecked against the rewritten P2/P7A/P7B/P8A/P10/P11 contracts and the exact current `RemoteChannel`/tunnel call graph. The following additional **documentation-integration drifts** were corrected without creating new source claims:

- OAuth/internal URL validation now excludes `localhost` and permits HTTP only on the explicit literal-loopback development policy; P2's WebAuthn-only `http://localhost` exception is kept separate.
- A2 now models the full P7B authorization-server capability profile (`authorization_code`, device code, refresh, `none`, PKCE S256, required issuer scopes and release-approved endpoint paths), monotonic deadlines, 64/32 KiB decoded limits, bounded `Retry-After`, and safe 429/5xx semantics. P7B still requires the final transport to prove an independent raw transfer-byte cap.
- A3/A5 now persist a durable `clearGeneration`, perform internal stale cleanup only against the exact loaded generation, keep explicit clear separate, and require pairing-lease ownership before save. Losing-session cleanup must be revoked or durably queued, not ignored.
- A8 now adds an explicit read-only `inspectDurableIdentity()` contract and performs tunnel-identity inspection plus vault/receipt inspection before any tunnel mutation. Existing authority with missing tunnel identity enters repair rather than silently creating a new resource.
- The A8 provisioning receipt now uses the exact P7A receipt fields including the OS-vault-only `receiptSecret`; the one-use bootstrap capability is not persisted.
- The five-method `DeviceControlPlaneClient` path uses bounded/time-limited responses and does not propagate free-form server error bodies.
- Central passkey/RP configuration and the per-device MCP resource-verifier runtime are split so the resource artifact does not import account/passkey/private signing/migration authority.
- B9 no longer references a nonexistent `intent.callbackPath`; canonical callback navigation remains non-authoritative and revalidates the opaque durable request after sign-in.
- B14 now carries the exact prove/provision key signatures and idempotency inputs and accepts an `approvalReference`, never the provider pending ID, from the browser.
- B13 refuses to overwrite an unknown existing `WWW-Authenticate` challenge; preferred implementation configures the selected MCP helper natively and proves one canonical challenge in P10.
- C4 reconstructs distinct runtime property allowlists per telemetry event, and C5 uses pinned-commit placeholders rather than mutable action version tags.
- P8A's datastore gate no longer accidentally preselects PostgreSQL before the implementation ADR selects an exact engine/service.

These corrections make the docs internally coherent; they do **not** close the external P0/P1/P7A/P8A/P9A/P10/P11 gates or imply that any proposed snippet compiles in source today.

## Third-pass contract review remediation — 2026-09-07

A subsequent independent review found eleven additional design/contract defects after the R-01–R-43 pass. They are preserved here as a new traceability ledger rather than rewriting the historical findings above.

| Third-pass finding | Documentation resolution | Remaining implementation/evidence gate |
| --- | --- | --- |
| T3-01 deployment state could not pause registration without disabling general passkey sign-in/re-enabling password signup | FIXED — P9A contract adds `registration_paused_migration`, `registration_paused_passkey_only`, and `registration_paused_legacy_removed`; permanent password-signup disablement is a transition invariant | implement P9A parser/transition engine; P10 generated proof |
| T3-02 P10 depended on parser/threshold code owned by later P11 | FIXED — new P9A task owns parser, transition/evidence/threshold engines, mutation API, telemetry schemas and registry before P10; DAG is `P9 -> P9A -> P10 -> P11` | implement/freeze P9A artifact digest |
| T3-03 first-run bootstrap had no executable way to reconfigure already-running resource server | FIXED — P7A.5A/P7B define owner-only atomic runtime/proof state + server acknowledgement; public metadata ready before `/challenge`, proof ready before `/prove` | source implementation and cross-platform file/ACL tests |
| T3-04 persisted unexpired access token bypassed provider issuer/audience verifier | FIXED — A2/A5/P7B require restart-time cryptographic/introspection verification before first use, with stable-generation recheck | implementation + P10 wrong/missing/multi-audience restart tests |
| T3-05 shared URL helper allowed loopback HTTP in production | FIXED — explicit `RuntimeProfile` + URL class; public production OAuth/resource is HTTPS-only; local HTTP is separately typed | implementation/parser tests |
| T3-06 B6 dropped immutable pending-device security bindings and retry state was ambiguous | FIXED — B6 mirrors complete P3 pending-device snapshot; `retry_new_challenge` and terminal `repair_required` CAS paths are explicit | P1/P8A implementation proof |
| T3-07 terminal non-owned provisioning receipt permanently stranded restart | FIXED — authenticated `cleanupComplete` permits exact proof/key/receipt archive-clear then one fresh bootstrap; cleanup-incomplete/ambiguous remains repair | receipt/cleanup implementation tests |
| T3-08 research plan told P9 to delete verifier material | FIXED — plan now disables legacy-login entitlement after independent passkey sign-in and defers destructive verifier retirement to P11 contraction | migration rehearsal |
| T3-09 fresh auth was not bound to pre-existing account/current session | FIXED — P4/P6 bind asserted credential owner to pre-reauth session account and marker to post-reauth current session ID/server timestamp; P10 adds A-session/B-passkey negative | implementation + P10 evidence |
| T3-10 health timeout disappeared when caller signal existed | FIXED — A6 composes caller signal with independent timeout; P10 adds hanging-response/non-aborting-caller regression | tunnel-health implementation tests |
| T3-11 P10 redaction list was weaker than P11 never-log policy | FIXED — `PASSKEY-NEVER-LOG-REGISTRY-V1.json` is canonical, P9A implements sink sanitizers, P10 generates nested/error/URL fixtures for every rule × sink | implement registry loaders/sanitizers + gate evidence |

The third-pass fixes also move C2–C4 runtime state/telemetry helpers to P9A ownership, remove P11-local duplicate runtime helper types, and make the per-device MCP verifier consume the acknowledged runtime resource snapshot rather than process-start `REMOTE_MCP_RESOURCE`.

## Fourth-pass remediation — uploaded review 2026-09-07

The later implementation-readiness review found twelve additional semantic/runtime gaps after the earlier R-01–R-43 remediation. They are retained here as traceability items `T4-01` through `T4-12`. **FIXED IN DOCS** means the normative task/snippet contract was corrected; source implementation/release evidence remains downstream.

| Finding | Current documentation state | Remaining implementation/evidence gate |
| --- | --- | --- |
| T4-01 backward exit-gate dependencies | FIXED — P7A/P7B hand off mechanism/test hooks without P10 results; P8B no longer requires P9A digest or `passkey-auth-gate` result | P10 later supplies timed/conformance release evidence |
| T4-02 P9 production migration before rollout | FIXED — P9 is implementation/development/staging rehearsal only; P11 cohort 4 executes real retained-account migration and emits `p9_migration_complete` / `p9_authority_matrix_verified` | production cohort execution |
| T4-03 B13 module-scope runtime load | FIXED — MCP/RFC9728 routes resolve acknowledged runtime per request or revision-keyed atomic cache; unconfigured import/requests stay bootable and fail 503 | implement watcher/cache/routes |
| T4-04 wrong HTTP runtime owner | FIXED — tunneled `apps/control-plane` HTTP artifact owns watcher/liveness/RFC9728/MCP/proof; DesktopCommander `src/server.ts` explicitly remains stdio | freeze committed control-plane revision |
| T4-05 first-run tunnel-health deadlock | FIXED — tunnel creation preflights separate private loopback/admin liveness; public metadata is checked only after config acknowledgement | implement separate local admin liveness / provider wiring |
| T4-06 threshold actions invalid after snapshot change | FIXED — each rule has explicit `appliesToSnapshots`; transition validates target-compatible threshold revision/action and P10 tests carryover for every edge | implement parser/generator |
| T4-07 unregistered prose evidence | FIXED — closed `PasskeyEvidencePredicateV1`; added `incident_or_change_approved` and `rollback_artifact_schema_compatible` with signer/freshness/environment/release/digest binding | implement evidence trust roots/storage |
| T4-08 P3 forced split shown as default | FIXED — Model A single physical transaction is preferred/default; Model B requires P1 library-boundary proof + P8A repair ledger | P1/P8A implementation proof |
| T4-09 lost `/provision` response unrecoverable | FIXED — OS-vault recovery journal precedes `/provision`; device-key recover-provision endpoint returns only original idempotent result | implement recovery route/store/tests |
| T4-10 successful ownership leaves proof/key | FIXED — cleanup obligation is persisted before candidate V2 can be saved; consumed-owned proof removal/key deletion resumes idempotently after crash | implement cleanup worker/store |
| T4-11 `/dashboard/passkeys` callback omitted | FIXED — B3 queryless allowlist and B6 union include exact route; descendants/query variants reject; P10 round-trip tests added | implementation tests |
| T4-12 telemetry event/never-log gaps | FIXED — C4 runtime-parses event names; registry expanded to HTTP headers, raw WebAuthn fields, request targets and 8 application/ingress/proxy/audit sinks; P10 tests final serialized output for every rule × sink | implement registry-driven sink adapters |

This fourth-pass remediation also preserves the prior external gates: P0 approvals, P1 server-enforced UV/account-model proof, concrete P8A technology/adapter selections, committed control-plane/IaC identities, P9A implementation artifact, P10 green evidence, and P11 release values/owners.

## Fifth-pass full-example remediation — 2026-09-07

The next review requested copyable/executable contract examples rather than prose-only closure. Findings `T5-01` through `T5-15` remain traceable here. **FIXED IN DOCS** means the normative example and cross-file contract agree; implementation and production evidence remain downstream gates.

| Finding | Documentation resolution | Remaining implementation/evidence gate |
| --- | --- | --- |
| T5-01 P8A omitted account deletion | FIXED — P8A flow ledger now includes P6's revocation-first account-deletion saga, independent journal acknowledgement, roll-forward cleanup, erasure, tombstone, and repair states; B15 mirrors it | select physical stores/APIs and fault-injection implementation |
| T5-02 generic auth transaction could mint cross-account fresh auth | FIXED — P8A separately defines ordinary sign-in and fresh reauth bound to account A/current S0, rejects credential owner B, rotates exact S0→S1, and atomically creates `FreshAuth(A,S1)` | P1 adapter transaction-boundary proof + tests |
| T5-03 independent journals were not crash-safe publication protocols | FIXED — SQL transactional-outbox or journal-as-ordered-authority patterns, append acknowledgement, pending API status, event idempotency, and every crash boundary are explicit | P8A technology choice and recovery drill |
| T5-04 runtime acknowledgements lacked schemas/durability | FIXED — exact operation/revision/document-or-tombstone digest/resource/bootstrap/server-generation/applied-time schema, stale/ABA rejection, POSIX fsync sequence, and Windows flushed-generation equivalent | cross-platform implementation/power-loss tests |
| T5-05 bootstrap class claimed unenforceable native identity | FIXED — class is `resource-control-bootstrap-v1`; it proves only key + exact-resource control and receives no binary/software-identity privilege | provider route/class implementation tests |
| T5-06 proof-only lifecycle state could strand recovery | FIXED — proof verification is request/transaction-local and direct durable CAS is `challenge_issued -> capability_issued`; idempotent sealed response handles response loss | P8A transaction implementation/fault injection |
| T5-07 browser approval exposed provider authorization ID | FIXED — browser submits only session-bound `approvalReference`; server resolves the provider ID from trusted state | route/parser/CSRF integration tests |
| T5-08 verification URLs accepted arbitrary same-origin paths/queries | FIXED — A2 pins exact route, queryless base URI, and one canonical matching `user_code` query for complete URI; duplicates/unknowns/fragments/alternate routes reject | provider-format and URL golden tests |
| T5-09 verifier network I/O escaped enclosing deadlines | FIXED — JWT/JWKS/introspection receives composed caller + verifier timeout + remaining operation/device-flow deadline; hanging-verifier tests added | connector implementation and timeout evidence |
| T5-10 initial rollout required completed fleet reauthorization | FIXED — new `device_v2_reauthorization_path_ready` gates initial production rollout; `device_v2_reauthorization_complete` remains required only for passkey-only cutover | signed production readiness/inventory evidence |
| T5-11 thresholds were mutable and weakly bound | FIXED — authenticated create-only publication with `If-None-Match: *`, canonical digest, immutable revision, idempotency, atomic audit/outbox, and exact `thresholds_green` revision+digest binding | P9A storage/API implementation + P11 values |
| T5-12 mutation body controlled operator identity | FIXED — body `actor` removed; `AuthenticatedOperatorPrincipalV1` is server-derived and authoritative for authorization/audit/outbox/idempotency | IAM integration tests |
| T5-13 cohorts lacked a canonical security boundary | FIXED — immutable environment/release-bound policy, allowlist ref+digest, sticky HMAC basis points/key ID, publication/audit, cross-instance/cache fail-closed rules, state revision, and durable expansion freeze are explicit | P9A policy/key/cache implementation + release policy |
| T5-14 P10 wording implied production migration proof | FIXED — P10 verifies only P9 development/staging rehearsal; only P11 cohort 4 emits production `p9_authority_matrix_verified` | production cohort-4 execution |
| T5-15 consolidated snippets were incomplete | FIXED — A2/A8/B5/B6/B14/B15/C2 now mirror URI/deadline/ack/class/lifecycle/browser-binding/account-deletion/threshold/cohort/principal contracts | compile against P1/P7A/P8A-selected APIs |

No row claims source implementation or real release evidence. The external P0/P1/P8A/P8B/P10/P11 gates remain open exactly where marked.

## Fourth-pass post-remediation validation

Validation is **path-aware over the untracked artifacts**; ordinary `git diff --check` is not used as proof for untracked documentation. After T4 remediation:

```text
Markdown documents parsed with Remark/GFM: 26/26
Markdown-It renders: 26/26
untracked passkey/research artifacts checked: 27
path-aware integrity errors: 0
internal docs/*.md|json references: 96
broken internal references: 0
never-log registry rules: 30 unique
never-log required sinks: 8 unique
registry selector/schema errors: 0
canonical task DAG nodes: 15
DAG cycles: 0
closed evidence predicate IDs: 19
transition predicate IDs used: 19
unregistered transition predicates: 0
latest-review required-marker misses: 0
tracked Git diff files: 0
non-doc working-tree entries: 0
HEAD: 19addf3c7fb5af82bb36424ccca3c003030c4832
```

The whitespace/newline/fence/duplicate-H2/NUL checks operate directly on each untracked path, so this validation does not rely on Git staging. All 27 working-tree entries remain under `docs/`; no application/source/config file was modified and no commit was created.

## Fifth-pass post-remediation validation

After the T5 full-example changes, the same path-aware validation was rerun directly over the untracked files:

```text
Markdown documents parsed with Remark/GFM: 26/26
Markdown-It renders: 26/26
untracked passkey/research artifacts checked: 27
path-aware integrity errors: 0
internal docs/*.md|json references: 97
broken internal references: 0
never-log registry rules: 30 unique
never-log required sinks: 8 unique
canonical task DAG nodes: 15
canonical task DAG edges: 53
DAG cycles: 0
closed evidence predicate IDs: 20 unique
transition predicate IDs used: 20
unregistered/unused transition predicates: 0
T5 required-marker misses: 0
T5 prohibited semantic findings: 0
tracked Git diff files: 0
non-doc working-tree entries: 0
HEAD: 19addf3c7fb5af82bb36424ccca3c003030c4832
```

The T5 semantic scan rejects the retired bootstrap class/state names, a browser provider-ID field in P7A approval input, a body `actor` property in `PasskeyDeploymentMutationV1`, the old initial-transition reauthorization predicate, and missing runtime-ack/threshold/cohort/account-deletion/browser-binding markers.

## Verdict

At the time of the second-pass review, the product/security direction was sound but the task pack and snippets were **not implementation-ready**. The remediation table above is the current status: the documentation defects have been addressed, while P0/P1/P7A/P8A/release gates still prevent a production-readiness claim.

Keep these decisions:

- passkeys are the only normal end-user credential;
- no social provider, email magic link, or product password;
- registration is one product action plus the mandatory browser/OS WebAuthn ceremony;
- device approval remains explicit;
- ChatGPT OAuth consent remains explicit;
- one stable passkey RP and authorization issuer are separate from per-device MCP resources;
- device refresh credentials stay in the OS vault;
- local Desktop Commander execution and claim-before-side-effect semantics remain local and unchanged;
- production passkey/OAuth authority uses durable shared state.

Do not begin production implementation until the blockers below are closed. The consolidated snippets now provide full contract-level reference examples for the reviewed findings, but they are not falsely presented as drop-in compiling source before P1/P7A/P8A select and verify the concrete provider, datastore, filesystem, IAM, and framework APIs.

## Review method and evidence boundary

The device-side review used CodeGraph against the current `DesktopCommanderMCP` source and traced the actual callers of:

- `DeviceOAuthSession`;
- `pairDevice()` and `refreshDeviceSession()`;
- `DeviceTokenManager`;
- credential-store implementations;
- tunnel metadata health checks;
- tunnel provider `status()` and `doctor()` paths;
- `MCPDevice` startup wiring.

The control-plane review relies on the source/package evidence already recorded in `docs/PASSKEY-ONLY-REGISTRATION-PLAN-AUDIT.md`. Its CodeGraph index is polluted by stale generated `.next` output, so package-version-dependent claims remain gates rather than assumptions.

No application source was changed by this review.

## Original blocking findings (pre-remediation evidence)

### R-01 — P0 is still open, not frozen

Evidence:

- `docs/PASSKEY-TASK-P0-PRODUCT-CONTRACT.md` calls the hostname a recommendation rather than a provisioned fact.
- Its exit checklist is entirely unchecked.
- No approved ADR containing the required G0 values is present in this docs pack.

Impact:

P1 cannot be considered started under the task pack's own gate model. RP identity becomes difficult to change after production credentials exist.

Required correction:

Create and approve a P0 ADR containing:

```text
PASSKEY_RP_ID
PASSKEY_ORIGIN
AUTHORIZATION_SERVER_ISSUER
WEBAUTHN_USER_VERIFICATION=required
FRESH_AUTH_MAX_AGE
ACCOUNT_IDENTITY policy
RESOURCE_MODEL
lost-all-passkeys behavior
minimum browser/OS versions
OAuth scopes per client/route family
```

Record an accountable DRI and product/security/operations approvers. Example values are not an approval.

### R-02 — P1 remains a hard no-go for the examined Better Auth versions

The existing audit correctly found:

- `@better-auth/passkey` 1.7.1 and examined 1.7.3 verification paths use `requireUserVerification: false`;
- Better Auth core 1.7.1 requires a unique email field.

Impact:

`userVerification: "required"` in generated options does not prove server-enforced UV, and the desired email-less account cannot be assumed to fit the current core schema.

Required correction:

P1 must choose and prove one production architecture that:

1. rejects registration with UP but no UV;
2. rejects authentication with UP but no UV;
3. persists no fabricated end-user email identity or email semantics;
4. creates account, credential, and session with a defined atomic/pending-state model;
5. preserves device and ChatGPT OAuth requests;
6. uses supported public package APIs rather than patched package output.

For a literal passkeys-only/email-less contract, P1 Option C should be marked no-go unless P0 explicitly changes the product definition to permit an internal compatibility value in a field named `email`.

### R-03 — OAuth authorization-server discovery is wrong for the proposed pathful issuer

Affected locations include:

- `docs/PASSKEY-TASK-P7-CENTRAL-ISSUER-RESOURCE-SEPARATION.md` discovery algorithm;
- `docs/PASSKEY-ONLY-REGISTRATION-FULL-SNIPPETS.md:186-188`;
- `docs/PASSKEY-ONLY-REGISTRATION-FULL-SNIPPETS.md:622-626`.

The snippets produce:

```text
https://auth.desktopcommander.app/api/auth/.well-known/oauth-authorization-server
```

For issuer `https://auth.desktopcommander.app/api/auth`, RFC 8414's path insertion form is:

```text
https://auth.desktopcommander.app/.well-known/oauth-authorization-server/api/auth
```

Required correction:

Prefer a pathless issuer such as:

```text
https://auth.desktopcommander.app
```

Otherwise implement the RFC 8414 path-insertion algorithm and optionally expose the framework-native appended route only as a tested compatibility alias. Compare returned `issuer` using exact configured-string equality.

### R-04 — First-device resource provisioning has a bootstrap cycle

The proposed flow currently implies:

```text
DCR client
-> link client to exact resource
-> authorize device
-> issue device token
-> register/own device
```

but the provisioning snippet expects account/device/client ownership that may not exist until after token issuance. The DCR request's `resources` member is not standard RFC 7591 metadata; it can be a private extension only if explicitly specified and validated by both sides.

Required P7 architecture gate:

1. Define how a new device obtains a one-time bootstrap capability.
2. Bind it cryptographically to a canonical resource and a device-generated bootstrap key or equivalent proof.
3. Define SSRF-safe proof of resource control.
4. Define request/response schemas, expiry, replay behavior, and idempotency.
5. Atomically create/reconcile the OAuth resource, client, and link.
6. Keep ownership pending until explicit account/device approval.
7. Define separate policies for resource-control bootstrap clients, public third-party MCP clients, and pre-registered clients.
8. Define resource lifecycle: disable, rotate, transfer, delete, and lost-account re-pair.

Do not expose generic resource administration to normal passkey sessions.

### R-05 — The task dependency graph is inconsistent

Examples:

- P3 relies on the durable intent/transaction model selected in P8 but declares only P1/P2 dependencies.
- P6 requires P8-grade concurrent final-passkey protection but declares only P3/P4 dependencies.
- The index diagram shows P8 feeding P5 while the dependency table and P5 file omit P8.
- P9 requires successful new-device approval but does not depend on P5.
- P8 references P3 registration atomicity and P6 concurrency requirements while being ordered before/independently of them.

Required correction:

Split P8:

```text
P8A — datastore and transaction foundation
P8B — serverless deployment, cold-start, scaling, and operations validation
```

Recommended dependency sequence:

```text
P0
 |
 v
P1 compatibility/security gate
 |
 +---------------------+---------------------+
 v                     v                     v
P2 auth/schema     P7A protocol         P8A datastore
foundation         contracts            foundation
 |                     |                     |
 +----------+----------+----------+----------+
            |                     |
            v                     v
        P3 registration       P7B device/resource implementation
            |
            v
        P4 sign-in
            |
   +--------+--------+
   v                 v
P5 approval       P6 management/recovery
   |                 |
   +--------+--------+
            v
        P8B deployment validation
            |
            v
        P9 migration
            |
            v
        P10 verification
            |
            v
        P11 rollout
```

Minimum dependency corrections:

- P3: P1, P2, P8A;
- P5: P3, P4, P7B, P8A;
- P6: P3, P4, P8A;
- P9: P5, P6, P7B, P8B;
- P10: all implementation tasks;
- P11: P10 evidence.

Generate the diagram and dependency table from one canonical DAG or validate them automatically.

### R-06 — Central auth and per-device resource deployment ownership is unresolved

P8 describes a logical split but does not freeze the deployable artifacts and route ownership. Allowing one Next.js application without a packaging rule risks deploying central passkey/session/admin routes behind every device tunnel.

Required correction:

Record:

- exact control-plane repository URL and immutable revision;
- central auth artifact;
- local/per-device resource artifact;
- owner of `/api/auth/**`, `/sign-in`, `/consent`, device approval, JWKS, and resource provisioning;
- owner of `/mcp`, RFC 9728 metadata, bearer challenge, and `/api/device/**`;
- whether `/mcp` and `/api/device/**` are one or separate OAuth resources;
- a versioned cross-repository contract for issuer, audience, scopes, claims, routes, provisioning, and compatibility windows.

Add a packaging test proving the local tunnel artifact cannot expose passkey registration, account management, migrations, or generic OAuth resource administration.

### R-07 — Audience and scope semantics are not defined per route family

The current device requests:

```text
device:sync offline_access
```

and sends the resulting bearer token to local `/api/device/**` routes. MCP calls require `mcp:tools`. The plan sometimes treats one public MCP resource as the audience for both, but snippets advertise only `mcp:tools` while provisioning both scopes.

Required correction:

Freeze one route authorization matrix. For example:

| Route family | Audience | Required scope |
| --- | --- | --- |
| Public `/mcp` | exact public MCP resource | `mcp:tools` |
| Internal `/api/device/**` as alternate transport for the same logical resource | exact public resource | `device:sync` |
| Internal `/api/device/**` as distinct resource | separate exact resource identifier | `device:sync` and a separate token |

Tests must prevent MCP tokens from being used for device synchronization and vice versa unless the shared-resource model is explicitly approved. Audience checks should be exact and should not accept arbitrary additional audiences by default.

### R-08 — The snippet pack cannot be described as copy-ready

Definite issues include:

- changed health-check signatures without updating all tunnel provider call sites;
- an incorrect RFC 8414 URL algorithm;
- incomplete runtime validation of OAuth JSON;
- unsafe refresh/clear races;
- a TypeScript narrowing error in the vault parser;
- replacement `env.ts` fields that break current consumers;
- prefix-collision callback validation;
- missing imports/error handling in the device auto-advance snippet;
- an unexported Next.js `POST` handler;
- circular resource provisioning;
- unresolved functions and package APIs in the central auth skeleton.

Required correction:

Rename the pack to implementation sketches and assign statuses such as:

```text
P1-BLOCKED
P7-BLOCKED
P8-BLOCKED
VERSION-UNVERIFIED
READY-AFTER-GATE
ILLUSTRATIVE
```

No snippet should be called a full replacement until its callers, package declarations, compile, unit tests, and security-negative tests are verified.

## Original high-priority task corrections (pre-remediation evidence)

### R-09 — Device approval needs an explicit CSRF and policy-enforcement contract

P5 should require:

- Approve/Deny mutations are POST-only;
- CSRF token and strict Origin/Sec-Fetch-Site policy appropriate to the cookie model;
- a one-time decision nonce bound to browser session and pending request;
- requested scopes are a subset of server policy for that client type;
- resource exists, is active, and is linked/eligible;
- client is active and is the client recorded in the pending request;
- replayed, cross-site, unknown-scope, unknown-resource, and changed-request submissions fail closed.

### R-10 — Device user-code handling needs guessing and URL-leakage controls

`verification_uri_complete` intentionally includes a user code, so it is an exception to a blanket “no credential in URLs” rule.

P5/P10 should require:

- durable per-code and coarse-source attempt limits;
- generic pre-auth errors for unknown, expired, denied, and consumed codes;
- no device metadata disclosure before account authentication;
- `Referrer-Policy: no-referrer`;
- no analytics or application logs containing the full code;
- replace the URL with an opaque server-bound reference after successful validation where practical;
- expiry and maximum-attempt behavior.

### R-11 — Completed registration intent must not become a session bearer credential

P3 suggests restoring a session after a committed response is lost. Possession of a consumed intent ID alone must never mint or restore a browser session.

Safe rule:

```text
commit succeeded but cookie/result was lost
-> fresh passkey authentication
-> existing account session established
```

If a continuation secret is used, it must be separate, one-use, bound to the original browser transaction, and threat-modeled. Add a stolen-completed-intent replay test.

### R-12 — Registration intent binding is incomplete in the snippets

The B6/B9 sketch does not explicitly bind:

- WebAuthn challenge/ceremony;
- expected RP ID and origin;
- opaque pending device request ID;
- state transition;
- account/credential/session transaction;
- browser continuation state.

A short RFC 8628 user code must not be stored as a bare fast hash. Use a server-owned opaque request ID or keyed HMAC/reference.

### R-13 — Lost-all-passkeys re-pairing needs an ownership-transition protocol

The plan says a locked-out user can create a new account and re-pair the local device, but no task defines what happens to:

- old owner association;
- old refresh credentials and grants;
- resource registry ownership;
- existing ChatGPT grants;
- device stable identity;
- simultaneous claims by old/new accounts.

Define this as creating a new association, not recovering the old cloud account. Require local control proof, invalidate old credentials/grants as policy dictates, and test transfer/re-pair races.

### R-14 — Device name/platform are self-asserted presentation metadata

Do not call CLI-supplied device name or platform trusted identity. They are integrity-bound to the pending request but can still be chosen by a malicious client.

Use copy such as:

```text
A computer identifying itself as “Tests-MacBook-Air” requests access.
```

Escape, length-limit, and reject control/bidirectional-confusing characters. Keep the normalized user code or equivalent possession confirmation visible in the primary approval summary; keep client ID/resource/scopes in advanced details.

### R-15 — Callback allowlisting must use route boundaries, not prefixes

This snippet is unsafe:

```ts
ALLOWED_PREFIXES.some((prefix) => pathname.startsWith(prefix))
```

It accepts paths such as `/device/approve-evil`.

Use exact or segment-boundary rules:

```ts
pathname === "/device/approve"
|| pathname === "/consent"
|| pathname === "/dashboard"
|| pathname.startsWith("/dashboard/")
```

Drop fragments unless required. Test encoded separators, backslashes, controls, dot segments, duplicate query keys, and nested callback parameters.

### R-16 — Device refresh state needs same-process and cross-process serialization

The proposed token manager can resurrect a credential after `clear()` if an in-flight refresh completes. The current store API also has no cross-process compare-and-swap or lock, so two desktop processes can race rotating refresh tokens.

Required design:

- typed OAuth errors, not regex over arbitrary descriptions;
- generation/epoch or abort handling so clear invalidates in-flight refresh;
- OS/file lock or versioned compare-and-swap around load/refresh/save/clear;
- stale writer cannot overwrite or clear a newer credential;
- crash-after-server-rotation recovery behavior;
- true multi-process tests.

### R-17 — OAuth/device HTTP needs runtime parsing, timeouts, and RFC 8628 hardening

Do not rely on TypeScript assertions over `response.json()`.

Validate:

- object shape and required string fields;
- `token_type` policy;
- finite positive bounded `expires_in`;
- finite bounded polling interval;
- verification URL scheme/origin;
- effective scopes;
- error response media/body shape.

Add per-request timeouts, total-flow cancellation, bounded backoff with jitter after transport errors, redirect/final-origin validation, and tests for `access_denied`, `expired_token`, malformed responses, malicious verification URLs, and recovery after transient failures.

OAuth permits refresh responses to omit a replacement refresh token and permits token responses to omit `scope` when unchanged. If mandatory refresh rotation is a provider-specific contract, document and test it as such rather than presenting it as generic OAuth behavior.

### R-18 — Resource canonicalization must be one exact, persisted algorithm

Silently removing trailing slashes can change the resource identifier. Define one provisioning-time serializer covering:

- lowercase scheme/host;
- deliberate IDNA handling;
- default ports;
- path and percent-encoding semantics;
- query/fragment rejection policy;
- IPv6 and loopback behavior.

Prefer rejecting noncanonical input with a corrective error. Persist one exact identifier and compare it exactly everywhere.

### R-19 — Revocation latency and migration revocation are underspecified

Disabling future issuance is not the same as immediately stopping existing access tokens.

Define maximum post-revocation exposure and choose a mechanism such as short token TTL, introspection, a grant/resource version claim, or a bounded local denylist/configuration feed.

P9 also needs a per-account revocation matrix for:

- browser sessions;
- password/email verification artifacts;
- OAuth grants;
- access and refresh-token families;
- bootstrap capabilities;
- approved devices;
- resource/client links;
- recovery credentials.

Unknown or quarantined accounts must not retain legacy authority after cutover.

### R-20 — Rollout state and rollback combinations are unsafe or ambiguous

`new_accounts` and `migration` may need to operate concurrently, so one sequential enum is insufficient unless states are explicitly cumulative. Independent flags can also produce impossible combinations.

Define a versioned deployment-state object and legal-combination validator. At minimum:

```text
central issuer enabled
=> verifier mapping deployed
=> resource provisioning available
=> v2 credential writes enabled

resource enforcement enabled
=> all active resource/client links backfilled

password disabled
=> passkey migration/recovery/support gates complete
```

Production issuer identity should be release-pinned/signed configuration, not a casually mutable feature flag.

Choose either no production dual-issuer fallback or a bounded dual-issuer period with exact issuer/JWKS/audience/scope allowlists and a hard expiration date.

### R-21 — P8 needs an executable datastore ADR

Before P8 implementation, choose and record:

- exact database, driver, and Better Auth adapter versions;
- transaction API for every atomic flow;
- isolation and row/advisory lock strategy;
- deadlock/serialization retry policy;
- serverless connection pool/proxy limits;
- migration locking/leader election;
- idempotency schema and retention;
- distributed rate limiter and endpoint-specific outage behavior;
- backup/PITR and restore behavior;
- regional consistency topology.

“Managed PostgreSQL-compatible” is a direction, not an executable persistence plan.

### R-22 — P10 lacks mandatory MCP bearer-challenge conformance tests

Add HTTP-level tests for:

```text
no Authorization header        -> 401
malformed token                -> 401
expired token                  -> 401
wrong issuer                   -> 401
wrong audience                 -> 401
valid token, insufficient scope -> 403
```

Every applicable `401` must include `WWW-Authenticate: Bearer` and the MCP-required `resource_metadata` reference to the exact RFC 9728 metadata URL. Test quoting, duplicate headers, redirects, caching, and absence of internal hostnames.

### R-23 — P10's default integration command is not generally runnable

The current integration runner includes infrastructure-dependent zrok tests that fail unless their environment is configured.

Split or document commands such as:

```text
test:integration
test:integration:oauth
test:integration:tunnel
test:e2e:production-shaped
```

Define skip policy, credentials, infrastructure, cleanup, network/cost implications, and expected CI environments.

### R-24 — P11 rollout gates need numeric thresholds

Before cohort rollout, record:

- minimum cohort size and soak duration;
- baseline comparison window;
- absolute/relative registration and sign-in failure thresholds;
- device approval/token refresh/MCP 401/403 thresholds;
- P95/P99 latency thresholds;
- database and rate-limiter saturation thresholds;
- alert evaluation duration;
- automatic versus manual rollback triggers;
- named incident owner and decision deadline.

## Original task-by-task review (pre-remediation)

| Task | Result | Required change before exit |
| --- | --- | --- |
| P0 | OPEN | Approve ADR, exact RP/issuer, platform versions, recovery, fresh-auth age, route scopes, accountable owners |
| P1 | BLOCKED | Prove server-required UV and a truly acceptable email-less identity/session architecture |
| P2 | BLOCKED BY P1/P8A | Pin one package family, preserve migration login safely, enforce credential uniqueness, validate RP/origin/issuer, remove email semantics |
| P3 | NEEDS REVISION | Bind intent to challenge/RP/origin/request; prevent intent-based session recovery; depend on P8A |
| P4 | DIRECTIONALLY SOUND | Use exact callback rules, preserve explicit create/sign-in distinction, freeze fresh-auth semantics |
| P5 | NEEDS REVISION | Add CSRF/Origin/nonce, rate limits, generic pre-auth errors, trusted policy checks, self-asserted metadata wording; depend on P8A |
| P6 | NEEDS P8A | Make final-passkey guard transactional; define account-deletion exception and lost-account re-pair semantics |
| P7 | BLOCKED | Correct RFC 8414 discovery; define bootstrap/provisioning protocol, route audience/scope matrix, exact canonicalization, cross-process token rotation |
| P8 | TOO BROAD | Split foundation from deployment validation and write exact datastore/deployment ADRs |
| P9 | NEEDS REVISION | Depend on P5; add complete legacy-authority revocation matrix and old/new ownership behavior |
| P10 | INCOMPLETE | Add MCP bearer challenge, malformed OAuth, multi-process vault, bootstrap/SSRF, legal rollout state, and runnable command coverage |
| P11 | INCOMPLETE | Define legal flag combinations, immutable issuer rollout, dual-issuer policy, numeric gates, and incident ownership |

## Original snippet-by-snippet review (pre-remediation)

### DesktopCommanderMCP snippets

| Snippet | Result | Required correction |
| --- | --- | --- |
| A1 `remote-identity.ts` | Not ready | Reject URL credentials and invalid protocols; freeze exact canonicalization; validate loopback consistently |
| A2 `device-oauth.ts` | Not ready | Correct RFC 8414 URL; validate JSON; validate verification URI; add timeouts/cancellation/backoff; define scope/rotation contract |
| A3 credential store | Incomplete | Store API needs generation/CAS or external cross-process lock for rotating refresh tokens |
| A4 vault parser | Definite TS issue | Check `typeof expiresAt === "number"` before `Number.isFinite`; canonicalize binding fields with A1 rules |
| A5 token manager | Unsafe race | Clear must invalidate in-flight refresh; use typed OAuth errors; protect cross-process rotation/stale writes |
| A6 tunnel health | Integration incomplete | Correct discovery URL, validate metadata fields, and update every provider `status()`/`doctor()` caller |
| A7 `device.ts` | Incomplete | Remove constructor-time environment mutation; inject identity/API client before imports can capture mutable env |
| A8 `remote.ts` | Incomplete | Update tunnel provider options and all Tailscale/zrok health call sites, not only direct CLI calls |
| A9 tests | Expand | Cover malformed metadata, redirects, timeouts, malicious verification URLs, multi-process refresh, exact canonicalization |

CodeGraph confirmed current `checkProtectedResourceMetadata()` and `checkAuthorizationServerMetadata()` are called from both Tailscale and zrok provider `status()`/`doctor()` paths. Changing only `remote.ts` is insufficient.

Also add `src/remote-device/control-plane-client.ts` to P7 targets: it captures `MCP_SERVER_URL` at module load, making current behavior import-order-dependent.

### Control-plane/auth snippets

| Snippet | Result | Required correction |
| --- | --- | --- |
| B1 OAuth scopes | Needs route model | Separate/define device and MCP route audiences/scopes; avoid contradictory metadata |
| B2 `env.ts` | Not a replacement | Retain/update all current consumers; make DB config valid; validate issuer, RP/origin relationship, credentials, protocol, path |
| B3 callback helper | Unsafe prefix match | Exact/segment-boundary route matching; no fragments; normalization attack tests |
| B4 auth client | P1/version blocked | Verify exact package declarations and plugin ordering; compile against pinned package family |
| B5 auth plugins | Hard blocked | UV/email blockers unresolved; missing functions; resource claims/policies incomplete; provider options version-unverified |
| B6 registration intent | Incomplete | Add challenge/RP/origin/request/state/transaction binding; no bare short-code hash |
| B7 account identity | Minor issue | Do not derive display label from OAuth subject prefix; generate independent label or display none |
| B8 sign-in action | P1 blocked | Preserve typed callback/error behavior and conditional UI cancellation semantics |
| B9 create action | P1/P8 blocked | Define atomic verified lifecycle and safe network ambiguity; context is never session authority |
| B10 device auto-advance | Definite integration issues | Add imports/helper, catch rejected calls, durable limits, no code leakage, effect dependency correctness |
| B11 approval copy | Directionally sound | Use self-asserted device wording and keep possession confirmation primary |
| B12 resource metadata | Contradictory scopes | Advertise every scope supported by that resource or define separate resources; freeze exact metadata URL |
| B13 bearer handler | Definite route issue | `export const POST`; implement required 401 challenge; validate active client/resource/grant policy as designed |
| B14 provisioning | Circular/unsafe | Derive subject/client/resource from trusted pending state; define first-device bootstrap and cross-store transaction/saga |

B2 specifically removes current environment fields consumed elsewhere and makes `betterAuthDbPath` optional while current database resolution expects a string. It cannot be pasted as a complete `env.ts` replacement.

### Test and rollout helpers

| Snippet | Result | Required correction |
| --- | --- | --- |
| C1 virtual authenticator | Useful | Add helpers for explicit UV=false/UP=true negative ceremonies and cleanup |
| C2 rollout state | Incomplete | Model cumulative/orthogonal capabilities and reject illegal combinations |
| C3 auth event types | Type-only | Enforce runtime event/property allowlists and length/value bounds |
| C4 Desktop telemetry | Too generic | Do not accept arbitrary property bags; map each event to a fixed runtime-safe schema |

## Specific corrected code shapes

### RFC 8414 metadata URL for a pathful issuer

```ts
function authorizationServerMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  const issuerPath = url.pathname === "/"
    ? ""
    : url.pathname.replace(/\/$/, "");

  url.pathname = `/.well-known/oauth-authorization-server${issuerPath}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
```

Prefer avoiding this complexity with a pathless issuer if the selected auth service supports it.

### Exact callback route boundaries

```ts
function isAllowedCallbackPath(pathname: string): boolean {
  return pathname === "/device/approve"
    || pathname === "/consent"
    || pathname === "/dashboard"
    || pathname.startsWith("/dashboard/");
}
```

### Vault numeric narrowing

```ts
if (
  typeof value.expiresAt !== "number"
  || !Number.isFinite(value.expiresAt)
  || value.expiresAt <= 0
) {
  return null;
}
```

### Interoperable refresh response handling

```ts
type OAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
};

const next: DeviceOAuthSessionV2 = {
  ...session,
  accessToken: response.access_token,
  refreshToken: response.refresh_token ?? session.refreshToken,
  expiresAt: Date.now() + response.expires_in * 1000,
  scope: response.scope ?? session.scope,
};
```

If rotation is mandatory for the chosen provider, replace the fallback with a named provider invariant and test it explicitly.

### Safe resource provisioning input boundary

A browser or device request should provide an opaque pending request reference, not authoritative ownership fields:

```ts
type ApproveProvisionedDevice = {
  approvalReference: string;
  decisionNonce: string;
  csrfToken: string;
};
// authenticated subject/session and provider pending authorization ID are server-resolved
```

The server loads client ID, resource, requested scopes, and device presentation from trusted pending state and performs policy checks before approval.

## Required remediation order

1. Mark the old GitHub/magic-link recommendation as superseded historical research.
2. Mark the snippet pack as implementation sketches, not copy-ready.
3. Complete and approve P0.
4. Run P1 and select the actual auth/WebAuthn architecture.
5. Freeze a pathless issuer or correct RFC 8414 discovery.
6. Write the P7 bootstrap/resource/audience/scope protocol ADR.
7. Write the P8A datastore/transaction ADR and revise the DAG.
8. Correct snippets only after those contracts are fixed.
9. Add P5 CSRF/user-code controls and P3 intent replay rules.
10. Add P7 multi-process refresh and P10 MCP bearer-challenge tests.
11. Add P9 full revocation behavior.
12. Add P11 legal rollout states and numeric gates.
13. Only then create an implementation branch and convert approved snippets into code incrementally.

## Implementation start criteria

Source implementation may begin only when:

- P0 is approved;
- P1 records GO for server-enforced UV and account/session identity;
- exact auth package versions and public APIs are pinned;
- issuer discovery behavior is standards-correct;
- first-device resource provisioning/bootstrap is specified;
- route audience/scope matrix is approved;
- P8A database/transaction design is selected;
- the dependency DAG is internally consistent;
- snippets are relabeled and corrected against actual call sites.

Until then, use the documents as design input and risk inventory, not as a copy/paste implementation backlog.

## Continued review — residual findings (R-25 through R-43)

This section records defects found after the first R-01–R-24 remediation pass. These are documentation/design findings, not claims about implemented source behavior.

### Residual severity summary

| Finding | Severity | Area | Result |
| --- | --- | --- | --- |
| R-25 | HIGH | Bootstrap issuance | Trust root and issuance channel undefined |
| R-26 | HIGH | Bootstrap lifecycle | Restart, retry receipt, reservation, abandonment, and final consumption incomplete |
| R-27 | HIGH | Resource-control proof | Wire protocol and SSRF-safe connection behavior not implementable yet |
| R-28 | HIGH | Client classes | DCR/CIMD privileges and SSRF policy incomplete |
| R-29 | HIGH | OAuth metadata/device UX | Capability validation incomplete and RFC 8628 user-code display regressed |
| R-30 | HIGH | OAuth transport | Response limits, 5xx retry, cancellation, deadline, and scope checks incomplete |
| R-31 | HIGH | Device wiring | Proposed injected client does not reach the actual `RemoteChannel` call path |
| R-32 | HIGH | Credential concurrency | Pairing/refresh error recovery and lock scope are unsafe/incomplete |
| R-33 | HIGH | Auth atomicity | Challenge consumption/counter/session terminal states undefined |
| R-34 | HIGH | Cross-store consistency | Transaction-versus-saga ownership and compensation undefined |
| R-35 | HIGH | Revocation/restore | No executable maximum exposure or pre-traffic restore reconciliation |
| R-36 | MEDIUM | Migration | Monotonic state conflicts with reversible legacy-login rollback |
| R-37 | MEDIUM | Dependency graph | Authoritative diagram and implementation order disagree with canonical table |
| R-38 | MEDIUM | Duplicate normative text | Older P3/P5 examples contradict corrected late sections/snippets |
| R-39 | MEDIUM | URL/callback validation | Loopback schemes, normalized paths, nested callbacks, and code normalization remain unsafe |
| R-40 | MEDIUM | Control-plane snippets | Environment, JWKS/RP validation, CSRF input, and response parsing remain inconsistent |
| R-41 | MEDIUM | Rollout contract | Conflicting V1 schemas and incomplete legal states/transitions/thresholds |
| R-42 | MEDIUM | Build/deployment evidence | Clean CI sequence, migration executor, artifact/IaC ownership remain open |
| R-43 | LOW | Test/telemetry helpers | Type-only safety and cleanup/runtime-property enforcement are incomplete |

### R-25 — Bootstrap capability issuance has no trust root

Evidence:

- `docs/PASSKEY-TASK-P7A-PROTOCOL-BOOTSTRAP-AND-RESOURCE-CONTRACT.md:130-150` says the capability comes from a “first-party provisioning channel” but does not define that channel.
- `docs/PASSKEY-ONLY-REGISTRATION-FULL-SNIPPETS.md` calls `bootstrapFirstPartyRemoteDevice()` without specifying who can call the issuance endpoint or how its initial device-key binding is authenticated.

Impact:

An unrestricted endpoint would allow arbitrary resource/client provisioning; an unspecified restricted endpoint is not implementable.

Required correction:

Define the endpoint or transport, eligible caller class, trust root, device-public-key binding, capability entropy and TTL, durable rate limits, one-time state transition, replay behavior, and response schema. Explicitly prohibit unrestricted anonymous capability issuance.

### R-26 — Bootstrap lifecycle and normal restart are incomplete

Evidence:

- `docs/PASSKEY-ONLY-REGISTRATION-FULL-SNIPPETS.md:1045-1072` performs bootstrap before the credential store is opened or checked.
- `DeviceTokenManager.initialize()` requires a provisioned client ID even when a valid bound V2 session exists.
- P7A has overlapping `provisioned`, `consumed`, replay, and idempotency concepts without a complete transition table.

Impact:

Normal restart can unnecessarily invoke a one-time bootstrap. If provisioning succeeds but RFC 8628 pairing fails, the spent capability/client ID has no durable local recovery receipt. Concurrent bootstraps can reserve the same resource ambiguously.

Required correction:

1. Open/load the credential store first.
2. Reuse a valid bound V2 session without bootstrap.
3. Invoke bootstrap lazily only when authorization is required.
4. Persist a versioned provisioning receipt before RFC 8628 begins.
5. Define a unique active reservation on the canonical resource.
6. Freeze a state machine with proof verification and capability issuance as one atomic transition, then `capability_issued -> provisioned_pending_approval -> consumed_owned`, with `expired/revoked/abandoned` terminals.
7. Define denial/expiry cleanup and exact retry-versus-malicious-replay behavior.

### R-27 — Resource-control proof remains non-implementable and under-specified for SSRF

Evidence:

- P7A describes a signed proof at a high level, while B14 reduces it to a caller-supplied `resourceControlProof: string`.
- A8 assumes `tunnel.prepare()` and `tunnelState.controlProof`, which do not exist in the current tunnel interfaces.
- P7B's source targets omit a bootstrap client, proof-serving route, ephemeral key manager, and tunnel proof integration.

Required correction:

Specify the signed object format and domain separator over bootstrap ID, exact resource, random challenge, and expiry. The central verifier must derive the proof path, reject redirects, enforce bounded streaming, validate TLS hostname, resolve and reject all special/private address classes, pin the validated address for the connection while retaining hostname for SNI/Host, and revalidate on retry. Add concrete source/interface targets.

### R-28 — DCR and CIMD client-class policy remains incomplete

Evidence:

- P7A says third-party clients follow a separate DCR/CIMD policy, but that policy is not frozen.
- B5 enables unauthenticated DCR and raw CIMD metadata fetching.

Required correction:

Define a server-enforced client matrix:

| Client class | Registration | Grants | Scopes | Resource authority |
| --- | --- | --- | --- | --- |
| `resource-control-bootstrap-v1` | key + exact-resource proof bootstrap only; no binary-identity privilege | device code + refresh | `device:sync`, approved offline scope | one server-linked resource |
| RFC 7591 third party | DCR | authorization code + refresh only | `mcp:tools`, approved offline scope | no resource admin/device scope |
| CIMD URL client | CIMD | authorization code + refresh only | `mcp:tools`, approved offline scope | no bootstrap/device scope |
| Internal client | authenticated server registration | explicit allowlist | explicit allowlist | explicit server policy |

Require PKCE S256 and exact redirect-URI rules for public authorization-code clients. Apply SSRF-safe redirect, DNS, address, timeout, size, and content-type controls to CIMD metadata retrieval.

### R-29 — Authorization metadata and RFC 8628 presentation checks are incomplete

Evidence:

- A2 validates issuer and endpoint strings but not the advertised grant, token-auth, response-type, and scope capabilities used by the client.
- `docs/PASSKEY-ONLY-REGISTRATION-FULL-SNIPPETS.md:466-474` hides `user_code` when a complete URI is opened.

Required correction:

Validate `response_types_supported`, device-code and refresh grant support, `token_endpoint_auth_methods_supported` containing `none`, required scopes, endpoint URL policy, media type, and bounded body. Always display validated `verification_uri` and `user_code`; opening `verification_uri_complete` is additional convenience under RFC 8628, not a replacement.

### R-30 — OAuth transport, deadline, and effective-scope handling remain incomplete

Evidence:

- A2 buffers `response.text()` before checking `text.length`, so its byte limit does not bound allocation and counts UTF-16 units rather than bytes.
- HTTP 5xx becomes `OAuthProtocolError` and is immediately rethrown, contrary to P7B/P10's retry requirement.
- No caller `AbortSignal` reaches pairing, polling, refresh, request timeout, or sleep.
- A2 stores any returned nonempty scope without requiring `device:sync` or rejecting scope expansion.

Required correction:

Use a bounded streaming reader, combine caller cancellation with per-request timeout and remaining total deadline, make sleep abortable, classify 429/5xx/transport failures for bounded jittered retry, and validate the effective scope as a subset of requested scopes containing `device:sync`. Prove the provider emits one exact resource audience through initial issuance and refresh.

### R-31 — Proposed client injection does not update the real call path

Evidence:

- A7 assigns `this.controlPlaneClient` but constructs `new RemoteChannel(this.tokens)`.
- Current `RemoteChannel` imports five free functions from `control-plane-client.ts`.
- The proposed class exposes only a generic `request()` method and removes the current API surface.
- P7B targets omit `remote-channel.ts`, tunnel types/factory, and direct-constructor tests.

Required correction:

Define a typed `DeviceControlPlaneClient` with register, Jazz token, heartbeat, claim, and completion methods. Inject it into `RemoteChannel`, replace all free-function calls, and include `remote-channel.ts`, tunnel types, `create-tunnel-provider.ts`, standalone device entry, test constructors, and supervisor-driven status paths in the migration.

### R-32 — Credential recovery and lock scope remain unsafe

Evidence:

- A5 turns refresh failures into `ReauthorizationRequiredError`, but `initialize()` only recognizes `OAuthProtocolError`, so same-startup re-pair can fail.
- Pairing occurs while the native credential lock is held, potentially blocking clear or another process for the full interactive flow.

Required correction:

Handle `ReauthorizationRequiredError` explicitly and continue to pairing. Keep the vault lock around load/refresh/save/clear only. Use a separate durable pairing lease, perform browser/poll work outside the vault lock, then reacquire and save only when lease, epoch, generation, and binding still permit it. Define duplicate-pair result disposal/revocation.

### R-33 — Challenge consumption is not part of a defined terminal auth transaction

Evidence:

- P8A lists challenge consumption separately from account + credential + session + intent.
- P10 fault injection does not place failures immediately around challenge CAS, counter update, session write, commit, and cookie emission.

Required correction:

For registration and authentication, choose either one supported transaction or an explicit durable state machine such as `pending -> verified_pending_commit -> completed`. Document behavior when the auth library consumes a challenge internally before application writes. Include credential-counter/fresh-auth/session state and response ambiguity in the same terminal model.

### R-34 — Cross-store transaction versus saga is undefined

Evidence:

- P7A says `BEGIN durable transaction/saga` without distinguishing them.
- Better Auth/OAuth records, application resource records, and Jazz/device ownership may not share one physical store.

Required correction:

For every durable record, specify owner, physical store, authoritative key, SQL transaction participation, outbox/inbox step, idempotency key, compensation or roll-forward action, retry deadline, and terminal manual-repair state. Split P8A physical primitives from per-flow contracts finalized jointly with P3/P5/P6/P7A/P7B.

### R-35 — Revocation and restore do not have executable deadlines

Evidence:

- `MAX_POST_REVOCATION_ACCESS_TOKEN_EXPOSURE` remains unapproved.
- P9's authority matrix is not required by its exit checklist.
- P10 does not time rejection against the approved maximum.
- P11 database rollback does not require revocation replay before traffic.

Required correction:

Approve a numeric maximum and enforcement mechanism. Test immediate refresh denial and access-token rejection by the deadline for account, device, resource, client, grant, and refresh-family revocation. Add matrix completion to P9/P10 exits. Restored auth services remain isolated until an independent append-only revocation/migration watermark is replayed and verified.

### R-36 — Migration monotonicity conflicts with rollback

P9 allows password verifier deletion while promising legacy sign-in restoration and monotonic migration states. Separate immutable migration evidence, current login entitlement, and destructive credential retirement. Keep disablement reversible through the soak window; delete verifier material only in P11's destructive contraction phase, or explicitly declare password rollback impossible for that account.

### R-37 — Canonical dependency diagram and snippet implementation order disagree with the table

Evidence:

- `docs/PASSKEY-ONLY-REGISTRATION-TASK-INDEX.md:52-76` depicts edges not present in the canonical table, including P7A-to-P2 and P6-to-P7B, and does not clearly show P7A/P8A prerequisites for P7B.
- `docs/PASSKEY-ONLY-REGISTRATION-FULL-SNIPPETS.md:1902-1909` schedules P1 before P0 approval and A1–A5 before P7A/P8A closure.

Required correction:

Regenerate all diagrams and implementation order from the dependency table. Distinguish optional pre-P0 research from the formal P1 gate. A1–A9 belong to P7B and require P1 GO + P7A + P8A.

### R-38 — Older normative P3/P5 text contradicts corrected late sections

Evidence:

- P3.1 still proposes the incomplete intent with `pendingDeviceCodeHash`.
- P3.2 still uses unsafe callback prefix matching and preserves fragments.
- P5.4 still routes with `user_code`, while B10 uses opaque `approval_ref`.
- Earlier P5 and its exit checklist call device name/platform trusted, while P5.16 correctly calls them self-asserted.

Required correction:

Replace—not merely append to—the obsolete types/examples. The canonical post-validation flow is `/device?user_code=... -> server validation -> /device/approve?request=<opaque reference>`. Mark presentation metadata server-bound but self-asserted.

### R-39 — URL, callback, and device-code validators still accept unsafe forms

Residuals:

- checks of `protocol !== "https:" && isLoopback(...)` admit schemes such as `ftp://localhost`;
- B3 can accept normalized dot segments, recursively encoded separators/controls, arbitrary duplicate query keys, and nested callback parameters;
- B10 strips/truncates invalid device-code characters so different invalid inputs can collapse to one valid code;
- resource/issuer helpers trim identity values before validation.

Required correction:

Allow only HTTPS or explicitly HTTP on approved loopback in development. Reject leading/trailing whitespace. Use route-specific callback query schemas and reject normalization ambiguity before/after parsing. Normalize only provider-defined display separators, then validate the entire device code against exact alphabet and length; never strip arbitrary characters or truncate.

### R-40 — Control-plane snippet composition remains inconsistent

Residuals:

- B2 exports `passkeyIdentityEnv`, while B5 imports `env` and expects the added fields.
- JWKS URL is only checked for nonemptiness.
- RP suffix logic can accept public suffixes.
- B4 uses an unsafe JSON assertion for a capability token.
- B14's CSRF helper receives no HTTP `Request`, so it cannot verify method, Origin, Host, or Sec-Fetch-Site.

Required correction:

Use one environment object or explicit consistent import; validate JWKS against the approved issuer; use a release-approved exact RP ID or public-suffix-aware validation; runtime-parse bounded capability responses; pass the actual HTTP request and session binding into approval validation.

### R-41 — Rollout state and thresholds are not one executable contract

C2 defines a boolean-heavy `PasskeyRolloutConfigV1`, while P11 defines a different enum-based V1 shape. Neither provides a complete state/readiness predicate set, transition graph, CAS mutation revision, or approved rollback target per state.

Use one canonical runtime-parsed schema. Define named cohort snapshots, legal directed transitions, evidence predicates, durable mutation revision/ETag, idempotent operator update, and exhaustive generated tests. Thresholds also need numerator/denominator, minimum sample, absolute and relative limits, burn/evaluation window, revocation/JWKS limits, and exact legal action/rollback target.

### R-42 — Clean CI and deployment ownership remain incomplete

P10 names real Just targets, but a clean checkout still needs `just bootstrap`; there is no dedicated passkey auth gate or CI workflow running it. P8B also leaves migration execution identity, IaC revision, artifact digest, secrets/signing-key owner, and promotion/rollback commands undefined.

Required correction:

Document and automate a clean sequence such as:

```text
nix develop -c just bootstrap
nix develop -c just test
nix develop -c just remote-gate
nix develop -c just passkey-auth-gate
```

Add a CI job with disposable auth dependencies and evidence artifacts. Freeze the one-shot migration job/IAM identity and explicitly prohibit cold-start migrations. Readiness should check a supported schema-version range/capability set, not exact equality during rolling expand-compatible deployment.

### R-43 — Test and telemetry helpers remain only partially safe

C1 lacks an explicit Playwright `Page` type and cleanup should detach/disable in nested `finally` blocks. C4's generic typing does not sanitize runtime JavaScript or `any` callers and omits at least the resource-metadata failure event used elsewhere.

Use per-event runtime parsers that construct fresh allowlisted objects. Reuse the single P11 rollout type rather than defining a second V1 schema.

## Continued-review remediation result (R-25 through R-43)

The residual findings below describe the state **before** this second remediation pass. Their current closure is:

| Finding | Current documentation resolution | Remaining external evidence |
| --- | --- | --- |
| R-25 | FIXED — `/challenge` -> server-fetched proof -> one-use 256-bit capability; no unrestricted anonymous capability issuance | implement/rate-limit/test endpoints |
| R-26 | FIXED — full bootstrap state machine, unique resource reservation, durable provisioning receipt, lazy bootstrap after vault reuse | implement receipt/lease/reconcile |
| R-27 | FIXED — exact Ed25519 signed bytes, derived proof path, TLS/SNI, IP pinning, DNS revalidation, special-address rejection, bounded streaming | implement SSRF-safe connector/proof handler |
| R-28 | FIXED — server-enforced first-party/RFC7591/CIMD/internal matrix, PKCE S256, CIMD SSRF policy | provider API verification/implementation |
| R-29 | FIXED — metadata grants/auth-method/scopes/response-types validated; user code always displayed | protocol integration tests |
| R-30 | FIXED — bounded byte reader, caller abort, abortable sleep, total deadline, 429/5xx/transport retry, effective-scope subset check | implementation tests |
| R-31 | FIXED — typed five-method `DeviceControlPlaneClient` injected into actual `RemoteChannel`; tunnel types/factory/supervisor/direct constructors included | source migration |
| R-32 | FIXED — `ReauthorizationRequiredError` recovery, short vault lock, separate pairing lease, winner/loser handling | native implementation/multi-process tests |
| R-33 | FIXED — terminal registration/auth state includes challenge CAS, counter, session/fresh-auth, commit/cookie ambiguity | P1 library-boundary proof |
| R-34 | FIXED — `PASSKEY-P8A-CROSS-STORE-CONSISTENCY-ADR.md` distinguishes transaction vs durable saga per record/flow | fill physical P8A choices |
| R-35 | FIXED — 300-second V1 maximum, immediate refresh denial, timed P10 checks, isolated restore + independent watermark replay | security approval + measured evidence |
| R-36 | FIXED — immutable migration evidence separated from reversible login entitlement and destructive verifier retirement | migration rehearsal |
| R-37 | FIXED — DAG/order regenerated from canonical table; formal P1 starts after P0; A1–A9 are P7B after P7A/P8A | validator/implementation adherence |
| R-38 | FIXED — obsolete P3/P5 types/callbacks/trusted-presentation wording replaced in place | none beyond implementation |
| R-39 | FIXED — exact https/http-loopback schemes, raw whitespace rejection, route-specific canonical callbacks, full-code validation/no stripping/truncation | parser tests |
| R-40 | FIXED — consistent identity env import, release-approved RP/JWKS, runtime capability parsing, Request-bound CSRF, class-policy skeleton | P1/package API compile proof |
| R-41 | FIXED — single `PASSKEY-P9A-DEPLOYMENT-STATE-CONTRACT.md`, revision/ETag CAS, named snapshots/transitions/readiness/rollback/metric semantics | release values |
| R-42 | FIXED IN DOCS — clean CI sequence, `passkey-auth-gate`, explicit migration IAM/job, artifact/IaC ownership, rolling schema capability readiness | actual committed workflows/artifact revisions |
| R-43 | FIXED — typed nested WebAuthn cleanup and runtime per-event telemetry reconstruction including resource-metadata failure | implementation tests |

### Current verdict

The task pack is now internally consistent for the reviewed R-01 through R-43 documentation/design findings. It is still **not production implementation-ready** because P0 approvals, P1 compatibility evidence, exact P8A technology/adapter selections, P7A/P7B implementation proof, P10 green evidence, and release-specific P11 values remain intentionally external gates.

No documentation statement should interpret “fixed” as proof that source code already implements these contracts.
