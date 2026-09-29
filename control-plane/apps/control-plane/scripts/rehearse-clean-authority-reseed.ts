import { copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  compareSourceSnapshots,
  fourDeviceIdentitiesCanonical,
  importLogicalSnapshot,
  readLogicalSnapshot,
  safeDeviceIdentity,
  serializeDevice,
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

function sourceOverlapCounts(backend: LogicalSnapshot, admin: LogicalSnapshot) {
  const tables = ["devices", "remoteCalls", "workerSessions", "chatJobs", "auditEvents"] as const;
  return Object.fromEntries(tables.map((table) => {
    const backendIds = new Set(backend[table].map((row) => row.id));
    const adminIds = new Set(admin[table].map((row) => row.id));
    let overlapCount = 0;
    for (const id of backendIds) if (adminIds.has(id)) overlapCount += 1;
    return [table, { backendCount: backendIds.size, adminCount: adminIds.size, overlapCount }];
  }));
}

function unionReferenceClosure(backend: LogicalSnapshot, admin: LogicalSnapshot) {
  const deviceIds = new Set([...backend.devices, ...admin.devices].map((row) => row.id));
  const sessionIds = new Set([...backend.workerSessions, ...admin.workerSessions].map((row) => row.id));
  const callIds = new Set([...backend.remoteCalls, ...admin.remoteCalls].map((row) => row.id));
  const issues = new Map<string, { table: string; id: string; field: string }>();

  for (const row of [...backend.remoteCalls, ...admin.remoteCalls]) {
    if (!deviceIds.has(String(row.deviceId))) {
      issues.set(`remoteCalls:${row.id}:deviceId`, { table: "remoteCalls", id: row.id, field: "deviceId" });
    }
  }
  for (const row of [...backend.chatJobs, ...admin.chatJobs]) {
    if (row.claimedBySessionId && !sessionIds.has(String(row.claimedBySessionId))) {
      issues.set(`chatJobs:${row.id}:claimedBySessionId`, { table: "chatJobs", id: row.id, field: "claimedBySessionId" });
    }
  }
  for (const row of [...backend.auditEvents, ...admin.auditEvents]) {
    if (row.deviceId && !deviceIds.has(String(row.deviceId))) {
      issues.set(`auditEvents:${row.id}:deviceId`, { table: "auditEvents", id: row.id, field: "deviceId" });
    }
    if (row.remoteCallId && !callIds.has(String(row.remoteCallId))) {
      issues.set(`auditEvents:${row.id}:remoteCallId`, { table: "auditEvents", id: row.id, field: "remoteCallId" });
    }
  }

  const list = [...issues.values()].sort((a, b) =>
    a.table.localeCompare(b.table) || a.id.localeCompare(b.id) || a.field.localeCompare(b.field));
  return { ok: list.length === 0, issues: list };
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

function withoutTargetDevice(snapshot: LogicalSnapshot, targetId: string): LogicalSnapshot {
  return {
    devices: snapshot.devices.filter((row) => row.id !== targetId),
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

async function main(): Promise<number> {
  const sourceAuthorityInput = resolve(required("DEVICE_RESEED_SOURCE_AUTHORITY_DB"));
  const sourceBackendInput = resolve(required("DEVICE_RESEED_SOURCE_BACKEND_DB"));
  const liveAuthorityInput = resolve(required("DEVICE_RESEED_LIVE_AUTHORITY_DB"));
  const liveBackendInput = resolve(required("DEVICE_RESEED_LIVE_BACKEND_DB"));
  const deviceId = required("DEVICE_RESEED_DEVICE_ID");
  const expectedBackendStableId = required("DEVICE_RESEED_EXPECTED_BACKEND_STABLE_ID");
  const expectedCanonicalStableId = required("DEVICE_RESEED_EXPECTED_CANONICAL_STABLE_ID");

  if (expectedBackendStableId === expectedCanonicalStableId) {
    throw new Error("Expected backend and canonical stable IDs must differ");
  }

  const [sourceAuthorityDb, sourceBackendDb, liveAuthorityDb, liveBackendDb, realTmp] =
    await Promise.all([
      realpath(sourceAuthorityInput),
      realpath(sourceBackendInput),
      realpath(liveAuthorityInput),
      realpath(liveBackendInput),
      realpath(tmpdir()),
    ]);
  const allowedPrefix = resolve(realTmp) + "/remote-mcp-jazz-clean-reseed.";
  if (!sourceAuthorityDb.startsWith(allowedPrefix) || !sourceBackendDb.startsWith(allowedPrefix)) {
    throw new Error("Source snapshot copies must be inside the clean-reseed temporary directory");
  }
  if (sourceAuthorityDb === liveAuthorityDb || sourceBackendDb === liveBackendDb) {
    throw new Error("Copy-only rehearsal input aliases production storage");
  }

  const workRoot = await mkdtemp(join(realTmp, "remote-mcp-jazz-clean-reseed.work."));
  const hidden = [
    sourceAuthorityDb,
    sourceBackendDb,
    liveAuthorityDb,
    liveBackendDb,
    workRoot,
    env.jazzAdminSecret,
    env.jazzBackendSecret,
  ];

  let sourceServer: any;
  let sourceViews: any;
  let destinationServer: any;
  let destinationViews: any;
  let oldCacheViews: any;
  let finalViews: any;

  try {
    const sourceAuthorityDir = join(workRoot, "source-work", "authority");
    const sourceBackendPath = join(workRoot, "source-work", "backend.db");
    await mkdir(sourceAuthorityDir, { recursive: true });
    await copyFile(sourceAuthorityDb, join(sourceAuthorityDir, "jazz.sqlite"));
    await copyFile(sourceBackendDb, sourceBackendPath);

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
    console.error("reseed-phase=source-read-complete");
    const sourceComparison = compareSourceSnapshots(backendSource, adminSource, {
      deviceId,
      expectedBackendStableId,
      expectedCanonicalStableId,
    });

    const targetAdmin = adminSource.devices.find((row) => row.id === deviceId) ?? null;
    const targetBackend = backendSource.devices.find((row) => row.id === deviceId) ?? null;
    let dashboardTarget: Device | null = null;
    let deviceTarget: Device | null = null;
    if (targetAdmin) {
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
      [dashboardTarget, deviceTarget] = await Promise.all([
        readDevice(sourceViews.dashboardDb, deviceId),
        readDevice(sourceViews.deviceDb, deviceId),
      ]);
    }

    const sourceCharacterization = {
      overlaps: sourceOverlapCounts(backendSource, adminSource),
      unionReferenceClosure: unionReferenceClosure(backendSource, adminSource),
      targetViews: {
        backend: safeContinuityDevice(targetBackend),
        admin: safeContinuityDevice(targetAdmin),
        dashboard: safeContinuityDevice(dashboardTarget),
        device: safeContinuityDevice(deviceTarget),
      },
      canonicalPrincipalAgreement: Boolean(
        targetAdmin
        && dashboardTarget
        && deviceTarget
        && stableJson(safeContinuityDevice(targetAdmin)) === stableJson(safeContinuityDevice(dashboardTarget))
        && stableJson(safeContinuityDevice(targetAdmin)) === stableJson(safeContinuityDevice(deviceTarget))
      ),
    };

    if (!targetAdmin || !targetBackend) throw new Error("Target device is missing from one or both source views");
    if (targetAdmin.revokedAt || targetBackend.revokedAt) throw new Error("Target device must not be revoked");
    if (targetAdmin.status !== "offline" || targetBackend.status !== "offline") {
      throw new Error("Target device must be offline in both source views");
    }
    if (targetAdmin.stableId !== expectedCanonicalStableId) throw new Error("Admin target stable ID precondition failed");
    if (targetBackend.stableId !== expectedBackendStableId) throw new Error("Backend target stable ID precondition failed");
    if (targetAdmin.ownerId !== targetBackend.ownerId || targetAdmin.oauthClientId !== targetBackend.oauthClientId) {
      throw new Error("Target ownership/client precondition failed");
    }

    const compositeRecovery = buildCompositeRecoverySnapshot(backendSource, adminSource, {
      deviceId,
      expectedBackendStableId,
      expectedCanonicalStableId,
    });
    const { snapshot: canonicalSnapshot, ...sourceComposite } = compositeRecovery;
    const canonicalTarget = canonicalSnapshot.devices.find((row) => row.id === deviceId) ?? null;
    const provenanceSupported = supportedSourceProvenance(compositeRecovery.tables);
    const sourceCandidateAccepted = compositeRecovery.recoverable
      && sourceCharacterization.canonicalPrincipalAgreement
      && canonicalTarget !== null
      && provenanceSupported;
    console.error("reseed-phase=source-composite-" + (sourceCandidateAccepted ? "accepted" : "blocked"));

    if (!sourceCandidateAccepted) {
      console.log(JSON.stringify({
        phase: "source-composite-blocked",
        sourceComparison,
        sourceCharacterization,
        sourceComposite,
        provenanceSupported,
        rehearsalAccepted: false,
        productionMigrationAuthorized: false,
        deviceJazzPersistence: "memory-only",
        persistentDeviceJazzCachePresent: false,
        deviceCacheRetirementRequired: false,
      }));
      return 2;
    }

    const expectedBackendSnapshot = replaceTargetDevice(backendSource, canonicalTarget!);
    const expectedAdminSnapshot = replaceTargetDevice(adminSource, canonicalTarget!);
    // The incident proves this device ID has distinct backend and admin/capability
    // histories. Recreate both branches with the same canonical logical row so
    // visibility is preserved without preserving the divergent field values.
    const adminSeedSnapshot = expectedAdminSnapshot;

    await shutdownViews(sourceViews);
    sourceViews = null;
    await stopServer(sourceServer);
    sourceServer = null;

    const destinationAuthorityDir = join(workRoot, "destination", "authority");
    const seedBackendPath = join(workRoot, "destination", "seed-backend.db");
    await mkdir(destinationAuthorityDir, { recursive: true });
    destinationServer = await startLocalJazzServer({
      appId: env.jazzAppId,
      dataDir: destinationAuthorityDir,
      jwksUrl: env.jazzJwksUrl,
      adminSecret: env.jazzAdminSecret,
      backendSecret: env.jazzBackendSecret,
      allowLocalFirstAuth: false,
      enableLogs: false,
    });
    if (!destinationServer.url) throw new Error("Destination authority did not provide a URL");
    await deploy({
      appId: env.jazzAppId,
      serverUrl: destinationServer.url,
      adminSecret: env.jazzAdminSecret,
      schema: app,
      permissions,
    });
    const seedViews = await createBackendAdminViews(destinationServer.url, seedBackendPath);
    try {
      console.error("reseed-phase=destination-backend-import-start");
      await importLogicalSnapshot(
        seedViews.backendDb,
        expectedBackendSnapshot,
        (phase) => console.error("reseed-backend-import=" + phase),
      );
      console.error("reseed-phase=destination-backend-import-complete");
      console.error("reseed-phase=destination-admin-import-start");
      await importLogicalSnapshot(
        seedViews.adminDb,
        adminSeedSnapshot,
        (phase) => console.error("reseed-admin-import=" + phase),
      );
      console.error("reseed-phase=destination-admin-import-complete");
    } finally {
      await shutdownViews(seedViews);
    }
    await stopServer(destinationServer);
    destinationServer = null;

    destinationServer = await startLocalJazzServer({
      appId: env.jazzAppId,
      dataDir: destinationAuthorityDir,
      jwksUrl: env.jazzJwksUrl,
      adminSecret: env.jazzAdminSecret,
      backendSecret: env.jazzBackendSecret,
      allowLocalFirstAuth: false,
      enableLogs: false,
    });
    if (!destinationServer.url) throw new Error("Restarted destination authority did not provide a URL");
    const fresh1Path = join(workRoot, "destination", "fresh-1.db");
    destinationViews = await createFullViews(destinationServer.url, fresh1Path, canonicalTarget);
    const fresh1 = await inspectDestination(
      destinationViews,
      expectedBackendSnapshot,
      expectedAdminSnapshot,
      canonicalTarget,
      expectedCanonicalStableId,
    );
    const fresh1Accepted = fresh1.backendEquivalent
      && fresh1.adminEquivalent
      && fresh1.fourViewCanonical
      && fresh1.fourViewTargetExact;
    console.error("reseed-phase=fresh-cache-1-" + (fresh1Accepted ? "accepted" : "blocked"));
    await shutdownViews(destinationViews);
    destinationViews = null;

    const oldCachePath = join(workRoot, "destination", "old-cache-reconnect.db");
    await copyFile(sourceBackendDb, oldCachePath);
    oldCacheViews = await createFullViews(destinationServer.url, oldCachePath, canonicalTarget);
    const oldCacheSnapshot = await readLogicalSnapshot(oldCacheViews.backendDb);
    const oldCacheComparison = compareExactSnapshots(expectedBackendSnapshot, oldCacheSnapshot);
    const oldCacheSyncEquivalent = snapshotEquivalent(oldCacheComparison);
    console.error("reseed-phase=old-cache-sync-" + (oldCacheSyncEquivalent ? "equivalent" : "divergent"));

    let oldCacheWriteAcknowledged = false;
    let oldCacheWriteError: string | null = null;
    try {
      const handle = oldCacheViews.backendDb.update(app.devices, canonicalTarget.id, {
        stableId: expectedCanonicalStableId,
      });
      await withTimeout(handle.wait({ tier: "global" }), "returning backend cache test write", 12_000);
      oldCacheWriteAcknowledged = true;
      console.error("reseed-phase=old-cache-write-acknowledged");
    } catch (error) {
      console.error("reseed-phase=old-cache-write-blocked");
      oldCacheWriteError = safeErrorMessage(error, hidden);
    }

    await shutdownViews(oldCacheViews);
    oldCacheViews = null;
    await stopServer(destinationServer);
    destinationServer = null;

    destinationServer = await startLocalJazzServer({
      appId: env.jazzAppId,
      dataDir: destinationAuthorityDir,
      jwksUrl: env.jazzJwksUrl,
      adminSecret: env.jazzAdminSecret,
      backendSecret: env.jazzBackendSecret,
      allowLocalFirstAuth: false,
      enableLogs: false,
    });
    if (!destinationServer.url) throw new Error("Second destination restart did not provide a URL");
    const fresh2Path = join(workRoot, "destination", "fresh-2.db");
    finalViews = await createFullViews(destinationServer.url, fresh2Path, canonicalTarget);
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
    console.error("reseed-phase=fresh-cache-2-" + (postOldCacheFreshConvergence ? "accepted" : "blocked"));
    const returningCacheCompatible =
      oldCacheSyncEquivalent && oldCacheWriteAcknowledged && postOldCacheFreshConvergence;
    const backendCacheRetirementRequired = !returningCacheCompatible;
    const backendCacheRetirementProven =
      backendCacheRetirementRequired && postOldCacheFreshConvergence;

    const rehearsalAccepted =
      sourceCandidateAccepted
      && fresh1Accepted
      && postOldCacheFreshConvergence
      && (returningCacheCompatible || backendCacheRetirementProven);

    console.log(JSON.stringify({
      phase: rehearsalAccepted ? "copy-only-reseed-accepted" : "copy-only-reseed-blocked",
      sourceComparison,
      sourceCharacterization,
      sourceComposite,
      provenanceSupported,
      expectedPrincipalViews: {
        backend: Object.fromEntries(Object.entries(expectedBackendSnapshot).map(([table, rows]) => [table, rows.length])),
        admin: Object.fromEntries(Object.entries(expectedAdminSnapshot).map(([table, rows]) => [table, rows.length])),
      },
      freshAfterReseedRestart: fresh1,
      returningBackendCache: {
        comparison: oldCacheComparison,
        syncEquivalent: oldCacheSyncEquivalent,
        writeAcknowledged: oldCacheWriteAcknowledged,
        writeError: oldCacheWriteError,
        compatible: returningCacheCompatible,
      },
      freshAfterReturningCacheAttempt: fresh2,
      postOldCacheFreshConvergence,
      backendCacheRetirementRequired,
      testedRetirementProcedure: backendCacheRetirementRequired
        ? "discard copied pre-reseed backend cache and start with an empty backend cache"
        : null,
      backendCacheRetirementProven,
      deviceJazzPersistence: "memory-only",
      persistentDeviceJazzCachePresent: false,
      deviceCacheRetirementRequired: false,
      rehearsalAccepted,
      productionMigrationAuthorized: false,
    }));
    return rehearsalAccepted ? 0 : 2;
  } finally {
    await shutdownViews(finalViews);
    await shutdownViews(oldCacheViews);
    await shutdownViews(destinationViews);
    await shutdownViews(sourceViews);
    await stopServer(destinationServer);
    await stopServer(sourceServer);
    await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    const hidden = [
      process.env.DEVICE_RESEED_SOURCE_AUTHORITY_DB ?? "",
      process.env.DEVICE_RESEED_SOURCE_BACKEND_DB ?? "",
      process.env.DEVICE_RESEED_LIVE_AUTHORITY_DB ?? "",
      process.env.DEVICE_RESEED_LIVE_BACKEND_DB ?? "",
      process.env.JAZZ_ADMIN_SECRET ?? "",
      process.env.JAZZ_BACKEND_SECRET ?? "",
    ];
    console.log(JSON.stringify({
      phase: "unexpected-error",
      error: safeErrorMessage(error, hidden),
      rehearsalAccepted: false,
      productionMigrationAuthorized: false,
      deviceJazzPersistence: "memory-only",
      persistentDeviceJazzCachePresent: false,
      deviceCacheRetirementRequired: false,
    }));
    process.exitCode = 1;
  });
