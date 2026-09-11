# P9A canonical deployment-state, threshold, and cohort-policy contract

Status: **NORMATIVE PRE-P10 RUNTIME CONTRACT — implementation owned by P9A; release values remain P11/security gated**

Parent: `docs/PASSKEY-TASK-P9A-DEPLOYMENT-STATE-FOUNDATION.md`

## Canonical authority

This document is the single canonical serialized V1 contract for passkey deployment state, transition evidence, emergency registration pause, rollout thresholds, and cohort assignment/publication. P9A implements one runtime parser/schema/transition artifact before P10. P10 supplies conformance evidence. P11 operates the already-implemented contract; P11 does not implement a parser required by P10.

The runtime parser rejects unknown, missing, or duplicate properties; wrong scalar types; unsafe integers; out-of-range values; and illegal enum/cross-field combinations before use. Parser/evidence/state unavailability and unknown future versions fail closed. Each request resolves one immutable snapshot at request start and never rereads mutable rollout state mid-request.

Implementation package/module, generated schema artifact, immutable digest, and owning repository: `TBD-P9A-IMPLEMENTATION` (**P9A exit gate**).

## Runtime state schema

```ts
export type PasskeyDeploymentSnapshotV1 =
  | "disabled"
  | "internal"
  | "new_accounts_plus_migration"
  | "registration_paused_migration"
  | "passkey_only"
  | "registration_paused_passkey_only"
  | "legacy_removed"
  | "registration_paused_legacy_removed";

export type PasskeyDeploymentStateV1 = Readonly<{
  version: 1;
  revision: number;
  snapshot: PasskeyDeploymentSnapshotV1;
  passkeyRegistration: "off" | "internal" | "general";
  passkeySignIn: "off" | "internal" | "general";
  migration: "closed" | "retained_only" | "complete";
  legacyPasswordSignUp: "enabled" | "disabled";
  legacyPasswordSignIn: "enabled" | "migration_only" | "disabled";
  deviceSessionV2: "off" | "reauth_legacy_write_v2" | "v2_only";
  resourceEnforcement: "off" | "shadow" | "enforced";
  centralIssuerRouting: "off" | "internal" | "general";
  thresholdsRevision: number;
  cohortPolicyRevision: number;
}>;
```

`revision`, `thresholdsRevision`, and `cohortPolicyRevision` are safe integers `>= 0`; accepted mutations increment `revision` by exactly one. `ETag` is exactly `"passkey-deployment-state-v1:<revision>"`. Issuer, RP/origin, JWKS, artifact identity, schema range, IAM identity, and irreversible credential-retirement evidence are release configuration/evidence rather than mutable rollout toggles.

## Named snapshots and exact capability combinations

Only these exact tuples are valid:

| Snapshot | Registration | Sign-in | Migration | Password sign-up | Password sign-in | Device session | Resource enforcement | Central issuer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `disabled` | `off` | `off` | `closed` | `enabled` | `enabled` | `off` | `off` | `off` |
| `internal` | `internal` | `internal` | `closed` | `enabled` | `enabled` | `reauth_legacy_write_v2` | `shadow` | `internal` |
| `new_accounts_plus_migration` | `general` | `general` | `retained_only` | `disabled` | `migration_only` | `reauth_legacy_write_v2` | `enforced` | `general` |
| `registration_paused_migration` | `off` | `general` | `retained_only` | `disabled` | `migration_only` | `reauth_legacy_write_v2` | `enforced` | `general` |
| `passkey_only` | `general` | `general` | `complete` | `disabled` | `disabled` | `v2_only` | `enforced` | `general` |
| `registration_paused_passkey_only` | `off` | `general` | `complete` | `disabled` | `disabled` | `v2_only` | `enforced` | `general` |
| `legacy_removed` | `general` | `general` | `complete` | `disabled` | `disabled` | `v2_only` | `enforced` | `general` |
| `registration_paused_legacy_removed` | `off` | `general` | `complete` | `disabled` | `disabled` | `v2_only` | `enforced` | `general` |

