import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createJazzContext, type JazzContext } from "jazz-tools/backend";
import { app } from "../schema";
import permissions from "../permissions";
import { env } from "./env";

declare global {
  var __remoteMcpJazzContext: JazzContext | undefined;
}

export function jazzContext(): JazzContext {
  if (globalThis.__remoteMcpJazzContext) return globalThis.__remoteMcpJazzContext;

  const dataPath = resolve(env.jazzBackendDataPath);
  mkdirSync(dirname(dataPath), { recursive: true, mode: 0o700 });
  const context = createJazzContext({
    appId: env.jazzAppId,
    app,
    permissions,
    driver: { type: "persistent", dataPath },
    serverUrl: env.jazzInternalServerUrl,
    env: process.env.NODE_ENV === "production" ? "prod" : "dev",
    // Only the authority is global; global reads/writes must reach it rather
    // than being acknowledged by this process's backend cache.
    tier: "edge",
    adminSecret: env.jazzAdminSecret,
    backendSecret: env.jazzBackendSecret,
    jwksUrl: env.jazzJwksUrl,
    allowLocalFirstAuth: process.env.NODE_ENV !== "production",
  });

  globalThis.__remoteMcpJazzContext = context;
  return context;
}
