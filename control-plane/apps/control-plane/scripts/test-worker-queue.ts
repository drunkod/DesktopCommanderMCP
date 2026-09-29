import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploy, startLocalJazzServer } from "jazz-tools/testing";

const backendDataDir = await mkdtemp(join(tmpdir(), "remote-mcp-worker-queue-"));
const server = await startLocalJazzServer({ inMemory: true, allowLocalFirstAuth: true });
Object.assign(process.env, {
  NODE_ENV: "development",
  APP_ORIGIN: "http://127.0.0.1:3000",
  REMOTE_MCP_RESOURCE: "http://127.0.0.1:3000/mcp",
  BETTER_AUTH_SECRET: "worker-queue-test-secret-32-bytes-minimum",
  BETTER_AUTH_DB_PATH: ":memory:",
  JAZZ_APP_ID: server.appId,
  JAZZ_SERVER_URL: server.url,
  JAZZ_INTERNAL_SERVER_URL: server.url,
  JAZZ_BACKEND_DATA_PATH: join(backendDataDir, "runtime.db"),
  JAZZ_ADMIN_SECRET: server.adminSecret,
  JAZZ_BACKEND_SECRET: server.backendSecret,
  JAZZ_JWKS_URL: "http://127.0.0.1:9/jwks",
  JAZZ_TOKEN_PRIVATE_JWK_B64: "e30",
  JAZZ_TOKEN_PUBLIC_JWK_B64: "e30",
});

