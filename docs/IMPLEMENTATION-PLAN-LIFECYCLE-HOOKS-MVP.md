# DesktopCommanderMCP lifecycle hooks: detailed MVP implementation plan

## Goal

Implement a minimal, low-risk lifecycle layer that can answer four questions for almost every Desktop Commander operation:

1. When did work start?
2. What tool/file/process is currently active?
3. When should we checkpoint and warn as the observed ~25-minute web execution window approaches?
4. Why did work stop: success, tool error, MCP cancellation, local MCP loss, remote transport degradation, or process shutdown?

The first implementation should be intentionally narrow:

> **Add one lifecycle manager and wrap the central `CallToolRequestSchema` handler.**

This gives tool start/end, elapsed-time monitoring, durable state, model-visible warnings, and MCP protocol cancellation from one place. Do not add timers to every tool.

> **Reviewed/hardened on 2026-09-02.** The implemented MVP now serializes persistence, uses unique atomic temp files, rehydrates `current.json`, persists one-shot notice state, records request IDs, handles already-aborted or absent direct-test `AbortSignal` metadata, ignores `isError: true` results when counting successful completions, and awaits cancellation persistence before the wrapped handler exits. `src/utils/work-lifecycle.ts` and `docs/LIFECYCLE-HOOKS-MVP-EXERCISES.md` are the copy-ready source of truth.

## Repository state verified for this plan

Working tree examined:

```text
/Users/test/Documents/RemoteMCP-Jazz/repositories/DesktopCommanderMCP
branch: feat/jazz-remote-device
HEAD: 2f8d2fd4b40e5f0afa0fa9df54ad83765233d159
```

The draft research report is useful for the server/process design, but its Supabase `TIMED_OUT/CLOSED/CHANNEL_ERROR` transport section is stale for this branch. The current remote path is Jazz-backed and uses `DeviceHeartbeat`, `ReconnectSupervisor`, `db.subscribeAll`, and control-plane HTTP completion.
## Codegraph and Graphify findings

`codegraph status` reports 215 indexed files, 3,131 nodes, and 8,875 edges. The central dispatch path is:

```text
server.setRequestHandler(CallToolRequestSchema)
  -> handleCallToolRequest(request)
  -> trackToolCall(name, args)
  -> switch(name)
  -> handlers.handleStartProcess / handleReadFile / handleEditBlock / ...
  -> toolHistory.addCall(...)
  -> usageTracker.trackSuccess/trackFailure
  -> result post-processing
  -> return ServerResult
```

Current on-disk insertion points:

```text
src/server.ts:1251  central CallToolRequestSchema handler
src/server.ts:1266  handleCallToolRequest
src/server.ts:1322  existing trackToolCall hook
src/server.ts:1327  central tool switch
src/server.ts:1539  tool-history persistence
src/server.ts:1665  normal result return
src/server.ts:1680  finally telemetry hook
```

Graphify confirms `handleCallToolRequest()` is the architectural hub connecting the filesystem, terminal, edit/search, config, history, and process handler communities. That makes it the correct MVP hook point.
## Existing lifecycle signals we should reuse

### MCP request cancellation

The installed `@modelcontextprotocol/sdk` is `^1.9.0`. Its `RequestHandlerExtra` type already exposes:

```ts
signal: AbortSignal;
sessionId?: string;
requestId: RequestId;
taskId?: string;
```

The current handler only accepts `request`, so the MVP should change it to `(request, extra)` and observe `extra.signal`.

### Terminal lifecycle

`src/terminal-manager.ts` already distinguishes:

```text
executeCommand() spawn                line 256
session registered                    line 303
timeout fallback                      lines 450-459
actual child process exit             lines 461-488
forceTerminate()                      line 757
```

The timeout fallback only stops waiting for the initial tool call; it does **not** prove the OS process ended. The lifecycle record must preserve that distinction.

### Current Jazz remote lifecycle

The current branch no longer has Supabase channel-status callbacks. Relevant signals are now:

