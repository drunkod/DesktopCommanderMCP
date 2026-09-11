# P6 — Multi-passkey credential management and recovery policy

Parent: `docs/PASSKEY-ONLY-REGISTRATION-TASK-INDEX.md`

Owner: auth service + account UX

Depends on: P3, P4, P7A, P7B, P8A

Blocks: P9, P9A (through P9), P10, P11

## Objective

Make passkey-only accounts survivable without introducing a hidden password/email recovery path. Users can add and remove credentials safely, but a recent passkey assertion is required for sensitive changes and the final credential cannot be deleted in V1.

## P6.1 Credential management model

User-visible list item:

```ts
type PasskeySummary = {
  id: string;             // application row id; not full credential material
  name: string;
  createdAt: Date;
  lastUsedAt?: Date;
  deviceType?: string;
  backedUp?: boolean;
  providerLabel?: string;
};
```

Do not expose public key or full credential ID.

## P6.2 Add another passkey

Flow:

```text
settings -> Add passkey
-> require fresh passkey authentication
-> generate registration options for current account
-> WebAuthn create
-> verify required UV
-> add credential to same account
-> show success + optional friendly label
```

This is an authenticated/additional-credential ceremony; it must never create a second account.

## P6.3 Fresh-auth requirement

Sensitive actions requiring a recent assertion:

```text
add passkey
rename passkey (optional depending on threat model)
delete passkey
revoke all device OAuth sessions
account deletion
```

Suggested freshness window: 5 minutes, to be frozen in P0/security review.

P4's account/session binding is mandatory. If the current browser session is `account=A`, the reauthentication assertion must resolve to `account=A`; selecting a discoverable passkey for account B fails closed. On success the server binds the fresh-auth marker to the exact current/rotated session ID, account A, and a server-issued timestamp. Sensitive mutation requires all three to still match. Sign-out, account switch, session revocation, or subsequent session rotation invalidates the marker.

A normal session cookie older than the freshness window redirects through this account-bound passkey reauthentication step and returns to the intended management action. The continuation is also bound to the same account/session and cannot be carried into a different signed-in account.

## P6.4 Prevent final credential deletion

Server invariant, not UI-only:

```text
activePasskeys(accountId) <= 1
AND account remains active
=> delete rejected
```

Error:

```text
Add another passkey before removing your last passkey.
```

The delete transaction must lock/read consistently enough that two concurrent deletions cannot remove both remaining credentials.

## P6.5 Concurrent-delete test

Initial state:

```text
credential A
credential B
```

Concurrent requests:

```text
delete A

delete B
```

Expected final state:

```text
at least one active credential remains
```

This requires transactional/serializable enforcement appropriate to the P8 database, not two independent preflight counts.

## P6.6 Revocation behavior

Deleting a passkey means future WebAuthn authentication with it fails immediately from shared durable state.

Decide whether deleting one passkey also revokes existing browser sessions. Recommended V1:

- credential deletion does not automatically kill every session unless compromise is selected;
- provide a separate “Sign out other sessions” / “Secure account” action;
- account-wide compromise flow can revoke sessions, device grants, and OAuth grants explicitly.

## P6.7 Device OAuth is separate from passkeys

Adding/removing a passkey must not silently delete paired devices.

Trust domains:

```text
passkeys       -> authenticate account holder
browser session -> current web login
device grant    -> paired Desktop Commander device
ChatGPT grant   -> MCP client consent
```

Expose separate revocation UI for devices/clients.

## P6.8 Recovery posture

V1 lost-all-passkeys behavior follows P0:

```text
no support-agent credential bypass
no email reset
no password reset
no local device auto-login to cloud account
```

If all credentials are lost, the user creates a new cloud account and explicitly re-pairs local devices. Local files/settings are not deleted.

## P6.9 Encourage redundancy

After first registration, inspect credential backup metadata if available.

If `backedUp === false`, show a non-blocking recommendation:

```text
Add another passkey so you have a recovery option.
```

Do not imply `backedUp === true` guarantees recoverability forever.

## P6.10 Credential labels

Default label may use:

- user-entered friendly name after ceremony;
- best-effort authenticator provider from AAGUID;
- generic `Passkey created <date>`.

Do not label based on unstable/private fingerprinting signals.

AAGUID is authenticator model metadata, not a unique device identity.

## P6.11 lastUsedAt

The examined Better Auth passkey schema does not visibly include `lastUsedAt`.

If product needs it, add application-owned metadata updated after successful authentication. It is convenience/security context, not authorization authority.

Update should not make sign-in fail if analytics/last-used write is temporarily unavailable unless the selected transaction model deliberately couples them.

## P6.12 Synced passkey counter behavior

Do not treat every zero/non-increasing counter from a synchronized credential as proof of cloning.

P8/P10 must test the library's documented counter semantics. Security decisions should combine:

- authenticator/device type;
- backup/sync behavior;
- credential counter behavior;
- actual WebAuthn verification result;
- revocation state.

## P6.13 Account deletion

Account deletion requires fresh passkey auth and explicit confirmation. It is a revocation-first durable saga, not a cascade of best-effort deletes:

```ts
type AccountDeletionStateV1 =
  | "requested"
  | "authority_revocation_committed"
  | "remote_cleanup_pending"
  | "credential_erasure_pending"
  | "completed"
  | "repair_required";

type AccountDeletionOperationV1 = Readonly<{
  version: 1;
  operationId: string; // 128+ CSPRNG bits; idempotency anchor
  accountId: string;
  initiatingSessionId: string;
  expectedAccountRevision: number;
  state: AccountDeletionStateV1;
  revocationWatermark: number | null;
  createdAt: Date;
  updatedAt: Date;
}>;
```

Required ordering:

```text
fresh-auth account/session check + explicit confirmation
-> BEGIN anchor transaction: lock/CAS active account, create deletion operation,
   mark account deleting, deny all new authority, revoke local browser/OAuth/device/resource authority,
   and insert the unique canonical revocation outbox event
-> COMMIT anchor transaction; API status is pending, not completed
-> outbox worker idempotently appends the same event ID to the independent revocation journal
-> receive durable append acknowledgement/watermark and record it idempotently
-> only now may the operation/API report authority_revocation_committed
-> consumers apply outbox/inbox work
-> roll forward Jazz/device/resource cleanup until authority is unusable
-> erase passkeys and deletable account data
-> retain the minimum non-secret audit/tombstone required to prevent resurrection/reuse
-> completed
```

A failure after revocation starts never compensates by restoring authority; it remains `remote_cleanup_pending` or `repair_required` and rolls forward. Reusing `operationId` with the same canonical request returns the original status; conflicting reuse rejects. Remote call history/audit retention follows the approved retention policy and is detached/pseudonymized where required. Local Desktop Commander files remain local unless the user separately deletes them.

## P6.14 Security event: stolen authenticator

Provide one account security action:

```text
Remove compromised passkey
-> fresh auth with another passkey
-> delete credential
-> optionally revoke other browser sessions
-> optionally revoke device/ChatGPT grants
```

If only one passkey exists, require adding a replacement first.

## P6.15 Management API authorization

Every credential-management endpoint verifies:

```text
authenticated account
fresh passkey assertion
credential belongs to account
action allowed under final-credential rule
CSRF/origin protections as required by framework
```

A credential row ID from another account must return not-found/unauthorized without leaking ownership.

## P6.16 Tests

```text
list shows only current-account passkeys
add second passkey maps to same subject
add requires fresh auth bound to same current account/session
remove requires fresh auth bound to same current account/session
account-A session + account-B discoverable passkey reauth -> reject
stale marker after session rotation/sign-out/account switch -> reject
cannot remove final credential
concurrent delete of two credentials leaves >=1
removed passkey cannot authenticate
renaming cannot target another account
AAGUID/provider label absence handled
synced credential counter case handled
session revocation action works independently
device grant remains unless explicitly revoked
lost-all-passkeys has no hidden legacy recovery endpoint
```

## Future implementation targets

Names depend on P1 architecture:

```text
apps/control-plane/app/dashboard/security/passkeys/page.tsx
apps/control-plane/lib/passkey-management.ts
apps/control-plane/lib/fresh-auth.ts
apps/control-plane/app/api/account/passkeys/*
apps/control-plane/test/passkey-management*.test.ts
```

Prefer selected Better Auth passkey management endpoints where their authorization/freshness semantics meet this task; wrap only the additional product invariants.

## P6.17 Transactional final-credential guard

Final-passkey protection is enforced inside the P8A transaction/lock boundary. Two concurrent deletes must not both observe “2 credentials” and leave an active account with zero.

Account deletion is the explicit P7A/P7B/P8A-backed terminal saga above. It may remove all credentials only after revocation-first authority denial is committed and the independent revocation journal acknowledges the event; partial remote cleanup is forward-repaired and never restores authority.

## P6.18 Lost-all-passkeys creates a new association

If P0 approves the V1 policy, local re-pair does **not** recover the old cloud account or transfer its OAuth subject.

Required flow:

```text
prove local control of Desktop Commander installation/device
create a new passkey account
create a new account-device association
reconcile/replace resource ownership through P7A lifecycle rules
revoke/invalidate old device refresh authority and links per policy
require new ChatGPT consent/grants where old subject cannot remain valid
```

Define and test races where the old account regains access while a new account attempts re-pair. The service must never silently permit simultaneous authoritative ownership.

## Exit checklist

- [ ] Multiple passkeys per account supported.
- [ ] Fresh assertion required for sensitive actions.
- [ ] Final credential deletion blocked server-side.
- [ ] Concurrent deletion cannot remove all credentials.
- [ ] Removed credential fails immediately.
- [ ] Device/ChatGPT grants remain separately manageable.
- [ ] Recovery posture matches P0.
- [ ] No hidden email/password/support bypass.
- [ ] Synced-counter behavior tested/documented.
- [ ] Account deletion revocation-first saga, idempotency, journal acknowledgement, retention/tombstone, and terminal repair states are implemented and fault-injection tested.

## Rollback

Disable credential-management mutations while preserving sign-in with all existing passkeys. Never mass-delete passkeys to roll back the management UI. If a migration bug affects labels/last-used metadata, roll back only that non-authoritative metadata layer.
