import { isTaskAdmissionFrozen } from "../lib/cutover-mode";
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

  if (!isTaskAdmissionFrozen()) {
    console.error("Task admission must be frozen before worker sessions are quiesced");
    return 2;
  }

  const db = jazzBackendDb();
  const [jobs, calls, sessions, devices] = await Promise.all([
    db.all(app.chatJobs, { tier: "global" }),
    db.all(app.remoteCalls, { tier: "global" }),
    db.all(app.workerSessions, { tier: "global" }),
    db.all(app.devices, { tier: "global" }),
  ]);

  const ownerIds = new Set(
    [...jobs, ...calls, ...sessions, ...devices].map((row) => row.ownerId),
  );
  const expectedDevicePresent = devices.some(
    (device) => device.ownerId === expectedOwnerId && !device.revokedAt,
  );
  if (!expectedDevicePresent
    || ownerIds.size !== 1
    || !ownerIds.has(expectedOwnerId)) {
    console.error(JSON.stringify({
      error: "deployment identity is not verified",
      expectedOwnerId,
      observedOwnerIds: [...ownerIds].sort(),
      expectedDevicePresent,
    }));
    return 2;
  }

  const runningJobs = jobs.filter((job) => job.status === "running");
  if (runningJobs.length > 0) {
    console.error(JSON.stringify({
      error: "running worker jobs must reach a terminal state before sessions are quiesced",
      runningTaskIds: runningJobs.map((job) => job.id),
    }));
    return 2;
  }

  const activeSessions = sessions.filter((session) => session.status === "active");
  const closedSessionIds: string[] = [];
  for (const session of activeSessions) {
    const now = new Date();
    const write = db.update(app.workerSessions, session.id, {
      status: "closed",
      lastSeenAt: now,
      closedAt: now,
    });
    await write.wait({ tier: "global" });
    closedSessionIds.push(session.id);
  }

  console.log(JSON.stringify({
    state: "quiesced",
    expectedOwnerId,
    closedSessionIds,
  }, null, 2));
  return 0;
});