The three `registration_paused_*` snapshots are emergency containment states: they stop new passkey account creation while preserving general passkey sign-in and the phase's password-login/device/resource semantics. They are not a password/social fallback.

`passkey_only` and `legacy_removed` intentionally share runtime capabilities; likewise their paused forms share runtime capabilities. The `legacy_removed` names certify separately stored irreversible contraction evidence. Moving application behavior back never recreates retired verifier material/schema.

### Permanent password-signup monotonicity

Once any committed state has `legacyPasswordSignUp = "disabled"`, every later legal state must also have `legacyPasswordSignUp = "disabled"`. The transition validator enforces this independently of the edge table. Therefore there is no legal production edge from `new_accounts_plus_migration` (or later) back to `internal`/`disabled`.

## Emergency registration-pause target registry

Every production snapshot has one exact target used by the P11 emergency-registration runbook and by threshold actions that need to stop onboarding without disabling sign-in:

| Production snapshot | Emergency target |
| --- | --- |
| `new_accounts_plus_migration` | `registration_paused_migration` |
| `registration_paused_migration` | `registration_paused_migration` |
| `passkey_only` | `registration_paused_passkey_only` |
| `registration_paused_passkey_only` | `registration_paused_passkey_only` |
| `legacy_removed` | `registration_paused_legacy_removed` |
| `registration_paused_legacy_removed` | `registration_paused_legacy_removed` |

`disabled` and `internal` are pre-production/pre-cutover states and are not post-launch emergency targets.

## Evidence predicate registry

P9A implements a **closed** predicate registry. Mutation input cannot supply arbitrary predicate strings. Real P10/P11 release evidence is produced later, but every envelope is runtime parsed against this schema before a transition can use it:

```ts
export type PasskeyEvidencePredicateV1 =
  | "p10_uv_and_auth_invariants_green"
  | "foundation_artifacts_frozen"
  | "staging_foundation_ready"
  | "passkey_ci_gate_green"
  | "new_account_flow_green"
  | "migration_support_live"
  | "p9_migration_complete"
  | "p9_authority_matrix_verified"
  | "recovery_policy_approved"
  | "device_v2_reauthorization_path_ready"
  | "device_v2_reauthorization_complete"
  | "revocation_deadline_zero_misses"
  | "restore_watermarks_reconciled"
  | "thresholds_green"
  | "legacy_rollback_still_possible"
  | "destructive_contraction_approved"
  | "legacy_material_retired"
  | "registration_incident_contained"
  | "incident_or_change_approved"
  | "rollback_artifact_schema_compatible";

type TransitionEvidenceBaseV1 = Readonly<{
  artifactDigest: string;
  environmentId: string;
  releaseId: string;
  observedAt: string;
  expiresAt: string | null;
  signerRole: string;
  signatureRef: string;
}>;

type ThresholdsGreenEvidenceV1 = TransitionEvidenceBaseV1 & Readonly<{
  predicate: "thresholds_green";
  thresholdsRevision: number;
  thresholdsDigest: string;
}>;

export type TransitionEvidenceV1 =
  | (TransitionEvidenceBaseV1 & Readonly<{
      predicate: Exclude<PasskeyEvidencePredicateV1, "thresholds_green">;
    }>)
  | ThresholdsGreenEvidenceV1;
```

All evidence is bound to the exact environment and release being mutated and to an immutable artifact digest. `artifactDigest`, signer role, and signature reference are mandatory even for operator approvals; a database row ID or prose reason alone is not evidence. Generic evidence freshness/clock-skew limits are frozen by P9A operations policy and fail closed when stale. Additional predicate-specific requirements are:

| Predicate ID | Required proof / signer and freshness binding |
| --- | --- |
| `p10_uv_and_auth_invariants_green` | P10 CI attestor; exact tested artifact digest/environment/release; valid for that artifact only |
| `foundation_artifacts_frozen` | release engineering approver; exact central/device/IaC/migration/P9A artifact digests and executor identities |
| `staging_foundation_ready` | platform/release attestor; current environment/release readiness result |
| `passkey_ci_gate_green` | CI attestor; exact workflow + tested artifact digest; current build only |
| `new_account_flow_green` | release/quality attestor; current cohort artifact/threshold evidence |
| `migration_support_live` | auth/release attestor; current environment migration UI/entitlement/evidence path |
| `p9_migration_complete` | **P11 cohort-4 production migration executor/attestor**; exact production environment/release; all retained accounts completed or approved exclusion |
| `p9_authority_matrix_verified` | **P11 cohort-4 production security/release attestor**; exact production authority disposition artifact |
| `recovery_policy_approved` | security/product approver; exact recovery contract revision |
| `device_v2_reauthorization_path_ready` | release/device attestor; current environment/release proves legacy readers can reauthorize and durably write V2 without opening general rollout |
| `device_v2_reauthorization_complete` | release/device attestor; current environment/release inventory proves every in-scope production device is V2 or explicitly revoked/excluded |
| `revocation_deadline_zero_misses` | P10/current-window security attestor; exact revocation timing artifact; expires with its defined observation window |
| `restore_watermarks_reconciled` | operations attestor; exact restore run/environment and source/target watermarks |
| `thresholds_green` | monitoring/release attestor; exact immutable `thresholdsRevision` **and** `thresholdsDigest` loaded by the target state; expires at the end of the evaluation freshness window |
| `legacy_rollback_still_possible` | migration/release attestor; current verifier/schema retention artifact; invalid immediately if destructive retirement advances |
| `destructive_contraction_approved` | security/change approver; exact migration artifact/environment/release; one contraction operation only |
| `legacy_material_retired` | migration executor + verifier attestor; exact destructive job digest/result |
| `registration_incident_contained` | incident commander; current environment/release and exact paused snapshot; short-lived current incident evidence |
| `incident_or_change_approved` | incident commander or authorized change approver; exact `fromSnapshot`, `toSnapshot`, mutation/environment/release; **max 15-minute freshness** and one mutation only |
| `rollback_artifact_schema_compatible` | release engineering attestor; exact rollback artifact digest + current schema capability digest + environment/release; **max 24-hour freshness and invalidated immediately when either digest changes** |

Predicate storage, signature algorithm/trust roots, generic freshness rules, and evidence URI scheme are `TBD-P9A/OPERATIONS` implementation fields; P9A cannot exit until they are concrete. Production evidence values themselves are produced by P10/P11 as described above.

## Legal directed transitions

No other cross-snapshot edge is legal. Same-snapshot mutation may only install an immutable compatible `thresholdsRevision` and/or `cohortPolicyRevision` plus audit metadata without changing capability fields.

