# P9A — Deployment-state, threshold, cohort-policy, telemetry, and operator-mutation foundation

Parent: `docs/PASSKEY-ONLY-REGISTRATION-TASK-INDEX.md`

Owner: auth/platform + security/release engineering + operations tooling

Depends on: P8B production-shaped deployment foundation + P9 migration implementation/rehearsal semantics (not production migration completion)

Blocks: P10 conformance evidence and P11 production rollout

Type: pre-P10 executable foundation

## Objective

Implement the deployment-state parser, exact snapshot validator, directed-transition engine, threshold and cohort-policy parsers plus immutable publishers, evidence parser, revision/ETag mutation API, telemetry schemas, and never-log registry **before** P10 runs. P9A creates no production rollout approval and moves no production cohort; it only makes the state/telemetry contract executable and testable.

This split removes the former P10/P11 cycle: P10 consumes P9A artifacts, while P11 consumes P10 evidence to operate those already-implemented artifacts.

## P9A.1 Canonical runtime contract

The single serialized/runtime contract is `docs/PASSKEY-P9A-DEPLOYMENT-STATE-CONTRACT.md`.

Implementation must provide one parser/schema/publication/telemetry artifact whose immutable digest is produced and frozen **by P9A itself** after the P8B-declared repository/package/deployment boundary exists. Runtime code, operator tooling, CI, P10 tests, and P11 import that exact P9A artifact. Do not redefine a second boolean/enum rollout model.

## P9A.2 Required implementation surface

Before P9A exit, implement and version:

```text
parsePasskeyDeploymentStateV1
parsePasskeyThresholdSetV1
parsePasskeyCohortPolicyV1
publishImmutableThresholdSetV1
publishImmutableCohortPolicyV1
assignStickyCohortV1
assertLegalDeploymentTransition
requiredEvidenceForTransition
approvedEmergencyRegistrationPauseTarget
mutation request parser
revision + If-Match ETag CAS transaction
mutation idempotency/audit/outbox write using server-derived operator principal
threshold/cohort create-only If-None-Match publication + canonical digest
durable cohort-expansion freeze/unfreeze enforcement
telemetry event runtime parsers
never-log registry loader and sink sanitizers
schema compatibility readiness parser
```

Exact package/module paths, artifact digest, datastore table, transaction API, operator IAM role, and audit/outbox ownership are `TBD-IMPLEMENTATION` until selected; they are P9A exit gates, not P11 work.

## P9A.3 Production-safe registration pause states

The canonical contract must contain post-launch states that disable **new passkey registration** while keeping general passkey sign-in available and keeping password sign-up permanently disabled. Every production snapshot has one exact emergency registration-pause target; no emergency edge after password sign-up disablement may transition to `internal` or `disabled` if that would re-enable password registration.

P10 exhaustively tests these targets and P11 uses them in the emergency-registration runbook.

## P9A.4 Evidence without a dependency cycle

P9A implements predicate identifiers and validators, including predicates whose real release evidence is produced later by P10. P9A tests use signed/non-secret fixtures; they do **not** assert that P10 evidence is already green.

P10 supplies pre-release conformance evidence. P11 then produces/attaches live production evidence while operating cohorts. `device_v2_reauthorization_path_ready` proves the V2 reauthorization/write path is deployed and gates `internal -> new_accounts_plus_migration`; it is deliberately different from the fleet-inventory `device_v2_reauthorization_complete` required for passkey-only cutover. In particular, `p9_migration_complete` and `p9_authority_matrix_verified` are generated during P11 cohort 4, not during pre-P10 P9/P9A. The parser accepts their fixture schemas before P10, but production transitions require real current artifacts.

## P9A.5 Telemetry and never-log registry

`docs/PASSKEY-NEVER-LOG-REGISTRY-V1.json` is the machine-readable V1 deny registry for security-sensitive sinks. P9A implements runtime sanitizers from that registry for:

```text
application logs
structured traces/spans
analytics/captureRemote
error reporting/crash capture
operator diagnostic bundles
ingress HTTP access logs
reverse-proxy/CDN/WAF access logs
audit/outbox/dead-letter diagnostics
```

Sanitizers recursively reconstruct fresh allowlisted objects; they do not mutate and forward arbitrary caller objects. The registry parser supports only the closed selectors `keys`, `headerNames`, `urlQueryKeys`, `requestTargetQueryKeys`, and `urlBearingHeaderNames`; unknown selectors fail closed. It covers Authorization/Cookie/Set-Cookie headers, request-target query strings, URL-bearing headers, raw WebAuthn response fields, and application payload keys. Telemetry **event names** are runtime-parsed against exact sets before any sink call; TypeScript unions alone are not a security boundary. P10 validates the final serialized bytes/events emitted by every required sink, not merely intermediate sanitized objects.

