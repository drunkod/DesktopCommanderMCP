import crypto from "node:crypto";
import { app, type ChatJob, type WorkerSession } from "../schema";
import { deterministicUuid } from "./ids";
import { isTaskAdmissionFrozen, TaskAdmissionFrozenError } from "./cutover-mode";
import { jazzBackendDb } from "./jazz-principal";

export const WORKER_SESSION_MS = 25 * 60 * 1000;
const MAX_PROMPT_CHARS = 16_384;
const MAX_ANSWER_CHARS = 65_536;
const CLAIM_CANDIDATES = 20;
const CLAIM_TRANSACTION_RETRIES = 4;

export class WorkerSessionExpiredError extends Error {
  constructor() {
    super("Worker session expired");
    this.name = "WorkerSessionExpiredError";
  }
}

export class WorkerTaskUnavailableError extends Error {
  constructor(message = "Task is no longer available to claim") {
    super(message);
    this.name = "WorkerTaskUnavailableError";
  }
}

export type WorkerQueueCounts = {
  queued: number;
  running: number;
  completed: number;
  failed: number;
};

export async function openWorkerSession(subject: string): Promise<WorkerSession> {
  if (isTaskAdmissionFrozen()) throw new TaskAdmissionFrozenError();
  await recoverStaleWorkerTasks(subject);
  const db = jazzBackendDb();
  const now = new Date();
  const write = db.insert(app.workerSessions, {
    ownerId: subject,
    status: "active",
    startedAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + WORKER_SESSION_MS),
  });
  await write.wait({ tier: "global" });
  return write.value;
}

export async function closeWorkerSession(
  subject: string,
  sessionId: string,
): Promise<WorkerSession> {
  const db = jazzBackendDb();
  const result = await db.transaction(async (tx) => {
    const session = await tx.one(app.workerSessions.where({ id: sessionId }), { tier: "global" });
    if (!session || session.ownerId !== subject) throw new Error("Worker session not found");
    if (session.status === "closed" || session.status === "expired") return session;
    const now = new Date();
    tx.update(app.workerSessions, session.id, {
      status: "closed",
      lastSeenAt: now,
      closedAt: now,
    });
    return { ...session, status: "closed", lastSeenAt: now, closedAt: now };
  });
  return await result.wait({ tier: "global" });
}

export async function enqueueWorkerTask(
  subject: string,
  promptInput: string,
  idempotencyKey?: string,
): Promise<ChatJob> {
  const prompt = validateText(promptInput, MAX_PROMPT_CHARS, "Task prompt");
  const db = jazzBackendDb();
  const fingerprint = sha256(prompt);
  const requestId = idempotencyKey ?? crypto.randomUUID();
  const rowId = idempotencyKey
    ? deterministicUuid("worker-task", `${subject}\0${idempotencyKey}`)
    : crypto.randomUUID();
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    // Read at the authority tier before sealing the transaction. On alpha.53,
    // a local/edge read can produce a batch rejected by the global authority.
    const existing = await tx.one(app.chatJobs.where({ id: rowId }), { tier: "global" });
    if (existing) {
      if (existing.ownerId !== subject || existing.requestFingerprint !== fingerprint) {
        throw new Error("Task idempotency key was reused with different content");
      }
      return existing;
    }
    if (isTaskAdmissionFrozen()) throw new TaskAdmissionFrozenError();
    return tx.insert(app.chatJobs, {
      ownerId: subject,
      requesterId: subject,
      source: "mvp",
      requestId,
      requestFingerprint: fingerprint,
      prompt,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    }, { id: rowId });
  });
  return await result.wait({ tier: "global" });
}

