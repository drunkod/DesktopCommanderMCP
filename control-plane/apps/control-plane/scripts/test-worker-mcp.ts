import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { deploy, startLocalJazzServer } from "jazz-tools/testing";

const backendDataDir = await mkdtemp(join(tmpdir(), "remote-mcp-worker-mcp-"));
const server = await startLocalJazzServer({ inMemory: true, allowLocalFirstAuth: true });
Object.assign(process.env, {
  NODE_ENV: "development",
  APP_ORIGIN: "http://127.0.0.1:3000",
  REMOTE_MCP_RESOURCE: "http://127.0.0.1:3000/mcp",
  BETTER_AUTH_SECRET: "worker-mcp-test-secret-32-bytes-minimum",
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

const protocolVersion = "2026-07-28";
const clientMeta = {
  "io.modelcontextprotocol/protocolVersion": protocolVersion,
  "io.modelcontextprotocol/clientInfo": { name: "worker-mcp-test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
async function rpc(
  handler: ReturnType<typeof createMcpHandler>,
  id: number,
  method: string,
  params: Record<string, unknown>,
  name?: string,
): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": protocolVersion,
    "Mcp-Method": method,
  };
  if (name) headers["Mcp-Name"] = name;
  const response = await handler.fetch(new Request("http://127.0.0.1:3000/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: { ...params, _meta: clientMeta },
    }),
  }));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}