| From | To | Required passing evidence | Approved failure/emergency target |
| --- | --- | --- | --- |
| `disabled` | `internal` | `p10_uv_and_auth_invariants_green`, `foundation_artifacts_frozen`, `staging_foundation_ready`, `passkey_ci_gate_green`, `thresholds_green`, `revocation_deadline_zero_misses` | `disabled` |
| `internal` | `disabled` | `incident_or_change_approved` | `disabled` |
| `internal` | `new_accounts_plus_migration` | `new_account_flow_green`, `migration_support_live`, `device_v2_reauthorization_path_ready`, `thresholds_green`, `revocation_deadline_zero_misses` | `registration_paused_migration` after commit; never `internal` once password signup is disabled |
| `new_accounts_plus_migration` | `registration_paused_migration` | `incident_or_change_approved` | `registration_paused_migration` |
| `registration_paused_migration` | `new_accounts_plus_migration` | `registration_incident_contained`, `thresholds_green` | `registration_paused_migration` |
| `registration_paused_migration` | `registration_paused_passkey_only` | `p9_migration_complete`, `p9_authority_matrix_verified`, `recovery_policy_approved`, `device_v2_reauthorization_complete`, `restore_watermarks_reconciled`, `thresholds_green`, `revocation_deadline_zero_misses` | `registration_paused_migration` while `legacy_rollback_still_possible`; otherwise stay paused and forward-repair |
| `new_accounts_plus_migration` | `passkey_only` | `p9_migration_complete`, `p9_authority_matrix_verified`, `recovery_policy_approved`, `device_v2_reauthorization_complete`, `restore_watermarks_reconciled`, `thresholds_green`, `revocation_deadline_zero_misses` | `new_accounts_plus_migration` while `legacy_rollback_still_possible`; otherwise `registration_paused_passkey_only` + forward repair |
| `passkey_only` | `new_accounts_plus_migration` | `incident_or_change_approved`, `legacy_rollback_still_possible` | `registration_paused_migration` |
| `registration_paused_passkey_only` | `registration_paused_migration` | `incident_or_change_approved`, `legacy_rollback_still_possible` | `registration_paused_migration` |
| `passkey_only` | `registration_paused_passkey_only` | `incident_or_change_approved` | `registration_paused_passkey_only` |
| `registration_paused_passkey_only` | `passkey_only` | `registration_incident_contained`, `thresholds_green` | `registration_paused_passkey_only` |
| `registration_paused_passkey_only` | `registration_paused_legacy_removed` | `destructive_contraction_approved`, `legacy_material_retired`, `restore_watermarks_reconciled`, `thresholds_green`, `revocation_deadline_zero_misses` | `registration_paused_passkey_only` application behavior with destructive evidence preserved |
| `passkey_only` | `legacy_removed` | `destructive_contraction_approved`, `legacy_material_retired`, `restore_watermarks_reconciled`, `thresholds_green`, `revocation_deadline_zero_misses` | `passkey_only` application behavior with destructive evidence preserved |
| `legacy_removed` | `passkey_only` | `incident_or_change_approved`, `rollback_artifact_schema_compatible` | `registration_paused_passkey_only` with destructive evidence preserved |
| `legacy_removed` | `registration_paused_legacy_removed` | `incident_or_change_approved` | `registration_paused_legacy_removed` |
| `registration_paused_legacy_removed` | `legacy_removed` | `registration_incident_contained`, `thresholds_green` | `registration_paused_legacy_removed` |
| `registration_paused_legacy_removed` | `registration_paused_passkey_only` | `incident_or_change_approved`, `rollback_artifact_schema_compatible` | `registration_paused_passkey_only` with destructive evidence preserved |

The transition engine additionally rejects any edge that would weaken required UV, resource/audience binding, revocation policy, or the permanent password-signup monotonicity invariant.

## Mutation, revision, ETag, and idempotency contract

```ts
export type PasskeyDeploymentMutationV1 = Readonly<{
  version: 1;
  mutationId: string;
  expectedRevision: number;
  fromSnapshot: PasskeyDeploymentSnapshotV1;
  toSnapshot: PasskeyDeploymentSnapshotV1;
  thresholdsRevision: number;
  cohortPolicyRevision: number;
  evidence: ReadonlyArray<TransitionEvidenceV1>;
  reason: string;
}>;

export type AuthenticatedOperatorPrincipalV1 = Readonly<{
  subjectId: string;       // stable server-authenticated IAM subject
  issuer: string;
  authenticationId: string;
  roles: ReadonlyArray<string>;
}>;
```

`AuthenticatedOperatorPrincipalV1` is constructed only from the authenticated server/IAM context after credential and audience verification. It is never accepted from JSON body, query, forwarded free-form header, or caller-selected audit field.

