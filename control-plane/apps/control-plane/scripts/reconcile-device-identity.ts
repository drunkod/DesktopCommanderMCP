import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createDb } from "jazz-tools";
import { runWorkerCliWithExitCode } from "./worker-cli";

const deviceId = process.env.DEVICE_RECONCILE_DEVICE_ID?.trim();
const configPath = process.env.DC_REMOTE_DEVICE_CONFIG_PATH?.trim();
const expectedBackendStableId = process.env.DEVICE_RECONCILE_EXPECTED_BACKEND_STABLE_ID?.trim();
const expectedCanonicalStableId = process.env.DEVICE_RECONCILE_EXPECTED_CANONICAL_STABLE_ID?.trim();
const createConfig = process.env.DEVICE_RECONCILE_CREATE_CONFIG === "1";
const apply = process.env.DEVICE_RECONCILE_APPLY === "1";

if (!deviceId) throw new Error("DEVICE_RECONCILE_DEVICE_ID is required");
if (!expectedBackendStableId) {
  throw new Error("DEVICE_RECONCILE_EXPECTED_BACKEND_STABLE_ID is required");
}
if (!expectedCanonicalStableId) {
  throw new Error("DEVICE_RECONCILE_EXPECTED_CANONICAL_STABLE_ID is required");
}
if (expectedBackendStableId === expectedCanonicalStableId) {
  throw new Error("Expected backend and canonical stable IDs must differ for reconciliation");
}
if (!configPath || !path.isAbsolute(configPath)) {
  throw new Error("DC_REMOTE_DEVICE_CONFIG_PATH must be an explicit absolute path");
}

const officialConfigPath = path.join(homedir(), ".desktop-commander-device", "device.json");
if (path.resolve(configPath) === path.resolve(officialConfigPath)) {
  throw new Error("Refusing to reconcile the official Remote Desktop Commander device config");
}

type IsolatedConfigState =
  | { exists: false; stableId: null }
  | { exists: true; stableId: string };

async function readIsolatedConfig(): Promise<IsolatedConfigState> {
  try {
    const raw = await readFile(configPath!, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Isolated Jazz device config must be a JSON object");
    }
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 1 || keys[0] !== "stableId" || typeof record.stableId !== "string" || !record.stableId) {
      throw new Error("Isolated Jazz device config must contain only a non-empty stableId");
    }
    return { exists: true, stableId: record.stableId };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { exists: false, stableId: null };
    }
    throw error;
  }
}

