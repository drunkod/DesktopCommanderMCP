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
  const [{ app }, { jazzBackendDb }] = await Promise.all([
    import("../schema"),
    import("../lib/jazz-principal"),
  ]);

  const db = jazzBackendDb();
  const [jobs, calls, sessions, devices] = await Promise.all([
    db.all(app.chatJobs, { tier: "global" }),
    db.all(app.remoteCalls, { tier: "global" }),
    db.all(app.workerSessions, { tier: "global" }),
    db.all(app.devices, { tier: "global" }),
  ]);

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
});
