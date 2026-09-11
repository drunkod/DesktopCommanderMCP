# P11 — Rollout, observability, rollback, and operational readiness

Parent: `docs/PASSKEY-ONLY-REGISTRATION-TASK-INDEX.md`

Owner: product + auth/control-plane + DesktopCommanderMCP + operations/security

Depends on: P9A deployment-state/telemetry foundation implemented + P10 complete and green

Type: production cutover gate

## Objective

Ship the passkey-only account system without losing the ability to detect failures, contain regressions, preserve local-first behavior, or roll back application behavior safely. Rollout must be staged by capability and account cohort; schema contraction and destructive legacy-auth removal happen only after a defined observation window and backup/restore proof.

## P11.1 Preconditions

Do not begin rollout until P10 evidence proves:

```text
server-enforced UV
supported account identity model
registration/authentication terminal transaction or explicit durable-state boundary, including challenge/intent/credential-counter/session/fresh-auth/commit-cookie ambiguity
credential ID uniqueness
central issuer + per-device resource separation
versioned issuer/resource-bound device credentials
durable shared auth/OAuth state
migration rehearsal
browser/platform acceptance
backup + restore drill
```

Any P10 blocker returns the project to the owning P-task.

## P11.2 Rollout principles

1. Expand before contract.
2. Prefer reversible feature/config changes before destructive schema changes.
3. Never roll back by weakening UV or resource binding.
4. Never restore password sign-up as an emergency fallback for new users.
5. Preserve registered passkeys during application rollback whenever schema compatibility permits.
6. Treat database rollback, key rollback, issuer rollback, and application rollback as separate procedures.
7. Keep device and ChatGPT approval explicit throughout rollout.

## P11.3 Canonical versioned deployment-state model

The single normative serialized and runtime-parsed V1 contract is `docs/PASSKEY-P9A-DEPLOYMENT-STATE-CONTRACT.md`. P9A must already have implemented its parser, transition engine, threshold/evidence parsers, mutation API, telemetry schemas, and emergency registration-pause mapping before P10. P11 imports that tested artifact; it must not define or implement a second boolean/enum V1, transition table, evidence registry, threshold shape, or mutation engine.

The canonical contract fixes exact named snapshot tuples, every legal directed transition, required evidence predicate IDs, approved rollback target per edge, threshold/cohort-policy schemas and immutable publication, and revision/ETag/idempotency semantics. Runtime parsing rejects unknown/duplicate/missing fields and invalid cross-field combinations before use. State or evidence unavailability fails closed. Each request resolves one immutable snapshot at start and never rereads mutable flags mid-request.

`new_accounts_plus_migration` explicitly permits general passkey registration for new users while retained legacy accounts still have migration-only login. Its emergency target is `registration_paused_migration`, which disables registration but preserves general passkey sign-in and keeps password signup disabled. `passkey_only` and `legacy_removed` have corresponding registration-paused targets. Production issuer/RP/JWKS identity, schema compatibility range/capabilities, artifact digests, and IAM identities are immutable release evidence, not rollout toggles.

## P11.4 Legal state, evidence, transition, and rollback enforcement

The operator API must enforce the canonical `If-Match` ETag plus body `expectedRevision`, exact `fromSnapshot`, globally unique idempotency/mutation ID, server-derived `AuthenticatedOperatorPrincipalV1` (never a body actor), bounded reason, immutable evidence digests, exact threshold/cohort revisions, and one-transaction state+audit/outbox mutation. Stale or mismatched CAS has no side effects; identical retries return the original result and conflicting mutation-ID reuse rejects.

No transition proceeds when a required predicate is missing, failed, stale, malformed, or references the wrong artifact. In particular, central routing depends on verifier/resource/bootstrap/v2 readiness; enforced resource policy depends on canonical resource/link backfill; disabled legacy sign-in depends on completed P9 evidence/authority disposition and approved recovery; and `v2_only` depends on completed reauthorization. These are summaries only—the canonical predicate registry and transition table are authoritative.

Rollback never invents a state or weakens UV/resource/revocation policy. If verifier/schema retirement makes password rollback impossible, the only legal target preserves destructive state and rolls application behavior to the latest compatible snapshot.

## P11.5 State source, audit, and dual-issuer policy

