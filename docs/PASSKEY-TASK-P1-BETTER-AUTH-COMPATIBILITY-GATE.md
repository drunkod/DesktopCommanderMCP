# P1 — Better Auth / WebAuthn compatibility gate

Parent: `docs/PASSKEY-ONLY-REGISTRATION-TASK-INDEX.md`

Owner: authentication/control-plane

Type: mandatory spike + architecture decision

Depends on: P0

Blocks: P2–P11

## Objective

Prove that the selected authentication stack can satisfy the passkey-only security model before adding production UI or migrations.

P1 is **not** “install the passkey package and see if it compiles.” It must prove account lifecycle, server-side WebAuthn verification, OAuth continuity, and persistence semantics using the exact dependency versions proposed for production.

## Current audit state

Pinned control-plane stack:

```text
better-auth                   1.7.1
@better-auth/mcp              1.7.1
@better-auth/oauth-provider   1.7.1
@better-auth/cimd             1.7.1
```

Examined compatible passkey package:

```text
@better-auth/passkey          1.7.1
@simplewebauthn/server        ^13.3.1
@simplewebauthn/browser       ^13.3.0
```

Registry audit also examined `@better-auth/passkey@1.7.3`.

### Confirmed supported API surface

The examined package does expose:

```ts
registration: {
  requireSession: false,
  resolveUser,
  afterVerification,
}
```

and client behavior equivalent to:

```ts
authClient.passkey.addPasskey({
  context,
  createSession: true,
});

authClient.signIn.passkey({ autoFill: true });
```

### Current blocker B1 — UV verifier

Both examined passkey versions call SimpleWebAuthn registration and authentication verification with:

```ts
requireUserVerification: false
```

P0 requires server-enforced UV. Therefore the current candidate fails until this is resolved through a supported production architecture.

### Current blocker B2 — core email schema

Better Auth core 1.7.1 declares the base user email field required + unique. The desired account is email-less.

A passkey-first `resolveUser()` identity is not itself a durable Better Auth user; `createSession: true` expects the target user to be loadable during verified registration persistence.

## P1.1 Build a compatibility matrix

Create a spike document/table for every candidate stack:

| Candidate | Pre-auth registration | Email-less account | Server-enforced UV | Creates session after verify | OAuth device flow | OAuth consent | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BA/passkey 1.7.1 | yes API | currently blocked | currently blocked | API exists | test | test | fail until blockers fixed |
| BA/passkey 1.7.3 | yes API | verify core | currently blocked | API exists | test | test | fail until blockers fixed |
| newer supported release | test | test | test | test | test | test | TBD |
| BA sessions + custom WebAuthn boundary | design/test | design/test | must pass | test | test | test | fallback candidate |

Do not select a candidate because documentation says “passkey supported.” Run the negative verification tests below.

## P1.2 Prove server-enforced UV

Use a virtual WebAuthn authenticator or captured test fixture capable of producing UP without UV.

Required tests:

```text
registration: UP=1 UV=1 -> success
registration: UP=1 UV=0 -> reject
authentication: UP=1 UV=1 -> success
authentication: UP=1 UV=0 -> reject
```

The rejection must happen in trusted server verification, not only because the browser happened to request UV.

Pass condition:

```text
server verifier is configured/proven to require UV for both ceremonies
```

Fail condition:

```text
server accepts a valid signature with UV absent
```

## P1.3 Prove email-less durable account creation

The successful proof must create a real production-shaped account with:

```text
stable account id
opaque WebAuthn user handle
pseudonymous/friendly display label
one passkey
one authenticated session
NO fabricated end-user email identity
```

Validate both database schema and runtime serialization.

Required assertions:

- no required email input;
- no deliverable/fake email value persisted;
- no email claim emitted;
- account can be loaded by session ID;
- OAuth `sub` resolves to stable account ID;
- passkey can sign in again username-less;
- a second credential maps to the same account.

## P1.4 Evaluate identity architecture options

