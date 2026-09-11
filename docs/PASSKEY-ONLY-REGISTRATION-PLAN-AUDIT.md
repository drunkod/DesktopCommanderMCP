# Passkey-only registration plan audit

Status: docs-only implementation audit — 2026-09-06

Source plan: `docs/PASSKEY-ONLY-REGISTRATION-RESEARCH-AND-IMPLEMENTATION-PLAN.md`

Branch: `docs/passkey-only-registration-task-pack`

## Audit constraint

This audit was performed read-only against the implementation source. No application, test, package, lockfile, migration, or configuration file was modified. The only intended outputs of this work are Markdown files under `docs/`.

## Verdict

The product direction in the draft is sound:

- passkeys are the only normal end-user credential;
- a stable authentication RP/issuer is separate from per-device MCP resources;
- device approval and ChatGPT consent remain explicit;
- device OAuth secrets remain in the OS credential vault;
- local execution remains local-first;
- production auth state must be durable and shared.

The draft is **not implementation-ready yet**. P1 must be treated as a hard architecture gate because the exact Better Auth stack currently contradicts two core requirements: server-enforced user verification and an email-less Better Auth core user.

## Severity summary

| ID | Severity | Finding | Consequence |
| --- | --- | --- | --- |
| A-01 | BLOCKER | `@better-auth/passkey` 1.7.1 and 1.7.3 verify registration and authentication with `requireUserVerification: false` | The draft's `userVerification: required` security invariant is not server-enforced by the examined plugin |
| A-02 | BLOCKER | Better Auth core 1.7.1 defines `user.email` as required + unique | A genuinely email-less Better Auth core user is not supported by the examined schema as assumed by the draft |
| A-03 | BLOCKER | Central issuer must authorize many dynamic per-device resource URLs, while current composition uses `mcp({ resource: env.remoteResource })` for one configured resource | Auth/resource deployment and resource-registration architecture must be redesigned before production |
| A-04 | HIGH | OAuth scopes still include `email` and `profile`; approval/consent UI renders `session.user.email` | Replacing the sign-in form alone does not produce an email-less product |
| A-05 | HIGH | Device OAuth derives issuer from public MCP origin and rewrites OAuth endpoints to local origin | Stable central issuer cannot work safely without P7 |
| A-06 | HIGH | Stored device session contains no version, issuer, or resource and is cast from JSON without semantic validation | Refresh credentials can be reused under changed runtime identity until server rejection |
| A-07 | HIGH | Passkey schema examined marks `credentialID` indexed but not explicitly unique | Concurrent duplicate-credential registration requires a DB-level uniqueness decision/test |
| A-08 | HIGH | Auth database is local `node:sqlite` with a process-global singleton | Not a horizontally scaled/serverless identity authority |
| A-09 | HIGH | Passkey counter update is a plain post-verification update | Concurrent synchronized-passkey assertions require explicit transaction/race testing |
| A-10 | MEDIUM | Prefilled device code still requires `Continue` | Redundant first-run click; safe to remove while retaining explicit approval |
| A-11 | MEDIUM | Approval page exposes raw OAuth client/scope/resource as primary UI | Security context is technically useful but poor primary onboarding copy |
| A-12 | MEDIUM | `remote tunnel prepare` still prints env vars and requires control-plane restart | One-CLI onboarding remains blocked by orchestration work beyond the passkey UI |

## Evidence: exact dependency state

The control-plane checkout is:

```text
/Users/test/Documents/RemoteMCP-Jazz/implementation/apps/control-plane
```

Pinned auth packages:

```text
better-auth                   1.7.1
@better-auth/mcp              1.7.1
@better-auth/oauth-provider   1.7.1
@better-auth/cimd             1.7.1
```

`@better-auth/passkey` is not installed. Registry inspection during the audit found 1.7.3 as the latest Better Auth/passkey release available at the time of this audit.

`@better-auth/passkey@1.7.1` declares compatible peers with Better Auth 1.7.1 and uses SimpleWebAuthn 13.x. Its public API does support the important passkey-first mechanics in the draft:

```text
registration.requireSession: false
registration.resolveUser(...)
registration.afterVerification(...)
context
createSession
passkeyClient()
signIn.passkey({ autoFill: true })
passkey.addPasskey(...)
```

Those APIs are real in the examined package, but they do not resolve A-01/A-02.

## A-01 — server-enforced UV is currently blocked

The examined passkey plugin asks authenticators for preferred/overridden UV through generated WebAuthn options, but both verification paths call SimpleWebAuthn with:

```ts
requireUserVerification: false
```

This occurs in both registration verification and authentication verification in `@better-auth/passkey@1.7.1`. The same hardcoded value is still present in the examined `1.7.3` package.

Therefore this proposed configuration is **not sufficient evidence of the security invariant**:

```ts
authenticatorSelection: {
  residentKey: "required",
  userVerification: "required",
}
```

It requests UV from the client/authenticator, but the server verifier must independently require the UV flag. P1 cannot pass until one of these is proven:

1. a supported Better Auth/passkey release exposes and enforces required UV for both ceremonies;
2. a supported extension/hook can fail closed by cryptographically verifying UV without duplicating unsafe logic;
3. the project adopts a separately maintained WebAuthn verification boundary that explicitly sets `requireUserVerification: true` and integrates cleanly with Better Auth sessions/OAuth.

Do not patch `node_modules`, generated package output, or vendored minified code as the production solution.

## A-02 — Better Auth core email is required

The exact Better Auth core 1.7.1 table definition examined during the audit defines:

```text
user.name             required
user.email            required + unique
user.emailVerified    required
```

The passkey plugin's pre-auth `resolveUser()` returns a WebAuthn registration identity (`id`, `name`, optional `displayName`). With `createSession: true`, verification expects the target Better Auth user to exist before the session is created.

This means the draft's desired identity:

```text
account ID + opaque WebAuthn user handle + pseudonymous display label
```

cannot simply be persisted as a normal Better Auth 1.7.1 core user with no email. A fake deliverable-looking email is explicitly rejected by the product contract and should remain rejected.

P1 must choose one supported route before P2:

- **Preferred:** supported Better Auth version/schema where core email is truly optional.
- **Acceptable:** application-owned account/passkey identity with a deliberate Better Auth/OAuth bridge that does not fabricate user identity fields.
- **Only if explicitly accepted by security/product:** an internal non-deliverable technical identifier stored in a field named `email`, with every email/OIDC semantic disabled and documented. This is a compatibility shim, not an email identity, and should be avoided if a clean model exists.

The task pack does not pre-approve the third option.

## A-03 — central issuer needs a resource-provisioning model

The current control plane combines three roles in one Next.js process:

```text
Better Auth/OAuth authorization server
MCP protected resource server
Device/Jazz application API and UI
```

Current auth composition uses:

```ts
mcp({
  ...oauthBaseOptions,
  resource: env.remoteResource,
})
```

The `@better-auth/mcp` helper is intentionally centered on one canonical MCP resource while also configuring the OAuth provider and serving resource metadata.

The underlying `@better-auth/oauth-provider` supports persisted `oauthResource` rows and server-only admin resource CRUD/link endpoints. That is the more suitable primitive for a central issuer that authorizes many per-device resource identifiers.

Required target split:

```text
Stable account/auth service
  - Better Auth sessions
  - passkey ceremonies
  - oauthProvider + device authorization + CIMD + JWT/JWKS
  - durable oauthResource registry
  - tightly privileged resource provisioning

Per-device/local resource edge
  - /.well-known/oauth-protected-resource[/mcp]
  - /mcp protected resource
  - device/Jazz bridge as required
  - verifies issuer/JWKS from stable auth service
```

Important security finding: the OAuth provider's resource administration defaults are permissive if `resourcePrivileges` is not supplied. The central issuer task must configure this fail-closed and expose no user-facing generic resource CRUD.

## A-04 — email semantics remain in OAuth/UI

Exact current control-plane surfaces include:

```ts
const oauthScopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "mcp:tools",
  "device:sync",
] as const;
```

and both approval surfaces render the authenticated email:

```tsx
session.data?.user.email
session.user.email
```

A passkey-only target must audit and remove or replace:

- `email` scope;
- `profile` if no profile claim is required;
- userinfo/email claim assumptions;
- email-based account display;
- email/password copy/tests/endpoints.

Use a pseudonymous account label or no account identifier in high-friction approval UI.

## A-05/A-06 — device identity is coupled and credentials are unbound

`src/remote-device/device-oauth.ts` currently:

- derives the issuer as `${publicOrigin()}/api/auth`;
- requires `REMOTE_MCP_RESOURCE` to share the public application origin;
- fetches OAuth metadata through the local control plane;
- rejects OAuth metadata endpoints on any other origin;
- rewrites accepted public endpoints to `MCP_SERVER_URL`.

`DeviceOAuthSession` currently has no `version`, `issuer`, or `resource`.

