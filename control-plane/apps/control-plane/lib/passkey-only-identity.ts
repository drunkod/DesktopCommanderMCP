import type { BetterAuthPlugin } from "better-auth";

/**
 * Better Auth 1.7.1 makes the core user email field required. Passkey-only
 * accounts have no email identity, so override that core field through the
 * documented plugin-schema merge point instead of fabricating an address.
 *
 * SQLite UNIQUE indexes permit multiple NULL values, which preserves uniqueness
 * if a future migration attaches a real email while allowing email-less users.
 */
export function passkeyOnlyIdentitySchemaPlugin(): BetterAuthPlugin {
  return {
    id: "desktop-commander-passkey-only-identity",
    schema: {
      user: {
        fields: {
          email: {
            type: "string",
            required: false,
            unique: true,
            sortable: true,
          },
        },
      },
      passkey: {
        fields: {
          credentialID: {
            type: "string",
            required: true,
            unique: true,
            index: true,
          },
        },
      },
    },
  };
}
