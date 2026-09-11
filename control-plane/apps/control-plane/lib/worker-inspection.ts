import { app } from "../schema";
import { jazzBackendDb } from "./jazz-principal";

/** Trusted operator read: unlike MCP status, this must never heartbeat a worker. */
export async function inspectWorkerSession(sessionId: string, expectedOwnerId?: string) {
  const db = jazzBackendDb();
  const session = await db.one(app.workerSessions.where({ id: sessionId }), { tier: "global" });
  if (!session || (expectedOwnerId !== undefined && session.ownerId !== expectedOwnerId)) {
    throw new Error("Worker session not found");
  }
  const jobs = await db.all(
    app.chatJobs.where({ ownerId: session.ownerId, claimedBySessionId: session.id }).orderBy("createdAt", "asc"),
    { tier: "global" },
  );
  const observedAt = new Date();
  const counts = { running: 0, completed: 0, failed: 0 };
  for (const job of jobs) {
    if (job.status === "running" || job.status === "completed" || job.status === "failed") {
      counts[job.status] += 1;
    }
  }
  return {
    observedAt: observedAt.toISOString(),
    workerSession: {
      id: session.id,
      ownerId: session.ownerId,
      storedStatus: session.status,
      effectiveStatus: session.status === "active" && session.expiresAt <= observedAt ? "expired" : session.status,
      startedAt: session.startedAt.toISOString(),
      lastSeenAt: session.lastSeenAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      closedAt: session.closedAt?.toISOString() ?? null,
      windowSeconds: (session.expiresAt.getTime() - session.startedAt.getTime()) / 1000,
      remainingSeconds: session.status === "active"
        ? Math.max(0, Math.ceil((session.expiresAt.getTime() - observedAt.getTime()) / 1000))
        : 0,
      heartbeatAgeSeconds: Math.max(0, Math.floor((observedAt.getTime() - session.lastSeenAt.getTime()) / 1000)),
    },
    assignedTaskCounts: counts,
    tasks: jobs.map((job) => ({
      id: job.id,
      status: job.status,
      claimedAt: job.claimedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
      answerRecorded: job.answer !== undefined,
      errorRecorded: job.error !== undefined,
    })),
    evidenceLimit: "Read-only snapshot, not proof of continuous polling or ChatGPT identity. Correlate with the ChatGPT tool transcript; reassigned tasks are not included.",
  };
}
