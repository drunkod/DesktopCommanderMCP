import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createDb } from "jazz-tools";
import { createJazzContext } from "jazz-tools/backend";
import { app, type Device } from "../schema";
import permissions from "../permissions";
import { env } from "../lib/env";
import { mintJazzDashboardToken, mintJazzDeviceToken } from "../lib/jazz-capability";
import {
  readLogicalSnapshot,
  safeDeviceIdentity,
  sha256Json,
  stableJson,
} from "../lib/reseed-recovery";

type StageManifest = {
  mode: string;
  stageReady: boolean;
  gitSha: string;
  expectedCanonicalStableId: string;
  expectedPrincipalViews: {
    backend: { counts: Record<string, number>; hash: string };
    admin: { counts: Record<string, number>; hash: string };
  };
  canonicalTarget: {
    id: string;
    ownerId: string;
    oauthClientId: string;
    stableId: string;
    status: string;
    revoked: boolean;
  };
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("Missing required environment variable: " + name);
  return value;
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
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

function snapshotCounts(snapshot: Awaited<ReturnType<typeof readLogicalSnapshot>>) {
  return Object.fromEntries(Object.entries(snapshot).map(([table, rows]) => [table, rows.length]));
}

async function readDevice(db: any, id: string): Promise<Device | null> {
  return await withTimeout(
    db.one(app.devices.where({ id }), { tier: "global" }) as Promise<Device | null>,
    "device view read",
  );
}

async function shutdownDb(db: any, label: string): Promise<void> {
  if (!db) return;
  await withTimeout(db.shutdown(), label + " shutdown", 5_000).catch(() => undefined);
}

async function main(): Promise<{ code: number; result: Record<string, unknown> }> {
  const manifestPath = required("DEVICE_RESEED_STAGE_MANIFEST");
  const verifierBackendPath = resolve(required("DEVICE_RESEED_VERIFY_BACKEND_DB"));
  const configuredBackendPath = resolve(env.jazzBackendDataPath);
  if (verifierBackendPath === configuredBackendPath) {
    throw new Error("Dedicated verifier backend cache aliases the configured application backend cache");
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as StageManifest;
  if (manifest.mode !== "production" || !manifest.stageReady) {
    throw new Error("Stage manifest is not a ready production stage");
  }
  if (manifest.canonicalTarget.stableId !== manifest.expectedCanonicalStableId) {
    throw new Error("Stage manifest canonical target does not match expected canonical stable ID");
  }

  const context = createJazzContext({
    appId: env.jazzAppId,
    app,
    permissions,
    driver: { type: "persistent", dataPath: verifierBackendPath },
    serverUrl: env.jazzInternalServerUrl,
    env: "prod",
    tier: "edge",
    adminSecret: env.jazzAdminSecret,
    backendSecret: env.jazzBackendSecret,
    jwksUrl: env.jazzJwksUrl,
    allowLocalFirstAuth: false,
  });
  const backendDb = context.asBackend(app);

  let adminDb: any;
  let dashboardDb: any;
  let deviceDb: any;
  try {
    adminDb = await withTimeout(createDb({
      appId: env.jazzAppId,
      serverUrl: env.jazzInternalServerUrl,
      adminSecret: env.jazzAdminSecret,
      driver: { type: "memory" },
    }), "admin verifier creation");

    const [dashboardToken, deviceToken] = await withTimeout(Promise.all([
      mintJazzDashboardToken(manifest.canonicalTarget.ownerId),
      mintJazzDeviceToken(
        manifest.canonicalTarget.ownerId,
        manifest.canonicalTarget.oauthClientId,
        manifest.canonicalTarget.id,
      ),
    ]), "capability token mint");

    dashboardDb = await withTimeout(createDb({
      appId: env.jazzAppId,
      serverUrl: env.jazzInternalServerUrl,
      jwtToken: dashboardToken,
      driver: { type: "memory" },
    }), "dashboard verifier creation");
    deviceDb = await withTimeout(createDb({
      appId: env.jazzAppId,
      serverUrl: env.jazzInternalServerUrl,
      jwtToken: deviceToken,
      driver: { type: "memory" },
    }), "device verifier creation");

    const [
      backendSnapshot,
      adminSnapshot,
      backendDevice,
      adminDevice,
      dashboardDevice,
      deviceDevice,
    ] = await withTimeout(Promise.all([
      readLogicalSnapshot(backendDb),
      readLogicalSnapshot(adminDb),
      readDevice(backendDb, manifest.canonicalTarget.id),
      readDevice(adminDb, manifest.canonicalTarget.id),
      readDevice(dashboardDb, manifest.canonicalTarget.id),
      readDevice(deviceDb, manifest.canonicalTarget.id),
    ]), "post-handoff projection reads", 25_000);

    const backendHash = sha256Json(backendSnapshot);
    const adminHash = sha256Json(adminSnapshot);
    const backendCounts = snapshotCounts(backendSnapshot);
    const adminCounts = snapshotCounts(adminSnapshot);
    const backendProjectionEquivalent =
      backendHash === manifest.expectedPrincipalViews.backend.hash
      && stableJson(backendCounts) === stableJson(manifest.expectedPrincipalViews.backend.counts);
    const adminProjectionEquivalent =
      adminHash === manifest.expectedPrincipalViews.admin.hash
      && stableJson(adminCounts) === stableJson(manifest.expectedPrincipalViews.admin.counts);

    const identities = [backendDevice, adminDevice, dashboardDevice, deviceDevice]
      .map((row) => safeDeviceIdentity(row));
    const fourViewIdentityExact = identities.every(
      (identity) => identity !== null
        && stableJson(identity) === stableJson(manifest.canonicalTarget),
    );
    const liveValidationAccepted =
      backendProjectionEquivalent && adminProjectionEquivalent && fourViewIdentityExact;

    return {
      code: liveValidationAccepted ? 0 : 2,
      result: {
        phase: liveValidationAccepted ? "post-handoff-validated" : "post-handoff-blocked",
        verifierBackendCache: "dedicated",
        backendProjectionEquivalent,
        adminProjectionEquivalent,
        fourViewIdentityExact,
        backend: { counts: backendCounts, hash: backendHash },
        admin: { counts: adminCounts, hash: adminHash },
        deviceViews: {
          backend: identities[0],
          admin: identities[1],
          dashboard: identities[2],
          device: identities[3],
        },
        liveValidationAccepted,
        admissionsReopenAuthorized: false,
        publicIngressReopenAuthorized: false,
      },
    };
  } finally {
    await Promise.allSettled([
      shutdownDb(deviceDb, "device verifier"),
      shutdownDb(dashboardDb, "dashboard verifier"),
      shutdownDb(adminDb, "admin verifier"),
      withTimeout(context.shutdown(), "backend verifier context shutdown", 5_000).catch(() => undefined),
    ]);
  }
}

async function emitAndExit(result: Record<string, unknown>, code: number): Promise<never> {
  await new Promise<void>((resolveWrite) => {
    process.stdout.write(JSON.stringify(result) + "\n", () => resolveWrite());
  });
  process.exit(code);
}

main()
  .then(({ code, result }) => emitAndExit(result, code))
  .catch((error) => emitAndExit({
    phase: "post-handoff-error",
    error: error instanceof Error ? error.name + ": " + error.message : String(error),
    liveValidationAccepted: false,
    admissionsReopenAuthorized: false,
    publicIngressReopenAuthorized: false,
  }, 1));
