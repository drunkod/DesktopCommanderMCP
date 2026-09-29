import { mkdirSync } from "node:fs";
import path from "node:path";
import { startLocalJazzServer } from "jazz-tools/dev";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const dataDir = path.resolve(
  process.env.JAZZ_DATA_DIR?.trim() || path.join(process.cwd(), "../../.data/jazz"),
);
mkdirSync(dataDir, { recursive: true });

const server = await startLocalJazzServer({
  appId: required("JAZZ_APP_ID"),
  port: Number(process.env.JAZZ_PORT || "1625"),
  dataDir,
  jwksUrl: required("JAZZ_JWKS_URL"),
  backendSecret: required("JAZZ_BACKEND_SECRET"),
  adminSecret: required("JAZZ_ADMIN_SECRET"),
  allowLocalFirstAuth: process.env.NODE_ENV !== "production",
  enableLogs: true,
});

console.log(`Jazz authority ready: ${server.url}`);
console.log(`Jazz data directory: ${server.dataDir}`);

const keepAlive = setInterval(() => undefined, 60_000);
let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  clearInterval(keepAlive);
  console.log(`Stopping Jazz authority (${signal})...`);
  await server.stop();
  process.exit(0);
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
