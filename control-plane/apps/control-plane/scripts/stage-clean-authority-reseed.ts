import { chmod, copyFile, mkdir, mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createDb } from "jazz-tools";
import { createJazzContext } from "jazz-tools/backend";
import { deploy, startLocalJazzServer } from "jazz-tools/testing";
import { app, type Device } from "../schema";
import permissions from "../permissions";
import { env } from "../lib/env";
import { mintJazzDashboardToken, mintJazzDeviceToken } from "../lib/jazz-capability";
import {
  buildCompositeRecoverySnapshot,
  compareExactSnapshots,
  fourDeviceIdentitiesCanonical,
  importLogicalSnapshot,
  readLogicalSnapshot,
  safeDeviceIdentity,
  serializeDevice,
  sha256Json,
  snapshotEquivalent,
  stableJson,
  supportedSourceProvenance,
  type LogicalSnapshot,
} from "../lib/reseed-recovery";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("Missing required environment variable: " + name);
  return value;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 12_000): Promise<T> {
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

function safeErrorMessage(error: unknown, hidden: string[]): string {
  let message = error instanceof Error ? error.name + ": " + error.message : String(error);
  for (const value of hidden) {
    if (value) message = message.split(value).join("[redacted]");
  }
  return message.slice(0, 1000);
}

async function stopServer(server: any): Promise<void> {
  if (!server) return;
  await withTimeout(server.stop(), "isolated Jazz server shutdown", 6_000).catch(() => undefined);
}

async function createBackendAdminViews(serverUrl: string, backendPath: string) {
  const context = await createJazzContext({
    appId: env.jazzAppId,
    app,
    permissions,
    driver: { type: "persistent", dataPath: backendPath },
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

async function createFullViews(serverUrl: string, backendPath: string, target: Device) {
  const base = await createBackendAdminViews(serverUrl, backendPath);
  const [dashboardToken, deviceToken] = await Promise.all([
    mintJazzDashboardToken(target.ownerId),
    mintJazzDeviceToken(target.ownerId, target.oauthClientId, target.id),
  ]);
  const dashboardDb = await createDb({
    appId: env.jazzAppId,
    serverUrl,
    jwtToken: dashboardToken,
    driver: { type: "memory" },
  });
  const deviceDb = await createDb({
    appId: env.jazzAppId,
    serverUrl,
    jwtToken: deviceToken,
    driver: { type: "memory" },
  });
  return { ...base, dashboardDb, deviceDb };
}

async function shutdownViews(views: any): Promise<void> {
  if (!views) return;
  await Promise.allSettled([
    views.deviceDb ? withTimeout(views.deviceDb.shutdown(), "device view shutdown", 6_000) : Promise.resolve(),
    views.dashboardDb ? withTimeout(views.dashboardDb.shutdown(), "dashboard view shutdown", 6_000) : Promise.resolve(),
    views.adminDb ? withTimeout(views.adminDb.shutdown(), "admin view shutdown", 6_000) : Promise.resolve(),
    views.context ? withTimeout(views.context.shutdown(), "backend context shutdown", 6_000) : Promise.resolve(),
  ]);
}

async function readDevice(db: any, id: string): Promise<Device | null> {
  return await db.one(app.devices.where({ id }), { tier: "global" }) as Device | null;
}
function safeContinuityDevice(row: Device | null) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.ownerId,
    oauthClientId: row.oauthClientId,
    stableId: row.stableId,
    status: row.status,
    revoked: Boolean(row.revokedAt),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

function replaceTargetDevice(snapshot: LogicalSnapshot, target: Device): LogicalSnapshot {
  return {
    devices: snapshot.devices
      .map((row) => row.id === target.id ? target : row)
      .sort((a, b) => a.id.localeCompare(b.id)),
    remoteCalls: [...snapshot.remoteCalls],
    workerSessions: [...snapshot.workerSessions],
    chatJobs: [...snapshot.chatJobs],
    auditEvents: [...snapshot.auditEvents],
  };
}

async function inspectDestination(
  views: any,
  expectedBackend: LogicalSnapshot,
  expectedAdmin: LogicalSnapshot,
  target: Device,
  expectedCanonicalStableId: string,
) {
  const [backendSnapshot, adminSnapshot, backendDevice, adminDevice, dashboardDevice, deviceDevice] =
    await Promise.all([
      readLogicalSnapshot(views.backendDb),
      readLogicalSnapshot(views.adminDb),
      readDevice(views.backendDb, target.id),
      readDevice(views.adminDb, target.id),
      readDevice(views.dashboardDb, target.id),
      readDevice(views.deviceDb, target.id),
    ]);
  const backendComparison = compareExactSnapshots(expectedBackend, backendSnapshot);
  const adminComparison = compareExactSnapshots(expectedAdmin, adminSnapshot);
  return {
    backendComparison,
    adminComparison,
    backendEquivalent: snapshotEquivalent(backendComparison),
    adminEquivalent: snapshotEquivalent(adminComparison),
    fourViewCanonical: fourDeviceIdentitiesCanonical(
      [backendDevice, adminDevice, dashboardDevice, deviceDevice],
      expectedCanonicalStableId,
    ),
    fourViewTargetExact: [backendDevice, adminDevice, dashboardDevice, deviceDevice].every(
      (row) => row !== null && stableJson(serializeDevice(row)) === stableJson(serializeDevice(target)),
    ),
    deviceViews: {
      backend: safeDeviceIdentity(backendDevice),
      admin: safeDeviceIdentity(adminDevice),
      dashboard: safeDeviceIdentity(dashboardDevice),
      device: safeDeviceIdentity(deviceDevice),
    },
  };
}

function projectionSummary(snapshot: LogicalSnapshot) {
  return {
    counts: Object.fromEntries(Object.entries(snapshot).map(([table, rows]) => [table, rows.length])),
    hash: sha256Json(snapshot),
  };
}

async function main(): Promise<number> {
  const sourceAuthorityInput = resolve(required("DEVICE_RESEED_STAGE_SOURCE_AUTHORITY_DB"));
  const sourceBackendInput = resolve(required("DEVICE_RESEED_STAGE_SOURCE_BACKEND_DB"));
  const liveAuthorityInput = resolve(required("DEVICE_RESEED_LIVE_AUTHORITY_DB"));
  const liveBackendInput = resolve(required("DEVICE_RESEED_LIVE_BACKEND_DB"));
  const stageAuthorityInput = resolve(required("DEVICE_RESEED_STAGE_AUTHORITY_DIR"));
  const stageMode = required("DEVICE_RESEED_STAGE_MODE");
  const deviceId = required("DEVICE_RESEED_DEVICE_ID");
  const expectedBackendStableId = required("DEVICE_RESEED_EXPECTED_BACKEND_STABLE_ID");
  const expectedCanonicalStableId = required("DEVICE_RESEED_EXPECTED_CANONICAL_STABLE_ID");

  if (stageMode !== "rehearsal" && stageMode !== "production") {
    throw new Error("DEVICE_RESEED_STAGE_MODE must be rehearsal or production");
  }
  if (expectedBackendStableId === expectedCanonicalStableId) {
    throw new Error("Expected backend and canonical stable IDs must differ");
  }

  const [sourceAuthorityDb, sourceBackendDb, liveAuthorityDb, liveBackendDb] =
    await Promise.all([
      realpath(sourceAuthorityInput),
      realpath(sourceBackendInput),
      realpath(liveAuthorityInput),
      realpath(liveBackendInput),
    ]);
  if (sourceAuthorityDb === liveAuthorityDb || sourceBackendDb === liveBackendDb) {
    throw new Error("Stage input aliases production storage");
  }
  if (await pathExists(stageAuthorityInput)) {
    throw new Error("Stage authority output already exists");
  }

  const stageBuilding = stageAuthorityInput + ".building-" + process.pid;
  if (await pathExists(stageBuilding)) {
    throw new Error("Stage building directory already exists");
  }
  await mkdir(dirname(stageAuthorityInput), { recursive: true });

  const workRoot = await mkdtemp(join(tmpdir(), "remote-mcp-jazz-reseed-stage."));
  const hidden = [
    sourceAuthorityDb,
    sourceBackendDb,
    liveAuthorityDb,
    liveBackendDb,
    stageAuthorityInput,
    stageBuilding,
    workRoot,
    env.jazzAdminSecret,
    env.jazzBackendSecret,
  ];

  let sourceServer: any;
  let sourceViews: any;
  let stageServer: any;
  let stageViews: any;
  let oldCacheViews: any;
  let finalViews: any;
  let stageReady = false;
  try {
    const sourceAuthorityDir = join(workRoot, "source", "authority");
    const sourceBackendPath = join(workRoot, "source", "backend.db");
    await mkdir(sourceAuthorityDir, { recursive: true });
    const sourceAuthorityWorkDb = join(sourceAuthorityDir, "jazz.sqlite");
    await copyFile(sourceAuthorityDb, sourceAuthorityWorkDb);
    await copyFile(sourceBackendDb, sourceBackendPath);
    await chmod(sourceAuthorityWorkDb, 0o600);
    await chmod(sourceBackendPath, 0o600);

    sourceServer = await startLocalJazzServer({
      appId: env.jazzAppId,
      dataDir: sourceAuthorityDir,
      jwksUrl: env.jazzJwksUrl,
      adminSecret: env.jazzAdminSecret,
      backendSecret: env.jazzBackendSecret,
      allowLocalFirstAuth: false,
      enableLogs: false,
    });
    if (!sourceServer.url) throw new Error("Copied source authority did not provide a URL");
    sourceViews = await createBackendAdminViews(sourceServer.url, sourceBackendPath);

    const [backendSource, adminSource] = await Promise.all([
      readLogicalSnapshot(sourceViews.backendDb),
      readLogicalSnapshot(sourceViews.adminDb),
    ]);
    const targetAdmin = adminSource.devices.find((row) => row.id === deviceId) ?? null;
    const targetBackend = backendSource.devices.find((row) => row.id === deviceId) ?? null;
    if (!targetAdmin || !targetBackend) throw new Error("Target device is missing from one or both source views");
    if (targetAdmin.revokedAt || targetBackend.revokedAt) throw new Error("Target device must not be revoked");
    if (targetAdmin.status !== "offline" || targetBackend.status !== "offline") {
      throw new Error("Target device must be offline in both source views");
    }
    if (targetAdmin.stableId !== expectedCanonicalStableId) {
      throw new Error("Admin target stable ID precondition failed");
    }
    if (targetBackend.stableId !== expectedBackendStableId) {
      throw new Error("Backend target stable ID precondition failed");
    }
    if (targetAdmin.ownerId !== targetBackend.ownerId || targetAdmin.oauthClientId !== targetBackend.oauthClientId) {
      throw new Error("Target ownership/client precondition failed");
    }

    const [dashboardToken, deviceToken] = await Promise.all([
      mintJazzDashboardToken(targetAdmin.ownerId),
      mintJazzDeviceToken(targetAdmin.ownerId, targetAdmin.oauthClientId, targetAdmin.id),
    ]);
    sourceViews.dashboardDb = await createDb({
      appId: env.jazzAppId,
      serverUrl: sourceServer.url,
      jwtToken: dashboardToken,
      driver: { type: "memory" },
    });
    sourceViews.deviceDb = await createDb({
      appId: env.jazzAppId,
      serverUrl: sourceServer.url,
      jwtToken: deviceToken,
      driver: { type: "memory" },
    });
    const [dashboardTarget, deviceTarget] = await Promise.all([
      readDevice(sourceViews.dashboardDb, deviceId),
      readDevice(sourceViews.deviceDb, deviceId),
    ]);
    const canonicalPrincipalAgreement = Boolean(
      dashboardTarget
      && deviceTarget
      && stableJson(safeContinuityDevice(targetAdmin)) === stableJson(safeContinuityDevice(dashboardTarget))
      && stableJson(safeContinuityDevice(targetAdmin)) === stableJson(safeContinuityDevice(deviceTarget))
    );

    const compositeRecovery = buildCompositeRecoverySnapshot(backendSource, adminSource, {
      deviceId,
      expectedBackendStableId,
      expectedCanonicalStableId,
    });
    const { snapshot: canonicalSnapshot, ...sourceComposite } = compositeRecovery;
    const canonicalTarget = canonicalSnapshot.devices.find((row) => row.id === deviceId) ?? null;
    const provenanceSupported = supportedSourceProvenance(compositeRecovery.tables);
    if (!compositeRecovery.recoverable || !canonicalPrincipalAgreement || !canonicalTarget || !provenanceSupported) {
      console.log(JSON.stringify({
        phase: "stage-source-blocked",
        stageMode,
        sourceComposite,
        provenanceSupported,
        canonicalPrincipalAgreement,
        stageReady: false,
        productionApplyAuthorized: false,
      }));
      return 2;
    }

    const expectedBackendSnapshot = replaceTargetDevice(backendSource, canonicalTarget);
    const expectedAdminSnapshot = replaceTargetDevice(adminSource, canonicalTarget);

    await shutdownViews(sourceViews);
    sourceViews = null;
    await stopServer(sourceServer);
    sourceServer = null;

    await mkdir(stageBuilding, { recursive: true });
    stageServer = await startLocalJazzServer({
      appId: env.jazzAppId,
      dataDir: stageBuilding,
      jwksUrl: env.jazzJwksUrl,
      adminSecret: env.jazzAdminSecret,
      backendSecret: env.jazzBackendSecret,
      allowLocalFirstAuth: false,
      enableLogs: false,
    });
    if (!stageServer.url) throw new Error("Staged authority did not provide a URL");
    await deploy({
      appId: env.jazzAppId,
      serverUrl: stageServer.url,
      adminSecret: env.jazzAdminSecret,
      schema: app,
      permissions,
    });

    const seedBackendPath = join(workRoot, "validation", "seed-backend.db");
    await mkdir(dirname(seedBackendPath), { recursive: true });
    const seedViews = await createBackendAdminViews(stageServer.url, seedBackendPath);
    try {
      await importLogicalSnapshot(seedViews.backendDb, expectedBackendSnapshot);
      await importLogicalSnapshot(seedViews.adminDb, expectedAdminSnapshot);
    } finally {
      await shutdownViews(seedViews);
    }
    await stopServer(stageServer);
    stageServer = null;
    stageServer = await startLocalJazzServer({
      appId: env.jazzAppId,
      dataDir: stageBuilding,
      jwksUrl: env.jazzJwksUrl,
      adminSecret: env.jazzAdminSecret,
      backendSecret: env.jazzBackendSecret,
      allowLocalFirstAuth: false,
      enableLogs: false,
    });
    if (!stageServer.url) throw new Error("Restarted staged authority did not provide a URL");
    const fresh1Path = join(workRoot, "validation", "fresh-1.db");
    stageViews = await createFullViews(stageServer.url, fresh1Path, canonicalTarget);
    const fresh1 = await inspectDestination(
      stageViews,
      expectedBackendSnapshot,
      expectedAdminSnapshot,
      canonicalTarget,
      expectedCanonicalStableId,
    );
    const fresh1Accepted = fresh1.backendEquivalent
      && fresh1.adminEquivalent
      && fresh1.fourViewCanonical
      && fresh1.fourViewTargetExact;
    await shutdownViews(stageViews);
    stageViews = null;

    const oldCachePath = join(workRoot, "validation", "old-cache.db");
    await copyFile(sourceBackendDb, oldCachePath);
    await chmod(oldCachePath, 0o600);
    oldCacheViews = await createFullViews(stageServer.url, oldCachePath, canonicalTarget);
    const oldCacheSnapshot = await readLogicalSnapshot(oldCacheViews.backendDb);
    const oldCacheComparison = compareExactSnapshots(expectedBackendSnapshot, oldCacheSnapshot);
    const oldCacheSyncEquivalent = snapshotEquivalent(oldCacheComparison);
    let oldCacheWriteAcknowledged = false;
    let oldCacheWriteError: string | null = null;
    try {
      const handle = oldCacheViews.backendDb.update(app.devices, canonicalTarget.id, {
        stableId: expectedCanonicalStableId,
      });
      await withTimeout(handle.wait({ tier: "global" }), "staged old-cache no-op write", 12_000);
      oldCacheWriteAcknowledged = true;
    } catch (error) {
      oldCacheWriteError = safeErrorMessage(error, hidden);
    }
    await shutdownViews(oldCacheViews);
    oldCacheViews = null;
    await stopServer(stageServer);
    stageServer = null;

    stageServer = await startLocalJazzServer({
      appId: env.jazzAppId,
      dataDir: stageBuilding,
      jwksUrl: env.jazzJwksUrl,
      adminSecret: env.jazzAdminSecret,
      backendSecret: env.jazzBackendSecret,
      allowLocalFirstAuth: false,
      enableLogs: false,
    });
    if (!stageServer.url) throw new Error("Second staged authority restart did not provide a URL");
    const fresh2Path = join(workRoot, "validation", "fresh-2.db");
    finalViews = await createFullViews(stageServer.url, fresh2Path, canonicalTarget);
    const fresh2 = await inspectDestination(
      finalViews,
      expectedBackendSnapshot,
      expectedAdminSnapshot,
      canonicalTarget,
      expectedCanonicalStableId,
    );
    const postOldCacheFreshConvergence =
      fresh2.backendEquivalent
      && fresh2.adminEquivalent
      && fresh2.fourViewCanonical
      && fresh2.fourViewTargetExact;
    const returningCacheCompatible =
      oldCacheSyncEquivalent && oldCacheWriteAcknowledged && postOldCacheFreshConvergence;
    const accepted = fresh1Accepted && returningCacheCompatible && postOldCacheFreshConvergence;

    await shutdownViews(finalViews);
    finalViews = null;
    await stopServer(stageServer);
    stageServer = null;

    if (!accepted) {
      console.log(JSON.stringify({
        phase: "stage-validation-blocked",
        stageMode,
        sourceComposite,
        provenanceSupported,
        freshAfterStageRestart: fresh1,
        returningBackendCache: {
          comparison: oldCacheComparison,
          syncEquivalent: oldCacheSyncEquivalent,
          writeAcknowledged: oldCacheWriteAcknowledged,
          writeError: oldCacheWriteError,
          compatible: returningCacheCompatible,
        },
        freshAfterReturningCacheAttempt: fresh2,
        stageReady: false,
        productionApplyAuthorized: false,
      }));
      return 2;
    }

    await rename(stageBuilding, stageAuthorityInput);
    stageReady = true;

    console.log(JSON.stringify({
      phase: "stage-ready",
      stageMode,
      stageReady: true,
      productionApplyAuthorized: false,
      sourceComposite,
      provenanceSupported,
      canonicalTarget: safeDeviceIdentity(canonicalTarget),
      expectedPrincipalViews: {
        backend: projectionSummary(expectedBackendSnapshot),
        admin: projectionSummary(expectedAdminSnapshot),
      },
      freshAfterStageRestart: fresh1,
      returningBackendCache: {
        syncEquivalent: oldCacheSyncEquivalent,
        writeAcknowledged: oldCacheWriteAcknowledged,
        writeError: oldCacheWriteError,
        compatible: returningCacheCompatible,
      },
      postOldCacheFreshConvergence,
      deviceJazzPersistence: "memory-only",
      persistentDeviceJazzCachePresent: false,
    }));
    return 0;
  } finally {
    await shutdownViews(finalViews);
    await shutdownViews(oldCacheViews);
    await shutdownViews(stageViews);
    await shutdownViews(sourceViews);
    await stopServer(stageServer);
    await stopServer(sourceServer);
    await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
    if (!stageReady) {
      await rm(stageBuilding, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    const hidden = [
      process.env.DEVICE_RESEED_STAGE_SOURCE_AUTHORITY_DB ?? "",
      process.env.DEVICE_RESEED_STAGE_SOURCE_BACKEND_DB ?? "",
      process.env.DEVICE_RESEED_LIVE_AUTHORITY_DB ?? "",
      process.env.DEVICE_RESEED_LIVE_BACKEND_DB ?? "",
      process.env.DEVICE_RESEED_STAGE_AUTHORITY_DIR ?? "",
      process.env.JAZZ_ADMIN_SECRET ?? "",
      process.env.JAZZ_BACKEND_SECRET ?? "",
    ];
    console.log(JSON.stringify({
      phase: "stage-unexpected-error",
      error: safeErrorMessage(error, hidden),
      stageReady: false,
      productionApplyAuthorized: false,
    }));
    process.exitCode = 1;
  });
