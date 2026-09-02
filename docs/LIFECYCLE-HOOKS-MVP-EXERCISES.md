# Lifecycle hooks MVP: exercises and implementation tasks

This workbook turns `IMPLEMENTATION-PLAN-LIFECYCLE-HOOKS-MVP.md` into concrete coding exercises for the current DesktopCommanderMCP branch.

The objective is to implement the smallest useful lifecycle system first, then add process and Jazz-aware interruption signals only after the core works.

> **Reviewed implementation note (2026-09-02):** the code examples below reflect the hardened MVP: serialized atomic persistence, restart rehydration, one-shot persisted notices, request IDs, already-aborted MCP signals, and error-shaped tool results that do not count as successful completions.

## Minimum functional version

The **minimum functional version** is only three moving parts:

1. `src/utils/work-lifecycle.ts` stores one active work window, elapsed time, last tool/path, and durable JSON state.
2. `src/server.ts` wraps the central `CallToolRequestSchema` handler and feeds start/end/cancel events into that manager.
3. `test/test-work-lifecycle.js` proves start, completion, threshold warning, persistence, and MCP cancellation behavior.

Everything else is phase 2 or later. You do **not** need terminal-manager events, Jazz heartbeat events, new MCP tools, config UI, or explicit remote-session IDs to get the first useful version working.

The MVP success condition is simple:

```text
first agent tool call -> lifecycle starts
subsequent tool calls -> durable progress updates
20/23/24 min -> next tool result receives warning
MCP AbortSignal -> work marked interrupted
25 min -> state persisted, no process is killed
```
## Exercise 1 — Define the lifecycle state model

### Task

Create `src/utils/work-lifecycle.ts` and define the minimum state needed to recover after a web-session interruption.

### Required fields

```ts
export type WorkStatus =
  | 'running'
  | 'completed'
  | 'interrupted';

export interface WorkState {
  id: string;
  status: WorkStatus;
  startedAt: number;
  lastActivityAt: number;
  deadlineAt: number;
  lastTool?: string;
  lastFile?: string;
  lastPath?: string;
  lastRequestId?: string;
  completedOperations: number;
  noticesSent: BudgetNoticeLevel[];
  pendingNoticeLevel?: BudgetNoticeLevel;
  interruptionReason?: InterruptionReason;
  interruptionDetail?: string;
}
```

### Why this is enough

Do not model every possible event yet. The MVP only needs to answer: when did work start, what happened most recently, how much time remains, and was it interrupted?
### Exercise 1 expected implementation

```ts
import { randomUUID } from 'node:crypto';

const MINUTE = 60_000;

export class WorkLifecycleManager {
  private state?: WorkState;
  private readonly budgetMs: number;

  constructor(budgetMs = 25 * MINUTE) {
    this.budgetMs = budgetMs;
  }

  start(tool?: string, file?: string): WorkState {
    if (this.state?.status === 'running') {
      return this.touch(tool, file);
    }

    const now = Date.now();
    this.state = {
      id: randomUUID(),
      status: 'running',
      startedAt: now,
      lastActivityAt: now,
      deadlineAt: now + this.budgetMs,
      lastTool: tool,
      lastFile: file,
      completedOperations: 0,
    };
    return this.state;
  }
```

### Verification

Instantiate the manager with a very small test budget, call `start({ tool: 'read_file', requestId: 'test-1' })`, and verify that `deadlineAt > startedAt` and `status === 'running'`.
## Exercise 2 — Record activity and completion

### Task

Add `touch()` and `toolCompleted()` so every successful tool call updates recoverable state.

```ts
  touch(activity: WorkActivity = {}): WorkState {
    if (!this.state || this.state.status !== 'running') {
      return this.start(activity);
    }
    this.applyActivity(this.state, activity);
    void this.persist();
    return this.state;
  }

  toolCompleted(activity: WorkActivity = {}): WorkState | undefined {
    if (!this.state) this.start(activity);
    if (!this.state || this.state.status !== 'running') return this.state;

    this.applyActivity(this.state, activity);
    this.state.completedOperations += 1;
    this.evaluateThresholds();
    void this.persist();
    return this.state;
  }
```

### Verification task

Run the equivalent of:

```ts
manager.start('read_file', '/tmp/a.txt');
manager.toolCompleted('edit_block', '/repo/src/server.ts');
const state = manager.getState();
```

Expected: `completedOperations === 1`, `lastTool === 'edit_block'`, and `lastFile` points to `src/server.ts`.
## Exercise 3 — Persist durable recovery state

### Task

Persist the active work state to disk after meaningful changes. Use an atomic temporary-file replacement so interruption does not leave a half-written JSON document.

```ts
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';

private persistQueue: Promise<void> = Promise.resolve();

private persist(): Promise<void> {
  if (!this.state) return this.persistQueue;
  const snapshot = JSON.stringify(this.state, null, 2);
  const target = path.join(this.stateDir, 'current.json');

  this.persistQueue = this.persistQueue.then(async () => {
    await mkdir(this.stateDir, { recursive: true });
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, snapshot, 'utf8');
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }).catch(error => this.onPersistenceError(error));

  return this.persistQueue;
}
```

Serialize writes, snapshot state when the write is queued, and use a unique temporary filename. A unique filename alone prevents collisions but does **not** prevent an older snapshot from finishing after a newer interruption snapshot. Persistence errors must be reported but must never fail an MCP tool call. For `interrupt()`, await the persistence queue before returning.

### Verification task

Use a temporary directory in the test, complete one operation, read the JSON back, and assert that the persisted `lastTool`, `lastFile`, and `completedOperations` match memory.
## Exercise 4 — Compute the 20/23/24/25-minute budget

### Task

Add a budget function. In production the defaults are 20, 23, 24 and 25 minutes; tests should inject millisecond-scale values.

```ts
export type BudgetLevel =
  | 'normal'
  | 'checkpoint'
  | 'warning'
  | 'critical'
  | 'expired';

getBudgetLevel(now = Date.now()): BudgetLevel {
  if (!this.state) return 'normal';
  const elapsed = now - this.state.startedAt;

  if (elapsed >= 25 * MINUTE) return 'expired';
  if (elapsed >= 24 * MINUTE) return 'critical';
  if (elapsed >= 23 * MINUTE) return 'warning';
  if (elapsed >= 20 * MINUTE) return 'checkpoint';
  return 'normal';
}
```

For a testable implementation, put the thresholds in constructor options instead of hard-coding them.

### Verification task

With thresholds `{ checkpointMs: 20, warningMs: 30, criticalMs: 40, budgetMs: 50 }`, advance a fake `now` value and assert all five levels without waiting in real time.
## Exercise 5 — Produce a one-shot model-visible warning

### Task

Add one-shot flags so each threshold message is returned only once. The important behavior is not logging the warning; it is appending it to the next MCP tool result so the model can act on it.

```ts
private queueNotice(level: BudgetNoticeLevel): void {
  if (!this.state || this.state.noticesSent.includes(level)) return;
  const current = this.state.pendingNoticeLevel;
  if (current && NOTICE_RANK[current] >= NOTICE_RANK[level]) return;
  this.state.pendingNoticeLevel = level;
  void this.persist();
}

consumePendingWarning(now = Date.now()): string | undefined {
  this.evaluateThresholds(now);
  if (!this.state?.pendingNoticeLevel) return undefined;

  const level = this.state.pendingNoticeLevel;
  this.state.pendingNoticeLevel = undefined;
  if (!this.state.noticesSent.includes(level)) this.state.noticesSent.push(level);
  void this.persist();
  return this.noticeText(level);
}
```

### Verification task

Call `consumePendingWarning()` twice at the same threshold. The first call must return a message; the second must return `undefined`.
## Exercise 6 — Wrap the central `CallToolRequestSchema` handler

### Task

Modify only the central handler in `src/server.ts`. Keep `handleCallToolRequest()` and its large switch unchanged.

Current shape:

```ts
server.setRequestHandler(
  CallToolRequestSchema,
  async (request: CallToolRequest): Promise<ServerResult> => {
    // UI-origin handling
    return handleCallToolRequest(request);
  },
);
```

