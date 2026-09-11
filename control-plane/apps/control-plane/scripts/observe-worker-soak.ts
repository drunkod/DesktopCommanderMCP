import { mkdir, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { WorkerSession } from "../schema";
import { runWorkerCli } from "./worker-cli";

const POLL_MS = 1_000;
const SAMPLE_MS = 30_000;
const DISCOVERY_TIMEOUT_MS = 30 * 60 * 1_000;

const fixtures = [
  { offsetSeconds: 0, prompt: "Acceptance minute 0: calculate 17 × 9 and submit just the number.", expected: "153" },
  { offsetSeconds: 6 * 60, prompt: "Acceptance minute 6: calculate 19 × 7 and submit just the number.", expected: "133" },
  { offsetSeconds: 15 * 60, prompt: "Acceptance minute 15: calculate 144 ÷ 12 and submit just the number.", expected: "12" },
  { offsetSeconds: 24 * 60, prompt: "Acceptance minute 24: calculate 23 + 19 and submit just the number.", expected: "42" },
] as const;

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const startedAfter = new Date();
const defaultEvidence = resolve(process.cwd(), "../../.data/acceptance", `chatgpt-worker-soak-${Date.now()}.jsonl`);
const evidencePath = process.env.WORKER_SOAK_EVIDENCE_PATH?.trim() || defaultEvidence;

await mkdir(dirname(evidencePath), { recursive: true });
async function record(type: string, data: Record<string, unknown>) {
  const event = { type, observedAt: new Date().toISOString(), ...data };
  await appendFile(evidencePath, `${JSON.stringify(event)}\n`, "utf8");
  console.log(JSON.stringify(event));
}

await runWorkerCli(async () => {
  const [{ app }, { jazzBackendDb }, queue, inspection] = await Promise.all([
    import("../schema"),
    import("../lib/jazz-principal"),
    import("../lib/worker-queue"),
    import("../lib/worker-inspection"),
  ]);
  const db = jazzBackendDb();
  const baseline = new Set(
    (await db.all(app.workerSessions.where({ status: "active" }), { tier: "global" }))
      .map((session) => session.id),
  );
  await record("observer_started", {
    startedAfter: startedAfter.toISOString(),
    baselineActiveSessionIds: [...baseline],
    evidencePath,
  });
  let session: WorkerSession | undefined;
  const discoveryDeadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  while (!session && Date.now() < discoveryDeadline) {
    const candidates = await db.all(
      app.workerSessions.where({ status: "active" }).orderBy("startedAt", "desc").limit(20),
      { tier: "global" },
    );
    session = candidates.find((candidate) =>
      !baseline.has(candidate.id) && candidate.startedAt >= startedAfter,
    );
    if (!session) await sleep(POLL_MS);
  }
  if (!session) throw new Error("No new active worker session appeared within 30 minutes");

  const ownerId = session.ownerId;
  const sessionId = session.id;
  await record("session_detected", {
    sessionId,
    ownerId,
    startedAt: session.startedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    windowSeconds: (session.expiresAt.getTime() - session.startedAt.getTime()) / 1000,
  });

  const jobs = new Map<number, string>();
  let nextSampleAt = Date.now();
  const stopAt = session.expiresAt.getTime() + 10_000;
  while (Date.now() < stopAt) {
    const elapsedSeconds = Math.floor((Date.now() - session.startedAt.getTime()) / 1000);
    for (const fixture of fixtures) {
      if (jobs.has(fixture.offsetSeconds) || elapsedSeconds < fixture.offsetSeconds) continue;
      const idempotencyKey = `chatgpt-soak:${sessionId}:${fixture.offsetSeconds}`;
      const job = await queue.enqueueWorkerTask(ownerId, fixture.prompt, idempotencyKey);
      jobs.set(fixture.offsetSeconds, job.id);
      await record("fixture_enqueued", {
        sessionId, taskId: job.id, offsetSeconds: fixture.offsetSeconds, expected: fixture.expected,
      });
    }

    if (Date.now() >= nextSampleAt) {
      const snapshot = await inspection.inspectWorkerSession(sessionId, ownerId);
      await record("session_sample", {
        sessionId,
        effectiveStatus: snapshot.workerSession.effectiveStatus,
        remainingSeconds: snapshot.workerSession.remainingSeconds,
        lastSeenAt: snapshot.workerSession.lastSeenAt,
        heartbeatAgeSeconds: snapshot.workerSession.heartbeatAgeSeconds,
        assignedTaskCounts: snapshot.assignedTaskCounts,
      });
      nextSampleAt += SAMPLE_MS;
    }
    await sleep(POLL_MS);
  }
  const finalSnapshot = await inspection.inspectWorkerSession(sessionId, ownerId);
  const results = [];
  for (const fixture of fixtures) {
    const taskId = jobs.get(fixture.offsetSeconds);
    const row = taskId
      ? await db.one(app.chatJobs.where({ id: taskId }), { tier: "global" })
      : null;
    results.push({
      offsetSeconds: fixture.offsetSeconds,
      taskId: taskId ?? null,
      status: row?.status ?? "not-enqueued",
      expected: fixture.expected,
      actual: row?.answer ?? null,
      answerMatches: row?.answer === fixture.expected,
      claimedAt: row?.claimedAt?.toISOString() ?? null,
      completedAt: row?.completedAt?.toISOString() ?? null,
    });
  }
  await record("observer_finished", {
    sessionId,
    effectiveStatus: finalSnapshot.workerSession.effectiveStatus,
    remainingSeconds: finalSnapshot.workerSession.remainingSeconds,
    lastSeenAt: finalSnapshot.workerSession.lastSeenAt,
    heartbeatAgeSeconds: finalSnapshot.workerSession.heartbeatAgeSeconds,
    results,
  });
  console.log(`Evidence: ${evidencePath}`);
});