```text
RemoteChannel heartbeat unhealthy     remote-channel.ts:81-84
ReconnectSupervisor state             remote-channel.ts:87-94
Jazz auth expiry/refresh failure      remote-channel.ts:154-160
Jazz pending-call subscription        remote-channel.ts:180-208
remote call claim                     remote-channel.ts:212-216
remote call completion                remote-channel.ts:218-244
RemoteChannel shutdown                remote-channel.ts:276-293
local stdio close/error               desktop-commander-integration.ts:102-104
```

## MVP architecture

The MVP should add only two production-code changes:

```text
NEW  src/utils/work-lifecycle.ts
EDIT src/server.ts
```

And one focused test:

```text
NEW  test/test-work-lifecycle.js
```

Everything else is Phase 2 or later.

The lifecycle clock starts on the first non-UI `tools/call` while no active work window exists. It is **not** tied to Node process uptime or Jazz connection uptime.

Recommended default thresholds:

```text
00:00  work:start
20:00  checkpoint warning
23:00  warning: finish current atomic operation
24:00  critical warning: checkpoint now
25:00  defensive budget expired; persist interruption state, do not kill child processes
```

Treat 25 minutes as a configurable operational budget derived from observed behavior, not a protocol guarantee.

Recommended environment variables for the MVP:

```bash
DC_WORK_BUDGET_MINUTES=25
DC_WORK_CHECKPOINT_MINUTES=20
DC_WORK_WARNING_MINUTES=23
DC_WORK_CRITICAL_MINUTES=24
```

Do not add these to `ConfigManager` in the first patch. Environment-only thresholds keep the first diff small and avoid UI/config-schema work.
## MVP code: `src/utils/work-lifecycle.ts`

This version is deliberately small. It persists one current state file, tracks request IDs, and exposes a one-shot notice that `src/server.ts` can append to the next tool result.

```ts
import { mkdir, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MINUTE = 60_000;

export type WorkStatus = 'running' | 'interrupted' | 'completed';
export type InterruptionReason =
  | 'mcp_cancelled'
  | 'budget_expired'
  | 'server_shutdown'
  | 'transport_lost'
  | 'unknown';

export interface WorkState {
  id: string;
  status: WorkStatus;
  startedAt: number;
  lastActivityAt: number;
  deadlineAt: number;
  lastTool?: string;
  lastPath?: string;
  lastRequestId?: string;
  completedOperations: number;
  interruptionReason?: InterruptionReason;
  interruptionDetail?: string;
}
```

```ts
export interface WorkActivity {
  tool: string;
  path?: string;
  requestId?: string | number;
}

export class WorkLifecycleManager {
  private state?: WorkState;
  private pendingNotice?: string;
  private timer?: NodeJS.Timeout;
  private readonly stateDir = path.join(
    os.homedir(),
    '.claude-server-commander',
    'work-state',
  );

  private readonly budgetMs = Number(
    process.env.DC_WORK_BUDGET_MINUTES ?? 25,
  ) * MINUTE;
  private readonly checkpointMs = Number(
    process.env.DC_WORK_CHECKPOINT_MINUTES ?? 20,
  ) * MINUTE;
  private readonly warningMs = Number(
    process.env.DC_WORK_WARNING_MINUTES ?? 23,
  ) * MINUTE;
  private readonly criticalMs = Number(
    process.env.DC_WORK_CRITICAL_MINUTES ?? 24,
  ) * MINUTE;

  startOrTouch(activity: WorkActivity): WorkState {
    if (!this.state || this.state.status !== 'running') {
      const now = Date.now();
      this.state = {
        id: `work-${now}-${randomUUID().slice(0, 8)}`,
        status: 'running',
        startedAt: now,
        lastActivityAt: now,
        deadlineAt: now + this.budgetMs,
        completedOperations: 0,
      };
      this.startTimer();
    }

    this.state.lastActivityAt = Date.now();
    this.state.lastTool = activity.tool;
    this.state.lastPath = activity.path;
    this.state.lastRequestId = activity.requestId === undefined
      ? undefined
      : String(activity.requestId);
    void this.persist();
    return this.state;
  }
```

