import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deploy, startLocalJazzServer } from "jazz-tools/testing";
import { EffectAdmissionFrozenError, TaskAdmissionFrozenError } from "../lib/cutover-mode";

type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

function runScript(scriptName: string, env: NodeJS.ProcessEnv): Promise<CliResult> {
  const script = fileURLToPath(new URL(scriptName, import.meta.url));
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", script],
      {
        env,
        timeout: 15_000,
        killSignal: "SIGKILL",
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const candidate = error as (Error & { code?: number | string; killed?: boolean }) | null;
        const code = error === null
          ? 0
          : typeof candidate?.code === "number"
            ? candidate.code
            : candidate?.killed
              ? -1
              : 1;
        resolve({
          code,
          stdout: String(stdout),
          stderr: String(stderr),
          timedOut: Boolean(candidate?.killed),
        });
      },
    );
  });
}

function runCli(env: NodeJS.ProcessEnv): Promise<CliResult> {
  return runScript("./inspect-cutover-readiness.ts", env);
}

function runQuiesceCli(env: NodeJS.ProcessEnv): Promise<CliResult> {
  return runScript("./quiesce-worker-sessions.ts", env);
}

function parseReport(result: CliResult) {
  assert.equal(result.timedOut, false, "cutover readiness CLI timed out: " + result.stderr);
  assert.ok(result.stdout.trim(), "cutover readiness CLI produced no JSON: " + result.stderr);
  return JSON.parse(result.stdout);
}

const temp = await mkdtemp(join(tmpdir(), "remote-mcp-cutover-readiness-"));
const authorityDir = join(temp, "authority");
const deploymentRoot = join(temp, "deployment");
const freezeFile = join(deploymentRoot, ".data", "task-admission.frozen");
const effectFreezeFile = join(deploymentRoot, ".data", "effect-admission.frozen");
const backendPath = join(temp, "writer", "runtime.db");
const authPath = join(temp, "auth.sqlite");
await mkdir(authorityDir, { recursive: true });
await mkdir(join(deploymentRoot, ".data"), { recursive: true });
await mkdir(join(temp, "writer"), { recursive: true });

const server = await startLocalJazzServer({
  dataDir: authorityDir,
  allowLocalFirstAuth: true,
});

const owner = "cutover-owner";
{
  const authDb = new DatabaseSync(authPath);
  authDb.exec('CREATE TABLE "user" (id TEXT PRIMARY KEY)');
  authDb.prepare('INSERT INTO "user" (id) VALUES (?)').run(owner);
  authDb.close();
}
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "production",
  APP_ORIGIN: "http://127.0.0.1:3000",
  REMOTE_MCP_RESOURCE: "http://127.0.0.1:3000/mcp",
  REMOTE_MCP_ROOT: deploymentRoot,
  REMOTE_MCP_TASK_ADMISSION_FREEZE_FILE: freezeFile,
  REMOTE_MCP_EFFECT_ADMISSION_FREEZE_FILE: effectFreezeFile,
  BETTER_AUTH_SECRET: "cutover-readiness-test-secret-32-bytes",
  BETTER_AUTH_DB_PATH: authPath,
  JAZZ_APP_ID: server.appId,
  JAZZ_SERVER_URL: server.url,
  JAZZ_INTERNAL_SERVER_URL: server.url,
  JAZZ_BACKEND_DATA_PATH: backendPath,
  JAZZ_ADMIN_SECRET: server.adminSecret,
  JAZZ_BACKEND_SECRET: server.backendSecret,
  JAZZ_JWKS_URL: "http://127.0.0.1:9/jwks",
  JAZZ_TOKEN_PRIVATE_JWK_B64: "e30",
  JAZZ_TOKEN_PUBLIC_JWK_B64: "e30",
};

