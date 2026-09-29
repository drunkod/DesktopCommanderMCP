import { betterAuth } from "better-auth";
import { buildAuthPlugins } from "./auth-plugins";
import { authDatabase } from "./auth-db";
import { env } from "./env";

export const auth = betterAuth({
  baseURL: env.appOrigin,
  secret: env.betterAuthSecret,
  trustedOrigins: [env.appOrigin],
  database: authDatabase(),
  rateLimit: {
    enabled: true,
    window: 10,
    max: 100,
    customRules: {
      "/oauth2/register": { window: 60, max: 10 },
    },
  },
  emailAndPassword: { enabled: false },
  plugins: buildAuthPlugins(),
});

// Better Auth owns OAuth/OIDC/MCP persistence in SQLite. Jazz accepts the
// resulting JWTs through Better Auth's JWKS endpoint and stores only Remote MCP
// application data (devices, calls, audit events).
