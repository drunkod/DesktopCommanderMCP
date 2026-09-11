import { betterAuth } from "better-auth";
import { authDatabase } from "./auth-db";
import { buildAuthMigrationPlugins } from "./auth-plugins";
import { env } from "./env";

/**
 * Better Auth CLI configuration for a brand-new SQLite database.
 *
 * Runtime uses mcp(), which seeds the protected OAuth resource during init.
 * Migration uses the underlying oauthProvider() schema with no resources so
 * the CLI can create the tables before runtime performs that first seed.
 */
export const auth = betterAuth({
  baseURL: env.appOrigin,
  secret: env.betterAuthSecret,
  trustedOrigins: [env.appOrigin],
  database: authDatabase(),
  emailAndPassword: { enabled: false },
  plugins: buildAuthMigrationPlugins(),
});