The P9A operator API requires both `If-Match: "passkey-deployment-state-v1:<expectedRevision>"` and the same parsed body revision. In one durable transaction it derives and authorizes the server principal, locks/CASes the exact current revision/snapshot, validates target tuple + edge + closed-registry evidence + password-signup monotonicity + emergency target + target-snapshot-valid immutable threshold/cohort revisions and digests, inserts unique `mutationId` audit/outbox data attributed to that server principal, writes `revision + 1`, then commits before response.

Identical canonical replay of the same `mutationId` returns the original committed result. Conflicting reuse, stale ETag/revision, audit/outbox failure, or illegal edge has no state side effect. No query/header/env/client per-request rollout override exists.

State source/table, transaction API, operator role, audit/outbox, and mutation-ID bounds: `TBD-P9A-IMPLEMENTATION` (**P9A exit gate**). Canonical request/document bytes use the RFC 8785 UTF-8 serialization fixed below; implementations do not choose another serializer.

## Threshold-set runtime schema

```ts
export type PasskeyThresholdRuleV1 = Readonly<{
  ruleId: string;
  metric: string;
  class: "availability" | "security_invariant" | "revocation_deadline" | "jwks_issuer_consistency";
  appliesToSnapshots: ReadonlyArray<PasskeyDeploymentSnapshotV1>; // nonempty, unique, explicit
  numerator: string;
  denominator: string;
  minimumSampleSize: number;
  absoluteLimit: Readonly<{ operator: "lt" | "lte" | "eq"; value: number; unit: "count" | "ratio" | "seconds" | "milliseconds" }>;
  relativeToBaselineLimit: null | Readonly<{ operator: "lte_ratio" | "lte_absolute_delta"; value: number }>;
  baselineWindowSeconds: number;
  evaluationWindowSeconds: number;
  burnWindowSeconds: number;
  requiredConsecutiveEvaluations: number;
  revocation: null | Readonly<{
    maxPostRevocationExposureSeconds: number;
    source: "P7A.MAX_POST_REVOCATION_ACCESS_TOKEN_EXPOSURE_SECONDS";
    authorities: ReadonlyArray<"account" | "browser_session" | "device" | "refresh_family" | "grant" | "client" | "resource">;
  }>;
  jwksIssuer: null | Readonly<{ maxInconsistentInstances: number; maxInconsistencySeconds: number }>;
  action: Readonly<
    | { kind: "warn"; target: "notify_owner"; runbook: string }
    | { kind: "freeze"; target: "freeze_cohort_expansion"; runbook: string }
    | { kind: "rollback"; target: PasskeyDeploymentSnapshotV1; runbook: string }
    | { kind: "pause_registration"; target: PasskeyDeploymentSnapshotV1; runbook: string }
  >;
  owner: string;
}>;

export type PasskeyThresholdSetV1 = Readonly<{
  version: 1;
  revision: number;
  environmentId: string;
  releaseId: string;
  rules: ReadonlyArray<PasskeyThresholdRuleV1>;
}>;

export type PublishedPasskeyThresholdSetV1 = Readonly<{
  document: PasskeyThresholdSetV1;
  canonicalDigest: string; // sha256-base64url(canonical JSON document)
  publishedAt: string;     // server UTC RFC3339
  publishedBySubject: string; // copied from authenticated server principal
}>;
```

Cross-field rules:

- required metric/rule IDs are unique and complete;
- `appliesToSnapshots` is nonempty/unique and every listed snapshot is a known exact V1 snapshot;
- a state transition must install/reference a `thresholdsRevision` whose **entire required rule set is valid for the target snapshot**; carrying the old revision across an edge is allowed only when every required rule still applies and every snapshot-valued action is legal for the target;
- `pause_registration` target must equal `approvedEmergencyRegistrationPauseTarget(sourceSnapshot)` for every source snapshot in that rule's `appliesToSnapshots`; split rules when source snapshots have different pause targets;
- `rollback` target must be the exact legal failure/rollback target for every source snapshot in that rule's `appliesToSnapshots`; split rules when targets differ;
- relative limit is explicit `null` when unused;
- zero-tolerance security rules are `eq 0 count`, minimum sample 1, immediate freeze/pause/legal rollback;
- required zero-tolerance classes include missing UV accepted, cross-account fresh-auth accepted, cross-account authorization, wrong audience accepted, and secret leakage;
- revocation deadline uses the security-approved P7A value (proposed V1 300 seconds remains `TBD-SECURITY-APPROVAL`) with zero allowed misses;
- JWKS/issuer rules require numeric inconsistent-instance/duration limits;
- missing/TBD release values make a threshold set non-promotable, not a reason to defer parser implementation past P9A.

