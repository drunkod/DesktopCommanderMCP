import { realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createDb } from "jazz-tools";
import { createJazzContext } from "jazz-tools/backend";
import { startLocalJazzServer } from "jazz-tools/testing";
import { app, type Device } from "../schema";
import permissions from "../permissions";
import { env } from "../lib/env";

const allowedOperations = ["backend-update", "backend-upsert", "admin-upsert"] as const;
type Operation = (typeof allowedOperations)[number];

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 8_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timed out after " + timeoutMs + "ms")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeDeviceView(row: Device | null) {
  if (!row) return null;
  return {
    id: row.id,
    stableId: row.stableId,
    status: row.status,
    revoked: Boolean(row.revokedAt),
    reconnectGeneration: row.reconnectGeneration,
  };
}

function safeErrorMessage(error: unknown, hiddenValues: string[]): string {
  let message = error instanceof Error ? error.name + ": " + error.message : String(error);
  for (const value of hiddenValues) {
    if (value) message = message.split(value).join("[redacted]");
  }
  return message.slice(0, 1000);
}

function devicePayload(row: Device, stableId: string) {
  return {
    ownerId: row.ownerId,
    stableId,
    oauthClientId: row.oauthClientId,
    name: row.name,
    platform: row.platform,
    appVersion: row.appVersion,
    capabilities: row.capabilities,
    status: row.status,
    lastSeenAt: row.lastSeenAt,
    lastError: row.lastError,
    reconnectGeneration: row.reconnectGeneration,
    reconnectRequestedAt: row.reconnectRequestedAt,
    revokedAt: row.revokedAt,
    authRevocationState: row.authRevocationState,
    authRevocationLastAttemptAt: row.authRevocationLastAttemptAt,
    authRevocationError: row.authRevocationError,
  };
}

async function createCopiedClients(serverUrl: string, backendDataPath: string) {
  const context = await createJazzContext({
    appId: env.jazzAppId,
    app,
    permissions,
    driver: { type: "persistent", dataPath: backendDataPath },
    serverUrl,
    env: "prod",
    tier: "edge",
    adminSecret: env.jazzAdminSecret,
    backendSecret: env.jazzBackendSecret,
    allowLocalFirstAuth: false,
  });
  const backendDb = context.asBackend();
  const adminDb = await createDb({
    appId: env.jazzAppId,
    serverUrl,
    adminSecret: env.jazzAdminSecret,
    driver: { type: "memory" },
  });
  return { context, backendDb, adminDb };
}

async function shutdownClients(clients: any) {
  if (!clients) return;
  await Promise.allSettled([
    withTimeout(clients.adminDb.shutdown(), "admin shutdown", 5_000),
    withTimeout(clients.context.shutdown(), "backend context shutdown", 5_000),
  ]);
}

async function stopServer(server: any) {
  if (!server) return;
  try {
    await withTimeout(server.stop(), "isolated Jazz server shutdown", 5_000);
  } catch {
    // Shutdown timeout or failure must not wedge cleanup.
  }
}

async function readDevice(db: any, id: string): Promise<Device | null> {
  return await db.one(app.devices.where({ id }), { tier: "global" }) as Device | null;
}

const operationValue = required("DEVICE_REHEARSAL_OPERATION");
if (!allowedOperations.includes(operationValue as Operation)) {
  throw new Error("Invalid DEVICE_REHEARSAL_OPERATION");
}
const operation = operationValue as Operation;
const authorityDirInput = resolve(required("DEVICE_REHEARSAL_AUTHORITY_DIR"));
const backendDataInput = resolve(required("DEVICE_REHEARSAL_BACKEND_DATA_PATH"));
const liveAuthorityInput = resolve(required("DEVICE_REHEARSAL_LIVE_AUTHORITY_DB"));
const liveBackendInput = resolve(required("DEVICE_REHEARSAL_LIVE_BACKEND_DB"));
const deviceId = required("DEVICE_REHEARSAL_DEVICE_ID");
const expectedBackendStableId = required("DEVICE_REHEARSAL_EXPECTED_BACKEND_STABLE_ID");
const expectedCanonicalStableId = required("DEVICE_REHEARSAL_EXPECTED_CANONICAL_STABLE_ID");

if (expectedBackendStableId === expectedCanonicalStableId) {
  throw new Error("Expected backend and canonical stable IDs must differ");
}

const rehearsalAuthorityDir = await realpath(authorityDirInput);
const rehearsalBackendDb = await realpath(backendDataInput);
const liveAuthorityDb = await realpath(liveAuthorityInput);
const liveBackendDb = await realpath(liveBackendInput);
const realTmp = await realpath(tmpdir());
const rehearsalPrefix = `${resolve(realTmp)}/remote-mcp-jazz-repair-rehearsal.`;

if (!rehearsalAuthorityDir.startsWith(rehearsalPrefix)) {
  throw new Error("Rehearsal authority directory must be under the rehearsal temporary directory");
}
if (!rehearsalBackendDb.startsWith(rehearsalPrefix)) {
  throw new Error("Rehearsal backend database must be under the rehearsal temporary directory");
}
if (rehearsalBackendDb === liveBackendDb) throw new Error("Rehearsal backend database aliases live backend database");
if (rehearsalAuthorityDir === dirname(liveAuthorityDb)) throw new Error("Rehearsal authority directory aliases live authority directory");
if (liveAuthorityDb === rehearsalAuthorityDir || liveAuthorityDb.startsWith(`${rehearsalAuthorityDir}/`)) {
  throw new Error("Rehearsal authority directory contains live authority database");
}