Choose exactly one after evidence.

### Option A — supported email-optional Better Auth core user

Preferred if an upstream supported release allows it cleanly and all plugins remain compatible.

Required proof:

- generated schema makes email nullable/optional in the actual adapter;
- Better Auth internal adapters do not call `findUserByEmail` for passkey flow;
- OAuth provider/userinfo does not require email;
- migrations are supported.

### Option B — application-owned account + supported auth bridge

Use if Better Auth core cannot represent the domain model cleanly.

Requirements:

- application account ID remains OAuth subject;
- passkey table is keyed to application account;
- Better Auth session/OAuth bridge is documented and supported;
- no shadow identities can diverge;
- transaction boundary for account + passkey + session is explicit.

### Option C — internal synthetic compatibility identifier

Not pre-approved. Consider only if A/B are impossible and product/security explicitly accept it.

If used, it must be unmistakably non-deliverable/internal, never exposed as an email identity, never used for recovery, and accompanied by an ADR describing why a field named `email` no longer carries email semantics.

Do not use random `@example.com` identities as if they were user contact addresses.

## P1.5 Prove verified-registration atomicity

Required invariant:

```text
failed/cancelled WebAuthn ceremony -> no active account + no active session
successful verified ceremony       -> exactly one account + credential + session
```

Test failure injection at:

1. challenge created, browser cancels;
2. verification fails;
3. account creation fails;
4. passkey insert fails;
5. session creation fails;
6. response is interrupted after transaction commit;
7. duplicate request/retry arrives.

Define which transient pending records may remain and their TTL/cleanup.

## P1.6 Prove credential-ID uniqueness

The examined passkey plugin schema marks `credentialID` indexed but not visibly unique.

Do not rely solely on WebAuthn `excludeCredentials`.

Required proof:

```text
UNIQUE(passkey.credentialID)
```

or an equivalent supported DB/adapter invariant.

Race test:

```text
request A --------------------+
                              +--> same credential ID
request B --------------------+

expected: exactly one durable credential association
```

If plugin-generated schema cannot express this, document a supported migration/index strategy before P2.

## P1.7 Prove passkey challenge semantics

Verify the selected implementation provides:

- cryptographically random challenge;
- short expiration;
- challenge bound to ceremony type;
- exact challenge verification;
- one-time consumption;
- expected origin verification;
- expected RP ID verification;
- credential ownership lookup;
- replay rejection.

The examined Better Auth passkey implementation stores a verification value and consumes it during verification; P1 must preserve or replace this single-use behavior.

## P1.8 Prove pending OAuth/device callback continuity

Scenario:

```text
/device?user_code=ABCDEFGH
-> unauthenticated
-> server validates user_code, replaces it with opaque request reference
-> /sign-in?callbackURL=/device/approve?request=<opaque>
-> create passkey account
-> session established
-> return to exact same pending device request
-> approve
```

Assertions:

- callback remains relative/same-origin;
- code is not replaced by attacker-controlled callback state;
- registration retry/cancel preserves the pending request when still valid;
- another signed-in account cannot inherit a callback already bound to a different ownership decision if server state forbids it.

## P1.9 Prove ChatGPT OAuth consent continuity

Start a normal authorization-code/CIMD request and require sign-in.

After passkey sign-in/registration:

- exact authorization request is restored;
- client identity is unchanged;
- resource is unchanged;
- requested scopes are unchanged;
- user sees explicit consent;
- resulting token `sub` is the stable passkey account ID.

## P1.10 Prove device authorization compatibility

Run RFC 8628 flow end-to-end with the candidate auth stack:

```text
DCR/client metadata
-> device authorization request
-> verification_uri_complete
-> passkey auth
-> explicit device approval
-> device polling
-> access + refresh token
```

Required token checks:

```text
iss == central issuer
aud/resource == exact device MCP resource
sub == account id
scope includes device:sync
refresh rotation/retry semantics remain valid
```