## P9A.6 Mutation API

The operator mutation API is implemented before P10 and must enforce:

```text
runtime-parsed body
If-Match ETag == body expectedRevision
authenticated + authorized server-derived operator principal; no body actor
exact fromSnapshot/current revision CAS
exact immutable threshold + cohort policy revision/digest resolution
legal directed edge only
required evidence set + freshness/digest checks
approved rollback/emergency target validation
unique mutationId idempotency
state + audit/outbox in one durable transaction
no query/header/env per-request rollout override
```

P9A tests prove stale/mismatched revisions, conflicting mutation-ID reuse, illegal snapshot tuples, body-controlled identity, and audit/outbox failure have no state side effects. Audit, outbox, and idempotency records use only the authenticated server-derived principal.

## P9A.7 Threshold and cohort artifact publication

Implement the canonical threshold-set schema before P10, including numerator/denominator, sample minimum, absolute and relative limits, baseline/evaluation/burn windows, consecutive evaluations, revocation/JWKS fields, owner/runbook, and exact action target.

Threshold publication is authenticated and create-only: require `If-None-Match: *` plus a bounded idempotency key, derive the operator principal from server IAM context, canonicalize/digest the parsed document, and insert immutable document + audit + outbox in one transaction. A revision is never overwritten. `thresholds_green` and every release record bind the exact revision and digest loaded by deployment state.

Implement the canonical cohort-policy artifact and publisher from the contract: environment/release, immutable revision/digest, internal allowlist reference/digest, explicit eligibility mode, basis points, assignment key ID, and `hmac-sha-256-sticky-v1`. Runtime assignment uses the authenticated opaque subject and is identical across instances; cache/policy/key/allowlist mismatch fails closed. Publication has the same authenticated `If-None-Match: *`, idempotency, no-overwrite, audit/outbox transaction as thresholds. Deployment state references `cohortPolicyRevision`.

`freeze_cohort_expansion` is durable state, not a log-only action. While active it blocks any new policy or state selection that can add eligible subjects—including percentage, non-subset allowlist, eligibility-mode, or assignment-key expansion—but permits strict contraction and emergency registration pause/rollback. Authenticated audited unfreeze requires current evidence.

Release numeric values may remain P11/P0/security gated, but missing/`TBD-*` values make a threshold set non-promotable rather than unparsable implementation work.

## P9A.8 Tests before P10 handoff

P9A unit/property tests must cover:

```text
every exact named snapshot tuple parses
every single-field-invalid tuple rejects
every ordered pair is legal iff listed
production registration-pause emergency target exists for every production snapshot
no post-password-disable edge re-enables password signup
unknown/duplicate/missing fields reject
future version fails closed
revision/ETag CAS and mutation idempotency; no body actor and server-principal audit attribution
threshold cross-field validation + immutable publication/revision/digest/idempotency
cohort allowlist digest + sticky HMAC basis-point assignment across instances
cohort expansion freeze blocks expansion but allows contraction/emergency pause
telemetry sanitizer nested/any/error/url fixtures
never-log registry completeness and duplicate rule IDs
```

These are foundation tests. P10 reruns them through the dedicated passkey gate and adds system/integration evidence.

## Exit checklist

- [ ] `PASSKEY-P9A-DEPLOYMENT-STATE-CONTRACT.md` is implemented by one runtime parser/schema artifact.
- [ ] Exact named snapshot/transition/emergency-target generated tests pass.
- [ ] Registration-pause states preserve general passkey sign-in and never restore password signup.
- [ ] State mutation revision/ETag/idempotency transaction uses a server-derived authenticated principal; body actor fields are rejected.
- [ ] Threshold/evidence parsers and immutable create-only threshold publication are implemented; green evidence binds revision + digest.
- [ ] Cohort-policy parser/publication, allowlist digest, sticky HMAC assignment, cross-instance cache semantics, and durable expansion freeze are implemented.
- [ ] Telemetry runtime parsers are implemented from fixed allowlists.
- [ ] Machine-readable never-log registry is loaded by all supported sinks.
- [ ] P8B has already frozen the repository/package/deployment boundary and accountable owner for P9A; P9A now records the actual immutable parser/telemetry artifact digest for P10/P11 evidence.
- [ ] P10 can run from a clean checkout without implementing any missing rollout parser itself.

## Rollback

P9A is pre-production foundation. Before production state is used, an incompatible parser/engine revision may be replaced with a migration of its durable state schema. After production mutations begin, rollback must use a schema-compatible artifact and preserve revision, audit, evidence, and irreversible migration/retirement state; it must never fall back to ad-hoc flags.