P9A owns parser/module/storage wiring; exact release numeric values, owners, approvals, and runbooks remain P11/security gates.

### Immutable threshold publication

Threshold documents are canonicalized with RFC 8785 JSON Canonicalization Scheme, encoded as UTF-8, verified with golden cross-language vectors, and digested as SHA-256 base64url without padding. Publication is create-only:

```http
PUT /api/operations/passkey-thresholds/v1/<environmentId>/<revision>
Authorization: Bearer <operator credential>
Content-Type: application/json
If-None-Match: *
Idempotency-Key: <128-bit-or-greater CSPRNG base64url>

<PasskeyThresholdSetV1 without any actor/approver field>
```

The server derives `AuthenticatedOperatorPrincipalV1`, validates its publication role, parses the closed document, requires exact environment/release, computes canonical bytes/digest, and in one transaction inserts the immutable `(environmentId, revision)` document, unique digest/idempotency record, audit row, and outbox row. It never overwrites or updates a revision. Identical idempotency-key + canonical digest returns the original `201/200` result; conflicting reuse or an existing revision/different digest returns `409` with no side effect. Missing `If-None-Match: *`, audit/outbox failure, stale release, or unauthorized principal has no publication.

Deployment mutation resolves the exact immutable revision, verifies its stored digest and target-snapshot applicability, and records both revision and digest in state audit/outbox. `thresholds_green` is valid only when its `thresholdsRevision` and `thresholdsDigest` exactly equal that resolved document and its evidence environment/release match the mutation. Every P11 release-evidence record includes both values.

## Cohort-policy runtime and immutable publication

```ts
export type PasskeyCohortPolicyV1 = Readonly<{
  version: 1;
  revision: number;
  environmentId: string;
  releaseId: string;
  internalAllowlist: Readonly<{
    reference: string; // opaque immutable artifact reference, never the member list
    digest: string;    // sha256-base64url of canonical allowlist artifact
  }>;
  eligibilityMode: "internal_allowlist" | "percentage" | "allowlist_or_percentage";
  percentageBasisPoints: number; // safe integer 0..10000
  assignmentKeyId: string;       // KMS/HSM key identifier; no key material
  assignmentAlgorithm: "hmac-sha-256-sticky-v1";
}>;

export type PublishedPasskeyCohortPolicyV1 = Readonly<{
  document: PasskeyCohortPolicyV1;
  canonicalDigest: string;
  publishedAt: string;
  publishedBySubject: string;
}>;
```

Internal membership is true only when the authenticated opaque subject is in the exact allowlist artifact named by `reference` and verified by `digest`. Final eligibility follows `eligibilityMode` exactly: allowlist only, percentage only, or their boolean union; no deployment snapshot or caller may silently reinterpret it. Percentage membership is deterministic and sticky: compute `HMAC-SHA-256(assignmentKey, UTF8("DC-PASSKEY-COHORT-V1\n" + environmentId + "\n" + opaqueSubjectId + "\n"))`, interpret the first unsigned 64 bits big-endian, and include when `value mod 10000 < percentageBasisPoints`. The stable opaque account subject comes from authenticated server state; browser IDs, email, IP, cookies, request IDs, and body-selected values are forbidden. Keeping the same `assignmentKeyId` preserves assignment across policy revisions; key rotation requires an explicit change artifact because it reshuffles buckets.

