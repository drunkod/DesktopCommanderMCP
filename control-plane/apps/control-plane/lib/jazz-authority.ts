import { createDb, type Db } from "jazz-tools";
import { env } from "./env";

declare global {
  var __remoteMcpJazzAuthorityDb: Promise<Db> | undefined;
}

/**
 * Canonical authority/admin handle for device-facing state.
 *
 * Device rows, remote calls, and audit events must be written on the authority
 * branch because dashboard/device capability principals read that branch.
 * Worker sessions and chat jobs remain on the persistent backend context.
 */
export function jazzAuthorityDb(): Promise<Db> {
  if (!globalThis.__remoteMcpJazzAuthorityDb) {
    globalThis.__remoteMcpJazzAuthorityDb = createDb({
      appId: env.jazzAppId,
      serverUrl: env.jazzInternalServerUrl,
      adminSecret: env.jazzAdminSecret,
      driver: { type: "memory" },
    });
  }
  return globalThis.__remoteMcpJazzAuthorityDb;
}

export async function shutdownJazzAuthorityDb(): Promise<void> {
  const pending = globalThis.__remoteMcpJazzAuthorityDb;
  globalThis.__remoteMcpJazzAuthorityDb = undefined;
  if (!pending) return;
  const db = await pending;
  await db.shutdown();
}