await runWorkerCliWithExitCode(async () => {
  const [{ app }, { mintJazzDashboardToken, mintJazzDeviceToken }, { jazzBackendDb }] = await Promise.all([
    import("../schema"),
    import("../lib/jazz-capability"),
    import("../lib/jazz-principal"),
  ]);

  const appId = process.env.JAZZ_APP_ID?.trim();
  const serverUrl = process.env.JAZZ_SERVER_URL?.trim();
  if (!appId || !serverUrl) throw new Error("JAZZ_APP_ID and JAZZ_SERVER_URL are required");

  const db = jazzBackendDb();
  const [backend, jobs, calls, sessions] = await Promise.all([
    db.one(app.devices.where({ id: deviceId }), { tier: "global" }),
    db.all(app.chatJobs, { tier: "global" }),
    db.all(app.remoteCalls, { tier: "global" }),
    db.all(app.workerSessions, { tier: "global" }),
  ]);

  if (!backend) throw new Error("Target device row does not exist");
  if (backend.revokedAt) throw new Error("Target device is revoked");
  if (backend.status !== "offline") throw new Error("Target device must be offline");
  if (
    backend.stableId !== expectedBackendStableId
    && backend.stableId !== expectedCanonicalStableId
  ) {
    throw new Error("Backend stable ID changed since the reconciliation plan was prepared");
  }

  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");
  const terminalCalls = new Set(["completed", "failed", "cancelled", "indeterminate"]);
  const activeCalls = calls.filter((call) => !terminalCalls.has(call.status));
  const observedAt = new Date();
  const activeSessions = sessions.filter(
    (session) => session.status === "active" && session.expiresAt > observedAt,
  );
  if (activeJobs.length || activeCalls.length || activeSessions.length) {
    throw new Error("Refusing device identity reconciliation while worker jobs, remote calls, or sessions are active");
  }

  const [deviceToken, dashboardToken] = await Promise.all([
    mintJazzDeviceToken(backend.ownerId, backend.oauthClientId, backend.id),
    mintJazzDashboardToken(backend.ownerId),
  ]);
  const deviceDb = await createDb({ appId, serverUrl, jwtToken: deviceToken });
  const dashboardDb = await createDb({ appId, serverUrl, jwtToken: dashboardToken });

  try {
    const [deviceVisible, dashboardVisible] = await Promise.all([
      deviceDb.one(app.devices.where({ id: backend.id }), { tier: "global" }),
      dashboardDb.one(app.devices.where({ id: backend.id }), { tier: "global" }),
    ]);
    if (!deviceVisible || !dashboardVisible) {
      throw new Error("Authenticated principals cannot both see the target device row");
    }
    for (const visible of [deviceVisible, dashboardVisible]) {
      if (visible.revokedAt) throw new Error("Authenticated device view is revoked");
      if (visible.status !== "offline") throw new Error("Authenticated device view must be offline");
      if (visible.ownerId !== backend.ownerId) throw new Error("Device owner identity diverges");
      if (visible.oauthClientId !== backend.oauthClientId) throw new Error("Device OAuth client identity diverges");
      if (visible.stableId !== expectedCanonicalStableId) {
        throw new Error("Authenticated Jazz view no longer matches the expected canonical stable ID");
      }
    }
    if (deviceVisible.stableId !== dashboardVisible.stableId) {
      throw new Error("Dashboard and device principals disagree on the canonical stable ID");
    }

    const config = await readIsolatedConfig();
    if (!config.exists && !createConfig) {
      throw new Error("Isolated Jazz device config is missing; set DEVICE_RECONCILE_CREATE_CONFIG=1 to create it explicitly");
    }
    if (
      config.exists
      && config.stableId !== expectedBackendStableId
      && config.stableId !== expectedCanonicalStableId
    ) {
      throw new Error("Isolated Jazz device config contains an unexpected stable ID");
    }

    const alreadyConverged = backend.stableId === expectedCanonicalStableId;
    console.log(JSON.stringify({
      state: alreadyConverged ? "already-converged" : apply ? "applying" : "dry-run",
      deviceId: backend.id,
      ownerId: backend.ownerId,
      oauthClientId: backend.oauthClientId,
      backendStableId: backend.stableId,
      canonicalStableId: expectedCanonicalStableId,
      configPath,
      configExists: config.exists,
      configStableId: config.stableId,
      configAction: config.exists
        ? config.stableId === expectedCanonicalStableId ? "keep" : "rewrite"
        : "create",
      officialConfigUntouched: officialConfigPath,
    }, null, 2));

    if (!apply) return 0;

    await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const backupPath = config.exists ? `${configPath}.pre-reconcile-${timestamp}` : null;
    const stagedPath = `${configPath}.reconcile-${process.pid}.tmp`;

    if (backupPath) {
      await copyFile(configPath, backupPath);
      await chmod(backupPath, 0o600);
    }
    await writeFile(
      stagedPath,
      JSON.stringify({ stableId: expectedCanonicalStableId }, null, 2) + "\n",
      { mode: 0o600 },
    );
    await chmod(stagedPath, 0o600);

    try {
      if (!alreadyConverged) {
        const update = db.update(app.devices, backend.id, { stableId: expectedCanonicalStableId });
        await update.wait({ tier: "global" });
      }

      const updatedBackend = await db.one(app.devices.where({ id: backend.id }), { tier: "global" });
      if (!updatedBackend || updatedBackend.stableId !== expectedCanonicalStableId) {
        throw new Error("Backend device row did not converge after globally acknowledged update");
      }

      const [deviceAfter, dashboardAfter] = await Promise.all([
        deviceDb.one(app.devices.where({ id: backend.id }), { tier: "global" }),
        dashboardDb.one(app.devices.where({ id: backend.id }), { tier: "global" }),
      ]);
      if (
        !deviceAfter
        || !dashboardAfter
        || deviceAfter.stableId !== expectedCanonicalStableId
        || dashboardAfter.stableId !== expectedCanonicalStableId
      ) {
        throw new Error("Authenticated Jazz views did not converge after reconciliation");
      }

      await rename(stagedPath, configPath);
      await chmod(configPath, 0o600);
      console.log(JSON.stringify({
        state: "reconciled",
        deviceId: backend.id,
        stableId: expectedCanonicalStableId,
        backupPath,
        configPath,
      }, null, 2));
      return 0;
    } catch (error) {
      await rm(stagedPath, { force: true }).catch(() => undefined);
      throw error;
    }
  } finally {
    await dashboardDb.shutdown().catch(() => undefined);
    await deviceDb.shutdown().catch(() => undefined);
  }
});
