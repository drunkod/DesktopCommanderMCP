# P2 — Passkey schema, auth plugins, and OAuth identity cleanup

Parent: `docs/PASSKEY-ONLY-REGISTRATION-TASK-INDEX.md`

Owner: control-plane/auth service

Depends on: P1 GO decision + P8A datastore/transaction foundation

Blocks: P3, P4, P5, P6, P8, P9

## Objective

Implement the exact auth stack selected by P1, migrate the required schema safely, and remove email/password semantics from the passkey-only identity surface without prematurely deleting legacy credentials needed for migration.

## Future implementation targets

Current files:

```text
apps/control-plane/package.json
pnpm-lock.yaml
apps/control-plane/lib/auth.ts
apps/control-plane/lib/auth-migration-config.ts
apps/control-plane/lib/auth-plugins.ts
apps/control-plane/lib/auth-client.ts
apps/control-plane/lib/auth-db.ts
apps/control-plane/lib/env.ts
apps/control-plane/app/consent/page.tsx
apps/control-plane/app/device/approve/page.tsx
```

Likely new files after P1 chooses the account model:

```text
apps/control-plane/lib/passkey-policy.ts
apps/control-plane/lib/account-identity.ts
apps/control-plane/lib/webauthn-errors.ts
apps/control-plane/lib/oauth-scopes.ts
```

Do not create these in this docs-only branch.

## P2.1 Pin one compatible auth family

Package rule:

```text
better-auth
@better-auth/passkey
@better-auth/oauth-provider
@better-auth/cimd
@better-auth/mcp (resource-side helper only if retained)
```

must be intentionally version-compatible. Avoid mixed 1.7.1/1.7.3 unless the package peer ranges and tests explicitly prove it.

Acceptance:

- lockfile resolves one intended Better Auth core family;
- no duplicate incompatible SimpleWebAuthn major versions;
- exact versions recorded in the P1 ADR;
- package bump is separated from product UI changes where practical.

## P2.2 Add immutable passkey environment configuration

Proposed environment contract:

```text
PASSKEY_RP_ID=auth.desktopcommander.app
PASSKEY_ORIGIN=https://auth.desktopcommander.app
AUTHORIZATION_SERVER_ISSUER=https://auth.desktopcommander.app
```

For the **WebAuthn browser origin only**, development may use the browser secure-context allowance for `http://localhost` when the test harness explicitly selects it. OAuth issuer/resource/bootstrap/CIMD/internal-transport URLs use P7A's stricter common policy: HTTPS, or HTTP only on explicit non-production literal `127.0.0.1` / `[::1]` loopback. Do not reuse the WebAuthn `localhost` exception as an OAuth trust rule.

Suggested `PASSKEY_ORIGIN` validation helper:

```ts
type PasskeyRuntimeProfile = "production" | "development" | "test";

function exactPasskeyOrigin(
  name: string,
  value: string,
  profile: PasskeyRuntimeProfile,
): string {
  if (value !== value.trim()) throw new Error(`${name} must not contain leading/trailing whitespace`);
  const url = new URL(value);
  const browserDevelopmentLoopback =
    profile !== "production"
    && url.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !browserDevelopmentLoopback) {
    throw new Error(`${name} must use HTTPS; HTTP loopback requires an explicit non-production profile`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an origin without credentials/path/query/fragment`);
  }
  if (value !== url.origin) throw new Error(`${name} is noncanonical; expected ${url.origin}`);
  return value;
}
```

Every caller passes an immutable, release-parsed profile; URL shape must never infer development mode. Production tests explicitly reject HTTP on `localhost`, `127.0.0.1`, and `[::1]`.

This helper is intentionally scoped to `PASSKEY_ORIGIN`. Validate `AUTHORIZATION_SERVER_ISSUER` through the P7A common OAuth URL policy and exact release identity. Do not derive RP ID from a per-device MCP URL.

## P2.3 Configure the server passkey boundary

Only use the exact plugin/custom verifier shape approved by P1.

Required properties:

```text
stable RP ID
exact allowed origin
resident/discoverable credential required
server-enforced user verification required
attestation none
pre-auth registration supported
single-use challenge state
verified-session creation supported
```

If the selected Better Auth plugin still internally verifies with `requireUserVerification: false`, P2 stops. Do not compensate with UI copy.

## P2.4 Add passkey client support

Current `auth-client.ts` uses:

```text
oauthProviderClient()
deviceAuthorizationClient()
```

Target includes passkey client support from the P1-approved package:

```ts
import { passkeyClient } from "@better-auth/passkey/client";