export async function claimNextWorkerTask(
  subject: string,
  sessionId: string,
): Promise<ChatJob | null> {
  if (isTaskAdmissionFrozen()) throw new TaskAdmissionFrozenError();
  const db = jazzBackendDb();
  const candidates = await db.all(
    app.chatJobs
      .where({ ownerId: subject, status: "queued" })
      .orderBy("createdAt", "asc")
      .limit(CLAIM_CANDIDATES),
    { tier: "global" },
  );

  for (const candidate of candidates) {
    try {
      const result = await db.transaction(async (tx) => {
        const session = await tx.one(app.workerSessions.where({ id: sessionId }), { tier: "global" });
        const sessionState = checkSession(subject, session);
        if (sessionState === "expired") {
          tx.update(app.workerSessions, session!.id, {
            status: "expired",
            lastSeenAt: new Date(),
          });
          return { kind: "expired" as const };
        }
        const current = await tx.one(app.chatJobs.where({ id: candidate.id }), { tier: "global" });
        if (!current || current.ownerId !== subject || current.status !== "queued") {
          return { kind: "skip" as const };
        }
        const now = new Date();
        tx.update(app.workerSessions, session!.id, { lastSeenAt: now });
        tx.update(app.chatJobs, current.id, {
          status: "running",
          claimedBySessionId: session!.id,
          claimedAt: now,
          updatedAt: now,
        });
        return {
          kind: "claimed" as const,
          job: {
            ...current,
            status: "running",
            claimedBySessionId: session!.id,
            claimedAt: now,
            updatedAt: now,
          },
        };
      });
      const outcome = await result.wait({ tier: "global" });
      if (outcome.kind === "expired") throw new WorkerSessionExpiredError();
      if (outcome.kind === "claimed") return outcome.job;
    } catch (error) {
      if (/transaction_conflict/i.test(String(error))) continue;
      throw error;
    }
  }
  await touchWorkerSession(subject, sessionId);
  return null;
}

export async function readWorkerSession(
  subject: string,
  sessionId: string,
): Promise<WorkerSession> {
  const session = await jazzBackendDb().one(
    app.workerSessions.where({ id: sessionId }),
    { tier: "global" },
  );
  if (checkSession(subject, session) === "expired") throw new WorkerSessionExpiredError();
  return session!;
}

export async function peekNextWorkerTask(
  subject: string,
  sessionId: string,
): Promise<ChatJob | null> {
  await readWorkerSession(subject, sessionId);
  const rows = await jazzBackendDb().all(
    app.chatJobs
      .where({ ownerId: subject, status: "queued" })
      .orderBy("createdAt", "asc")
      .limit(1),
    { tier: "global" },
  );
  return rows[0] ?? null;
}

export async function claimWorkerTask(
  subject: string,
  sessionId: string,
  taskId: string,
  nowMs: () => number = Date.now,
): Promise<ChatJob> {
  const db = jazzBackendDb();
  if (isTaskAdmissionFrozen()) {
    await readWorkerSession(subject, sessionId);
    const current = await db.one(app.chatJobs.where({ id: taskId }), { tier: "global" });
    if (current?.ownerId === subject
      && current.status === "running"
      && current.claimedBySessionId === sessionId) {
      return current;
    }
    throw new TaskAdmissionFrozenError();
  }

  for (let attempt = 0; attempt < CLAIM_TRANSACTION_RETRIES; attempt += 1) {
    try {
      const result = await db.transaction(async (tx) => {
        const session = await tx.one(app.workerSessions.where({ id: sessionId }), { tier: "global" });
        const sessionState = checkSession(subject, session, nowMs());
        if (sessionState === "expired") {
          const now = new Date(nowMs());
          tx.update(app.workerSessions, session!.id, { status: "expired", lastSeenAt: now });
          return { kind: "expired" as const, jobId: taskId };
        }

        const current = await tx.one(app.chatJobs.where({ id: taskId }), { tier: "global" });
        if (!current || current.ownerId !== subject) throw new Error("Task not found");

        // The task read may itself cross the fixed session deadline. Recheck time
        // immediately before staging any claim writes so an expired session never
        // intentionally transitions a queued task to running.
        const now = new Date(nowMs());
        if (session!.expiresAt.getTime() <= now.getTime()) {
          tx.update(app.workerSessions, session!.id, { status: "expired", lastSeenAt: now });
          return { kind: "expired" as const, jobId: current.id };
        }

        if (current.status === "running" && current.claimedBySessionId === sessionId) {
          return { kind: "claimed" as const, jobId: current.id };
        }
        if (current.status !== "queued") {
          return { kind: "unavailable" as const, jobId: current.id };
        }

        tx.update(app.workerSessions, session!.id, { lastSeenAt: now });
        tx.update(app.chatJobs, current.id, {
          status: "running",
          claimedBySessionId: session!.id,
          claimedAt: now,
          updatedAt: now,
        });
        return { kind: "claimed" as const, jobId: current.id };
      });

      const outcome = await result.wait({ tier: "global" });
      if (outcome.kind === "expired") throw new WorkerSessionExpiredError();
      if (outcome.kind === "unavailable") {
        throw new WorkerTaskUnavailableError("Task was claimed or completed elsewhere; return to wait_for_task");
      }

      const job = await db.one(app.chatJobs.where({ id: outcome.jobId }), { tier: "global" });
      if (!job || job.ownerId !== subject) {
        throw new Error("Claimed task is not visible after durable commit");
      }
      if (job.status !== "running" || job.claimedBySessionId !== sessionId) {
        throw new WorkerTaskUnavailableError("Another worker session won the durable claim; return to wait_for_task");
      }
      return job;
    } catch (error) {
      if (!/transaction_conflict/i.test(String(error))) throw error;
      if (attempt + 1 < CLAIM_TRANSACTION_RETRIES) continue;

      // Final reconciliation handles a duplicated transport retry that actually
      // committed in another attempt, while turning ordinary contention into an
      // actionable unavailable result instead of leaking a Jazz conflict.
      await readWorkerSession(subject, sessionId);
      const current = await db.one(app.chatJobs.where({ id: taskId }), { tier: "global" });
      if (!current || current.ownerId !== subject) throw new Error("Task not found");
      if (current.status === "running" && current.claimedBySessionId === sessionId) return current;
      throw new WorkerTaskUnavailableError("Task claim contention did not settle; return to wait_for_task");
    }
  }

  throw new WorkerTaskUnavailableError("Task claim contention did not settle; return to wait_for_task");
}

