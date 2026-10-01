import type { BetterAuthPlugin } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { bearer } from "better-auth/plugins";
import { jwt } from "better-auth/plugins/jwt";
import {
  oauthDeviceAuthorization,
  oauthProvider,
  type OAuthProviderExtension,
} from "@better-auth/oauth-provider";
import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { passkey } from "@better-auth/passkey";
import { env } from "./env";
import { fetchOAuthClientMetadataResource } from "./cimd-fetch";
import { consumePasskeyEnrollmentIntent, resolvePasskeyEnrollmentIntent } from "./passkey-enrollment";
import { passkeyOnlyIdentitySchemaPlugin } from "./passkey-only-identity";


function pluginTuple<const T extends BetterAuthPlugin[]>(...plugins: T): T {
  return plugins;
}

export const oauthScopes = [
  "openid",
  "profile",
  "offline_access",
  "mcp:tools",
  "device:sync",
] as const;

const jazzClaimsExtension = {
  claims: {
    accessToken: ({ client, scopes, resources }) => {
      if (!resources?.includes(env.remoteResource)) return {};

      return {
        claims: {
          scope: [...new Set(scopes)],
          client_id: client.clientId,
        },
      };
    },
  },
} satisfies OAuthProviderExtension;

function jwtPlugin() {
  return jwt({
    jwks: { keyPairConfig: { alg: "ES256" } },
    jwt: {
      issuer: env.authIssuer,
      audience: env.remoteResource,
      expirationTime: "5m",
      getSubject: ({ user }) => user.id,
      definePayload: ({ user }) => ({
        claims: {
          scope: ["dashboard"],
          username: user.name,
        },
      }),
    },
  });
}

const oauthBaseOptions = {
  loginPage: "/sign-in",
  // Resource-policy scopes include offline_access so RFC 8628 can preserve the
  // requested refresh-token scope. RFC 9728 metadata filters authorization-
  // server-only scopes and continues to advertise only MCP/device API scopes.
  resources: [{
    identifier: env.remoteResource,
    name: "Desktop Commander Remote MCP",
    allowedScopes: ["mcp:tools", "device:sync", "offline_access"],
  }],
  consentPage: "/consent",
  scopes: [...oauthScopes],
  accessTokenExpiresIn: env.oauthAccessTokenExpiresIn,
  refreshTokenReuseInterval: 30,
  // The revocation compatibility boundary performs authoritative lookups using
  // Better Auth's SHA-256/base64url stored-token representation. Pin the
  // provider setting explicitly instead of depending on its current default.
  storeTokens: "hashed" as const,
  allowDynamicClientRegistration: true,
  // First-party desktop clients are provisioned by the trusted operator/bootstrap boundary.
  allowUnauthenticatedClientRegistration: env.allowUnauthenticatedOAuthClientRegistration,
  // Better Auth's default token limiter allows only 20 continuous requests.
  // A 10-minute RFC8628 flow polling every 5s can legitimately need ~120,
  // so leave enough headroom for one complete human approval window.
  rateLimit: { token: { window: 60, max: 150 } },
  extensions: [jazzClaimsExtension],
};

function passkeyPlugin() {
  return passkey({
    rpID: new URL(env.appOrigin).hostname,
    rpName: "Desktop Commander",
    origin: env.appOrigin,
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
    registration: {
      requireSession: false,
      resolveUser: async ({ context }) => resolvePasskeyEnrollmentIntent(context),
      afterVerification: async ({ user, context, ctx }) => {
        const intent = await resolvePasskeyEnrollmentIntent(context);
        if (intent.id !== user.id) throw new Error("Passkey registration intent user binding mismatch");

        const existingUser = await ctx.context.internalAdapter.findUserById(user.id);
        if (intent.kind === "account-registration") {
          if (existingUser) throw new Error("Passkey registration account already exists");
          await ctx.context.internalAdapter.createUser({
            id: user.id,
            name: user.name,
            // Better Auth's runtime lowercases email only when present. The
            // passkey-only schema override makes this field optional, so no
            // synthetic email value is persisted.
            email: undefined as unknown as string,
            emailVerified: false,
          }, { method: "passkey" });
        } else if (!existingUser) {
          throw new Error("Passkey enrollment target user no longer exists");
        }

        await consumePasskeyEnrollmentIntent(context, user.id);
        return { userId: user.id, name: intent.displayName };
      },
    },
  });
}

function deviceGrantPlugin() {
  return oauthDeviceAuthorization({
    expiresIn: "10min",
    interval: "5s",
  });
}

function cimdPlugin() {
  return cimd({
    fetchClientMetadataResource: fetchOAuthClientMetadataResource,
    metadataProfile: "mcp-2026-07-28",
  });
}

export function buildAuthPlugins() {
  return pluginTuple(
    bearer(),
    jwtPlugin(),
    passkeyPlugin(),
    passkeyOnlyIdentitySchemaPlugin(),
    mcp({
      ...oauthBaseOptions,
      resource: env.remoteResource,
    }),
    deviceGrantPlugin(),
    cimdPlugin(),
    // Framework cookie integration must run after all plugins that may set cookies.
    nextCookies(),
  );
}

export function buildAuthMigrationPlugins() {
  return pluginTuple(
    bearer(),
    jwtPlugin(),
    passkeyPlugin(),
    passkeyOnlyIdentitySchemaPlugin(),
    // Same OAuth Provider tables as mcp(), but no boot-time resource seed.
    oauthProvider(oauthBaseOptions),
    deviceGrantPlugin(),
    cimdPlugin(),
  );
}
