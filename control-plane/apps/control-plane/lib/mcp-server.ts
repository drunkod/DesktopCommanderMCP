import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { app, type ChatJob, type WorkerSession } from "../schema";
import { jazzBackendDb } from "./jazz-principal";
import { jazzAuthorityDb } from "./jazz-authority";
import { dispatchRemoteCall } from "./call-router";
import { requestReconnect } from "./device-admin";
import { TaskAdmissionFrozenError } from "./cutover-mode";
import {
  WorkerSessionExpiredError,
  WorkerTaskUnavailableError,
  claimNextWorkerTask,
  claimWorkerTask,
  closeWorkerSession,
  completeWorkerTask,
  enqueueWorkerTask,
  failWorkerTask,
  getWorkerQueueCounts,
  getWorkerSessionStatus,
  openWorkerSession,
  peekNextWorkerTask,
  readWorkerSession,
  remainingSeconds,
} from "./worker-queue";

const deviceInput = z.object({
  deviceId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(200).optional(),
});

const workerSessionInput = z.object({ sessionId: z.string().min(1).max(200) });

const closedWorldRead = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const closedWorldWrite = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const closedWorldIdempotentWrite = {
  ...closedWorldWrite,
  idempotentHint: true,
} as const;

const closedWorldTerminalWrite = {
  ...closedWorldIdempotentWrite,
  destructiveHint: true,
} as const;