export async function completeWorkerTask(
  subject: string,
  sessionId: string,
  taskId: string,
  answerInput: string,
): Promise<ChatJob> {
  const answer = validateText(answerInput, MAX_ANSWER_CHARS, "Task answer");
  return settleWorkerTask(subject, sessionId, taskId, "completed", answer);
}

export async function failWorkerTask(
  subject: string,
  sessionId: string,
  taskId: string,
  errorInput: string,
): Promise<ChatJob> {
  const error = validateText(errorInput, 4_000, "Task error");
  return settleWorkerTask(subject, sessionId, taskId, "failed", error);
}

async function settleWorkerTask(
  subject: string,
  sessionId: string,
  taskId: string,
  terminal: "completed" | "failed",
  payload: string,
): Promise<ChatJob> {
  const db = jazzBackendDb();
  const result = await db.transaction(async (tx) => {
    const session = await tx.one(app.workerSessions.where({ id: sessionId }), { tier: "global" });
    const sessionState = checkSession(subject, session);
    if (sessionState === "expired") {
      tx.update(app.workerSessions, session!.id, {
        status: "expired",
        lastSeenAt: new Date(),
      });
      return { kind: "expired" as const };
    }
    const job = await tx.one(app.chatJobs.where({ id: taskId }), { tier: "global" });
    if (!job || job.ownerId !== subject) throw new Error("Task not found");
    if (job.status === terminal && job.claimedBySessionId === sessionId) {
      const samePayload = terminal === "completed"
        ? job.answer === payload
        : job.error === payload;
      if (!samePayload) {
        throw new Error("Task terminal payload conflict");
      }
      return { kind: "done" as const, jobId: job.id };
    }
    if (job.status !== "running" || job.claimedBySessionId !== sessionId) {
      throw new Error("Task is not claimed by this worker session");
    }
    const now = new Date();
    if (terminal === "completed") {
      tx.update(app.chatJobs, job.id, {
        status: terminal,
        answer: payload,
        error: undefined,
        completedAt: now,
        updatedAt: now,
      });
    } else {
      tx.update(app.chatJobs, job.id, {
        status: terminal,
        answer: undefined,
        error: payload,
        completedAt: now,
        updatedAt: now,
      });
    }
    tx.update(app.workerSessions, session!.id, { lastSeenAt: now });
    return { kind: "done" as const, jobId: job.id };
  });
  const outcome = await result.wait({ tier: "global" });
  if (outcome.kind === "expired") throw new WorkerSessionExpiredError();
  const job = await db.one(app.chatJobs.where({ id: outcome.jobId }), { tier: "global" });
  if (!job) throw new Error("Completed task is not visible after durable commit");
  return job;
}