Security-sensitive deployment state comes from a durable authenticated operator-controlled source with server-derived principal/time/reason audit. There is no query/header/client override and safe default is unavailable/fail-closed.

Default production issuer policy: **no dual-issuer fallback**.

If a bounded dual-issuer exception is ever approved by a separate incident/migration ADR, it must specify old/new exact issuer, exact JWKS sets, exact audiences/scopes, affected cohorts, hard start and expiration timestamps, owner/approver, and removal verification. After expiration the old issuer fails closed. Wildcard/multi-origin acceptance is forbidden.

## P11.6 Privacy-safe event taxonomy

Record state transitions, not credential material.

Control-plane event names:

```text
passkey_registration_started
passkey_registration_completed
passkey_registration_cancelled
passkey_registration_failed
passkey_auth_started
passkey_auth_completed
passkey_auth_cancelled
passkey_auth_failed
passkey_second_credential_added
passkey_credential_deleted
device_approval_shown
device_approved
device_denied
oauth_consent_shown
oauth_consent_approved
oauth_consent_denied
resource_provisioned
resource_provision_failed
```

Desktop/device events:

```text
remote_oauth_pairing_started
remote_oauth_pairing_completed
remote_oauth_refresh_completed
remote_oauth_reauthorization_required
remote_oauth_credential_binding_mismatch
remote_oauth_legacy_credential_detected
remote_oauth_discovery_failed
remote_oauth_resource_metadata_failed
```

## P11.7 Event properties allowlist

Allow only bounded, non-secret dimensions such as:

```text
app_version
schema_version
rollout_state
platform
browser_family
authenticator_category (platform/cross-platform only, if justified)
error_class enum
stage enum
credential_count_bucket
resource_provider/tunnel type
migration_state enum
```

Do not include raw free-form exception text by default if it may embed URLs, codes, or tokens.

## P11.8 Machine-readable never-log contract

`docs/PASSKEY-NEVER-LOG-REGISTRY-V1.json` is the canonical V1 deny registry implemented by P9A. P11 must not maintain a broader hand-written list that P10 can accidentally fail to test. The registry applies to every required sink:

```text
application logs
structured traces/spans
analytics/captureRemote
error reporting/crash capture
operator diagnostic bundles
```

It covers at least Authorization/Proxy-Authorization, Cookie/Set-Cookie, request-target and URL-bearing-header OAuth query values; access/refresh tokens; authorization/device/user codes; PKCE verifier; OAuth state; client/Better Auth/session secrets; WebAuthn challenge plus raw `attestationObject`, `clientDataJSON`, `authenticatorData`, assertion `signature`, `userHandle`, and `rawId`; credential public key/full credential ID; private JWK; bootstrap capability/device-key signature; provisioning receipt secret; verification-complete URLs; and biometric/PIN material.

Runtime sanitizers recursively construct fresh allowlisted outputs. Unknown authentication payload objects, nested `Error.cause`/response objects, raw URL strings, and arbitrary `any` property bags are secret-by-default and cannot bypass the registry by nesting or renaming through an untyped sink wrapper. Any P11 addition to the never-log policy must first update the registry and its generated P9A/P10 tests.

## P11.9 Existing DesktopCommander telemetry integration

This repository already exposes `captureRemote()` in `src/utils/capture.ts` and uses it for remote-device failure events.

Future implementation may emit the bounded device events through that path only after a redaction review.

Do not pass the complete caught `Error` object for authentication/OAuth failures until sanitization proves it cannot contain token responses, device codes, authorization URLs, or vault contents. Prefer a small enum payload:

```ts
void captureRemote("remote_oauth_credential_binding_mismatch", {
  reason: "issuer_mismatch",
  session_version: session.version,
});
```

Telemetry opt-out must continue to work and telemetry failure must never break device startup/auth semantics.

## P11.10 Structured server logs

For security/operator logs, use a stable schema:

```json
{
  "event": "passkey_auth_failed",
  "request_id": "opaque-request-id",
  "stage": "verify_assertion",
  "error_class": "missing_uv",
  "rollout_state": "internal"
}
```

No credential material. Request IDs must not encode user/device secrets.

## P11.11 Metrics

Minimum counters:

```text
passkey_registration_started_total
passkey_registration_completed_total
passkey_registration_cancelled_total
passkey_registration_failed_total
passkey_auth_started_total
passkey_auth_completed_total
passkey_auth_failed_total
device_approval_completed_total
oauth_consent_completed_total
resource_provision_failed_total
credential_binding_mismatch_total
legacy_credential_reauthorization_total
revocation_deadline_tested_total
revocation_deadline_missed_total
jwks_issuer_inconsistency_total
restore_watermark_lag_total
```

Histograms/timers:

```text
passkey_registration_duration_seconds
passkey_auth_duration_seconds
device_approval_duration_seconds
oauth_device_flow_duration_seconds
oauth_refresh_duration_seconds
```

Do not label by raw user/device/resource identifiers.

## P11.12 Derived service-level indicators

Track at least:

```text
registration completion rate
sign-in completion rate
approval completion rate
OAuth device-flow completion rate
refresh success rate
credential-binding mismatch rate
resource provisioning failure rate
unexpected legacy-auth endpoint usage
```

Separate user cancellation from technical failure so cancellation is not misdiagnosed as an outage.

## P11.13 Alert classes

### Critical

Page/stop rollout on:

- server accepts missing-UV assertion/registration in production verification tests;
- issuer metadata mismatch spike;
- tokens observed with wrong resource audience;
- credential/resource cross-account authorization failure;
- auth database corruption/unavailability beyond defined threshold;
- signing/JWKS inconsistency across instances;
- secret/token leakage detected in logs;
- any post-revocation access accepted after P7A's approved numeric maximum;
- restore readiness/traffic enabled while either independent revocation or migration watermark is stale.

### High

Pause cohort expansion on:

- registration verification failures spike;
- passkey sign-in failures spike across browsers;
- resource provisioning/link failures;
- OAuth device polling success collapses;
- refresh failures/re-authorization loops;
- migration subject/device ownership mismatch.

### Warning

Investigate without automatic rollback when:

- cancellation rate rises;
- one browser family degrades;
- second-passkey adoption below target;
- legacy credential reauthorization higher than expected during planned cutover.

## P11.14 Synthetic health checks

Run privacy-safe synthetic probes against non-production identities/resources:

```text
authorization-server metadata reachable
JWKS reachable and stable
protected-resource metadata advertises expected central issuer
resource registry can resolve a known synthetic resource
virtual-authenticator passkey sign-in succeeds in staging
OAuth device grant can reach pending state
```

Do not automate production biometric ceremonies.

## P11.15 Startup health separation

DesktopCommanderMCP operational status should expose independent checks for:

```text
tunnel transport
protected-resource metadata
central authorization-server metadata/JWKS
OAuth credential binding
Jazz/control-plane connectivity
local Desktop Commander child
```

This prevents an auth outage from being reported as a tunnel outage and vice versa.

## P11.15A Canonical cohort-policy operation

Every cohort uses the immutable P9A `PasskeyCohortPolicyV1` selected by deployment state's `cohortPolicyRevision`. The release record stores the policy revision + canonical digest, exact environment/release, internal-allowlist reference + digest, explicit eligibility mode, basis points, and assignment key ID. P11 cannot substitute an ad-hoc database query, request header, process-local percentage, email-domain rule, or browser cookie.

Internal operators come only from the exact immutable allowlist artifact. Percentage cohorts use P9A's deterministic `hmac-sha-256-sticky-v1` over the authenticated opaque subject, so all instances agree and assignment stays stable while the assignment key is unchanged. Missing/mismatched policy, digest, allowlist, key, cache revision, or release binding fails closed.

Expansion publishes a new immutable policy through the authenticated create-only API (`If-None-Match: *` + idempotency key), then CASes deployment state to that exact revision. It never overwrites a policy. A `freeze_cohort_expansion` action durably blocks every change that could add eligible subjects—including larger basis points, a non-subset allowlist, a broader eligibility mode, or assignment-key reshuffle—while allowing strict contraction, emergency registration pause, and approved rollback. Unfreeze is a separate authenticated/audited mutation with current green evidence.

## P11.16 Release cohort 0 — local/CI

Requirements:

- clean checkout runs `nix develop -c just bootstrap`, `just test`, and `just remote-gate`;
- dedicated future `nix develop -c just passkey-auth-gate` exists, is mandatory, and is not skipped/allowed-to-fail;
- disposable auth DB/issuer/rate-limiter only, migrated by the frozen one-shot job and CI-scoped identity;
- virtual authenticators only;
- no production RP registration;
- telemetry assertions/redaction tests run;
- canonical deployment-state/threshold/cohort publication, assignment, freeze, and exhaustive transition tests run;
- timed revocation and isolated dual-watermark restore rehearsal are green;
- pinned CI publishes the P10 non-secret artifact/test/seed/timing/revocation/restore evidence bundle with frozen owner/retention.

Exit: central/device/IaC/migration artifacts plus the P9A parser/telemetry digest are signed/identified for staging; every P8B ownership/executor/IAM field is filled and the P9A digest is recorded separately.

## P11.17 Release cohort 1 — staging stable RP

Deploy the final production-shaped architecture on a staging RP/issuer with separate staging resource URLs.

Verify:

- cold starts;
- shared durable DB;
- stable signing keys/JWKS;
- dynamic resource provisioning policy;
- device session v2 binding;
- browser matrix subset;
- logs/metrics/alerts.

No production passkey should be accidentally scoped to the staging RP.

## P11.18 Release cohort 2 — internal operators

Enable passkey registration/sign-in only for subjects in the exact immutable internal allowlist referenced/digested by the selected cohort policy. Record its cohort-policy revision/digest; no runtime body/header/domain rule may add an operator.

Perform:

```text
macOS platform passkey
Windows platform passkey
cross-device/hardware key
new device approval
normal restart without browser
revocation + same-startup reauthorization
ChatGPT consent/reconnect
second-passkey enrollment
```

Observe for at least the agreed minimum soak window from P0/release policy.

## P11.19 Release cohort 3 — new accounts passkey-only

Enable new account registration for the exact sticky HMAC percentage selected by the immutable cohort policy while keeping retained legacy migration paths isolated. Expansion changes basis points only by publishing and selecting a new immutable policy revision/digest.

Product requirements:

- one visible "Create account with a passkey" action;
- no email/password/social registration;
- unsupported platforms fail clearly;
- device approval remains explicit;
- ChatGPT consent remains explicit.

Do not expose migration-only password sign-in to new accounts. The `internal -> new_accounts_plus_migration` mutation requires `device_v2_reauthorization_path_ready`, proving the reauthorization/write-V2 mechanism is deployed; it does not falsely require fleet completion before rollout starts.

## P11.20 Release cohort 4 — retained-account migration

Open the P9 migration window only to explicitly retained identities.

Track three separate per-account axes; never collapse them into one reversible enum:

```text
immutable migration evidence:
  legacy_observed -> passkey_added -> independent_passkey_signin_verified
  -> resource_device_migration_verified -> legacy_cutover_eligible -> migration_complete

current legacyLoginEntitlement:
  enabled | migration_only | disabled

current passwordVerifierState:
  retained | destructively_retired
```

Immutable evidence never moves backward. During the approved soak window, entitlement may move between `migration_only` and `disabled` only while `passwordVerifierState == retained` and the canonical transition evidence allows rollback. No account disables legacy login before independent passkey sign-in proof. P9 does not destructively retire verifier material.

P9 delivered the migration implementation/rehearsal only; **this cohort is where real production retained-account migration executes.** After the migration window completes, P11 writes/signs the production evidence envelopes `p9_migration_complete` and `p9_authority_matrix_verified`, bound to the exact production environment/release and authority-disposition artifact. Those predicates do not exist as production-green evidence before this cohort and are required before the state engine may transition `new_accounts_plus_migration` (or its paused form) to `passkey_only`.

## P11.21 Release cohort 5 — passkey-only authentication

After all retained accounts are complete or deliberately excluded, and `device_v2_reauthorization_complete` proves every in-scope production device is V2 or explicitly revoked/excluded:

- disable legacy password sign-in globally through entitlement;
- keep protected password verifier material and compatibility columns through the approved rollback/observation window;
- keep `passwordVerifierState = retained` until cohort 6's separately approved contraction;
- verify password endpoints return intentional rejection/not-found;
- monitor unexpected endpoint attempts;
- keep passkey management/recovery policy prominent.

## P11.22 Release cohort 6 — legacy removal/schema contraction

Only after the observation window, isolated dual-watermark backup/restore proof, canonical `destructive_contraction_approved` evidence, and an explicit declaration that password rollback will become impossible:

- delete password-specific UI/routes/config;
- delete obsolete tests/fixtures;
- run the frozen one-shot credential-retirement job and set `passwordVerifierState = destructively_retired` only after verified deletion;
- remove obsolete email semantics/columns only if the selected architecture no longer needs compatibility fields;
- contract schema in a separate migration with its own immutable artifact, executor IAM identity, backup, verification, and forward-repair plan;
- append destructive retirement/cutover events to the independent migration journal.

Do not combine this destructive step with the first production passkey rollout. Once verifier material is retired, no rollback plan may claim password authentication can be restored.

## P11.23 Device v2 credential rollout

Recommended sequence:

1. ship code that can read legacy and v2 credentials but only uses v2 when fully bound;
2. on legacy credential, intentionally reauthorize and save v2;
3. observe reauthorization success rate;
4. after adoption window, remove legacy parsing only if safe.

Never convert v1 to v2 by adding issuer/resource fields without a new authorization exchange.

## P11.24 Central issuer rollout

Before switching device clients:

```text
central issuer metadata live
JWKS live/stable
resource registered
resource metadata advertises central issuer
DCR policy permits only intended resource
```

Then enable central routing for one internal cohort. The production default is no dual-issuer fallback. If a separately approved bounded dual-issuer ADR exists, only its exact issuers/JWKS/audiences/scopes and hard expiry may be used.

## P11.25 Resource registry rollout

Provision resources through one privileged application path.

Operational safeguards:

- create is idempotent;
- identifier validated as canonical HTTPS resource;
- owner/device association verified;
- allowed scopes explicit;
- disabled resource rejects token issuance;
- ordinary authenticated sessions cannot list/create/link arbitrary resources;
- audit event records safe resource fingerprint/id, not secret token data.

## P11.26 Signing key/JWKS rollout

Treat signing keys as a separate operational dependency.

Requirements:

- keys stored in durable secret/key management;
- all instances publish consistent JWKS;
- key IDs stable during normal restarts;
- planned rotation overlap documented;
- resource servers cache within safe TTL and recover after rotation;
- rollback never restores a compromised key.

## P11.27 Database migration rollout

Use expand/migrate/contract:

```text
expand schema -> deploy artifacts declaring compatible min/max + required capabilities -> migrate data -> verify -> contract later
```

For each migration record:

```text
migration id and immutable source/job artifact digest
backup/snapshot id
one-shot executor IAM/service identity and policy revision
schema revision before/after
capabilities added/removed
compatible application revision range before/after
forward command
verification query/test
rollback/isolated-restore/forward-repair procedure
operator/approver
```

Rolling readiness uses the artifact's inclusive compatibility range, required capabilities, and known-incompatible capabilities—not exact schema equality. Never run irreversible contraction before every running/rollback artifact is proven compatible or excluded.

## P11.28 Rollback decision tree

### UI/UX-only regression

Roll back UI/application code while preserving passkey schema/data.

### Passkey verifier/security regression

Immediately stop new passkey registration/sign-in cohort expansion. If the verifier cannot satisfy required UV, disable the affected authentication path rather than weaken policy. Existing sessions may need revocation based on impact analysis.

### Central issuer discovery regression

Pause new pairing; keep already valid cryptographically bound sessions only if their issuer/resource contract remains correct. Do not rewrite tokens to another issuer.

### Resource registry regression

Disable new resource provisioning/token grants for affected resources. Preserve existing resources unless corruption/security impact requires revocation.

### Database migration regression

Stop writes if necessary and restore only into an environment with issuance disabled and no production ingress/load-balancer/failover path. Replay both independently retained append-only P8A streams from the restored `revocationWatermark` and `migrationWatermark` to their current targets through durable dedupe. Verify revoked authority, login entitlement, destructive-retirement markers, signing/JWKS policy, and schema capabilities before readiness. Production traffic attachment requires a separate audited operator CAS/approval. Prefer forward repair when possible; do not mix application rollback with an incompatible schema.

### Key compromise

Rotate/revoke according to incident response; do not rollback to compromised signing material.

## P11.29 User-facing rollback behavior

If authentication service is temporarily unavailable:

- local Desktop Commander execution remains locally usable;
- new remote authorization fails closed;
- existing remote access only continues while valid authorization can be verified under policy;
- do not offer password/social fallback;
- communicate service status without exposing internal security details.

## P11.30 Device-side failure messages

Map safe operator messages to enums, for example:

```text
credential_binding_mismatch -> "Saved remote authorization belongs to a different server/resource; authorization must be repeated."
authorization_server_unreachable -> "The authorization service could not be reached."
resource_metadata_invalid -> "The remote MCP authorization metadata is invalid."
refresh_revoked -> "Remote authorization was revoked; authorization must be repeated."
```

Never print access/refresh tokens or complete device codes in generic error telemetry.

## P11.31 Runbook — emergency disable new registrations

Operator procedure:

1. read the current canonical production snapshot and resolve its exact P9A `approvedEmergencyRegistrationPauseTarget`;
2. CAS the state to that `registration_paused_*` target — never to `internal`/`disabled` after password signup has been disabled;
3. verify across instances that `passkeyRegistration == off`, `passkeySignIn == general`, and `legacyPasswordSignUp == disabled`;
4. verify existing passkey sign-in remains healthy if the incident does not affect authentication itself; if sign-in is unsafe, fail the affected auth path closed rather than enabling password/social fallback;
5. confirm device/OAuth grants still follow the unchanged audience/scope/revocation policy;
6. post service status/update and investigate using redacted event classes;
7. resume registration only through the canonical reverse edge after `registration_incident_contained` and current threshold evidence pass.

Required mapping: `new_accounts_plus_migration -> registration_paused_migration`, `passkey_only -> registration_paused_passkey_only`, and `legacy_removed -> registration_paused_legacy_removed`. Every mapping preserves general passkey sign-in and permanently disabled password signup.

## P11.32 Runbook — reauthorization storm

If bound credential mismatches spike:

1. check whether issuer/resource configuration changed unintentionally;
2. compare deployment metadata, not user tokens;
3. pause rollout if configuration drift exists;
4. do not suppress binding check;
5. confirm reauthorization completes once and stores v2;
6. verify restart no longer opens browser;
7. only then resume cohort expansion.

## P11.33 Runbook — resource provisioning failures

Check:

```text
resource canonicalization
resource row existence/disabled state
owner/device mapping
client-resource link policy
allowed scopes
database availability
```

Do not temporarily allow arbitrary resource URLs as a workaround.

## P11.34 Runbook — WebAuthn failure spike

Segment only by non-identifying dimensions:

```text
browser family
OS family
stage (options/browser/verify/session)
error class
rollout version
```

Determine whether failures are cancellation, unsupported platform, RP/origin drift, UV rejection, or server persistence failure.

## P11.35 Runbook — lost-all-passkeys

Initial-release policy from P0/P6 is intentionally strict.

If a user has lost every credential:

- do not bypass authentication through support email/social identity;
- explain account remote access is locked under current recovery policy;
- preserve local Desktop Commander data/use where technically independent;
- if P0 approves V1 re-pair, create a **new** passkey account and a **new** account-device association after local-control proof;
- revoke/reconcile the old device refresh family, grants, and resource/client association according to P6/P7A/P9; do not transfer the old OAuth subject;
- any future recovery of the old cloud account must ship as a separately threat-modeled feature.

## P11.36 Support documentation

Publish concise user guidance for:

- what a passkey is;
- supported platforms/browsers;
- adding a second passkey/security key;
- signing in on another device;
- phone/hybrid flow where supported;
- what happens if every passkey is lost;
- how device approval differs from sign-in;
- how ChatGPT authorization differs from device approval;
- how to revoke a device/passkey/grant where supported.

Do not promise recovery methods that are not implemented.

## P11.37 Security documentation

Maintain internal architecture docs for:

```text
RP ID/origin
central issuer/JWKS
resource provisioning
OAuth scopes
session/vault schema
passkey verification library/version
UV enforcement proof
durable database
signing key management
rollback boundaries
```

Update these whenever a security-relevant dependency changes.

## P11.38 Dependency upgrade policy

For Better Auth, passkey/WebAuthn, OAuth provider, MCP, and SimpleWebAuthn upgrades:

- rerun P1 UV/email/schema compatibility tests;
- rerun P10 negative suite;
- inspect generated/schema migration changes;
- verify resource policy defaults have not loosened;
- verify OAuth default scopes have not changed;
- record exact versions/lock hash.