Target shape:

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
```

This is the highest-value MVP change because virtually every agent-driven DesktopCommander tool passes this point.
### Exercise 6 helper: extract a path from tool arguments

Use a best-effort helper instead of adding hooks to every file tool.

```ts
function getPathFromToolRequest(
  request: CallToolRequest,
): string | undefined {
  const args = request.params.arguments;
  if (!args || typeof args !== 'object') return undefined;

  for (const key of ['path', 'file_path', 'source', 'destination']) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === 'string') return value;
  }

  return undefined;
}
```

This is intentionally imperfect. The MVP only needs enough context to answer “which file or path was the last operation touching?”

### Verification task

Feed requests shaped like `read_file({path})`, `edit_block({file_path})`, and a tool without a path. Assert that the helper returns the expected string or `undefined`.
### Exercise 6 helper: wrap execution

```ts
async function runWithWorkLifecycle(
  request: CallToolRequest,
  extra?: { signal?: AbortSignal; requestId?: string | number },
): Promise<ServerResult> {
  const tool = request.params.name;
  const file = getPathFromToolRequest(request);
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
    const notice = workLifecycle.consumePendingWarning();
    if (!notice) return result;
    return { ...result, content: [...(result.content ?? []), { type: 'text', text: notice }] } as ServerResult;
  } finally {
    if (abortListenerAttached) signal?.removeEventListener('abort', onAbort);
    if (interruptionPromise) await interruptionPromise;
  }
}
```

### Important rule

Do not make a single ordinary tool error terminate the entire work session. Record tool failure separately later if needed. The MVP should reserve `interrupted` for actual cancellation/budget/shutdown style interruption.

### Verification task

Call a harmless tool through the real server and confirm that the tool result is unchanged before the threshold and that lifecycle state records the tool afterward.
## Exercise 7 — Mark MCP cancellation as interruption

### Task

Add an explicit interruption method that persists before returning.

```ts
async interrupt(reason: string, detail?: string): Promise<void> {
  if (!this.state || this.state.status !== 'running') return;

  this.state.status = 'interrupted';
  this.state.lastActivityAt = Date.now();
  this.state.interruptionReason = detail
    ? `${reason}: ${detail}`
    : reason;

  await this.persist();
}
```

The `extra.signal` supplied by the MCP SDK is the real per-request cancellation hook. It should be treated as stronger evidence than a guessed timeout.

### Verification task

Create an `AbortController`, start a simulated tool call, call `controller.abort('test cancellation')`, and assert the persisted state becomes `interrupted` with an `mcp_cancelled` reason.
## Exercise 8 — Write the minimum regression test

### Task

Create `test/test-work-lifecycle.js` and keep the first test independent of the full MCP server.

```js
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkLifecycleManager } from '../dist/utils/work-lifecycle.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-work-life-'));
const manager = new WorkLifecycleManager({
  stateDirectory: dir,
  checkpointAfterMs: 20,
  warningAfterMs: 30,
  criticalAfterMs: 40,
  budgetMs: 50,
});

manager.start({ tool: 'read_file', file: '/tmp/a.txt' });
manager.toolCompleted({ tool: 'edit_block', file: '/repo/src/server.ts' });
const state = manager.getState();

assert.equal(state.status, 'running');
assert.equal(state.completedOperations, 1);
assert.equal(state.lastTool, 'edit_block');
assert.equal(state.lastFile, '/repo/src/server.ts');
```
### Exercise 8: threshold and cancellation assertions

```js
const startedAt = manager.getState().startedAt;
assert.equal(manager.getBudgetLevel(startedAt + 20), 'checkpoint');
assert.match(manager.consumePendingWarning(startedAt + 20), /checkpoint/);
assert.equal(manager.consumePendingWarning(startedAt + 20), undefined);

await manager.interrupt('mcp_cancelled', 'test cancellation');
await manager.flushPersistence();
assert.equal(manager.getState().status, 'interrupted');
assert.equal(manager.getState().interruptionReason, 'mcp_cancelled');

const persisted = JSON.parse(
  await fs.readFile(path.join(dir, 'current.json'), 'utf8'),
);
assert.equal(persisted.status, 'interrupted');
assert.equal(persisted.interruptionReason, 'mcp_cancelled');
```

### Run commands

```bash
nix develop
npm run build
node test/test-work-lifecycle.js
npm test
```

Do not rely on a real 20-minute sleep in tests. Inject tiny thresholds and test deterministically.