function asToolResult(call: Awaited<ReturnType<typeof dispatchRemoteCall>>) {
  if (call.status !== "completed") {
    return {
      isError: true,
      content: [{ type: "text" as const, text: call.error ?? `Call ended as ${call.status}` }],
    };
  }
  const text = typeof call.result === "string" ? call.result : JSON.stringify(call.result, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function sessionView(session: WorkerSession) {
  return {
    id: session.id,
    status: session.status,
    startedAt: session.startedAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    remainingSeconds: remainingSeconds(session),
  };
}

function jobView(job: ChatJob) {
  return {
    id: job.id,
    prompt: job.prompt,
    status: job.status,
    source: job.source,
    createdAt: job.createdAt.toISOString(),
  };
}

function jsonToolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function errorToolResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

export function buildServer(subject: string): McpServer {
  const server = new McpServer(
    { name: "remote-desktop-jazz", version: "0.2.0-mvp-worker" },
    {
      instructions:
        "MVP queue worker: when asked to run the worker, call open_task_worker_session once, then repeatedly call wait_for_task. " +
        "When wait_for_task reports a task, call claim_task for that task ID, solve it, call save_task_result, then immediately return to wait_for_task. " +
        "save_task_result only stores the result in the caller's private Jazz queue; submit_task_answer remains a compatibility alias. " +
        "wait_for_task is the preferred read-only polling path; next_task remains only as a compatibility claim-and-poll tool. " +
        "Continue only while the client keeps making tool calls and the 25-minute session remains active. " +
        "The server does not guarantee autonomous background execution after the model stops calling tools.",
    },
  );  server.registerTool("open_task_worker_session", {
    description: "Start a fixed 25-minute MVP queue-worker window. The deadline never extends.",
    inputSchema: z.object({}),
    annotations: closedWorldWrite,
  }, async () => {
    try {
      const session = await openWorkerSession(subject);
      return jsonToolResult({
        workerSession: sessionView(session),
        next: "Call wait_for_task repeatedly. When a task is available, claim it with claim_task, solve it, then record it with submit_task_answer.",
      });
    } catch (error) {
      if (error instanceof TaskAdmissionFrozenError) {
        return errorToolResult("New worker sessions are temporarily frozen for a controlled cutover.");
      }
      throw error;
    }
  });

  server.registerTool("enqueue_task", {
    description: "MVP/testing queue producer. Enqueue one standalone task into Jazz. Later /chat will call the same queue service instead.",
    inputSchema: z.object({
      prompt: z.string().min(1).max(16_384),
      idempotencyKey: z.string().min(8).max(200).optional(),
    }),
    annotations: closedWorldWrite,
  }, async ({ prompt, idempotencyKey }) => {
    try {
      const job = await enqueueWorkerTask(subject, prompt, idempotencyKey);
      return jsonToolResult({ task: jobView(job) });
    } catch (error) {
      if (error instanceof TaskAdmissionFrozenError) {
        return errorToolResult("Task admission is temporarily frozen for a controlled cutover.");
      }
      throw error;
    }
  });

  server.registerTool("wait_for_task", {
    description: "Read-only long poll for the oldest queued task ID. Does not claim tasks or update the worker heartbeat.",
    inputSchema: workerSessionInput.extend({ waitSeconds: z.number().int().min(0).max(10).default(8) }),
    annotations: closedWorldRead,
  }, async ({ sessionId, waitSeconds }) => {
    const deadline = Date.now() + waitSeconds * 1000;
    try {
      for (;;) {
        const job = await peekNextWorkerTask(subject, sessionId);
        const session = await readWorkerSession(subject, sessionId);
        if (job) {
          return jsonToolResult({
            state: "available",
            taskId: job.id,
            createdAt: job.createdAt.toISOString(),
            remainingSeconds: remainingSeconds(session),
            next: "Call claim_task with this taskId before reasoning about or answering the task.",
          });
        }
        if (Date.now() >= deadline) {
          return jsonToolResult({
            state: "idle",
            remainingSeconds: remainingSeconds(session),
            queue: await getWorkerQueueCounts(subject),
            next: "Call wait_for_task again while the worker session is active.",
          });
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(1, deadline - Date.now()))));
      }
    } catch (error) {
      if (error instanceof WorkerSessionExpiredError) return errorToolResult("The 25-minute worker session has expired.");
      if (/Worker session is closed/i.test(String(error))) return errorToolResult("The worker session is closed.");
      throw error;
    }
  });

  server.registerTool("claim_task", {
    description: "Claim one task previously reported by wait_for_task and return its prompt. Retries are idempotent only while that same task remains running under this active session; if another session wins, resume wait_for_task.",
    inputSchema: workerSessionInput.extend({ taskId: z.string().min(1).max(200) }),
    annotations: closedWorldIdempotentWrite,
  }, async ({ sessionId, taskId }) => {
    try {
      const job = await claimWorkerTask(subject, sessionId, taskId);
      const session = await jazzBackendDb().one(
        app.workerSessions.where({ id: sessionId }),
        { tier: "global" },
      );
      return jsonToolResult({
        state: "task",
        task: jobView(job),
        remainingSeconds: session ? remainingSeconds(session) : 0,
        next: "Solve this task, call save_task_result, then return to wait_for_task.",
      });
    } catch (error) {
      if (error instanceof TaskAdmissionFrozenError) return errorToolResult("New task claims are temporarily frozen for a controlled cutover.");
      if (error instanceof WorkerSessionExpiredError) return errorToolResult("The 25-minute worker session has expired.");
      if (error instanceof WorkerTaskUnavailableError) {
        return jsonToolResult({
          state: "unavailable",
          taskId,
          next: "Return to wait_for_task; another worker session may have claimed or completed this task.",
        });
      }
      throw error;
    }
  });

  server.registerTool("next_task", {
    description: "Compatibility tool: claim-and-poll with heartbeat writes. Prefer read-only wait_for_task plus claim_task for long-running workers.",
    inputSchema: workerSessionInput.extend({ waitSeconds: z.number().int().min(0).max(10).default(8) }),
    annotations: closedWorldWrite,
  }, async ({ sessionId, waitSeconds }) => {
    const deadline = Date.now() + waitSeconds * 1000;
    try {
      for (;;) {
        const job = await claimNextWorkerTask(subject, sessionId);
        if (job) {
          const status = await getWorkerSessionStatus(subject, sessionId);
          return jsonToolResult({
            state: "task",
            task: jobView(job),
            remainingSeconds: status.remainingSeconds,
            next: "Solve this task, call submit_task_answer, then call next_task again.",
          });
        }
        const status = await getWorkerSessionStatus(subject, sessionId);
        if (Date.now() >= deadline) {
          return jsonToolResult({
            state: "idle",
            remainingSeconds: status.remainingSeconds,
            queue: status.counts,
            next: status.remainingSeconds > 0 ? "Call next_task again." : "Worker session ended.",
          });
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(1, deadline - Date.now()))));
      }
    } catch (error) {
      if (error instanceof TaskAdmissionFrozenError) return errorToolResult("New task claims are temporarily frozen for a controlled cutover.");
      if (error instanceof WorkerSessionExpiredError) return errorToolResult("The 25-minute worker session has expired.");
      throw error;
    }
  });

  server.registerTool("save_task_result", {
    description: "Store the model result in the caller's private Jazz queue row already claimed by this worker session. This only updates internal queue state; it does not contact devices, files, messages, payments, accounts, or external services. Safe to retry with the same result while the task remains assigned to this active session.",
    inputSchema: workerSessionInput.extend({
      taskId: z.string().min(1).max(200),
      result: z.string().min(1).max(65_536),
    }),
    annotations: closedWorldIdempotentWrite,
  }, async ({ sessionId, taskId, result }) => {
    try {
      const job = await completeWorkerTask(subject, sessionId, taskId, result);
      return jsonToolResult({
        state: "completed",
        taskId: job.id,
        completedAt: job.completedAt?.toISOString() ?? null,
        next: "Call wait_for_task again while the worker session is active.",
      });
    } catch (error) {
      if (error instanceof WorkerSessionExpiredError) return errorToolResult("The 25-minute worker session expired before the result was stored.");
      throw error;
    }
  });

  server.registerTool("submit_task_answer", {
    description: "Compatibility alias for save_task_result. Record the answer for the claimed task in the caller's private Jazz queue.",
    inputSchema: workerSessionInput.extend({
      taskId: z.string().min(1).max(200),
      answer: z.string().min(1).max(65_536),
    }),
    annotations: closedWorldIdempotentWrite,
  }, async ({ sessionId, taskId, answer }) => {
    try {
      const job = await completeWorkerTask(subject, sessionId, taskId, answer);
      return jsonToolResult({
        state: "completed",
        taskId: job.id,
        completedAt: job.completedAt?.toISOString() ?? null,
        next: "Call wait_for_task again while the worker session is active.",
      });
    } catch (error) {
      if (error instanceof WorkerSessionExpiredError) return errorToolResult("The 25-minute worker session expired before the answer was recorded.");
      throw error;
    }
  });

  server.registerTool("fail_task", {
    description: "Record that a claimed task could not be solved during this MVP worker session.",
    inputSchema: workerSessionInput.extend({
      taskId: z.string().min(1).max(200),
      error: z.string().min(1).max(4_000),
    }),
    annotations: closedWorldTerminalWrite,
  }, async ({ sessionId, taskId, error }) => {
    try {
      const job = await failWorkerTask(subject, sessionId, taskId, error);
      return jsonToolResult({
        state: "failed",
        taskId: job.id,
        completedAt: job.completedAt?.toISOString() ?? null,
        next: "Call wait_for_task again while the worker session is active.",
      });
    } catch (caught) {
      if (caught instanceof WorkerSessionExpiredError) return errorToolResult("The 25-minute worker session expired before the failure was recorded.");
      throw caught;
    }
  });

  server.registerTool("task_worker_status", {
    description: "Return remaining worker time and queue counts. Heartbeats never extend the fixed 25-minute deadline.",
    inputSchema: workerSessionInput,
    annotations: closedWorldIdempotentWrite,
  }, async ({ sessionId }) => {
    try {
      const status = await getWorkerSessionStatus(subject, sessionId);
      return jsonToolResult({
        workerSession: sessionView(status.session),
        queue: status.counts,
      });
    } catch (error) {
      if (error instanceof WorkerSessionExpiredError) return errorToolResult("The 25-minute worker session has expired.");
      throw error;
    }
  });

  server.registerTool("close_task_worker_session", {
    description: "Close the MVP queue-worker session before its 25-minute deadline.",
    inputSchema: workerSessionInput,
    annotations: closedWorldIdempotentWrite,
  }, async ({ sessionId }) => {
    const session = await closeWorkerSession(subject, sessionId);
    return jsonToolResult({ workerSession: sessionView(session), state: "closed" });
  });

  server.registerTool("list_devices", {
    description: "List the caller's paired Desktop Commander devices.",
    inputSchema: z.object({}),
  }, async () => {
    const db = await jazzAuthorityDb();
    const rows = await db.all(app.devices.where({ ownerId: subject }), { tier: "global" });
    const devices = rows.map((row) => ({
      id: row.id,
      stableId: row.stableId,
      name: row.name,
      status: row.status,
      lastSeenAt: row.lastSeenAt,
      revoked: Boolean(row.revokedAt),
      capabilities: row.capabilities,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(devices, null, 2) }],
      structuredContent: { devices },
    };
  });  server.registerTool("ping_device", {
    description: "Ping one paired device through the durable Jazz call path.",
    inputSchema: deviceInput,
  }, async ({ deviceId, idempotencyKey }) => asToolResult(await dispatchRemoteCall(subject, {
    deviceId,
    toolName: "__control.ping",
    toolArgs: {},
    timeoutMs: 15_000,
    idempotencyKey,
  })));

  server.registerTool("reconnect_device", {
    description: "Rebuild device connectivity and return only after the device is online again.",
    inputSchema: deviceInput,
  }, async ({ deviceId, idempotencyKey }) => {
    try {
      return asToolResult(await requestReconnect(subject, deviceId, idempotencyKey));
    } catch (error) {
      return errorToolResult(error instanceof Error ? error.message : String(error));
    }
  });

  server.registerTool("shutdown_device", {
    description: "Gracefully stop a device after its result is globally durable.",
    inputSchema: deviceInput,
  }, async ({ deviceId, idempotencyKey }) => asToolResult(await dispatchRemoteCall(subject, {
    deviceId,
    toolName: "__control.shutdown",
    toolArgs: {},
    timeoutMs: 30_000,
    idempotencyKey,
  })));  server.registerTool("call_device_tool", {
    description: "Run any non-control Desktop Commander tool on a paired device.",
    inputSchema: z.object({
      deviceId: z.string().min(1),
      toolName: z.string().min(1),
      toolArgs: z.record(z.string(), z.unknown()).default({}),
      metadata: z.record(z.string(), z.unknown()).default({}),
      idempotencyKey: z.string().min(8).max(200).optional(),
    }),
  }, async ({ deviceId, toolName, toolArgs, metadata, idempotencyKey }) => {
    if (toolName.startsWith("__control.")) {
      return {
        isError: true,
        content: [{ type: "text", text: "Use a dedicated device-control tool." }],
      };
    }
    const call = await dispatchRemoteCall(subject, {
      deviceId,
      toolName,
      toolArgs,
      metadata,
      idempotencyKey,
    });
    return asToolResult(call);
  });

  return server;
}
