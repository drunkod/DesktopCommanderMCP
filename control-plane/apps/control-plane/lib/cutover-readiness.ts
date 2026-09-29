const TERMINAL_REMOTE_CALL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "indeterminate",
]);

type OwnedRow = { ownerId: string };
type JobRow = OwnedRow & {
  id: string;
  status: string;
  claimedBySessionId?: string | null;
  claimedAt?: Date | null;
};
type CallRow = OwnedRow & {
  id: string;
  status: string;
  deviceId: string;
  claimedAt?: Date | null;
  expiresAt: Date;
};
type SessionRow = OwnedRow & {
  id: string;
  status: string;
  expiresAt: Date;
};
type DeviceRow = OwnedRow & {
  id: string;
  stableId: string;
  status: string;
  lastSeenAt: Date;
  revokedAt?: Date | null;
};

export type CutoverReadinessInput = {
  expectedOwnerId: string;
  expectedOwnerKnownToAuth: boolean;
  taskAdmissionFrozen: boolean;
  effectAdmissionFrozen: boolean;
  observedAt: Date;
  jobs: JobRow[];
  calls: CallRow[];
  sessions: SessionRow[];
  devices: DeviceRow[];
};

export function summarizeCutoverReadiness(input: CutoverReadinessInput) {
  const ownerIds = new Set<string>();
  for (const row of [...input.jobs, ...input.calls, ...input.sessions, ...input.devices]) {
    ownerIds.add(row.ownerId);
  }
  const observedOwnerIds = [...ownerIds].sort();
  const expectedOwnerObservedInJazz = ownerIds.has(input.expectedOwnerId);
  const identityVerified = input.expectedOwnerKnownToAuth && expectedOwnerObservedInJazz;

  const runningJobs = input.jobs.filter((job) => job.status === "running");
  const queuedJobs = input.jobs.filter((job) => job.status === "queued");
  const nonTerminalCalls = input.calls.filter(
    (call) => !TERMINAL_REMOTE_CALL_STATUSES.has(call.status),
  );
  const activeWorkerSessions = input.sessions.filter(
    (session) => session.status === "active" && session.expiresAt > input.observedAt,
  );
  const onlineDevices = input.devices.filter(
    (device) => device.status === "online" && !device.revokedAt,
  );
  const nonRevokedDevices = input.devices.filter((device) => !device.revokedAt);
  const activeOwnerIds = [...new Set([
    ...queuedJobs,
    ...runningJobs,
    ...nonTerminalCalls,
    ...activeWorkerSessions,
    ...nonRevokedDevices,
  ].map((row) => row.ownerId))].sort();
  const unexpectedActiveOwnerIds = activeOwnerIds.filter(
    (ownerId) => ownerId !== input.expectedOwnerId,
  );

  const readyForIngressFreeze = input.taskAdmissionFrozen
    && input.effectAdmissionFrozen
    && identityVerified
    && unexpectedActiveOwnerIds.length === 0
    && runningJobs.length === 0
    && nonTerminalCalls.length === 0
    && activeWorkerSessions.length === 0;

  return {
    observedAt: input.observedAt.toISOString(),
    readyForIngressFreeze,
    deploymentIdentity: {
      expectedOwnerId: input.expectedOwnerId,
      expectedOwnerKnownToAuth: input.expectedOwnerKnownToAuth,
      expectedOwnerObservedInJazz,
      observedOwnerIds,
      activeOwnerIds,
      unexpectedActiveOwnerIds,
      verified: identityVerified,
    },
    taskAdmission: input.taskAdmissionFrozen ? "frozen" : "open",
    effectAdmission: input.effectAdmissionFrozen ? "frozen" : "open",
    counts: {
      queuedJobs: queuedJobs.length,
      runningJobs: runningJobs.length,
      nonTerminalRemoteCalls: nonTerminalCalls.length,
      activeWorkerSessions: activeWorkerSessions.length,
      onlineDevices: onlineDevices.length,
    },
    blockers: {
      taskAdmissionOpen: !input.taskAdmissionFrozen,
      effectAdmissionOpen: !input.effectAdmissionFrozen,
      deploymentIdentityUnverified: !identityVerified,
      unexpectedActiveOwnerIds,
      runningJobs: runningJobs.map((job) => ({
        id: job.id,
        ownerId: job.ownerId,
        status: job.status,
        claimedBySessionId: job.claimedBySessionId ?? null,
        claimedAt: job.claimedAt?.toISOString() ?? null,
      })),
      nonTerminalRemoteCalls: nonTerminalCalls.map((call) => ({
        id: call.id,
        ownerId: call.ownerId,
        status: call.status,
        deviceId: call.deviceId,
        claimedAt: call.claimedAt?.toISOString() ?? null,
        expiresAt: call.expiresAt.toISOString(),
      })),
      activeWorkerSessions: activeWorkerSessions.map((session) => ({
        id: session.id,
        ownerId: session.ownerId,
        status: session.status,
        expiresAt: session.expiresAt.toISOString(),
      })),
    },
    observations: {
      queuedJobs: queuedJobs.map((job) => ({
        id: job.id,
        ownerId: job.ownerId,
        status: job.status,
      })),
      onlineDevices: onlineDevices.map((device) => ({
        id: device.id,
        ownerId: device.ownerId,
        stableId: device.stableId,
        status: device.status,
        lastSeenAt: device.lastSeenAt.toISOString(),
      })),
    },
  };
}