let handler: ReturnType<typeof createMcpHandler> | undefined;
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

  const { buildServer } = await import("../lib/mcp-server");
  const owner = "worker-mcp-owner";
  handler = createMcpHandler(() => buildServer(owner), {
    legacy: "reject",
    responseMode: "json",
  });

  const listed = await rpc(handler, 1, "tools/list", {});
  const tools = listed.result?.tools ?? [];
  const names = tools.map((tool: { name: string }) => tool.name);
  for (const name of [
    "open_task_worker_session",
    "enqueue_task",
    "wait_for_task",
    "claim_task",
    "next_task",
    "save_task_result",
    "submit_task_answer",
  ]) assert.ok(names.includes(name), `missing MCP tool ${name}`);

  const annotationsFor = (name: string) => tools.find((tool: { name: string }) => tool.name === name)?.annotations;
  assert.deepEqual(annotationsFor("wait_for_task"), {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(annotationsFor("claim_task"), {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(annotationsFor("next_task"), {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  });
  assert.deepEqual(annotationsFor("save_task_result"), {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(annotationsFor("submit_task_answer"), {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(annotationsFor("fail_task"), {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(annotationsFor("close_task_worker_session"), {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  const { jazzBackendDb } = await import("../lib/jazz-principal");
  const { closeWorkerSession, enqueueWorkerTask, openWorkerSession } = await import("../lib/worker-queue");
  const db = jazzBackendDb();

  let id = 2;
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const body = await rpc(handler!, id++, "tools/call", { name, arguments: args }, name);
    assert.equal(body.error, undefined, JSON.stringify(body));
    assert.ok(body.result, JSON.stringify(body));
    return body.result as {
      isError?: boolean;
      structuredContent?: Record<string, any>;
      content?: Array<{ type: string; text?: string }>;
    };
  };

  const queued = await callTool("enqueue_task", {
    prompt: "MCP transport smoke: answer exactly MCP_QUEUE_OK",
    idempotencyKey: "mcp-worker-smoke-0001",
  });
  assert.equal(queued.isError, undefined);
  const taskId = queued.structuredContent?.task?.id;
  assert.equal(typeof taskId, "string");

  const opened = await callTool("open_task_worker_session", {});
  const sessionId = opened.structuredContent?.workerSession?.id;
  assert.equal(typeof sessionId, "string");
  assert.ok(opened.structuredContent?.workerSession?.remainingSeconds <= 1500);
  assert.ok(opened.structuredContent?.workerSession?.remainingSeconds > 1490);
  const beforeAvailableSession = await db.one(app.workerSessions.where({ id: sessionId }), { tier: "global" });
  const beforeAvailableTask = await db.one(app.chatJobs.where({ id: taskId }), { tier: "global" });
  const available = await callTool("wait_for_task", { sessionId, waitSeconds: 0 });
  assert.equal(available.structuredContent?.state, "available");
  assert.equal(available.structuredContent?.taskId, taskId);
  const afterAvailableSession = await db.one(app.workerSessions.where({ id: sessionId }), { tier: "global" });
  const afterAvailableTask = await db.one(app.chatJobs.where({ id: taskId }), { tier: "global" });
  assert.equal(afterAvailableSession?.lastSeenAt.toISOString(), beforeAvailableSession?.lastSeenAt.toISOString());
  assert.equal(afterAvailableTask?.status, "queued");
  assert.equal(afterAvailableTask?.claimedBySessionId, beforeAvailableTask?.claimedBySessionId);
  assert.equal(afterAvailableTask?.updatedAt.toISOString(), beforeAvailableTask?.updatedAt.toISOString());

  const claimed = await callTool("claim_task", { sessionId, taskId });
  assert.equal(claimed.structuredContent?.state, "task");
  assert.equal(claimed.structuredContent?.task?.id, taskId);

  const completed = await callTool("save_task_result", {
    sessionId,
    taskId,
    result: "MCP_QUEUE_OK",
  });
  assert.equal(completed.structuredContent?.state, "completed");
  const compatibilityRetry = await callTool("submit_task_answer", {
    sessionId,
    taskId,
    answer: "MCP_QUEUE_OK",
  });
  assert.equal(compatibilityRetry.structuredContent?.state, "completed");

  const beforeLongPoll = await db.one(app.workerSessions.where({ id: sessionId }), { tier: "global" });
  const delayedTaskPromise = new Promise<any>((resolve, reject) => {
    setTimeout(() => {
      enqueueWorkerTask(owner, "Arrive during a read-only long poll", "mcp-long-poll-0001").then(resolve, reject);
    }, 150);
  });
  const waited = await callTool("wait_for_task", { sessionId, waitSeconds: 1 });
  const delayedTask = await delayedTaskPromise;
  assert.equal(waited.structuredContent?.state, "available");
  assert.equal(waited.structuredContent?.taskId, delayedTask.id);
  const afterLongPoll = await db.one(app.workerSessions.where({ id: sessionId }), { tier: "global" });
  assert.equal(afterLongPoll?.lastSeenAt.toISOString(), beforeLongPoll?.lastSeenAt.toISOString());

  const delayedClaim = await callTool("claim_task", { sessionId, taskId: delayedTask.id });
  assert.equal(delayedClaim.structuredContent?.state, "task");
  const delayedCompleted = await callTool("save_task_result", {
    sessionId,
    taskId: delayedTask.id,
    result: "LONG_POLL_OK",
  });
  assert.equal(delayedCompleted.structuredContent?.state, "completed");

  const status = await callTool("task_worker_status", { sessionId });
  assert.deepEqual(status.structuredContent?.queue, {
    queued: 0,
    running: 0,
    completed: 2,
    failed: 0,
  });

  const beforeIdle = await db.one(app.workerSessions.where({ id: sessionId }), { tier: "global" });
  const idle = await callTool("wait_for_task", { sessionId, waitSeconds: 0 });
  assert.equal(idle.structuredContent?.state, "idle");
  const afterIdle = await db.one(app.workerSessions.where({ id: sessionId }), { tier: "global" });
  assert.equal(afterIdle?.lastSeenAt.toISOString(), beforeIdle?.lastSeenAt.toISOString(), "read-only wait must not heartbeat");

  const expirySession = await openWorkerSession(owner);
  const expiryAt = new Date(Date.now() + 250);
  const expiryWrite = await db.transaction(async (tx) => {
    tx.update(app.workerSessions, expirySession.id, { expiresAt: expiryAt });
    return true;
  });
  await expiryWrite.wait({ tier: "global" });
  const expiryBefore = await db.one(app.workerSessions.where({ id: expirySession.id }), { tier: "global" });
  const expiryWait = await callTool("wait_for_task", { sessionId: expirySession.id, waitSeconds: 1 });
  assert.equal(expiryWait.isError, true);
  assert.match(expiryWait.content?.[0]?.text ?? "", /25-minute worker session has expired/);
  const expiryAfter = await db.one(app.workerSessions.where({ id: expirySession.id }), { tier: "global" });
  assert.equal(expiryAfter?.status, "active", "read-only expiry observation must not persist status");
  assert.equal(expiryAfter?.lastSeenAt.toISOString(), expiryBefore?.lastSeenAt.toISOString());

  const closeWaitSession = await openWorkerSession(owner);
  const closeDuringWait = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      closeWorkerSession(owner, closeWaitSession.id).then(() => resolve(), reject);
    }, 150);
  });
  const closeWait = await callTool("wait_for_task", { sessionId: closeWaitSession.id, waitSeconds: 1 });
  await closeDuringWait;
  assert.equal(closeWait.isError, true);
  assert.match(closeWait.content?.[0]?.text ?? "", /worker session is closed/i);
  const closeWaitStored = await db.one(app.workerSessions.where({ id: closeWaitSession.id }), { tier: "global" });
  assert.equal(closeWaitStored?.status, "closed");

  const closed = await callTool("close_task_worker_session", { sessionId });
  assert.equal(closed.structuredContent?.state, "closed");
  console.log("worker MCP transport integration: ok");
} finally {
  try {
    await handler?.close();
  } finally {
    try {
      await globalThis.__remoteMcpJazzContext?.shutdown();
      globalThis.__remoteMcpJazzContext = undefined;
    } finally {
      await server.stop();
      await rm(backendDataDir, { recursive: true, force: true });
    }
  }
}