Publication uses revision-addressed `PUT /api/operations/passkey-cohort-policies/v1/<environmentId>/<revision>` with path/body equality, authenticated operator context, `If-None-Match: *`, and a 128-bit-or-greater `Idempotency-Key`. It uses the same RFC 8785 UTF-8 canonicalization and SHA-256 base64url digest, immutable `(environmentId, revision)`, no-overwrite, server-principal, state/audit/outbox transaction, and conflicting-replay semantics as threshold publication. The parser verifies the referenced allowlist digest before publication and runtime use.

Every request resolves the deployment state and its exact immutable cohort policy once. All instances must produce the same assignment for the same environment/subject/policy and fail closed if state, policy, allowlist, key, revision, or digest is missing/mismatched. Caches are keyed by `(environmentId, revision, digest)` and may publish atomically only after full validation; stale-cache fallback across revisions is forbidden.

A threshold `freeze_cohort_expansion` action durably creates a `CohortExpansionFreezeV1` record in the same action/audit/outbox transaction. While active, it rejects publication or deployment-state selection of any policy that increases basis points, changes the internal allowlist to anything other than a verified strict subset, changes the assignment key, or otherwise makes additional subjects eligible. It does not evict already eligible subjects and does not block emergency registration pause, rollback, or a strictly contracting policy. Only the named runbook and an authenticated, audited unfreeze mutation with current green evidence may clear it.

## Schema compatibility readiness

Application artifacts declare minimum/maximum compatible schema revision, required capabilities, and known-incompatible revisions/capabilities. Readiness accepts a supported inclusive range/capability set; exact schema-version equality is forbidden for rolling expand-compatible deployment.

## Exhaustive conformance tests

P9A implements the generator; P10 reruns it as release evidence. It must verify:

1. every named snapshot parses only with its exact tuple;
2. every single-field mutation rejects;
3. every ordered pair is accepted iff listed;
4. every state with password signup disabled rejects any transition to a state with it enabled;
5. every production snapshot resolves to the exact registration-pause target above, and migration/contraction can advance paused-to-paused without transiently enabling registration;
6. each transition rejects missing/failed/stale/wrong-digest evidence;
7. destructive rollback targets preserve irreversible evidence;
8. same-snapshot threshold/cohort revision changes are deterministic and reference immutable digests;
9. stale/missing/mismatched ETag/revision has no mutation;
10. identical mutation ID is idempotent and conflicting reuse rejects; body-controlled actor fields reject and audit always uses the authenticated server principal;
11. unknown/duplicate fields, future versions, unsafe integers, malformed thresholds reject;
12. threshold rules enforce samples, limits, windows, owners/runbooks, revocation/JWKS fields, explicit `appliesToSnapshots`, and legal action targets;
13. every directed transition tests both carrying the old threshold revision and installing a new one; carryover rejects whenever any required rule/action is invalid for the target snapshot;
14. threshold publication is create-only/idempotent and `thresholds_green` rejects wrong revision or digest;
15. cohort publication/allowlist digest/sticky bucket assignment is deterministic across instances and fails closed on cache/key/revision errors; freeze blocks every expansion but allows contraction/emergency action;
16. unknown predicate IDs and evidence with wrong signer role, stale freshness, wrong environment/release, or wrong artifact digest reject; `device_v2_reauthorization_path_ready` cannot substitute for `device_v2_reauthorization_complete` at passkey-only cutover;
17. zero-tolerance security/revocation rules fire on first violation;
18. schema compatibility range/capability checks accept only supported artifacts.

P9A test library/module/seed policy and clean-checkout command: `TBD-P9A-IMPLEMENTATION`; P9A cannot hand off to P10 until implemented. P10 cannot become green unless its dedicated `passkey-auth-gate` reruns these tests and publishes retained non-secret results.