## P1.11 Verify plugin composition/order

Candidate control-plane composition must test interaction among:

```text
passkey/session layer
JWT/JWKS
oauthProvider
OAuth device authorization
CIMD
bearer
nextCookies
```

Do not assume current `mcp()` composition remains correct after the central issuer/resource split; P7 likely moves the central auth service to `oauthProvider()` with the resource server separated.

## P1.12 Generate schema in a disposable database

Use Better Auth CLI/migration tooling against a temporary DB only.

Inspect:

- user fields/nullability;
- passkey fields;
- credential ID indexes/constraints;
- verification/challenge storage;
- session tables;
- OAuth resources/clients/grants/tokens;
- foreign keys and delete behavior.

No migration is applied to retained development auth data in P1.

## P1.13 Required spike tests

Suggested test names:

```text
passkey-register-no-session-success
passkey-register-rejects-missing-uv
passkey-auth-rejects-missing-uv
passkey-register-no-email-identity
passkey-register-failure-is-atomic
passkey-credential-id-is-unique-under-race
passkey-device-callback-preserved
passkey-device-oauth-subject
passkey-chatgpt-consent-subject
passkey-challenge-replay-rejected
```

Use virtual authenticators; do not make unit tests depend on a developer's Touch ID/Windows Hello hardware.

## P1.14 Go/no-go decision

P1 produces an ADR with one of:

### GO

All of these are proven:

- server-enforced UV;
- email-less domain identity without fabricated email semantics;
- atomic verified account + passkey + session lifecycle;
- credential uniqueness;
- device OAuth continuity;
- ChatGPT consent continuity;
- supported migrations.

### NO-GO / ARCHITECTURE CHANGE

Any blocker remains. Record the failing invariant and select the next supported candidate. Do not proceed by weakening P0.

## Copy-ready spike configuration shape

**Illustrative only; not approved against 1.7.1/1.7.3 until UV/email blockers are resolved.**

```ts
passkey({
  rpID: env.passkeyRpId,
  rpName: "Desktop Commander",
  origin: env.passkeyOrigin,
  authenticatorSelection: {
    residentKey: "required",
    userVerification: "required",
  },
  registration: {
    requireSession: false,
    resolveUser: async ({ context }) => {
      return resolvePendingPasskeyUser(context);
    },
    afterVerification: async (args) => {
      return persistVerifiedAccountIdentity(args);
    },
  },
})
```

The spike must inspect the actual verifier generated by the selected version and prove the negative UV tests. Configuration shape alone is not acceptance evidence.

## P1.15 Option C disposition

Under the current passkey-only/email-less product contract, Option C (an internal compatibility value stored in a field named `email`) is **NO-GO by default**.

It may be reconsidered only if P0 is deliberately amended and approved to permit that semantic mismatch. P1 may not select Option C merely because it is easier to fit Better Auth core schema.

P1 also records the exact public package APIs and versions that implementation is permitted to call. Any snippet marked `VERSION-UNVERIFIED` remains non-implementable until that compile/spike evidence exists.

## Exit checklist

- [ ] Exact production candidate versions recorded.
- [ ] Missing-UV registration rejected server-side.
- [ ] Missing-UV authentication rejected server-side.
- [ ] Account exists without fabricated email identity.
- [ ] Verified registration is atomic.
- [ ] Credential ID uniqueness is DB-enforced/proven.
- [ ] Challenge replay fails.
- [ ] Pending device callback survives passkey auth.
- [ ] Device OAuth completes with correct subject/resource.
- [ ] ChatGPT OAuth consent completes with same subject.
- [ ] Plugin composition is tested.
- [ ] Disposable migration/schema reviewed.
- [ ] GO/NO-GO ADR committed before P2 implementation.

## Rollback

P1 is a disposable spike. Delete the spike DB and temporary test credentials. Do not leave experimental password/passkey toggles in production configuration. No existing user credential should be migrated or deleted during P1.