Do not assume a minor upgrade preserves security defaults.

## P11.39 Success metrics

Suggested release targets:

| Metric | Target |
| --- | --- |
| New-account typed identity fields | 0 |
| Product clicks to start registration | 1 |
| Password/social/email registration paths | 0 |
| Orphan active accounts after failed registration | 0 |
| Wrong issuer/resource credential reuse | 0 |
| Browser opens on normal restart with valid v2 credential | 0 |
| Secret/passkey material logged | 0 |
| Return to pending device request after auth | >= 99% in healthy service |
| Second/backed-up passkey adoption | product target from P0, monitored without PII |

Do not use a success metric to justify relaxing UV or recovery security.

## P11.40 Release evidence record

For each cohort expansion record:

```text
release/version/commit
rollout state revision and snapshot before/after
immutable thresholds revision + canonical digest
immutable cohort-policy revision + canonical digest
cohort environment/release + percentage basis points + assignment key ID
internal allowlist artifact reference + digest (never member data)
time window
P10 evidence reference including thresholds_green exact revision + digest
database migration version
issuer/RP/resource config fingerprint
JWKS key ids (public identifiers only)
metrics before/after
alerts fired and cohort-expansion freeze state
known issues
server-derived operator principal subject/issuer/authentication ID + approver evidence
rollback trigger/command reference
```

## Canonical deployment-state consumption requirement

P11 performs no parser/transition-engine implementation. It imports the P9A artifact defined by `docs/PASSKEY-P9A-DEPLOYMENT-STATE-CONTRACT.md` together with its P10 evidence bundle. Production mutation is blocked if the deployed parser/telemetry artifact digest differs from the P9A-produced, P10-evidenced frozen digest or if any required evidence/threshold is stale.

P10 must already have generated every named tuple, each single-field-invalid tuple, every ordered snapshot pair, every emergency registration-pause target, password-signup monotonicity negatives, stale/mismatched ETags, and duplicate/conflicting mutation IDs. P11 only operates a green artifact; a hand-picked runtime happy path cannot substitute for that evidence.

## P9A telemetry artifact consumption

P11 does not define local telemetry property types or sanitizer implementations. It consumes the P9A runtime event parsers/allowlists and `docs/PASSKEY-NEVER-LOG-REGISTRY-V1.json` implementation that P10 already exercised across all required sinks. Adding a production event/property requires changing the P9A schema/registry first and rerunning the P10 generated telemetry/redaction gate; an operations-only wrapper cannot widen the allowlist.

Desktop `captureRemote` events likewise use the P9A per-event runtime reconstruction from C4 in the consolidated sketches. Callers pass unknown input to the sanitizer, never a trusted typed bag that can bypass runtime filtering.

## P11.41 Numeric rollout threshold records

No production expansion occurs while a threshold record is incomplete. Values remain `TBD-RELEASE`, but the **measurement semantics are fixed** by `docs/PASSKEY-P9A-DEPLOYMENT-STATE-CONTRACT.md`.

For each metric use the canonical runtime-parsed threshold rule and record numerator, denominator, minimum sample, absolute limit, explicit relative-to-baseline limit or `null`, baseline/evaluation/burn windows, consecutive evaluations, revocation or JWKS-specific numeric fields, exact action target/runbook, and owner. Before use, publish the complete set through P9A's authenticated create-only API with `If-None-Match: *`; record canonical digest and immutable revision. No revision overwrite is allowed. `thresholds_green` must name that exact revision + digest and the matching environment/release.

Required records:

```text
internal cohort minimum sample and soak duration
technical registration failure rate
technical sign-in failure rate
device approval technical failure rate
OAuth refresh failure rate
unexpected MCP 401 and 403 rates
resource provisioning failure rate
P95/P99 registration and sign-in latency
DB pool/saturation
rate-limiter saturation
JWKS/issuer inconsistency duration/count
revocation deadline misses
alert evaluation duration
manual decision deadline
```