plugins: [
  passkeyClient(),
  oauthProviderClient(),
  deviceAuthorizationClient(),
]
```

Exact import path/API must follow the selected package version.

## P2.5 Generate and review passkey schema

Required credential data:

```text
credential ID
public key
account/user ID
signature counter
device type
backup state
transports
created timestamp
AAGUID if available
friendly name if available
```

Do not log public key or full credential ID in normal telemetry.

## P2.6 Enforce global credential-ID uniqueness

The examined 1.7.1 passkey schema shows an index but not an explicit unique property for `credentialID`.

Migration acceptance requires one of:

```sql
CREATE UNIQUE INDEX ... ON passkey(credentialID);
```

or a supported adapter/schema declaration that produces equivalent uniqueness.

Verify generated SQL/adapter schema, do not assume.

Required test:

```text
concurrent duplicate credential inserts -> exactly one succeeds
```

## P2.7 Decide Better Auth core identity storage

Apply the P1-selected account model.

For any model, guarantee:

- stable account primary key;
- OAuth subject = account ID;
- opaque WebAuthn user handle separate from credential ID;
- no user-entered email requirement;
- no fabricated deliverable email identity;
- account label is safe to display without revealing credential details.

If an application-owned account table is selected, document every mapping between it and Better Auth session/OAuth records and enforce uniqueness/foreign keys.

## P2.8 Remove password *creation* without breaking migration

Current runtime and migration config both enable:

```ts
emailAndPassword: {
  enabled: true,
  autoSignIn: true,
  minPasswordLength: 12,
}
```

Cutover sequence:

1. introduce passkey path behind development/internal gate;
2. migrate or reset applicable accounts;
3. disable new password account creation;
4. verify retained users can authenticate with passkeys;
5. remove/disable password login endpoint only at P9/P11 cutover.

If Better Auth cannot separate password sign-up from sign-in as required, design a short-lived migration deployment rather than leaving hidden public sign-up available.

## P2.9 Remove email/profile OAuth semantics

Current scopes include:

```text
openid
profile
email
offline_access
mcp:tools
device:sync
```

Create a scope decision table:

| Scope | Device | ChatGPT | Keep? | Rationale |
| --- | --- | --- | --- | --- |
| `device:sync` | yes | no | yes | device synchronization APIs |
| `mcp:tools` | no | yes | yes | MCP execution |
| `offline_access` | yes | maybe | yes where refresh is required | refresh token |
| `openid` | maybe | maybe | only if protocol/client requires | OIDC subject semantics |
| `profile` | no default | no default | remove unless concrete use | avoid unused identity claims |
| `email` | no | no | remove | passkey-only account has no email identity |

Update consent descriptions and JWT/userinfo claims accordingly.

## P2.10 Remove email rendering from authorization UI

Current device approval renders:

```tsx
session.data?.user.email
```

Current consent renders:

```tsx
session.user.email
```

Target copy should use a pseudonymous account label only when useful:

```tsx
<p>Signed in to your Desktop Commander account.</p>
```

or:

```tsx
<p>Account: <strong>{account.displayLabel}</strong></p>
```

Never substitute a credential ID or WebAuthn user handle as visible identity.

## P2.11 Keep auth/session cookies correctly ordered

Current `nextCookies()` intentionally appears after plugins that may set cookies.

Passkey plugin insertion must test cookie/session behavior on:

- registration verification;
- authentication verification;
- OAuth authorization redirect;
- device approval;
- sign-out;
- repeated/cancelled WebAuthn ceremonies.

Do not move `nextCookies()` casually without a failing test that justifies it.

## P2.12 Migration configuration parity

`auth-migration-config.ts` must generate the same schema needed by runtime without triggering unsafe boot-time resource mutations.

If central auth moves from `mcp()` to `oauthProvider()` under P7/P8, migration config should match that long-term provider schema rather than retaining a divergent temporary shape.

## P2.13 Schema migration safety

Before applying to retained development data:

1. copy the development SQLite DB;
2. generate migration into reviewable output;
3. inspect unique/FK/nullability constraints;
4. run migration on copy;
5. run auth smoke tests;
6. test rollback/restore;
7. only then apply to retained data if P9 says it should be retained.

Synthetic smoke users should normally be reset under P9 instead of migrated one by one.

## P2.14 Error normalization

Create a browser-facing normalization layer for at least:

```text
NotAllowedError / user cancellation
InvalidStateError / credential already registered or state mismatch
NotSupportedError
SecurityError / RP-origin policy
AbortError
network failure
expired challenge/intent
server verification failure
```

Do not display raw stack traces, CBOR data, challenge values, credential IDs, or internal DB errors.

## P2.15 Security headers for stable RP

The passkey origin should have a deliberate browser security policy:

- strict CSP with no arbitrary third-party scripts;
- `frame-ancestors 'none'` unless a reviewed integration requires embedding;
- HTTPS/HSTS in production;
- secure/httpOnly/sameSite session cookies as appropriate;
- no credential-bearing URL query parameters;
- trusted origin list exact, not wildcarded to customer tunnel domains.

## Automated acceptance

Required tests added on future implementation branch:

```text
auth-config-rejects-non-https-passkey-origin
auth-config-rejects-rp-origin-mismatch
passkey-schema-has-credential-id-unique-constraint
passkey-client-plugin-loaded
password-signup-disabled-at-cutover
oauth-email-scope-not-advertised
consent-does-not-require-user-email
device-approval-does-not-require-user-email
```

## P2.16 P8A adapter/schema dependency

P2 must compile and generate schema against the exact P8A-selected database driver and Better Auth adapter. Do not first design schema around local SQLite and then assume production PostgreSQL transaction/constraint behavior is equivalent.

`env.ts` changes are additive/refactored against all current consumers; the snippet pack must not be pasted as a full replacement that silently removes existing Jazz/local configuration fields.

## Exit checklist

- [ ] P1-approved stack pinned.
- [ ] Passkey RP/origin configuration validated.
- [ ] Server verifier still proves required UV.
- [ ] Passkey client configured.
- [ ] Credential schema reviewed.
- [ ] Credential ID uniqueness enforced.
- [ ] Email-less account model implemented as approved.
- [ ] OAuth scope cleanup completed.
- [ ] Email rendering removed from approval/consent.
- [ ] Password cutover sequence preserves migration safety.
- [ ] Migration config matches runtime schema.
- [ ] RP security headers reviewed.

## Rollback

Before removing legacy credentials, rollback means disabling the passkey entry UI/plugin while preserving additive schema. After passkeys exist, never drop passkey rows or alter RP identity during rollback. Restore previous login routing while retaining new credential data until an explicit migration reverses it safely.
