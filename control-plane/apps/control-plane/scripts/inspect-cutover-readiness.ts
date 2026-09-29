import { isEffectAdmissionFrozen, isTaskAdmissionFrozen } from "../lib/cutover-mode";
import { expectedOwnerExistsInAuthDb } from "../lib/cutover-owner";
import { summarizeCutoverReadiness } from "../lib/cutover-readiness";
import { runWorkerCliWithExitCode } from "./worker-cli";

const expectedOwnerId = process.env.CUTOVER_EXPECTED_OWNER_ID?.trim();
if (!expectedOwnerId) {
  console.error("CUTOVER_EXPECTED_OWNER_ID is required");
  process.exit(1);
}

await runWorkerCliWithExitCode(async () => {
  const [{ app }, { createDb }, { env }, { jazzBackendDb }] = await Promise.all([
    import("../schema"),
    import("jazz-tools"),
    import("../lib/env"),
    import("../lib/jazz-principal"),
  ]);

  const backendDb = jazzBackendDb();
  const adminDb = await createDb({
    appId: env.jazzAppId,
    serverUrl: env.jazzInternalServerUrl,
    adminSecret: env.jazzAdminSecret,
    driver: { type: "memory" },
  });

  try {
    const [jobs, calls, sessions, backendDevices, adminDevices] = await Promise.all([
      backendDb.all(app.chatJobs, { tier: "global" }),
      backendDb.all(app.remoteCalls, { tier: "global" }),
      backendDb.all(app.workerSessions, { tier: "global" }),
      backendDb.all(app.devices, { tier: "global" }),
      adminDb.all(app.devices, { tier: "global" }),
    ]);

    const devicesById = new Map<string, (typeof backendDevices)[number]>();
    for (const device of backendDevices) devicesById.set(device.id, device);
    for (const device of adminDevices) devicesById.set(device.id, device);
    const devices = [...devicesById.values()];

    const report = summarizeCutoverReadiness({
      expectedOwnerId,
      expectedOwnerKnownToAuth: expectedOwnerExistsInAuthDb(expectedOwnerId),
      taskAdmissionFrozen: isTaskAdmissionFrozen(),
      effectAdmissionFrozen: isEffectAdmissionFrozen(),
      observedAt: new Date(),
      jobs,
      calls,
      sessions,
      devices,
    });

    console.log(JSON.stringify(report, null, 2));
    return report.readyForIngressFreeze ? 0 : 2;
  } finally {
    await adminDb.shutdown();
  }
});