const authorityServerOptions = {
  appId: env.jazzAppId,
  dataDir: rehearsalAuthorityDir,
  adminSecret: env.jazzAdminSecret,
  backendSecret: env.jazzBackendSecret,
  allowLocalFirstAuth: false,
  enableLogs: false,
};

let server: any;
let clients: any;
let freshServer: any;
let freshClients: any;
let candidateSucceeded = false;
let candidateError: string | null = null;
let before: any;
let immediateAfter: any;
let afterRestartFreshBackend: any;
let durableCanonical = false;

try {
  server = await startLocalJazzServer(authorityServerOptions);
  const serverUrl = server.url;
  if (!serverUrl) throw new Error("Local Jazz server did not provide a URL");
  clients = await createCopiedClients(serverUrl, rehearsalBackendDb);

  const backendBefore = await withTimeout(
    readDevice(clients.backendDb, deviceId),
    "immediate backend global read",
    5_000,
  );
  const adminBefore = await withTimeout(
    readDevice(clients.adminDb, deviceId),
    "immediate admin global read",
    5_000,
  );
  if (!backendBefore || !adminBefore) throw new Error("Target device must exist in both global views");
  if (backendBefore.revokedAt || adminBefore.revokedAt) throw new Error("Target device must not be revoked");
  if (backendBefore.status !== "offline" || adminBefore.status !== "offline") {
    throw new Error("Target device must be offline in both global views");
  }
  if (backendBefore.stableId !== expectedBackendStableId) throw new Error("Backend stable ID precondition failed");
  if (adminBefore.stableId !== expectedCanonicalStableId) throw new Error("Canonical stable ID precondition failed");
  if (backendBefore.ownerId !== adminBefore.ownerId || backendBefore.oauthClientId !== adminBefore.oauthClientId) {
    throw new Error("Device ownership or OAuth client precondition failed");
  }
  before = { backend: safeDeviceView(backendBefore), admin: safeDeviceView(adminBefore) };

  try {
    if (operation === "backend-update") {
      const handle = clients.backendDb.update(app.devices, deviceId, { stableId: expectedCanonicalStableId });
      await withTimeout(handle.wait({ tier: "global" }), operation + " global durability", 8_000);
    } else if (operation === "backend-upsert") {
      const handle = clients.backendDb.upsert(
        app.devices,
        devicePayload(backendBefore, expectedCanonicalStableId),
        { id: deviceId },
      );
      await withTimeout(handle.wait({ tier: "global" }), operation + " global durability", 8_000);
    } else {
      const handle = clients.adminDb.upsert(
        app.devices,
        devicePayload(adminBefore, expectedCanonicalStableId),
        { id: deviceId },
      );
      await withTimeout(handle.wait({ tier: "global" }), operation + " global durability", 8_000);
    }
    candidateSucceeded = true;
  } catch (error) {
    candidateSucceeded = false;
    candidateError = safeErrorMessage(error, [
      rehearsalAuthorityDir,
      rehearsalBackendDb,
      liveAuthorityDb,
      liveBackendDb,
      serverUrl,
    ]);
  }

  const [backendImmediate, adminImmediate] = await Promise.all([
    withTimeout(
      readDevice(clients.backendDb, deviceId),
      "immediate backend global read",
      5_000,
    ),
    withTimeout(
      readDevice(clients.adminDb, deviceId),
      "immediate admin global read",
      5_000,
    ),
  ]);
  immediateAfter = {
    backend: safeDeviceView(backendImmediate),
    admin: safeDeviceView(adminImmediate),
  };

  await shutdownClients(clients);
  clients = null;
  await stopServer(server);
  server = null;

  const freshBackendPath = `${rehearsalBackendDb}.fresh-after-restart`;
  await Promise.all([
    rm(freshBackendPath, { force: true }),
    rm(`${freshBackendPath}-wal`, { force: true }),
    rm(`${freshBackendPath}-shm`, { force: true }),
  ]);
  freshServer = await startLocalJazzServer(authorityServerOptions);
  const freshServerUrl = freshServer.url;
  if (!freshServerUrl) throw new Error("Restarted local Jazz server did not provide a URL");
  freshClients = await createCopiedClients(freshServerUrl, freshBackendPath);

  const [backendFresh, adminFresh] = await Promise.all([
    withTimeout(
      readDevice(freshClients.backendDb, deviceId),
      "fresh-after-restart backend global read",
      5_000,
    ),
    withTimeout(
      readDevice(freshClients.adminDb, deviceId),
      "fresh-after-restart admin global read",
      5_000,
    ),
  ]);
  afterRestartFreshBackend = {
    backend: safeDeviceView(backendFresh),
    admin: safeDeviceView(adminFresh),
  };
  durableCanonical = Boolean(
    backendFresh &&
      adminFresh &&
      backendFresh.stableId === expectedCanonicalStableId &&
      adminFresh.stableId === expectedCanonicalStableId &&
      backendFresh.ownerId === adminFresh.ownerId &&
      backendFresh.status === adminFresh.status &&
      Boolean(backendFresh.revokedAt) === Boolean(adminFresh.revokedAt),
  );
} finally {
  await shutdownClients(freshClients);
  await shutdownClients(clients);
  await stopServer(freshServer);
  await stopServer(server);
}

console.log(
  JSON.stringify({
    operation,
    candidateSucceeded,
    candidateError,
    before,
    immediateAfter,
    afterRestartFreshBackend,
    durableCanonical,
  }),
);
