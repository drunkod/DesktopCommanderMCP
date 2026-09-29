import { readFile } from "node:fs/promises";
import { createDb } from "jazz-tools";
import { app, type Device } from "../schema";
import { env } from "../lib/env";
import { jazzContext } from "../lib/jazz-context";
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

function snapshotCounts(snapshot: Awaited<ReturnType<typeof readLogicalSnapshot>>) {
  return Object.fromEntries(Object.entries(snapshot).map(([table, rows]) => [table, rows.length]));
}

async function readDevice(db: any, id: string): Promise<Device | null> {
  return await db.one(app.devices.where({ id }), { tier: "global" }) as Device | null;
}

async function main(): Promise<number> {
  const manifestPath = required("DEVICE_RESEED_STAGE_MANIFEST");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as StageManifest;
  if (manifest.mode !== "production" || !manifest.stageReady) {
    throw new Error("Stage manifest is not a ready production stage");
  }
  if (manifest.canonicalTarget.stableId !== manifest.expectedCanonicalStableId) {
    throw new Error("Stage manifest canonical target does not match expected canonical stable ID");
  }

  const context = jazzContext();
  const backendDb = context.asBackend(app);
  const adminDb = await createDb({
    appId: env.jazzAppId,
    serverUrl: env.jazzInternalServerUrl,
    adminSecret: env.jazzAdminSecret,
    driver: { type: "memory" },
  });

  const [dashboardToken, deviceToken] = await Promise.all([
    mintJazzDashboardToken(manifest.canonicalTarget.ownerId),
    mintJazzDeviceToken(
      manifest.canonicalTarget.ownerId,
      manifest.canonicalTarget.oauthClientId,
      manifest.canonicalTarget.id,
    ),
  ]);
  const dashboardDb = await createDb({
    appId: env.jazzAppId,
    serverUrl: env.jazzInternalServerUrl,
    jwtToken: dashboardToken,
    driver: { type: "memory" },
  });
  const deviceDb = await createDb({
    appId: env.jazzAppId,
    serverUrl: env.jazzInternalServerUrl,
    jwtToken: deviceToken,
    driver: { type: "memory" },
  });

  try {
    const [
      backendSnapshot,
      adminSnapshot,
      backendDevice,
      adminDevice,
      dashboardDevice,
      deviceDevice,
    ] = await Promise.all([
      readLogicalSnapshot(backendDb),
      readLogicalSnapshot(adminDb),
      readDevice(backendDb, manifest.canonicalTarget.id),
      readDevice(adminDb, manifest.canonicalTarget.id),
      readDevice(dashboardDb, manifest.canonicalTarget.id),
      readDevice(deviceDb, manifest.canonicalTarget.id),
    ]);

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

    console.log(JSON.stringify({
      phase: liveValidationAccepted ? "post-handoff-validated" : "post-handoff-blocked",
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
    }));
    return liveValidationAccepted ? 0 : 2;
  } finally {
    await Promise.allSettled([
      deviceDb.shutdown(),
      dashboardDb.shutdown(),
      adminDb.shutdown(),
      context.shutdown(),
    ]);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.log(JSON.stringify({
      phase: "post-handoff-error",
      error: error instanceof Error ? error.name + ": " + error.message : String(error),
      liveValidationAccepted: false,
      admissionsReopenAuthorized: false,
      publicIngressReopenAuthorized: false,
    }));
    process.exitCode = 1;
  });