try {
  const [{ app }, { default: permissions }] = await Promise.all([
    import("../schema"),
    import("../permissions"),
  ]);
  await deploy({
    appId: server.appId,
    serverUrl: server.url,
    adminSecret: server.adminSecret,
    schema: app,
    permissions,
  });

  const queue = await import("../lib/worker-queue");
  const { jazzBackendDb } = await import("../lib/jazz-principal");
  const db = jazzBackendDb();

  const owner = "worker-test-owner";

  const session = await queue.openWorkerSession(owner);
  assert.equal(session.status, "active");
  assert.ok(queue.remainingSeconds(session) <= 1500);
  assert.ok(queue.remainingSeconds(session) > 1490);

  const first = await queue.enqueueWorkerTask(owner, "What is 2 + 2?", "task-key-0001");
  const duplicate = await queue.enqueueWorkerTask(owner, "What is 2 + 2?", "task-key-0001");
  assert.equal(duplicate.id, first.id);

  const claimed = await queue.claimNextWorkerTask(owner, session.id);
  assert.ok(claimed);
  assert.equal(claimed.id, first.id);
  assert.equal(claimed.status, "running");
  const completed = await queue.completeWorkerTask(owner, session.id, first.id, "4");
  assert.equal(completed.status, "completed");
  assert.equal(completed.answer, "4");
  const completedRetry = await queue.completeWorkerTask(owner, session.id, first.id, "4");
  assert.equal(completedRetry.answer, "4");
  await assert.rejects(
    () => queue.completeWorkerTask(owner, session.id, first.id, "5"),
    /terminal payload conflict/,
  );

  const second = await queue.enqueueWorkerTask(owner, "Name the capital of France.", "task-key-0002");
  const claimedSecond = await queue.claimNextWorkerTask(owner, session.id);
  assert.equal(claimedSecond?.id, second.id);
  const failed = await queue.failWorkerTask(owner, session.id, second.id, "fixture failure");
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "fixture failure");
  const failedRetry = await queue.failWorkerTask(owner, session.id, second.id, "fixture failure");
  assert.equal(failedRetry.error, "fixture failure");
  await assert.rejects(
    () => queue.failWorkerTask(owner, session.id, second.id, "different failure"),
    /terminal payload conflict/,
  );

  const third = await queue.enqueueWorkerTask(owner, "Recover me after a worker stops.", "task-key-0003");
  const claimedThird = await queue.claimNextWorkerTask(owner, session.id);
  assert.equal(claimedThird?.id, third.id);

  const status = await queue.getWorkerSessionStatus(owner, session.id);
  assert.deepEqual(status.counts, { queued: 0, running: 1, completed: 1, failed: 1 });

  const closed = await queue.closeWorkerSession(owner, session.id);
  assert.equal(closed.status, "closed");
  await assert.rejects(
    () => queue.claimNextWorkerTask(owner, session.id),
    /closed/,
  );

  const successor = await queue.openWorkerSession(owner);
  const recovered = await queue.claimNextWorkerTask(owner, successor.id);
  assert.equal(recovered?.id, third.id);
  assert.equal(recovered?.status, "running");
  await queue.completeWorkerTask(owner, successor.id, third.id, "Recovered successfully");
  const finalStatus = await queue.getWorkerSessionStatus(owner, successor.id);
  assert.deepEqual(finalStatus.counts, { queued: 0, running: 0, completed: 2, failed: 1 });

  const replayOwner = "worker-claim-replay-owner";
  const replaySession = await queue.openWorkerSession(replayOwner);
  const replayTask = await queue.enqueueWorkerTask(replayOwner, "Concurrent duplicate claim", "claim-replay-0001");
  const [replayA, replayB] = await Promise.all([
    queue.claimWorkerTask(replayOwner, replaySession.id, replayTask.id),
    queue.claimWorkerTask(replayOwner, replaySession.id, replayTask.id),
  ]);
  assert.equal(replayA.id, replayTask.id);
  assert.equal(replayB.id, replayTask.id);
  assert.equal(replayA.claimedBySessionId, replaySession.id);
  assert.equal(replayB.claimedAt?.toISOString(), replayA.claimedAt?.toISOString());

  const raceOwner = "worker-claim-race-owner";
  const raceSessionA = await queue.openWorkerSession(raceOwner);
  const raceSessionB = await queue.openWorkerSession(raceOwner);
  const raceTask = await queue.enqueueWorkerTask(raceOwner, "Only one worker may claim me", "claim-race-0001");
  const raceResults = await Promise.allSettled([
    queue.claimWorkerTask(raceOwner, raceSessionA.id, raceTask.id),
    queue.claimWorkerTask(raceOwner, raceSessionB.id, raceTask.id),
  ]);
  assert.equal(raceResults.filter((result) => result.status === "fulfilled").length, 1);
  const raceLoser = raceResults.find((result) => result.status === "rejected");
  assert.ok(raceLoser && raceLoser.status === "rejected");
  assert.match(String(raceLoser.reason), /return to wait_for_task|no longer available/i);
  const raceStored = await db.one(app.chatJobs.where({ id: raceTask.id }), { tier: "global" });
  assert.equal(raceStored?.status, "running");
  assert.ok([raceSessionA.id, raceSessionB.id].includes(raceStored!.claimedBySessionId!));

  const ownerA = "worker-owner-a";
  const ownerB = "worker-owner-b";
  const ownerASession = await queue.openWorkerSession(ownerA);
  const ownerBSession = await queue.openWorkerSession(ownerB);
  const ownerATask = await queue.enqueueWorkerTask(ownerA, "Owner A only", "owner-a-task-0001");
  await assert.rejects(() => queue.claimWorkerTask(ownerB, ownerBSession.id, ownerATask.id), /Task not found/);
  await assert.rejects(() => queue.claimWorkerTask(ownerA, ownerBSession.id, ownerATask.id), /Worker session not found/);

  const closedOwner = "worker-closed-claim-owner";
  const closedSession = await queue.openWorkerSession(closedOwner);
  const closedTask = await queue.enqueueWorkerTask(closedOwner, "Remain queued after close", "closed-claim-0001");
  await queue.closeWorkerSession(closedOwner, closedSession.id);
  await assert.rejects(() => queue.claimWorkerTask(closedOwner, closedSession.id, closedTask.id), /closed/);
  const closedStored = await db.one(app.chatJobs.where({ id: closedTask.id }), { tier: "global" });
  assert.equal(closedStored?.status, "queued");

  const closeRaceOwner = "worker-close-race-owner";
  const closeRaceSession = await queue.openWorkerSession(closeRaceOwner);
  const closeRaceTask = await queue.enqueueWorkerTask(closeRaceOwner, "Claim versus close race", "close-race-0001");
  const [closeRaceClaim, closeRaceClose] = await Promise.allSettled([
    queue.claimWorkerTask(closeRaceOwner, closeRaceSession.id, closeRaceTask.id),
    queue.closeWorkerSession(closeRaceOwner, closeRaceSession.id),
  ]);
  assert.equal(closeRaceClose.status, "fulfilled");
  const closeRaceStored = await db.one(app.chatJobs.where({ id: closeRaceTask.id }), { tier: "global" });
  if (closeRaceClaim.status === "rejected") {
    assert.match(String(closeRaceClaim.reason), /closed|return to wait_for_task|no longer available/i);
    assert.equal(closeRaceStored?.status, "queued");
  } else {
    assert.equal(closeRaceStored?.status, "running");
    assert.equal(closeRaceStored?.claimedBySessionId, closeRaceSession.id);
  }

  const expiryOwner = "worker-deadline-race-owner";
  const expirySession = await queue.openWorkerSession(expiryOwner);
  const expiryTask = await queue.enqueueWorkerTask(expiryOwner, "Do not claim after deadline", "deadline-race-0001");
  let clockReads = 0;
  const forcedDeadlineClock = () => {
    clockReads += 1;
    return clockReads === 1 ? expirySession.expiresAt.getTime() - 1 : expirySession.expiresAt.getTime() + 1;
  };
  await assert.rejects(
    () => queue.claimWorkerTask(expiryOwner, expirySession.id, expiryTask.id, forcedDeadlineClock),
    queue.WorkerSessionExpiredError,
  );
  const expiryStoredTask = await db.one(app.chatJobs.where({ id: expiryTask.id }), { tier: "global" });
  const expiryStoredSession = await db.one(app.workerSessions.where({ id: expirySession.id }), { tier: "global" });
  assert.equal(expiryStoredTask?.status, "queued");
  assert.equal(expiryStoredTask?.claimedBySessionId, null);
  assert.equal(expiryStoredSession?.status, "expired");

  console.log("worker queue integration: ok");
} finally {
  try {
    await globalThis.__remoteMcpJazzContext?.shutdown();
    globalThis.__remoteMcpJazzContext = undefined;
  } finally {
    await server.stop();
    await rm(backendDataDir, { recursive: true, force: true });
  }
}
