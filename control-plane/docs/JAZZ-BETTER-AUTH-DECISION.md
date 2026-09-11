# Jazz + Better Auth architecture decision

Status: **accepted for MVP** — 2026-08-31.

## Decision

Use two persistence boundaries:

1. **Better Auth 1.7.x -> Node built-in SQLite** for users, sessions, OAuth
   clients, OAuth resources, access/refresh tokens, consents, device codes and
   MCP authorization-server state.
2. **Jazz -> Remote MCP application data** for devices, calls, audit events,
   realtime subscriptions, durability and row-level permissions.

Jazz authenticates application/device sessions by validating JWTs issued by
Better Auth against Better Auth's JWKS endpoint.

Supabase is not used anywhere in the target architecture.

## Why this decision exists

Jazz has an official Better Auth database adapter, and its documented workflow
is sound for the features currently covered by Jazz. We initially attempted to
use that adapter for the entire Better Auth MCP/OAuth database too.

That exposed a compatibility boundary that the current Jazz adapter explicitly
does not support.

## What Jazz officially demonstrates

Jazz's `auth-betterauth-chat` example uses Better Auth 1.7.1 with the Jazz
adapter for the core Better Auth tables plus admin/bearer/JWT plugins. Its
server-side adapter configuration is:

```ts
jazzAdapter({
  db: () => context.asBackend(app),
  schema: app.wasmSchema,
})
```

The generated Better Auth tables are merged into the same Jazz app and get
deny-all client policies. The backend secret allows the adapter to access them
through `asBackend(app)`.

Jazz separately documents the external-provider pattern: Better Auth issues a
JWT, exposes `/api/auth/jwks`, and Jazz validates the JWT before exposing its
claims and canonical `[iss, sub]` identity to permissions.

That external-provider boundary is the one this project now uses.

## Exact OAuth Provider incompatibility

Better Auth 1.7's OAuth Provider introduces legitimate relationships to
business keys rather than database row IDs:

```text
oauthClientResource.clientId -> oauthClient.clientId
oauthClientResource.resourceId -> oauthResource.identifier
oauthRefreshToken.clientId -> oauthClient.clientId
oauthAccessToken.clientId -> oauthClient.clientId
oauthConsent.clientId -> oauthClient.clientId
```

Jazz's current Better Auth schema generator deliberately permits references
only to the target row's `id`. Its own test suite contains a test named:

```text
throws when schema.ts generation encounters non-id references
```

Therefore this is not a local Nix issue and not a malformed Better Auth schema.
The OAuth Provider schema is outside the relationship model currently covered
by the Jazz adapter generator.

## Why we rejected scalarizing those references

A schema generator can mechanically turn those five fields into ordinary
strings. Normal Better Auth lookups would still work because the adapter queries
`clientId` and `identifier` as stored scalar values.

That is not enough for authentication correctness.

Better Auth's OAuth client deletion removes the `oauthClient` row and relies on
foreign-key cascade semantics for dependent OAuth state. Resource deletion also
assumes relationship cleanup. Scalarizing the fields would remove those database
cascades.

We could emulate every cascade in a custom Jazz adapter wrapper, but then this
project would own security-sensitive OAuth referential-integrity behavior that
neither Jazz nor Better Auth currently tests together. That is too much custom
authentication infrastructure for the MVP.

The former custom Jazz auth-schema generator has therefore been deleted.

## Why SQLite is acceptable here

The pinned Nix shell uses Node 22.23.2. Better Auth supports Node's built-in
`node:sqlite` `DatabaseSync`, so local development needs no additional database
service and no native npm SQLite package.

The SQLite file lives at:

```text
.data/better-auth.sqlite
```

and is ignored by Git. We enable SQLite foreign keys, WAL journalling and a
5-second busy timeout when opening it.

For deployment, the auth database is a separate operational concern from Jazz.
A single-instance MVP can persist the SQLite file on durable storage. Before
horizontal control-plane scaling, move Better Auth to a shared SQL database
such as PostgreSQL; the Jazz application-data architecture does not change.

## Migration bootstrap

Runtime `mcp()` configures and seeds the protected OAuth resource during Better
Auth initialization. On an empty database, that seed must not run before the
OAuth tables exist.

`lib/auth-migration-config.ts` therefore uses the underlying `oauthProvider()`
with the same schema-affecting options but no configured resources. This gives
`auth migrate` the same Better Auth tables without the boot-time resource seed.
After migration, normal runtime uses `mcp()` and performs the first resource
seed against an existing schema.

The intended bootstrap is:

```bash
just auth-plan
# inspect the migration plan
just auth-migrate
just auth-db-info
```

Do not delete or hand-edit OAuth tables to resolve migration errors.

## Revisit conditions

Reconsider storing Better Auth itself in Jazz only if Jazz adds and tests
OAuth Provider/MCP compatibility, including:

- non-ID/business-key relationships;
- the OAuth Provider composite uniqueness rules;
- client/resource deletion cascades;
- refresh/access token and consent cleanup;
- device-authorization persistence;
- the Better Auth MCP resource model.

Until then, keep this boundary explicit: **Better Auth authenticates; Jazz
synchronizes and authorizes Remote MCP application data.**

## JWT claim bridge required by Jazz permissions

Jazz does not expose arbitrary top-level OAuth claims through `session.claims`.
The published runtime reads the token's nested `claims` object, then adds its
canonical subject/issuer fields. Better Auth OAuth tokens, however, keep
`scope` and `client_id` at the standards-defined top level.

The control plane therefore emits an additional nested authorization projection
without changing the standard OAuth claims:

```json
{
  "scope": "device:sync",
  "client_id": "oauth-client-id",
  "claims": {
    "scope": ["device:sync"],
    "client_id": "oauth-client-id"
  }
}
```

`claims.client_id` comes from Better Auth's resolved OAuth client object through
`OAuthProviderExtension.claims.accessToken`; it is never copied from request or
client metadata. The projection is emitted only when the token is bound to the
configured `REMOTE_MCP_RESOURCE`.

## Published Jazz alpha.53 versus current main

The npm package installed by this repository is `jazz-tools@2.0.0-alpha.53`.
Its published `createJazzContext()` accepts JWKS configuration but not expected
issuer/audience options, and its published CLI does not expose a `server`
command. Its NAPI server binds to loopback and validates external JWTs from the
configured JWKS without the newer issuer/audience configuration surface.

The checked-out Jazz `main` at research time already contains newer source for:

- `jwtIssuer` / `jwtAudience` in backend request verification;
- issuer/audience checks in the TypeScript verifier;
- a richer server configuration path.

Those changes are not present in the npm artifact with the same version label.
Therefore the implementation must not rely on unreleased `main` behavior while
its lockfile still resolves the published alpha.53 tarball.

For local MVP, `just jazz` launches the server through the shipped
`startLocalJazzServer()` API. Before exposing direct Jazz sync as production
infrastructure, upgrade to a published Jazz build with strict expected
issuer/audience verification or put an equivalent strict gateway in front of
all direct sync connections.