```ts
  toolCompleted(): void {
    if (!this.state || this.state.status !== 'running') return;
    this.state.completedOperations += 1;
    this.state.lastActivityAt = Date.now();
    this.evaluateThresholds();
    void this.persist();
  }

  async interrupt(reason: InterruptionReason, detail?: string): Promise<void> {
    if (!this.state || this.state.status !== 'running') return;
    this.state.status = 'interrupted';
    this.state.lastActivityAt = Date.now();
    this.state.interruptionReason = reason;
    this.state.interruptionDetail = detail;
    this.stopTimer();
    await this.persist();
  }

  async complete(): Promise<void> {
    if (!this.state || this.state.status !== 'running') return;
    this.state.status = 'completed';
    this.state.lastActivityAt = Date.now();
    this.stopTimer();
    await this.persist();
  }

  consumeNotice(): string | undefined {
    const notice = this.pendingNotice;
    this.pendingNotice = undefined;
    return notice;
  }
```

```ts
  getState(): Readonly<WorkState> | undefined {
    return this.state ? { ...this.state } : undefined;
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => this.evaluateThresholds(), 5_000);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private evaluateThresholds(): void {
    if (!this.state || this.state.status !== 'running') return;
    const elapsed = Date.now() - this.state.startedAt;

    if (elapsed >= this.budgetMs) {
      this.pendingNotice = '[DC_WORK_BUDGET expired] checkpoint immediately';
      this.interrupt('budget_expired', 'Configured defensive work budget reached');
      return;
    }
```

```ts
    if (elapsed >= this.criticalMs) {
      this.pendingNotice = '[DC_WORK_BUDGET critical] ~1 minute remains; checkpoint now';
    } else if (elapsed >= this.warningMs) {
      this.pendingNotice = '[DC_WORK_BUDGET warning] finish the current atomic operation';
    } else if (elapsed >= this.checkpointMs) {
      this.pendingNotice = '[DC_WORK_BUDGET checkpoint] persist progress and exact next action';
    }
  }

  private persistQueue: Promise<void> = Promise.resolve();

  private persist(): Promise<void> {
    if (!this.state) return this.persistQueue;
    const snapshot = JSON.stringify(this.state, null, 2);
    const target = path.join(this.stateDir, 'current.json');

    this.persistQueue = this.persistQueue.then(async () => {
      await mkdir(this.stateDir, { recursive: true });
      const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await writeFile(temp, snapshot, 'utf8');
        await rename(temp, target);
      } finally {
        await rm(temp, { force: true }).catch(() => undefined);
      }
    }).catch(error => this.onPersistenceError(error));

    return this.persistQueue;
  }
}

export const workLifecycle = new WorkLifecycleManager();
```

### MVP hardening notes

Persistence is now part of the correctness contract, not a follow-up: queue writes in order, snapshot before enqueueing, use a unique temporary filename, atomically rename, clean temporary files, and catch/report storage failures without failing the tool call. Tests must include rapid updates followed by interruption to prove an older snapshot cannot overwrite the final interrupted state.

Do not call `complete()` after every tool. A tool ending is not the same as the logical work session ending. In the MVP, a work window ends only by budget expiry/cancellation, or by a future explicit completion mechanism.
## MVP code: wrap `CallToolRequestSchema` in `src/server.ts`

Keep UI-origin calls out of the work timer. They are programmatic widget activity and the existing code already deliberately separates them from agent telemetry.

Add:

```ts
import { workLifecycle } from './utils/work-lifecycle.js';

function inferWorkPath(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const value = args as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'source', 'destination']) {
    if (typeof value[key] === 'string') return value[key] as string;
  }
  return undefined;
}

function appendLifecycleNotice(
  result: ServerResult,
  notice?: string,
): ServerResult {
  if (!notice) return result;
  return {
    ...result,
    content: [
      ...(result.content ?? []),
      { type: 'text', text: notice },
    ],
  } as ServerResult;
}
```

Replace the current central registration with:

```ts
server.setRequestHandler(
  CallToolRequestSchema,
  async (request: CallToolRequest, extra): Promise<ServerResult> => {
    const args = request.params.arguments;
    const isUiOriginCall = !!(
      args && typeof args === 'object' && (args as any).origin === 'ui'
    );

    if (isUiOriginCall) {
      return runInUiOriginCallContext(() => handleCallToolRequest(request));
    }

    return runWithWorkLifecycle(request, extra);
  },
);

async function runWithWorkLifecycle(
  request: CallToolRequest,
  extra?: { signal?: AbortSignal; requestId?: string | number },
): Promise<ServerResult> {
  const tool = request.params.name;
  const file = inferWorkPath(request.params.arguments);
  const signal = extra?.signal;
  const activity = { tool, file, requestId: extra?.requestId };
  workLifecycle.start(activity);

  let aborted = false;
  let abortListenerAttached = false;
  let interruptionPromise: Promise<void> | undefined;
  const onAbort = () => {
    aborted = true;
    interruptionPromise = workLifecycle.interrupt(
      'mcp_cancelled',
      `${tool}: ${String(signal?.reason ?? 'MCP request cancelled')}`,
    );
  };

  if (signal?.aborted) onAbort();
  else if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
    abortListenerAttached = true;
  }

  try {
    const result = await handleCallToolRequest(request);
    if (!aborted && result.isError !== true) workLifecycle.toolCompleted(activity);
    return appendLifecycleNotice(result, workLifecycle.consumePendingWarning());
  } finally {
    if (abortListenerAttached) signal?.removeEventListener('abort', onAbort);
    if (interruptionPromise) await interruptionPromise;
  }
}
```

### Why the wrapper belongs here

This wrapper sits outside the giant dispatcher, so it covers almost every tool without modifying each handler. It also preserves the existing telemetry/history code in `handleCallToolRequest()` unchanged.

It should run **after** the UI-origin gate and **before** calling `handleCallToolRequest()`. That keeps widget refreshes from starting/resetting the work timer.

For the first patch, do not add lifecycle calls inside individual switch cases. If later you want richer checkpoints for material tools, add them centrally by tool name after a successful result.

Suggested material-tool set for Phase 1.1:

```ts
const MATERIAL_TOOLS = new Set([
  'write_file', 'write_pdf', 'edit_block',
  'create_directory', 'move_file', 'start_process',
]);
```

## Phase 2: terminal/process lifecycle hooks

After the central wrapper is stable, add an event emitter rather than importing `workLifecycle` directly into `TerminalManager`.

Recommended new file:

```text
src/utils/process-lifecycle-events.ts
```

Example:

```ts
import { EventEmitter } from 'node:events';
export const processLifecycleEvents = new EventEmitter();
```

Emit from `src/terminal-manager.ts`:

```ts
processLifecycleEvents.emit('process:start', { pid: childProcess.pid, command });
processLifecycleEvents.emit('process:timeout-wait', { pid: childProcess.pid, timeoutMs });
childProcess.on('exit', (code, signal) => {
  processLifecycleEvents.emit('process:exit', { pid: childProcess.pid, code, signal });
  // existing exit bookkeeping follows
});
```

Emit `process:interrupt-requested` before SIGINT in `forceTerminate()`. Never translate initial wait timeout into `process:exit` or whole-work completion.
## Phase 3: Jazz remote interruption classification

Do not reintroduce the old Supabase callback model. Use the current Jazz supervision signals.

Recommended lifecycle mapping:

```text
DeviceHeartbeat.onUnhealthy(reason)       -> transport:unhealthy
ReconnectSupervisor onState(connecting)  -> transport:reconnecting
ReconnectSupervisor onState(offline)     -> transport:offline
ReconnectSupervisor onState(online)      -> transport:recovered
Jazz auth refresh failure                -> transport:auth_refresh_failed
DesktopCommanderIntegration.onclose      -> local_mcp:closed
DesktopCommanderIntegration.onerror      -> local_mcp:error
MCPDevice SIGINT/SIGTERM                 -> device:shutdown
```

Only classify an event as `probable_budget_expiry` when it is near the configured work deadline **and** accompanied by a real cancellation/transport-loss signal. Time alone is not proof.

Example classifier:

```ts
const state = workLifecycle.getState();
const elapsed = state ? Date.now() - state.startedAt : 0;
const nearDeadline = elapsed >= 24 * 60_000;
const classification = nearDeadline
  ? 'probable_budget_expiry'
  : 'transport_lost';
```

