# P9 — Migration implementation, development cleanup, and production rehearsal

Parent: `docs/PASSKEY-ONLY-REGISTRATION-TASK-INDEX.md`

Owner: auth/control-plane + release engineering

Depends on: P5, P6, P7B, P8B

Blocks: P9A deployment-state/telemetry foundation and P10 migration/revocation conformance; P11 owns real production-account execution

## Objective

Implement and rehearse the complete migration machinery without migrating production cohorts before the rollout gate. Synthetic/development identities may be reset or migrated in disposable/staging fixtures; retained-production account classification, entitlement transitions, authority disposition, evidence schemas, runbooks, and rollback behavior are fully implemented and rehearsed. **Real production retained-account migration is executed only by P11 cohort 4.**

## Current development reality

Existing local auth data has been populated heavily by smoke tests and generated identities. It should not be treated as a production user directory.

The current password cannot be recovered as plaintext and there is no existing forgot-password flow. Migration must therefore be based on deliberate account ownership, not password extraction.

## P9.1 Classify current identities

Before migration, inventory without exporting secrets:

```text
synthetic smoke account
manual acceptance/operator account
unknown/unclassified
```

Classification inputs may include known naming patterns and test fixtures, but never infer a real person's ownership solely from an email-like string.

Produce counts, not credential dumps.

## P9.2 Reset synthetic accounts

Default handling for generated smoke identities:

```text
delete/reset in disposable development auth database
recreate through new passkey test fixtures or virtual authenticator harness
```

Also clean associated development-only:

```text
sessions
OAuth grants/tokens
OAuth clients created solely for smoke tests
device rows owned by synthetic users when safe
registration intents/challenges
```

Preserve Jazz/device data only where required for migration testing; otherwise rebuild a clean test environment deliberately.

## P9.3 Identify retained accounts explicitly

If one operator/user account must be preserved, record:

```text
old account ID
which devices it owns
which OAuth grants/clients it owns
whether it has an authenticated migration session
immutable migration evidence state
current legacyLoginEntitlement
current passwordVerifierState
new passkey count
```

Do not publish those values in logs/docs; keep the migration record in the secure operator workflow.

## P9.4 Require a trusted migration session

A retained email/password account may add its first passkey only after a trusted authenticated legacy session or another explicitly approved ownership proof.

Flow:

```text
legacy sign-in (temporary migration window)
-> fresh authentication
-> Add passkey
-> verified required-UV ceremony
-> passkey linked to SAME account ID
-> test passkey sign-in
-> mark account migration-ready
```

Do not create a new account if the intent is to retain device/Jazz/OAuth ownership.

## P9.5 Preserve OAuth subject

Critical invariant:

```text
old account user ID == post-migration OAuth sub
```

Changing the account primary key can orphan:

```text
device ownership
Jazz principal mapping
ChatGPT grants/consents
OAuth refresh tokens
call history authorization
```

If P1 chooses an application-owned identity bridge that requires a subject migration, create a separate explicit mapping/migration ADR and revoke/re-authorize all grants rather than silently aliasing identities.

## P9.6 Migrate identity display away from email

After first passkey is added, create/confirm a pseudonymous display label. Email may remain in a legacy column during phased DB migration but must no longer be:

```text
login identifier
OAuth email claim
approval-screen identity
recovery mechanism
required product field
```

Do not drop the column until schema contraction phase proves no code path depends on it.

## P9.7 Verify retained device ownership

For every retained account, before legacy auth removal:

```text
passkey sign-in succeeds
list owned devices returns expected set
device approval for a new device succeeds
existing paired device refresh/reconnect behavior is understood
revocation still targets correct account
```

P7 credential-binding migration may force a one-time device reauthorization; treat that as expected if issuer/resource changed.

## P9.8 Handle old unbound device vault credentials

Do not migrate by stamping new issuer/resource onto existing unbound refresh tokens.

Expected behavior after P7:

```text
legacy/unversioned vault credential
-> clear safely
-> open central auth device flow
-> passkey sign-in
-> explicit device approval
-> save v2 bound credential
```

This one-time reauthorization is preferable to ambiguous token reuse.

## P9.9 Handle existing ChatGPT grants

If issuer, account subject, resource, client metadata, or signing keys change materially, old ChatGPT grants may no longer be safely reusable.

For each migration path test:

```text
old connector still valid and correctly bound
OR
old grant revoked/invalidated with explicit reconnect instructions
```

Do not preserve an incompatible grant simply to avoid one consent click.

## P9.10 Separate immutable migration evidence from reversible login entitlement

Do not overload one monotonic state with both historical evidence and current rollback capability.

Immutable/auditable evidence progresses only forward:

```text
legacy_observed
passkey_added
independent_passkey_signin_verified
resource_device_migration_verified
legacy_cutover_eligible
migration_complete
```

Current entitlement is a separate operator-controlled state:

```text
legacyLoginEntitlement = enabled | migration_only | disabled
passwordVerifierState = retained | destructively_retired
```

During the migration/soak window, `legacyLoginEntitlement` may move between `migration_only` and `disabled` for a retained account if rollback is required, while the historical evidence remains monotonic. `passwordVerifierState` stays `retained` until P11 destructive contraction. Once destructively retired, rollback to password authentication is explicitly impossible for that account.

## P9.11 Disable new password sign-up first

Safer order:

1. block legacy password registration for new users;
2. allow legacy sign-in only for known migration accounts;
3. migrate each retained account to passkey;
4. verify independent passkey sign-in;
5. disable the account's server-side legacy-login entitlement while retaining protected verifier material for the approved rollback/soak window;
6. remove legacy endpoints/UI after all retained accounts are complete;
7. delete verifier material only in the separately approved P11 destructive contraction.

## P9.12 Password authority disablement versus destructive retirement

During P9:

- disable password sign-in through server-side entitlement for migrated accounts;
- preserve verifier material only in the protected legacy store needed for bounded rollback during the approved soak window;
- prevent new password registration permanently;
- invalidate migration-only sessions as policy requires;
- verify disabled password sign-in fails while passkey sign-in succeeds.

Do **not** delete password verifier material during reversible P9 migration. Destructive deletion occurs only in P11's separately approved schema/credential contraction after the rollback window closes. P9 has no normal early-deletion path: any exceptional early destructive retirement requires a separate security/change approval, `passwordVerifierState = destructively_retired`, immutable `password rollback impossible` evidence recorded before execution, and a rollback plan that does not claim password restoration.

## P9.13 Unknown/unclassified accounts

Do not automatically migrate them.

Options:

```text
keep quarantined during migration window
explicitly classify
reset if confirmed synthetic
leave legacy-disabled and require admin review in dev only
```

Production policy should never depend on hidden unknown local accounts.

## P9.14 Virtual authenticator test accounts

Automated smoke users should migrate from fixed passwords to deterministic test harness behavior using virtual WebAuthn authenticators.

Requirements:

- no real Touch ID prompts in CI;
- test credential state isolated per run;
- cleanup idempotent;
- no production RP origin used by CI;
- test account IDs clearly synthetic.

## P9.15 Migration rehearsal

On a copy of development state:

```text
backup DB
classify accounts
run schema expansion
add passkey for retained test operator through virtual/manual ceremony
verify sign-in
exercise device reauthorization
exercise ChatGPT grant behavior
disable legacyLoginEntitlement while retaining passwordVerifierState=retained
restart all services
verify passkey success and legacy-login denial again
restore backup into an isolated environment
replay independent revocationWatermark and migrationWatermark before any traffic-ready result
```

Record only non-secret pass/fail evidence.

## P9.16 Migration failure cases

| Failure | Required response |
| --- | --- |
| passkey added but sign-in fails | keep legacy login for that account; diagnose before cutover |
| subject changed unexpectedly | stop; do not continue grant/device migration |
| device ownership missing | restore/reconcile before password retirement |
| resource mismatch | P7 reauthorization, never token rebinding |
| DB migration failed | restore/retry expansion; no schema contraction |
| user loses only new passkey during window | legacy migration login remains until independent verification/cutover |

