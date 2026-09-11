import { mkdirSync } from "node:fs";
import { startLocalJazzServer } from "jazz-tools/dev";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const dataDir = process.env.JAZZ_DATA_DIR?.trim() || "/data/jazz";
const port = Number(process.env.JAZZ_LOOPBACK_PORT || "1626");
mkdirSync(dataDir, { recursive: true });

const server = await startLocalJazzServer({
  appId: required("JAZZ_APP_ID"),
  port,
  dataDir,
  jwksUrl: required("JAZZ_JWKS_URL"),
  backendSecret: required("JAZZ_BACKEND_SECRET"),
  adminSecret: required("JAZZ_ADMIN_SECRET"),
  allowLocalFirstAuth: process.env.JAZZ_ALLOW_LOCAL_FIRST_AUTH === "true",
  enableLogs: true,
});

console.log(`Jazz loopback authority ready: ${server.url}`);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Stopping Jazz authority (${signal})...`);
  await server.stop();
  process.exit(0);
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

await new Promise(() => {});