Object.assign(process.env, env);

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

  const [{ jazzBackendDb }, queue, { dispatchRemoteCall }] = await Promise.all([
    import("../lib/jazz-principal"),
    import("../lib/worker-queue"),
    import("../lib/call-router"),
  ]);
  const db = jazzBackendDb();

  const deviceWrite = db.insert(app.devices, {
    ownerId: owner,
    stableId: "cutover-device-stable",
    oauthClientId: "cutover-device-client",
    name: "Cutover Device",
    platform: "darwin",
    appVersion: "test",
    capabilities: { tools: [] },
    status: "online",
    lastSeenAt: new Date(),
    reconnectGeneration: 0,
  });
  await deviceWrite.wait({ tier: "global" });

  const remoteInput = {
    deviceId: deviceWrite.value.id,
    toolName: "fixture.remote",
    toolArgs: { value: 1 },
    timeoutMs: 20,
    idempotencyKey: "cutover-remote-call-0001",
  };
  await assert.rejects(
    () => dispatchRemoteCall(owner, remoteInput),
    /timed out/,
  );
  const callsBeforeFreeze = await db.all(app.remoteCalls.where({ ownerId: owner }), { tier: "global" });
  assert.equal(callsBeforeFreeze.length, 1);

  const runningTask = await queue.enqueueWorkerTask(owner, "Running task may finish after freeze", "cutover-running-0001");
  const queuedTask = await queue.enqueueWorkerTask(owner, "Existing queued task survives freeze", "cutover-existing-0001");
  const session = await queue.openWorkerSession(owner);
  const claimed = await queue.claimWorkerTask(owner, session.id, runningTask.id);
  assert.equal(claimed.status, "running");

  await writeFile(freezeFile, "frozen_at=test\n", { mode: 0o600 });

  await assert.rejects(
    () => dispatchRemoteCall(owner, {
      ...remoteInput,
      idempotencyKey: "cutover-remote-call-0002",
    }),
    /timed out/,
    "task admission freeze must not block device remote calls needed by running work",
  );
  const callsAfterFreeze = await db.all(app.remoteCalls.where({ ownerId: owner }), { tier: "global" });
  assert.equal(callsAfterFreeze.length, 2, "task admission freeze must leave device-call admission available");

  for (const call of callsAfterFreeze) {
    const cancelRemote = await db.transaction(async (tx) => {
      const current = await tx.one(app.remoteCalls.where({ id: call.id }), { tier: "global" });
      assert.ok(current);
      tx.update(app.remoteCalls, current.id, {
        status: "cancelled",
        completedAt: new Date(),
      });
      return current.id;
    });
    await cancelRemote.wait({ tier: "global" });
  }

  const claimRetry = await queue.claimWorkerTask(owner, session.id, runningTask.id);
  assert.equal(claimRetry.id, runningTask.id, "already-committed claim retry must remain available while frozen");
  await assert.rejects(
    () => queue.claimWorkerTask(owner, session.id, queuedTask.id),
    TaskAdmissionFrozenError,
  );
  await assert.rejects(
    () => queue.openWorkerSession(owner),
    TaskAdmissionFrozenError,
  );

  const prematureQuiesce = await runQuiesceCli({ ...env, CUTOVER_EXPECTED_OWNER_ID: owner });
  assert.equal(prematureQuiesce.code, 2, prematureQuiesce.stderr);
  assert.equal(prematureQuiesce.timedOut, false);
  assert.match(prematureQuiesce.stderr, /running worker jobs/i);

  const completed = await queue.completeWorkerTask(owner, session.id, runningTask.id, "completed during drain");
  assert.equal(completed.status, "completed", "already-running work must be able to save its result after freeze");

  const duplicate = await queue.enqueueWorkerTask(owner, "Existing queued task survives freeze", "cutover-existing-0001");
  assert.equal(duplicate.id, queuedTask.id, "idempotent retry must remain available while admission is frozen");
  await assert.rejects(
    () => queue.enqueueWorkerTask(owner, "New task must be blocked", "cutover-new-task-0001"),
    TaskAdmissionFrozenError,
  );

  const activeSession = await runCli({ ...env, CUTOVER_EXPECTED_OWNER_ID: owner });
  assert.equal(activeSession.code, 2, activeSession.stderr);
  const activeSessionReport = parseReport(activeSession);
  assert.equal(activeSessionReport.readyForIngressFreeze, false);
  assert.equal(activeSessionReport.counts.activeWorkerSessions, 1);

  const quiesced = await runQuiesceCli({ ...env, CUTOVER_EXPECTED_OWNER_ID: owner });
  assert.equal(quiesced.code, 0, quiesced.stderr);
  assert.equal(quiesced.timedOut, false);
  const storedQuiescedSession = await db.one(app.workerSessions.where({ id: session.id }), { tier: "global" });
  assert.equal(storedQuiescedSession?.status, "closed");

  const effectOpen = await runCli({ ...env, CUTOVER_EXPECTED_OWNER_ID: owner });
  assert.equal(effectOpen.code, 2, effectOpen.stderr);
  const effectOpenReport = parseReport(effectOpen);
  assert.equal(effectOpenReport.readyForIngressFreeze, false);
  assert.equal(effectOpenReport.blockers.effectAdmissionOpen, true);

  await writeFile(effectFreezeFile, "frozen_at=test\n", { mode: 0o600 });

  const existingEffectRetry = await dispatchRemoteCall(owner, remoteInput);
  assert.equal(existingEffectRetry.status, "cancelled", "existing idempotent effect receipt must remain readable while effect admission is frozen");
  await assert.rejects(
    () => dispatchRemoteCall(owner, {
      ...remoteInput,
      idempotencyKey: "cutover-remote-call-0003",
    }),
    EffectAdmissionFrozenError,
  );

  const ready = await runCli({ ...env, CUTOVER_EXPECTED_OWNER_ID: owner });
  assert.equal(ready.code, 0, ready.stderr);
  const readyReport = parseReport(ready);
  assert.equal(readyReport.readyForIngressFreeze, true);
  assert.equal(readyReport.deploymentIdentity.verified, true);
  assert.equal(readyReport.counts.queuedJobs, 1);

  const wrongOwner = await runCli({ ...env, CUTOVER_EXPECTED_OWNER_ID: "wrong-owner" });
  assert.equal(wrongOwner.code, 2, wrongOwner.stderr);
  const wrongOwnerReport = parseReport(wrongOwner);
  assert.equal(wrongOwnerReport.readyForIngressFreeze, false);
  assert.equal(wrongOwnerReport.deploymentIdentity.verified, false);

  const { summarizeCutoverReadiness } = await import("../lib/cutover-readiness");
  const emptyState = summarizeCutoverReadiness({
    expectedOwnerId: owner,
    expectedOwnerKnownToAuth: true,
    taskAdmissionFrozen: true,
    effectAdmissionFrozen: true,
    observedAt: new Date(),
    jobs: [],
    calls: [],
    sessions: [],
    devices: [],
  });
  assert.equal(emptyState.readyForIngressFreeze, false);
  assert.equal(emptyState.deploymentIdentity.expectedOwnerObservedInJazz, false);

  const historicalForeignOwner = summarizeCutoverReadiness({
    expectedOwnerId: owner,
    expectedOwnerKnownToAuth: true,
    taskAdmissionFrozen: true,
    effectAdmissionFrozen: true,
    observedAt: new Date(),
    jobs: [
      { id: "expected-history", ownerId: owner, status: "completed" },
      { id: "foreign-history", ownerId: "historical-probe-owner", status: "completed" },
    ],
    calls: [],
    sessions: [],
    devices: [],
  });
  assert.equal(historicalForeignOwner.readyForIngressFreeze, true);
  assert.deepEqual(historicalForeignOwner.deploymentIdentity.unexpectedActiveOwnerIds, []);

  await unlink(freezeFile);
  const admissionOpen = await runCli({ ...env, CUTOVER_EXPECTED_OWNER_ID: owner });
  assert.equal(admissionOpen.code, 2, admissionOpen.stderr);
  const admissionOpenReport = parseReport(admissionOpen);
  assert.equal(admissionOpenReport.readyForIngressFreeze, false);
  assert.equal(admissionOpenReport.blockers.taskAdmissionOpen, true);

  await writeFile(freezeFile, "frozen_at=test\n", { mode: 0o600 });
  const foreignDeviceWrite = db.insert(app.devices, {
    ownerId: "foreign-owner",
    stableId: "foreign-device-stable",
    oauthClientId: "foreign-device-client",
    name: "Foreign Device",
    platform: "darwin",
    appVersion: "test",
    capabilities: { tools: [] },
    status: "offline",
    lastSeenAt: new Date(),
    reconnectGeneration: 0,
  });
  await foreignDeviceWrite.wait({ tier: "global" });

  const multipleOwners = await runCli({ ...env, CUTOVER_EXPECTED_OWNER_ID: owner });
  assert.equal(multipleOwners.code, 2, multipleOwners.stderr);
  const multipleOwnersReport = parseReport(multipleOwners);
  assert.equal(multipleOwnersReport.deploymentIdentity.verified, true);
  assert.deepEqual(multipleOwnersReport.deploymentIdentity.observedOwnerIds, ["cutover-owner", "foreign-owner"]);
  assert.deepEqual(multipleOwnersReport.deploymentIdentity.unexpectedActiveOwnerIds, ["foreign-owner"]);

  console.log("cutover readiness integration: ok (ready/blocked exits terminate, wrong owner fails closed)");
} finally {
  try {
    await globalThis.__remoteMcpJazzContext?.shutdown();
    globalThis.__remoteMcpJazzContext = undefined;
  } finally {
    await server.stop();
    await rm(temp, { recursive: true, force: true });
  }
}