Persist both raw reason and derived classification. Never kill an active terminal process just because the remote/web work budget expired.
## MVP test plan

Add `test/test-work-lifecycle.js` and keep thresholds tiny through environment variables so the test finishes in seconds.

Required cases:

```text
1. first agent tool call creates running state
2. UI-origin call does not start/reset lifecycle state
3. subsequent tool call updates lastTool/lastPath/requestId
4. successful tool increments completedOperations
5. checkpoint/warning/critical notices are emitted in order
6. notice is consumed once, not appended forever
7. AbortSignal cancellation marks state interrupted=mcp_cancelled
8. budget expiry persists interrupted state without killing process sessions
9. state file survives manager recreation / process restart path
10. persistence failure does not fail an otherwise successful tool call
```

Use an injectable clock/timing options in the production class before merging tests if real-time sleeps make the suite flaky.

For server-wrapper coverage, add a focused integration test that creates an MCP client, calls a harmless tool, and sends cancellation to an in-flight request. The installed SDK already exposes `extra.signal`, `requestId`, optional `sessionId`, and optional `taskId` to request handlers.

Do not modify `test/repro/test-start-process-timeout-block.js`; it is a valuable regression guard proving that command timeout and process exit are different events.

Also run existing `test/test-remote-device-supervision.js` after any Phase 3 work because it protects local-child fail-fast/restart behavior.
## Full file-change map

### MVP (first patch)

```text
NEW  src/utils/work-lifecycle.ts
EDIT src/server.ts
NEW  test/test-work-lifecycle.js
```

### Phase 1.1 optional status tools

```text
EDIT src/tools/schemas.ts
NEW  src/handlers/work-lifecycle-handlers.ts
EDIT src/handlers/index.ts
EDIT src/server.ts
```

Possible tools: `get_work_status`, `checkpoint_work`, `complete_work`. These are useful for explicit recovery but are not required for automatic warning/checkpoint behavior.

### Phase 2 process events

```text
NEW  src/utils/process-lifecycle-events.ts
EDIT src/terminal-manager.ts
EDIT src/tools/improved-process-tools.ts
NEW/EDIT focused process lifecycle tests
```

### Phase 3 Jazz/remote supervision

```text
EDIT src/remote-device/heartbeat.ts
EDIT src/remote-device/reconnect-supervisor.ts
EDIT src/remote-device/remote-channel.ts
EDIT src/remote-device/desktop-commander-integration.ts
EDIT src/remote-device/device.ts
EDIT test/test-remote-device-supervision.js
```

## Rollout order

1. Implement `WorkLifecycleManager` with safe persistence and injectable timing.
2. Add the central `CallToolRequestSchema` wrapper; leave the giant dispatcher unchanged.
3. Add model-visible 20/23/24-minute notices to the returned `ServerResult`.
4. Add focused lifecycle unit/integration tests and run the full existing suite.
5. Only after the MVP is stable, add process event emission.
6. Then add Jazz heartbeat/reconnect/local-child interruption classification.
7. Finally consider explicit lifecycle MCP tools and ConfigManager/UI settings.

## MVP acceptance criteria

The first patch is done when all of these are true:

```text
- One non-UI tool call starts a work window.
- Every subsequent agent tool call updates durable current state.
- Current state records tool name, best-effort path, requestId, timestamps, count.
- MCP cancellation updates durable state to interrupted/mcp_cancelled.
- A 20-minute threshold sets a model-visible checkpoint notice.
- 23/24-minute thresholds escalate the model-visible notice.
- 25-minute budget expiry persists state but does not kill terminal processes.
- UI-origin tool calls do not create lifecycle activity.
- Existing tool history, usage tracking, telemetry, and Docker/onboarding post-processing still run.
- `npm run build`, focused lifecycle tests, and existing regression tests pass.
```

## Key design rule

Keep these lifecycles separate:

```text
tool timeout != process exit
process exit != work end
remote reconnect != new work session
transport loss != proven ChatGPT budget expiry
MCP cancellation = real per-request interruption signal
```

That separation is what makes the recovery record trustworthy enough to resume work in a new ChatGPT web session.