export async function getWorkerSessionStatus(
  subject: string,
  sessionId: string,
): Promise<{ session: WorkerSession; remainingSeconds: number; counts: WorkerQueueCounts }> {
  const session = await touchWorkerSession(subject, sessionId);
  const counts = await getWorkerQueueCounts(subject);
  return {
    session,
    remainingSeconds: remainingSeconds(session),
    counts,
  };
}

export async function getWorkerQueueCounts(subject: string): Promise<WorkerQueueCounts> {
  const db = jazzBackendDb();
  const rows = await db.all(app.chatJobs.where({ ownerId: subject }), { tier: "global" });
  const counts: WorkerQueueCounts = { queued: 0, running: 0, completed: 0, failed: 0 };
  for (const row of rows) {
    if (row.status in counts) counts[row.status as keyof WorkerQueueCounts] += 1;
  }
  return counts;
}

async function touchWorkerSession(subject: string, sessionId: string): Promise<WorkerSession> {
  const db = jazzBackendDb();
  const result = await db.transaction(async (tx) => {
    const session = await tx.one(app.workerSessions.where({ id: sessionId }), { tier: "global" });
    const state = checkSession(subject, session);
    const now = new Date();
    if (state === "expired") {
      tx.update(app.workerSessions, session!.id, { status: "expired", lastSeenAt: now });
      return { kind: "expired" as const, session: { ...session!, status: "expired", lastSeenAt: now } };
    }
    tx.update(app.workerSessions, session!.id, { lastSeenAt: now });
    return { kind: "active" as const, session: { ...session!, lastSeenAt: now } };
  });
  const outcome = await result.wait({ tier: "global" });
  if (outcome.kind === "expired") throw new WorkerSessionExpiredError();
  return outcome.session;
}

function checkSession(
  subject: string,
  session: WorkerSession | null,
  nowMs: number = Date.now(),
): "active" | "expired" {
  if (!session || session.ownerId !== subject) throw new Error("Worker session not found");
  if (session.status === "closed") throw new Error("Worker session is closed");
  if (session.status === "expired" || session.expiresAt.getTime() <= nowMs) return "expired";
  if (session.status !== "active") throw new Error(`Unsupported worker session state: ${session.status}`);
  return "active";
}

export async function recoverStaleWorkerTasks(subject: string): Promise<number> {
  const db = jazzBackendDb();
  const running = await db.all(
    app.chatJobs.where({ ownerId: subject, status: "running" }).limit(100),
    { tier: "global" },
  );
  let recovered = 0;
  for (const candidate of running) {
    const claimedSessionId = candidate.claimedBySessionId;
    const session = claimedSessionId
      ? await db.one(app.workerSessions.where({ id: claimedSessionId }), { tier: "global" })
      : null;
    const stale = !session
      || session.ownerId !== subject
      || session.status !== "active"
      || session.expiresAt.getTime() <= Date.now();
    if (!stale) continue;

    try {
      const result = await db.transaction(async (tx) => {
        const current = await tx.one(app.chatJobs.where({ id: candidate.id }), { tier: "global" });
        if (!current || current.ownerId !== subject || current.status !== "running") return false;
        if (current.claimedBySessionId !== claimedSessionId) return false;
        const currentSession = claimedSessionId
          ? await tx.one(app.workerSessions.where({ id: claimedSessionId }), { tier: "global" })
          : null;
        const stillStale = !currentSession
          || currentSession.ownerId !== subject
          || currentSession.status !== "active"
          || currentSession.expiresAt.getTime() <= Date.now();
        if (!stillStale) return false;
        const now = new Date();
        if (currentSession?.status === "active" && currentSession.expiresAt.getTime() <= now.getTime()) {
          tx.update(app.workerSessions, currentSession.id, { status: "expired", lastSeenAt: now });
        }
        tx.update(app.chatJobs, current.id, {
          status: "queued",
          claimedBySessionId: undefined,
          claimedAt: undefined,
          updatedAt: now,
        });
        return true;
      });
      if (await result.wait({ tier: "global" })) recovered += 1;
    } catch (error) {
      if (!/transaction_conflict/i.test(String(error))) throw error;
    }
  }
  return recovered;
}

export function remainingSeconds(session: WorkerSession): number {
  return Math.max(0, Math.ceil((session.expiresAt.getTime() - Date.now()) / 1000));
}

function validateText(value: string, maxChars: number, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must not be empty`);
  if (trimmed.length > maxChars) throw new Error(`${label} is too long`);
  return trimmed;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