## P9.17 Tests

```text
synthetic accounts reset cleanly
retained account gets passkey without changing subject
independent passkey sign-in works
password sign-up disabled for new users
legacy sign-in limited to migration window/accounts
password sign-in fails after entitlement disablement while verifier remains retained during soak
device ownership survives subject-preserving migration
unbound vault credential triggers new device auth
ChatGPT grant retained or explicitly reauthorized per migration contract
service restart does not resurrect legacy auth
```

## P9.18 Complete legacy-authority revocation matrix

For every retained, synthetic-reset, quarantined, and migrated account, record the intended disposition of:

| Authority/state | Retain, rotate, revoke, or delete |
| --- | --- |
| browser sessions | explicit per migration state |
| legacy-login entitlement | disable after independent passkey proof; may return to `migration_only` only during approved soak/rollback |
| password verifier material | retain protected throughout P9; delete only in P11 contraction or under separately approved rollback-impossible exception |
| email verification/recovery artifacts | revoke/delete if no longer a product identity |
| OAuth grants/consents | retain only when subject/client/resource contract remains valid |
| access token families | bounded by TTL/revocation policy |
| refresh token families | rotate/revoke explicitly |
| device authorization records | expire/consume/clear |
| bootstrap capabilities | consume/revoke |
| approved device associations | preserve only for retained subject; otherwise new association |
| resource/client links | preserve/reconcile/revoke according to P7A lifecycle |
| ChatGPT connector grants | retain only when exact subject/resource/client remains valid |

Unknown/quarantined accounts must not retain hidden legacy authority after cutover.

## P9.19 Revocation latency evidence

The migration implementation must consume the configured P7A revocation-exposure contract and expose non-secret `revokedAt`, `revocationCommittedAt`, and `firstRejectedAt` timing fields for every applicable authority class. P9 rehearsal uses synthetic/staging fixtures to prove those hooks and dispositions are executable. The security-approved numeric release value and **production** measured evidence are downstream gates: P10 validates the mechanism/timing in release-shaped tests, and P11 cohort 4 records real production migration/revocation evidence. P9 must not migrate production accounts early merely to satisfy its own exit checklist.

## Exit checklist — pre-production implementation/rehearsal only

- [ ] Synthetic smoke users classified/reset in disposable development fixtures.
- [ ] Retained-account classification and secure operator inventory workflow implemented without exporting secrets.
- [ ] Subject-preserving passkey migration path implemented and rehearsed on staging/synthetic retained fixtures.
- [ ] Device/resource/ChatGPT grant disposition matrix implementation is complete and rehearsal evidence exists for every authority class.
- [ ] New password sign-up disablement and migration-only legacy sign-in controls are implemented and tested.
- [ ] Immutable migration evidence, `legacyLoginEntitlement`, and `passwordVerifierState` are stored/reported as three separate axes.
- [ ] Password verifier destruction is deferred to P11 contraction; rollback-impossible exceptions require separate approval/evidence.
- [ ] Revocation timing hooks are implemented and exercised on non-production fixtures; P10 owns release-shaped timing conformance.
- [ ] Unknown-account quarantine/review behavior is implemented.
- [ ] Backup/restore and production migration runbooks are rehearsed without moving a production cohort.
- [ ] **No P9 exit item requires every production retained account to be migrated.** `p9_migration_complete` and `p9_authority_matrix_verified` are production predicates emitted during P11 cohort 4 and consumed only by later production transitions.

## Rollback

During the approved migration/soak window, legacy sign-in entitlement may be restored only for retained migration accounts whose verifier has not been destructively retired; do not reopen new password sign-up. Preserve all successfully registered passkeys and immutable migration evidence. After P11 destructive verifier retirement, password rollback is impossible and recovery uses the approved passkey/re-pair policy.
