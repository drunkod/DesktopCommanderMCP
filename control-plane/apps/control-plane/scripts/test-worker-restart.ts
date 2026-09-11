import assert from "node:assert/strict";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deploy, startLocalJazzServer } from "jazz-tools/testing";

const owner = "worker-restart-owner";
const prompt = "Retain this task across authority and backend restarts.";
const requestId = "worker-restart-task-0001";
const answer = "RESTART_QUEUE_OK";
const mode = process.argv[2];

async function clientPhase() {
  const [{ jazzContext }, { jazzBackendDb }, { app }, queue] = await Promise.all([
    import("../lib/jazz-context"),
    import("../lib/jazz-principal"),
    import("../schema"),
    import("../lib/worker-queue"),
  ]);
  try {
    if (mode === "enqueue") {
      const job = await queue.enqueueWorkerTask(owner, prompt, requestId);
      assert.equal(job.status, "queued");
      process.send?.({ taskId: job.id });
    } else {
      const rows = await jazzBackendDb().all(app.chatJobs.where({ ownerId: owner }), { tier: "global" });
      assert.equal(rows.length, 1, `${mode}: cold backend must see the persisted task`);
      const job = rows[0]!;
      assert.equal(job.id, process.env.RESTART_TASK_ID);
      assert.equal(job.prompt, prompt);
      if (mode === "complete") {
        assert.equal(job.status, "queued");
        const duplicate = await queue.enqueueWorkerTask(owner, prompt, requestId);
        assert.equal(duplicate.id, job.id, "idempotency must survive restart");
        const session = await queue.openWorkerSession(owner);
        const { inspectWorkerSession } = await import("../lib/worker-inspection");
        const active = await inspectWorkerSession(session.id, owner);
        assert.equal(active.workerSession.effectiveStatus, "active");
        assert.equal(active.workerSession.lastSeenAt, session.lastSeenAt.toISOString());
        assert.ok(active.workerSession.remainingSeconds > 0);
        const unchanged = await jazzBackendDb().one(app.workerSessions.where({ id: session.id }), { tier: "global" });
        assert.deepEqual(unchanged, session, "active inspection must not heartbeat the worker");
        assert.equal((await queue.claimNextWorkerTask(owner, session.id))?.id, job.id);
        await queue.completeWorkerTask(owner, session.id, job.id, answer);
        await queue.closeWorkerSession(owner, session.id);
      } else {
        assert.equal(job.status, "completed");
        assert.equal(job.answer, answer);
        const sessions = await jazzBackendDb().all(app.workerSessions.where({ ownerId: owner }), { tier: "global" });
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0]!.status, "closed");
        const { inspectWorkerSession } = await import("../lib/worker-inspection");
        const before = sessions[0]!;
        const snapshot = await inspectWorkerSession(before.id, owner);
        assert.equal(snapshot.workerSession.lastSeenAt, before.lastSeenAt.toISOString());
        assert.equal(snapshot.workerSession.windowSeconds, 1500);
        assert.equal(snapshot.workerSession.effectiveStatus, "closed");
        assert.equal(snapshot.workerSession.remainingSeconds, 0);
        assert.deepEqual(snapshot.assignedTaskCounts, { running: 0, completed: 1, failed: 0 });
        assert.equal(snapshot.tasks[0]?.answerRecorded, true);
        await assert.rejects(() => inspectWorkerSession(before.id, "wrong-owner"), /not found/);
        await assert.rejects(() => inspectWorkerSession(randomUUID()), /not found/);
        const { stdout } = await promisify(execFile)(process.execPath, [
          "--import", "tsx", fileURLToPath(new URL("./inspect-worker-session.ts", import.meta.url)), before.id,
        ], { env: { ...process.env, WORKER_TASK_OWNER_ID: owner }, timeout: 30_000 });
        const cliSnapshot = JSON.parse(stdout);
        assert.equal(cliSnapshot.workerSession.id, before.id);
        assert.equal(cliSnapshot.workerSession.lastSeenAt, snapshot.workerSession.lastSeenAt);
        assert.equal(cliSnapshot.workerSession.expiresAt, snapshot.workerSession.expiresAt);
        assert.deepEqual(cliSnapshot.tasks, snapshot.tasks);
        const after = await jazzBackendDb().one(app.workerSessions.where({ id: before.id }), { tier: "global" });
        assert.deepEqual(after, before, "inspection must not mutate the worker session");

        const startedAt = new Date(Date.now() - 1_501_000);
        const expired = jazzBackendDb().insert(app.workerSessions, {
          ownerId: "inspection-expired-owner", status: "active", startedAt,
          lastSeenAt: startedAt, expiresAt: new Date(startedAt.getTime() + 1_500_000),
        });
        await expired.wait({ tier: "global" });
        const expiredSnapshot = await inspectWorkerSession(expired.value.id);
        assert.equal(expiredSnapshot.workerSession.storedStatus, "active");
        assert.equal(expiredSnapshot.workerSession.effectiveStatus, "expired");
        assert.equal(expiredSnapshot.workerSession.remainingSeconds, 0);
        const storedExpired = await jazzBackendDb().one(app.workerSessions.where({ id: expired.value.id }), { tier: "global" });
        assert.deepEqual(storedExpired, expired.value, "inspection must not persist expiry");
      }
      process.send?.({ taskId: job.id });
    }
  } finally {
    await jazzContext().shutdown();
    globalThis.__remoteMcpJazzContext = undefined;
  }
  if (process.connected) process.disconnect();
  // The fork can retain tsx/NAPI handles after a clean shutdown. This point is
  // reached only when the phase assertions and cleanup completed successfully.
  process.exit(0);
}