Security invariants—missing UV accepted, cross-account authorization, wrong audience accepted, secret leakage—have threshold **0 occurrences**, minimum event sample 1, and immediate rollout freeze/approved rollback without waiting for a burn window. P7A's proposed V1 `MAX_POST_REVOCATION_ACCESS_TOKEN_EXPOSURE_SECONDS` is **300 seconds** and remains `TBD-SECURITY-APPROVAL`; no cohort expansion occurs until it is approved and imported. Refresh/new issuance denial is immediate, timed already-issued-token deadline misses have threshold **0**, and any miss immediately freezes rollout. JWKS/issuer inconsistency has explicit numeric instance/duration limits and an exact action target; its `TBD-RELEASE` values block expansion.

## P11.42 Incident ownership and decision authority

Before cohort 2, record:

```text
incident commander / primary owner: TBD-RELEASE
security decision owner: TBD-RELEASE
auth/platform owner: TBD-RELEASE
DesktopCommanderMCP owner: TBD-RELEASE
database/operations owner: TBD-RELEASE
rollback executor: TBD-RELEASE
```

The release evidence names the on-call decision deadline and exact rollback command/runbook reference.

## P11.43 Final cutover checklist

- [ ] P9A parser/transition/threshold/mutation/telemetry artifact implemented and immutable digest frozen.
- [ ] P10 fully green against that exact P9A artifact.
- [ ] Stable production RP/issuer frozen.
- [ ] Durable DB and key management verified.
- [ ] Central/device/IaC/migration/parser/CI artifact digests, accountable owners, deployment and migration executor IAM identities, and promotion/rollback workflows are frozen.
- [ ] Privacy-safe metrics/logs deployed.
- [ ] Alerts tested in staging.
- [ ] Feature-state source of truth audited.
- [ ] Canonical deployment-state runtime parser + legal-combination + directed-transition/CAS tests green; mutation audit uses only server-derived operator principal.
- [ ] Threshold and cohort-policy documents are immutably published with create-only precondition, canonical revision+digest, idempotency, and atomic audit/outbox; deployment state references exact revisions.
- [ ] Cohort allowlist reference/digest, HMAC assignment key, cross-instance sticky assignment, cache fail-closed behavior, and expansion-freeze tests are green.
- [ ] Numeric rollout thresholds include sample, absolute+relative limits, baseline/evaluation/burn windows, revocation/JWKS limits, exact action target/runbook, and owner; all are filled/approved and `thresholds_green` binds the selected revision+digest.
- [ ] P7A's numeric revocation maximum is approved and current timed evidence has zero deadline misses.
- [ ] Incident/rollback owners and decision deadline recorded.
- [ ] Production issuer/dual-issuer policy release-pinned.
- [ ] Internal cohort soaked successfully.
- [ ] New accounts passkey-only.
- [ ] Retained migration accounts complete.
- [ ] Legacy password sign-in disabled.
- [ ] Device v2 credential adoption measured.
- [ ] Normal restart causes no browser authorization.
- [ ] Resource registry remains fail-closed.
- [ ] ChatGPT consent remains explicit.
- [ ] Device approval remains explicit.
- [ ] Backup/restore procedure keeps the restore isolated, replays both independent append-only watermarks, and requires separate audited traffic attachment.
- [ ] Emergency registration pause reaches the exact `registration_paused_*` target for every production snapshot, preserves general passkey sign-in, and never re-enables password signup.
- [ ] Emergency disable/reauthorization/resource runbooks tested.
- [ ] User support docs published.
- [ ] Legacy schema contraction scheduled separately after observation window.

## P11.44 Definition of final completion

The project reaches `legacy_removed` only when:

```text
all supported new accounts are passkey-only
no retained account requires password login
server-enforced UV is continuously verified
central issuer/resource model is stable
all usable device credentials are bound v2 or intentionally reauthorized
legacy auth endpoints are unreachable
legacy credentials/schema are removed only under the separately approved P11 contraction and rollback evidence no longer claims password restoration
independent revocation/migration watermarks are reconciled before restored traffic
P7A's approved numeric revocation deadline is continuously gated at zero misses
observability can detect the primary security/availability failures
rollback/runbooks have been rehearsed
```

## Rollback

Rollback to the last compatible application release/configuration state, not to weaker authentication. Preserve passkey credentials and durable auth records when schema-compatible. If a security invariant is violated, disable the affected remote/auth path and fail closed until repaired. Never re-enable open password registration, fabricate email recovery, suppress issuer/resource binding, or reduce required UV as a rollback mechanism.
