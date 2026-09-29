import { withWorkerBackend } from "./worker-cli";

const ownerId = process.env.CUTOVER_OWNER_ID?.trim()
  || process.env.WORKER_TASK_OWNER_ID?.trim();
if (!ownerId) {
  throw new Error("CUTOVER_OWNER_ID or WORKER_TASK_OWNER_ID is required");
}

const terminalRemoteCallStatuses = new Set([
  "completed",
  "failed",
  "cancelled",
  "indeterminate",
]);

await withWorkerBackend(async () => {
  const [{ app }, { jazzBackendDb }] = await Promise.all([
    import("../schema"),
    import("../lib/jazz-principal"),
  ]);

  const db = jazzBackendDb();
  const [jobs, calls, sessions, devices] = await Promise.all([
    db.all(app.chatJobs.where({ ownerId }).orderBy("createdAt", "asc"), { tier: "global" }),
    db.all(app.remoteCalls.where({ ownerId }).orderBy("expiresAt", "asc"), { tier: "global" }),
    db.all(app.workerSessions.where({ ownerId }).orderBy("startedAt", "asc"), { tier: "global" }),
    db.all(app.devices.where({ ownerId }).orderBy("lastSeenAt", "asc"), { tier: "global" }),
  ]);

  const observedAt = new Date();
  const runningJobs = jobs.filter((job) => job.status === "running");
  const queuedJobs = jobs.filter((job) => job.status === "queued");
  const nonTerminalCalls = calls.filter((call) => !terminalRemoteCallStatuses.has(call.status));
  const activeWorkerSessions = sessions.filter(
    (session) => session.status === "active" && session.expiresAt > observedAt,
  );
  const onlineDevices = devices.filter(
    (device) => device.status === "online" && device.revokedAt === undefined,
  );

  const drained = runningJobs.length === 0 && nonTerminalCalls.length === 0;
  const report = {
    observedAt: observedAt.toISOString(),
    ownerId,
    drained,
    counts: {
      queuedJobs: queuedJobs.length,
      runningJobs: runningJobs.length,
      nonTerminalRemoteCalls: nonTerminalCalls.length,
      activeWorkerSessions: activeWorkerSessions.length,
      onlineDevices: onlineDevices.length,
    },
    blockers: {
      runningJobs: runningJobs.map((job) => ({
        id: job.id,
        status: job.status,
        claimedBySessionId: job.claimedBySessionId ?? null,
        claimedAt: job.claimedAt?.toISOString() ?? null,
      })),
      nonTerminalRemoteCalls: nonTerminalCalls.map((call) => ({
        id: call.id,
        status: call.status,
        deviceId: call.deviceId,
        claimedAt: call.claimedAt?.toISOString() ?? null,
        expiresAt: call.expiresAt.toISOString(),
      })),
    },
    observations: {
      queuedJobs: queuedJobs.map((job) => ({ id: job.id, status: job.status })),
      activeWorkerSessions: activeWorkerSessions.map((session) => ({
        id: session.id,
        status: session.status,
        expiresAt: session.expiresAt.toISOString(),
      })),
      onlineDevices: onlineDevices.map((device) => ({
        id: device.id,
        stableId: device.stableId,
        status: device.status,
        lastSeenAt: device.lastSeenAt.toISOString(),
      })),
    },
    precondition:
      "Run only after public admission has been frozen. This probe is read-only and does not prove ingress is frozen or processes are stopped.",
  };

  console.log(JSON.stringify(report, null, 2));
  if (!drained) process.exitCode = 2;
});