async function authorityPhase() {
  const server = await startLocalJazzServer({
    appId: process.env.JAZZ_APP_ID,
    dataDir: process.env.JAZZ_DATA_DIR,
    adminSecret: process.env.JAZZ_ADMIN_SECRET,
    backendSecret: process.env.JAZZ_BACKEND_SECRET,
    allowLocalFirstAuth: false,
  });
  process.send?.({ url: server.url });
  process.once("message", () => void server.stop().then(() => process.disconnect()));
}

function child(phase: string, env: NodeJS.ProcessEnv) {
  const process = fork(fileURLToPath(import.meta.url), [phase], {
    execArgv: ["--import", "tsx"],
    env,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  // Cold-cache verification can itself launch a CLI with a 30s timeout. Leave
  // enough headroom for Jazz authority hydration on a busy development Mac.
  const timeout = setTimeout(() => process.kill("SIGKILL"), 90_000);
  const exited = once(process, "exit").then(([code, signal]) => {
    clearTimeout(timeout);
    assert.equal(code, 0, `${phase} exited with ${code ?? signal}`);
  });
  // Observe rejection immediately; callers still await the original promise.
  void exited.catch(() => undefined);
  return { process, exited };
}

async function main() {
  const temp = await mkdtemp(join(tmpdir(), "remote-mcp-worker-restart-"));
  const authorityDir = join(temp, "authority");
  await mkdir(authorityDir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    APP_ORIGIN: "http://127.0.0.1:3000",
    REMOTE_MCP_RESOURCE: "http://127.0.0.1:3000/mcp",
    BETTER_AUTH_SECRET: "worker-restart-test-secret-32-bytes-minimum",
    BETTER_AUTH_DB_PATH: ":memory:",
    JAZZ_APP_ID: randomUUID(),
    JAZZ_ADMIN_SECRET: "worker-restart-test-admin",
    JAZZ_BACKEND_SECRET: "worker-restart-test-backend",
    JAZZ_JWKS_URL: "http://127.0.0.1:9/jwks",
    JAZZ_TOKEN_PRIVATE_JWK_B64: "e30",
    JAZZ_TOKEN_PUBLIC_JWK_B64: "e30",
    JAZZ_DATA_DIR: authorityDir,
    JAZZ_BACKEND_DATA_PATH: join(temp, "backend", "runtime.db"),
  };
  let authority: ReturnType<typeof child> | undefined;
  const children = new Set<ChildProcess>();
  async function startAuthority() {
    authority = child("authority", env);
    children.add(authority.process);
    const [message] = await Promise.race([
      once(authority.process, "message"),
      authority.exited.then(() => { throw new Error("authority exited before ready"); }),
    ]);
    env.JAZZ_SERVER_URL = message.url;
    env.JAZZ_INTERNAL_SERVER_URL = message.url;
  }
  async function stopAuthority() {
    const current = authority;
    if (!current) return;
    if (current.process.connected) {
      await new Promise<void>((resolve, reject) => {
        current.process.send("stop", (error) => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_IPC_CHANNEL_CLOSED") {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
    await current.exited;
    children.delete(current.process);
    if (authority === current) authority = undefined;
  }
  async function phase(name: string, dataPath = env.JAZZ_BACKEND_DATA_PATH) {
    const client = child(name, { ...env, JAZZ_BACKEND_DATA_PATH: dataPath });
    children.add(client.process);
    let taskId: string | undefined;
    client.process.on("message", (message: { taskId: string }) => { taskId = message.taskId; });
    await client.exited;
    children.delete(client.process);
    assert.ok(taskId, `${name} produced no task ID`);
    env.RESTART_TASK_ID = taskId;
  }
  async function cli(script: string, args: string[] = []) {
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--import", "tsx", fileURLToPath(new URL(script, import.meta.url)), ...args,
    ], { env: { ...env, WORKER_TASK_OWNER_ID: "worker-cli-owner" }, timeout: 30_000 });
    return JSON.parse(stdout);
  }
  try {
    await startAuthority();
    Object.assign(process.env, env);
    const [{ app }, { default: permissions }] = await Promise.all([import("../schema"), import("../permissions")]);
    await deploy({
      appId: env.JAZZ_APP_ID!, serverUrl: env.JAZZ_SERVER_URL!,
      adminSecret: env.JAZZ_ADMIN_SECRET!, schema: app, permissions,
    });
    await phase("enqueue");
    const cliJob = await cli("./enqueue-worker-task.ts", ["CLI restart fixture"]);
    assert.equal(cliJob.status, "queued");
    await stopAuthority();
    await startAuthority();
    await phase("complete");
    await stopAuthority();
    await startAuthority();
    await phase("verify");
    // A separate CLI/instance must recover from the authority, not depend on
    // the writer's local cache or share its SQLite file.
    await phase("verify", join(temp, "fresh-reader.db"));
    const cliRows = await cli("./list-worker-tasks.ts");
    assert.equal(cliRows.length, 1);
    assert.equal(cliRows[0].id, cliJob.id);
    assert.equal(cliRows[0].status, "queued");
    assert.equal(cliRows[0].prompt, "CLI restart fixture");
    console.log("worker restart integration: ok (two authority restarts, fresh backend processes and cold cache)");
  } finally {
    if (authority) await stopAuthority().catch(() => undefined);
    for (const process of children) {
      if (process.exitCode === null && process.signalCode === null) {
        const exited = once(process, "exit");
        process.kill("SIGKILL");
        await exited;
      }
    }
    await rm(temp, { recursive: true, force: true });
  }
}

if (mode === "authority") await authorityPhase();
else if (mode) await clientPhase();
else await main();