`src/remote-device/native-credential-store.ts` parses persisted JSON and casts it to the session type. It clears syntactically corrupt JSON, but does not validate the semantic schema or runtime binding.

`src/remote-device/token-manager.ts` currently classifies only errors roughly matching:

```text
invalid_grant
invalid_token
revoked
```

as reauthorization conditions.

P7 must inject immutable runtime identity before token-manager initialization and reject/migrate unbound credentials before refresh.

## A-07 — credential uniqueness requires explicit enforcement

The examined passkey plugin schema declares `credentialID` required and indexed, but did not visibly declare it unique. Registration excludes credentials already known for the same user, which is not a substitute for global uniqueness under races.

P2/P10 must prove a database-level unique invariant on credential ID or implement an equally strong supported adapter constraint. Required race test:

```text
same credential registration response
submitted concurrently in two requests
=> at most one credential row and one account association succeeds
```

## A-08/A-09 — serverless persistence and counter concurrency

Current `lib/auth-db.ts` uses `node:sqlite` `DatabaseSync`, WAL, and a process-global cached database handle. That is appropriate for local development but is not a shared serverless identity authority.

The examined passkey authentication flow updates the credential counter after verification. P8/P10 must verify correct behavior for:

- simultaneous assertions;
- synchronized passkeys that may report non-monotonic/zero counters;
- transaction isolation;
- rollback on session/credential persistence failure;
- revoked credentials across regions/cold starts.

Counter regression is a security signal, not sufficient by itself to label a synchronized passkey cloned.

## Draft changes required before coding

The original research document should remain the architecture narrative. Implementation should follow the task pack created alongside this audit with these changes:

1. Make P1 a hard go/no-go gate with UV and email-schema blockers.
2. Add OAuth/email-scope cleanup to P2/P4/P5.
3. Make credential-ID uniqueness a concrete DB invariant.
4. Split central authorization-provider responsibilities from per-device MCP resource responsibilities.
5. Add trusted dynamic resource provisioning and fail-closed `resourcePrivileges` policy.
6. Introduce immutable `RemoteIdentityConfig` before token manager construction.
7. Version and validate OS-vault session payloads before use.
8. Test counter/revocation concurrency on the chosen durable adapter.
9. Do not remove password auth in production until passkey compatibility and migration gates are green.
10. Keep the separate one-CLI orchestration work visible as a dependency for the final onboarding goal.

## Implementation stop conditions

Stop the passkey cutover if any of these remain true:

- server verification cannot require UV for both registration and authentication;
- account creation still requires a fabricated end-user email identity;
- resource provisioning allows an arbitrary authenticated user to register resource audiences;
- resource tokens can be refreshed without matching current issuer + resource;
- production auth state is process-local;
- final-passkey deletion/recovery semantics are undefined;
- password endpoints are removed before retained-account migration is proven.

## Read-only source map used by this audit

DesktopCommanderMCP repository:

```text
src/remote-device/device-oauth.ts
src/remote-device/token-manager.ts
src/remote-device/credential-store.ts
src/remote-device/native-credential-store.ts
src/remote-device/tunnel/tunnel-health.ts
src/npm-scripts/remote.ts
src/npm-scripts/remote-options.ts
src/remote-device/device.ts
test/test-remote-device-supervision.js
test/test-remote-jazz-safety.js
test/test-remote-tunnels.js
test/integration/zrok-remote-mcp-e2e.js
```

Control-plane checkout:

```text
apps/control-plane/package.json
apps/control-plane/lib/auth.ts
apps/control-plane/lib/auth-migration-config.ts
apps/control-plane/lib/auth-plugins.ts
apps/control-plane/lib/auth-client.ts
apps/control-plane/lib/auth-db.ts
apps/control-plane/lib/env.ts
apps/control-plane/lib/device-request-auth.ts
apps/control-plane/lib/protected-resource-metadata.ts
apps/control-plane/app/sign-in/page.tsx
apps/control-plane/app/device/page.tsx
apps/control-plane/app/device/approve/page.tsx
apps/control-plane/app/consent/page.tsx
apps/control-plane/app/api/auth/[...all]/route.ts
apps/control-plane/app/api/mcp/route.ts
apps/control-plane/app/.well-known/oauth-protected-resource/route.ts
apps/control-plane/app/.well-known/oauth-protected-resource/mcp/route.ts
```

Package source was inspected from registry tarballs and installed package output for compatibility evidence only; no package source was modified.
