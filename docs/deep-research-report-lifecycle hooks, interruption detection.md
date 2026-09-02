# DesktopCommanderMCP: lifecycle hooks, interruption detection, and a twenty-minute watchdog for the observed twenty-five-minute ChatGPT window

## Executive finding

I reviewed your `drunkod/DesktopCommanderMCP` fork specifically for places where you can detect **work starting, work continuing, work finishing, and work being interrupted**. I also checked the MCP cancellation model and the way your remote-device transport is structured.

The most important conclusion is:

> **You already have nearly all of the low-level lifecycle signals you need, but you do not currently have one application-level “work session lifecycle” abstraction that combines them.**

Your best implementation is therefore **not** a single twenty-five-minute `setTimeout()`. It should be a small `WorkLifecycleManager`/`TaskWatchdog` that aggregates several existing signals:

1. the central MCP `CallToolRequestSchema` handler in `src/server.ts`;
2. MCP request cancellation through the handler's `AbortSignal`;
3. child-process `exit`, timeout, and force-termination events in `src/terminal-manager.ts`;
4. remote-channel `TIMED_OUT`, `CLOSED`, and `CHANNEL_ERROR` events;
5. `SIGINT`/`SIGTERM` process shutdown;
6. automatic checkpoint persistence at about twenty minutes;
7. a warning inserted into subsequent MCP tool results as the observed twenty-five-minute boundary approaches.

Your fork's current `main` was at commit `e7dd3ab91237a4a4e2c00ad475e85c5f9f163ce9` in the repository state I examined, with the recent remote-device persistence work included. fileciteturn5file0

There is **no DesktopCommanderMCP source-level twenty-five-minute timeout that I found which you can simply hook into**. In particular, the repository tree does not reveal an existing `25 * 60 * 1000` conversation deadline mechanism. fileciteturn12file0

Nor should the observed twenty-five-minute behaviour be treated as part of the MCP protocol. MCP defines cancellation of individual in-progress requests, including a cancellation notification and optional reason, but it does not define a universal twenty-five-minute conversation lifetime. citeturn2search15turn2search5

I also would **not hard-code “ChatGPT always terminates MCP after exactly twenty-five minutes” as a protocol fact**. In the OpenAI material checked during this investigation, I found documentation for MCP/custom-app connectivity, but not an OpenAI contract specifying an exact twenty-five-minute MCP-chat lifetime. Your twenty-five-minute observation should consequently be treated as an **external operational budget** that DesktopCommanderMCP defensively monitors rather than a guaranteed API deadline. citeturn0search0

The architecture I recommend is:

```text
                     ChatGPT / MCP client
                              │
                              ▼
                  tools/call request arrives
                              │
                    ┌─────────▼─────────┐
                    │  WorkLifecycle    │
                    │      Manager      │
                    └─────────┬─────────┘
                              │
              work:start / tool:start
                              │
                     existing dispatcher
                              │
          ┌───────────────────┼────────────────────┐
          ▼                   ▼                    ▼
 TerminalManager       RemoteChannel          file/edit/etc.
 child processes       connection state          tools
          │                   │                    │
    process:exit       transport:error       tool:end
    process:kill       transport:close       progress
          │                   │                    │
          └───────────────────┼────────────────────┘
                              ▼
                    WorkLifecycleManager
                              │
          ┌───────────────────┼─────────────────┐
          ▼                   ▼                 ▼
      20-minute          23/24-minute       interruption
      checkpoint           warning             record
          │                   │                 │
          ▼                   ▼                 ▼
       JSON state       next MCP result      JSON state
        on disk         gets warning         + reason
```

This gives you a much more reliable answer to **“where did ChatGPT/DesktopCommander stop?”** than a twenty-five-minute timer alone.

## What your codebase already exposes

### The central MCP tool handler is your best general-purpose hook

`src/server.ts` is the most useful integration point because DesktopCommanderMCP routes tool calls through a central:

```ts
server.setRequestHandler(CallToolRequestSchema, async (...) => {
    // tool dispatch
});
```

The repository already has surrounding infrastructure for tool history, tracking, telemetry and result processing, so this is the natural point at which to add a lifecycle wrapper instead of modifying every DesktopCommander tool separately. fileciteturn8file0

Conceptually:

```text
MCP request received
      ↓
onWorkStart / onToolStart
      ↓
existing DesktopCommander dispatch
      ↓
onToolComplete / onToolError
      ↓
append deadline warning if necessary
      ↓
return result to ChatGPT
```

There is an especially useful MCP facility that your existing handler can exploit: **the request-handler context contains a cancellation signal**. The official TypeScript MCP SDK exposes request cancellation to server-side handlers via an `AbortSignal`; this is the protocol-native way of detecting cancellation of an active MCP request. citeturn2search5turn2search7turn2search8

That means you can change the conceptual shape of your handler from:

```ts
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // existing implementation
});
```

to:

```ts
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    extra.signal.addEventListener('abort', () => {
        // work/tool was interrupted
    });

    // existing implementation
});
```

This is significantly better than trying to infer every interruption from a timer.

There is one important caveat: **MCP cancellation and loss of the underlying transport are not exactly the same signal**. Historical v1 TypeScript SDK behaviour has had distinctions around propagation of cancellation versus unexpected transport closure, so you should use the MCP `AbortSignal` *and* your remote-channel lifecycle rather than assuming one catches every failure. citeturn2search1turn2search11

Your package currently depends on the v1-generation SDK range:

```json
"@modelcontextprotocol/sdk": "^1.9.0"
```

so I would design the wrapper for the v1 handler context you are using today, rather than architecting around newer SDK APIs without first performing a deliberate SDK migration. fileciteturn9file0

### TerminalManager already provides process-lifecycle hooks

Your `TerminalManager` is another excellent source of lifecycle information. It maintains active process sessions and observes child-process completion. fileciteturn14file0

There are three different events here that should not be conflated.

**Normal process exit**

You already have the equivalent of:

```ts
childProcess.on('exit', code => {
    // process has actually ended
});
```

That is a genuine:

```text
process:end
```

signal.

**Command timeout**

Your execution machinery also has command-level timeout handling. Critically, the existing timeout behaviour can return a blocked/timed-out result without necessarily meaning that the spawned OS process has ceased to exist. fileciteturn14file0

So do not implement:

```ts
timeout => work ended
```

Instead use:

```ts
timeout => tool request stopped waiting / process still needs inspection
```

and persist the PID.

That distinction matters enormously for your use case. If ChatGPT disappears after approximately twenty-five minutes while a long-running command remains active, a recovery record should say:

```json
{
  "status": "interrupted",
  "lastTool": "start_process",
  "pid": 48321,
  "processMayStillBeRunning": true
}
```

rather than incorrectly saying the actual command was terminated.

**Explicit termination**

Your `forceTerminate(pid)` path sends an interrupt and subsequently escalates termination if the process remains alive. fileciteturn14file0

That is a very good location for:

```text
process:interrupt-requested
process:terminated
```

hooks.

### Remote-device transport already has failure lifecycle

Your remote-channel implementation already distinguishes connection-level conditions including `TIMED_OUT`, `CLOSED` and `CHANNEL_ERROR`, and includes reconnect/heartbeat behaviour. fileciteturn16file0

Those events are useful for:

```ts
workLifecycle.transportInterrupted({
    kind: 'channel_closed',
    ...
});
```

but they do **not** prove why ChatGPT stopped.

For example:

```text
25m02s elapsed
       +
remote channel CLOSED
```

supports a reasonable heuristic:

```text
probable_budget_expiry
```

but it does not establish:

```text
ChatGPT definitely hit its 25-minute limit
```

A Wi-Fi interruption, browser closure, relay problem, process restart, or explicit client cancellation can produce superficially similar behaviour.

That is why I recommend recording both the **raw event** and a separately derived **classification**:

```json
{
  "rawReason": "remote_channel_closed",
  "classification": "probable_budget_expiry",
  "confidence": "heuristic",
  "elapsedMs": 1497322
}
```

This will make debugging much easier later.

## The lifecycle model I recommend

Do not call the abstraction merely `Timer`. Call it something such as:

```ts
WorkLifecycleManager
```

because elapsed time is only one of its inputs.

You need at least these states:

```ts
type WorkStatus =
  | 'running'
  | 'checkpoint_due'
  | 'completed'
  | 'interrupted'
  | 'failed';
```

and these event types:

```ts
type WorkLifecycleEvent =
  | 'work:start'
  | 'work:activity'
  | 'tool:start'
  | 'tool:end'
  | 'work:warning'
  | 'work:checkpoint'
  | 'work:interrupt'
  | 'work:end'
  | 'process:exit'
  | 'transport:interrupt';
```

The recommended timing is:

```text
00:00    first tool operation
          └── work:start

00:00–20:00
          └── work:activity after tools / writes / commands

20:00    automatic durable checkpoint
          └── warning level 1

23:00    stronger warning
          └── tell model to finish current atomic operation

24:00    final warning
          └── checkpoint immediately
          └── don't begin another large operation

~25:00   observed external danger zone
          └── interruption signals classified and persisted
```

I would deliberately make all those values configurable:

```bash
DC_WORK_BUDGET_MINUTES=25
DC_WORK_CHECKPOINT_MINUTES=20
DC_WORK_WARNING_MINUTES=23
DC_WORK_CRITICAL_MINUTES=24
```

Do **not** make twenty-five minutes an invisible magic number embedded throughout the code.

A work-state record should include enough information for a subsequent ChatGPT session to resume:

```json
{
  "id": "work-1725275214000-f3c20c",
  "status": "running",
  "startedAt": "2026-09-02T11:06:54.000Z",
  "lastActivityAt": "2026-09-02T11:26:58.000Z",
  "deadlineAt": "2026-09-02T11:31:54.000Z",

  "lastTool": "edit_block",
  "lastFile": "/project/src/remote-device/remote-channel.ts",
  "lastPid": null,

  "completedOperations": 42,

  "checkpoint": {
    "createdAt": "2026-09-02T11:26:54.000Z",
    "summary": "Added lifecycle manager; server integration remains",
    "nextAction": "Wrap CallToolRequestSchema handler"
  },

  "lastInterruption": null
}
```

There is an architectural point here that is easy to miss:

> **A background timer can save a checkpoint, but a background timer cannot force ChatGPT's web interface to read a new MCP message.**

If DesktopCommander fires:

```ts
setTimeout(() => {
    console.error('20 minutes reached');
}, 20 * 60_000);
```

the server knows that twenty minutes passed, but the model is not necessarily making a tool request at that instant. That message may only appear in your DesktopCommander logs.

Therefore the strongest design is:

```text
background timer
    ↓
persist state + set `warningPending`
    ↓
next MCP tool result
    ↓
append a warning that ChatGPT/model actually receives
```

This is much more dependable than trying to “push” an arbitrary message into a request/response MCP interaction.

## A complete work-lifecycle implementation

I would add a file such as:

```text
src/utils/work-lifecycle.ts
```

The following implementation is intentionally independent of ChatGPT. That means you can reuse it for Claude Desktop, remote-device mode, tests, or other MCP clients.

```ts
// src/utils/work-lifecycle.ts

import { EventEmitter } from 'node:events';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MINUTE = 60_000;

export type WorkStatus =
  | 'running'
  | 'checkpoint_due'
  | 'completed'
  | 'interrupted'
  | 'failed';

export type WorkInterruptionReason =
  | 'mcp_cancelled'
  | 'remote_channel_timed_out'
  | 'remote_channel_closed'
  | 'remote_channel_error'
  | 'server_sigint'
  | 'server_sigterm'
  | 'tool_error'
  | 'deadline_reached'
  | 'probable_budget_expiry'
  | 'unknown';

export interface WorkCheckpoint {
  createdAt: number;
  summary?: string;
  nextAction?: string;
}

export interface WorkState {
  id: string;
  status: WorkStatus;

  startedAt: number;
  lastActivityAt: number;
  deadlineAt: number;

  checkpointDueAt: number;
  warningDueAt: number;
  criticalDueAt: number;

  lastTool?: string;
  lastFile?: string;
  lastPid?: number;

  completedOperations: number;

  checkpoint?: WorkCheckpoint;

  warning20Sent: boolean;
  warning23Sent: boolean;
  warning24Sent: boolean;

  interruptionReason?: WorkInterruptionReason;
  interruptionDetail?: string;
}

export interface BudgetStatus {
  elapsedMs: number;
  remainingMs: number;
  elapsedMinutes: number;
  remainingMinutes: number;
  level: 'normal' | 'checkpoint' | 'warning' | 'critical' | 'expired';
}

export interface WorkLifecycleOptions {
  budgetMs?: number;
  checkpointAfterMs?: number;
  warningAfterMs?: number;
  criticalAfterMs?: number;
  stateDirectory?: string;
}

export interface ActivityUpdate {
  tool?: string;
  file?: string;
  pid?: number;
}

export class WorkLifecycleManager extends EventEmitter {
  private readonly budgetMs: number;
  private readonly checkpointAfterMs: number;
  private readonly warningAfterMs: number;
  private readonly criticalAfterMs: number;
  private readonly stateDirectory: string;

  private state?: WorkState;
  private timer?: NodeJS.Timeout;

  public constructor(options: WorkLifecycleOptions = {}) {
    super();

    this.budgetMs =
      options.budgetMs ??
      Number(process.env.DC_WORK_BUDGET_MINUTES ?? 25) * MINUTE;

    this.checkpointAfterMs =
      options.checkpointAfterMs ??
      Number(process.env.DC_WORK_CHECKPOINT_MINUTES ?? 20) * MINUTE;

    this.warningAfterMs =
      options.warningAfterMs ??
      Number(process.env.DC_WORK_WARNING_MINUTES ?? 23) * MINUTE;

    this.criticalAfterMs =
      options.criticalAfterMs ??
      Number(process.env.DC_WORK_CRITICAL_MINUTES ?? 24) * MINUTE;

    this.stateDirectory =
      options.stateDirectory ??
      path.join(
        os.homedir(),
        '.claude-server-commander',
        'work-state',
      );
  }

  /**
   * Starts a new logical work window if none is active.
   * Otherwise returns the current work state.
   */
  public start(update: ActivityUpdate = {}): WorkState {
    if (this.state?.status === 'running' ||
        this.state?.status === 'checkpoint_due') {
      this.touch(update);
      return this.state;
    }

    const now = Date.now();

    this.state = {
      id: `work-${now}-${randomUUID().slice(0, 8)}`,
      status: 'running',

      startedAt: now,
      lastActivityAt: now,
      deadlineAt: now + this.budgetMs,

      checkpointDueAt: now + this.checkpointAfterMs,
      warningDueAt: now + this.warningAfterMs,
      criticalDueAt: now + this.criticalAfterMs,

      lastTool: update.tool,
      lastFile: update.file,
      lastPid: update.pid,

      completedOperations: 0,

      warning20Sent: false,
      warning23Sent: false,
      warning24Sent: false,
    };

    this.emit('work:start', this.snapshot());

    this.startMonitor();
    void this.persist();

    return this.state;
  }

  /**
   * Records ongoing activity.
   */
  public touch(update: ActivityUpdate = {}): WorkState {
    const state = this.state ?? this.start(update);

    state.lastActivityAt = Date.now();

    if (update.tool !== undefined) {
      state.lastTool = update.tool;
    }

    if (update.file !== undefined) {
      state.lastFile = update.file;
    }

    if (update.pid !== undefined) {
      state.lastPid = update.pid;
    }

    this.emit('work:activity', this.snapshot());

    // Check thresholds on every real operation rather than relying
    // exclusively on the timer.
    this.evaluateThresholds();

    return state;
  }

  /**
   * Call after an MCP tool successfully completes.
   */
  public toolCompleted(update: ActivityUpdate = {}): void {
    const state = this.state ?? this.start(update);

    this.touch(update);
    state.completedOperations += 1;

    this.emit('tool:end', this.snapshot());

    // Persist after material work. This is intentionally cheap and robust.
    void this.persist();
  }

  /**
   * Save an explicit resumable checkpoint.
   */
  public async checkpoint(
    summary?: string,
    nextAction?: string,
  ): Promise<void> {
    if (!this.state) {
      return;
    }

    this.state.checkpoint = {
      createdAt: Date.now(),
      summary,
      nextAction,
    };

    if (this.state.status === 'running') {
      this.state.status = 'checkpoint_due';
    }

    this.emit('work:checkpoint', this.snapshot());
    await this.persist();
  }

  /**
   * Mark current work as interrupted.
   */
  public async interrupt(
    reason: WorkInterruptionReason,
    detail?: string,
  ): Promise<void> {
    if (!this.state) {
      return;
    }

    if (
      this.state.status === 'completed' ||
      this.state.status === 'failed' ||
      this.state.status === 'interrupted'
    ) {
      return;
    }

    this.state.status = 'interrupted';
    this.state.lastActivityAt = Date.now();
    this.state.interruptionReason = reason;
    this.state.interruptionDetail = detail;

    this.emit('work:interrupt', this.snapshot());

    this.stopMonitor();
    await this.persist();
  }

  /**
   * Mark the logical job as complete.
   */
  public async complete(): Promise<void> {
    if (!this.state) {
      return;
    }

    this.state.status = 'completed';
    this.state.lastActivityAt = Date.now();

    this.emit('work:end', this.snapshot());

    this.stopMonitor();
    await this.persist();
  }

  /**
   * Mark it as failed without pretending it was an external interruption.
   */
  public async fail(detail?: string): Promise<void> {
    if (!this.state) {
      return;
    }

    this.state.status = 'failed';
    this.state.lastActivityAt = Date.now();
    this.state.interruptionReason = 'tool_error';
    this.state.interruptionDetail = detail;

    this.emit('work:end', this.snapshot());

    this.stopMonitor();
    await this.persist();
  }

  /**
   * Current budget information.
   */
  public getBudgetStatus(now = Date.now()): BudgetStatus | undefined {
    if (!this.state) {
      return undefined;
    }

    const elapsedMs = Math.max(0, now - this.state.startedAt);
    const remainingMs = Math.max(0, this.state.deadlineAt - now);

    let level: BudgetStatus['level'] = 'normal';

    if (now >= this.state.deadlineAt) {
      level = 'expired';
    } else if (now >= this.state.criticalDueAt) {
      level = 'critical';
    } else if (now >= this.state.warningDueAt) {
      level = 'warning';
    } else if (now >= this.state.checkpointDueAt) {
      level = 'checkpoint';
    }

    return {
      elapsedMs,
      remainingMs,
      elapsedMinutes: elapsedMs / MINUTE,
      remainingMinutes: remainingMs / MINUTE,
      level,
    };
  }

  /**
   * Returns a model-readable warning, but only when one of the threshold
   * levels is crossed. This prevents every tool result becoming noisy.
   */
  public consumePendingWarning(): string | undefined {
    if (!this.state) {
      return undefined;
    }

    const budget = this.getBudgetStatus();
    if (!budget) {
      return undefined;
    }

    if (
      (budget.level === 'critical' || budget.level === 'expired') &&
      !this.state.warning24Sent
    ) {
      this.state.warning24Sent = true;
      void this.persist();

      return [
        '[DCMCP_WORK_BUDGET critical]',
        `elapsed=${budget.elapsedMinutes.toFixed(1)}m`,
        `remaining≈${budget.remainingMinutes.toFixed(1)}m`,
        'action=checkpoint_now_and_finish_current_atomic_operation',
      ].join(' ');
    }

    if (
      budget.level === 'warning' &&
      !this.state.warning23Sent
    ) {
      this.state.warning23Sent = true;
      void this.persist();

      return [
        '[DCMCP_WORK_BUDGET warning]',
        `elapsed=${budget.elapsedMinutes.toFixed(1)}m`,
        `remaining≈${budget.remainingMinutes.toFixed(1)}m`,
        'action=avoid_starting_large_new_operation',
      ].join(' ');
    }

    if (
      budget.level === 'checkpoint' &&
      !this.state.warning20Sent
    ) {
      this.state.warning20Sent = true;
      void this.checkpoint();

      return [
        '[DCMCP_WORK_BUDGET checkpoint]',
        `elapsed=${budget.elapsedMinutes.toFixed(1)}m`,
        `remaining≈${budget.remainingMinutes.toFixed(1)}m`,
        'action=save_progress_and_record_next_step',
      ].join(' ');
    }

    return undefined;
  }

  public getState(): Readonly<WorkState> | undefined {
    return this.snapshot();
  }

  private startMonitor(): void {
    this.stopMonitor();

    // A relatively small polling timer keeps all threshold logic in one place.
    this.timer = setInterval(() => {
      this.evaluateThresholds();
    }, 5_000);

    // Do not keep the MCP server alive only because the watchdog exists.
    this.timer.unref();
  }

  private stopMonitor(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private evaluateThresholds(): void {
    if (!this.state) {
      return;
    }

    const budget = this.getBudgetStatus();
    if (!budget) {
      return;
    }

    if (
      budget.level === 'checkpoint' ||
      budget.level === 'warning' ||
      budget.level === 'critical'
    ) {
      this.emit('work:warning', {
        state: this.snapshot(),
        budget,
      });
    }

    // The deadline is deliberately an observed operational budget.
    // We save state rather than killing arbitrary child processes here.
    if (budget.level === 'expired') {
      void this.interrupt(
        'deadline_reached',
        'Configured DesktopCommander work budget reached',
      );
    }
  }

  private snapshot(): WorkState | undefined {
    return this.state ? { ...this.state } : undefined;
  }

  private async persist(): Promise<void> {
    if (!this.state) {
      return;
    }

    try {
      await mkdir(this.stateDirectory, { recursive: true });

      const target = path.join(
        this.stateDirectory,
        `${this.state.id}.json`,
      );

      const temporary = `${target}.tmp`;

      await writeFile(
        temporary,
        JSON.stringify(this.state, null, 2),
        'utf8',
      );

      // Atomic replacement on the same filesystem.
      await rename(temporary, target);
    } catch (error) {
      // Persistence failure should not make DesktopCommander itself fail.
      console.error(
        '[WorkLifecycle] Failed to persist work state:',
        error,
      );
    }
  }
}

export const workLifecycle = new WorkLifecycleManager();
```

There are several deliberate decisions in this implementation.

First, `timer.unref()` prevents the monitoring timer from becoming the reason your Node process remains alive.

Second, the watchdog **does not kill long-running child processes at twenty-five minutes**. That would destroy exactly the state you may want to reconnect to.

Third, state is persisted after tool completions as well as at twenty minutes. A checkpoint that exists only in RAM is of little value when the event you are trying to survive is an unexpected disconnect.

Fourth, threshold checking happens on actual activity *and* on a timer. You therefore do not depend upon a timer firing at one exact instant.

## Hooking it into your existing server, terminal and remote paths

### Hook MCP tool start, completion and cancellation

The most valuable patch is around the central `CallToolRequestSchema` handler already present in `src/server.ts`. fileciteturn8file0

A clean approach is to extract your existing giant dispatch body into one function and put the lifecycle logic around it.

Conceptually:

```ts
import { workLifecycle } from './utils/work-lifecycle.js';

// The body of your CURRENT CallToolRequestSchema handler moves here.
// Do not duplicate individual cases; this remains your single dispatcher.
async function dispatchToolCall(
  request: CallToolRequest,
): Promise<ServerResult> {
  // ------------------------------------------------------------
  // YOUR EXISTING CallToolRequestSchema BODY GOES HERE
  // ------------------------------------------------------------
  //
  // switch (request.params.name) {
  //   ...
  // }
  //
  // Return the same ServerResult that your existing code returns.
  throw new Error('Replace with existing DesktopCommander dispatch body');
}

server.setRequestHandler(
  CallToolRequestSchema,
  async (request, extra): Promise<ServerResult> => {
    const toolName = request.params.name;

    workLifecycle.start({
      tool: toolName,
    });

    workLifecycle.touch({
      tool: toolName,
    });

    let aborted = false;

    const handleAbort = (): void => {
      aborted = true;

      const reason =
        extra.signal.reason instanceof Error
          ? extra.signal.reason.message
          : String(extra.signal.reason ?? 'MCP request cancelled');

      void workLifecycle.interrupt(
        'mcp_cancelled',
        `${toolName}: ${reason}`,
      );
    };

    extra.signal.addEventListener('abort', handleAbort, {
      once: true,
    });

    try {
      const result = await dispatchToolCall(request);

      if (!aborted) {
        workLifecycle.toolCompleted({
          tool: toolName,
        });
      }

      const warning = workLifecycle.consumePendingWarning();

      if (!warning) {
        return result;
      }

      // Append to a normal MCP text/tool response so the client/model sees it.
      return {
        ...result,
        content: [
          ...(result.content ?? []),
          {
            type: 'text',
            text: warning,
          },
        ],
      } as ServerResult;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      if (!aborted) {
        await workLifecycle.fail(
          `${toolName}: ${message}`,
        );
      }

      throw error;
    } finally {
      extra.signal.removeEventListener(
        'abort',
        handleAbort,
      );
    }
  },
);
```

The use of an `AbortSignal` here follows MCP's cancellation semantics rather than inventing a DesktopCommander-specific cancellation protocol. MCP specifies cancellation notifications for in-flight requests, and the TypeScript SDK exposes cancellation context to request handlers. citeturn2search15turn2search7

One change I would make to that basic example in production is **not marking the entire work session failed whenever one ordinary tool fails**. Instead distinguish:

```ts
tool:error
```

from:

```ts
work:failed
```

because an `edit_block` failure followed by a corrected edit should not terminate the logical task.

For example:

```ts
public async toolFailed(
  tool: string,
  error: unknown,
): Promise<void> {
  if (!this.state) {
    return;
  }

  this.state.lastTool = tool;
  this.state.lastActivityAt = Date.now();

  this.emit('tool:error', {
    state: this.getState(),
    error,
  });

  await this.persist();
}
```

and in `server.ts`:

```ts
} catch (error) {
  if (!aborted) {
    await workLifecycle.toolFailed(toolName, error);
  }

  throw error;
}
```

That is the version I recommend.

### Do not infer the last file only from the tool name

For recovery, knowing:

```text
lastTool = edit_block
```

is much less useful than:

```text
lastTool = edit_block
lastFile = /repo/src/server.ts
```

So, before dispatch, inspect the parameters of the tools that act on files.

A lightweight helper:

```ts
function getPathFromToolRequest(
  request: CallToolRequest,
): string | undefined {
  const args = request.params.arguments;

  if (
    args &&
    typeof args === 'object' &&
    'path' in args &&
    typeof args.path === 'string'
  ) {
    return args.path;
  }

  return undefined;
}
```

Then:

```ts
const lastFile = getPathFromToolRequest(request);

workLifecycle.touch({
  tool: request.params.name,
  file: lastFile,
});
```

This alone would substantially improve the sort of error you described:

> session ended while stopped at a particular task or file

because DesktopCommander could leave a structured recovery document saying exactly which tool and file were active.

### Expose status as an MCP tool

I would also add a tool like:

```text
get_work_status
```

It is useful after reconnecting, although it should be an addition to automatic checkpointing rather than a replacement for it.

A typical response should look like:

```json
{
  "workId": "work-...",
  "status": "checkpoint_due",
  "elapsedMinutes": 21.4,
  "remainingMinutes": 3.6,
  "lastTool": "edit_block",
  "lastFile": "/repo/src/server.ts",
  "completedOperations": 31,
  "checkpoint": {
    "summary": "Lifecycle manager implemented",
    "nextAction": "Connect RemoteChannel interruption event"
  }
}
```

The implementation itself can simply call:

```ts
const state = workLifecycle.getState();
const budget = workLifecycle.getBudgetStatus();

return {
  content: [
    {
      type: 'text',
      text: JSON.stringify(
        { state, budget },
        null,
        2,
      ),
    },
  ],
};
```

You could add three related tools:

```text
get_work_status
checkpoint_work
complete_work
```

but I would keep their number small. **The model cannot be relied upon to remember to call a monitoring tool before an external timeout**, which is why the server-side lifecycle manager remains necessary.

### Hook actual child-process exit

Your process handling in `TerminalManager` already observes child-process exit. fileciteturn14file0

Add a callback or EventEmitter instead of coupling `TerminalManager` directly to the global watchdog.

For example:

```ts
// terminal-manager.ts
import { EventEmitter } from 'node:events';

export const terminalLifecycle = new EventEmitter();
```

Around process creation:

```ts
terminalLifecycle.emit('process:start', {
  pid: childProcess.pid,
  command,
  startedAt: Date.now(),
});
```

And inside your existing exit handler:

```ts
childProcess.on('exit', (code, signal) => {
  terminalLifecycle.emit('process:exit', {
    pid,
    code,
    signal,
    endedAt: Date.now(),
  });

  // Existing TerminalManager exit logic follows.
});
```

Then wire it from the server bootstrap:

```ts
terminalLifecycle.on(
  'process:start',
  ({ pid }) => {
    workLifecycle.touch({ pid });
  },
);

terminalLifecycle.on(
  'process:exit',
  ({ pid, code, signal }) => {
    console.error(
      `[WorkLifecycle] process ${pid} exited`,
      { code, signal },
    );

    // Persist current state, but DO NOT automatically declare the
    // whole ChatGPT work session complete.
    void workLifecycle.checkpoint(
      `Process ${pid} exited with code ${String(code)}`,
      'Inspect process result and continue the current task',
    );
  },
);
```

Notice that:

```ts
process exit !== work end
```

A shell command can finish at minute eleven while ChatGPT continues editing for another ten minutes.

Likewise:

```ts
work interruption !== child-process termination
```

A browser/MCP disconnection may occur while a detached or asynchronously tracked process continues running.

Keeping those lifecycles separate is one of the most important design decisions here.

### Hook explicit process termination separately

Inside `forceTerminate(pid)`, emit something such as:

```ts
terminalLifecycle.emit(
  'process:interrupt-requested',
  {
    pid,
    at: Date.now(),
  },
);
```

Then once you know the process has actually exited:

```ts
terminalLifecycle.emit(
  'process:terminated',
  {
    pid,
    at: Date.now(),
  },
);
```

That will let your state file distinguish:

```json
{
  "interruption": "ChatGPT/MCP disappeared",
  "pid": 12345,
  "processStillPotentiallyRunning": true
}
```

from:

```json
{
  "interruption": "User explicitly terminated process",
  "pid": 12345,
  "processStillPotentiallyRunning": false
}
```

Your existing `forceTerminate()` implementation is the correct place to generate those process-specific lifecycle events. fileciteturn14file0

### Hook the remote channel

The current remote-channel code already has explicit state transitions for timeout, closure and channel error, plus heartbeat/reconnection behaviour. fileciteturn16file0

I would expose those through an event emitter:

```ts
// remote-device/remote-channel.ts

import { EventEmitter } from 'node:events';

export const remoteLifecycle = new EventEmitter();
```

In the existing Supabase/realtime subscription status callback, add:

```ts
switch (status) {
  case 'TIMED_OUT':
    remoteLifecycle.emit('transport:interrupt', {
      reason: 'remote_channel_timed_out',
      at: Date.now(),
    });
    break;

  case 'CLOSED':
    remoteLifecycle.emit('transport:interrupt', {
      reason: 'remote_channel_closed',
      at: Date.now(),
    });
    break;

  case 'CHANNEL_ERROR':
    remoteLifecycle.emit('transport:interrupt', {
      reason: 'remote_channel_error',
      at: Date.now(),
    });
    break;
}
```

Then wire it:

```ts
remoteLifecycle.on(
  'transport:interrupt',
  async ({ reason }) => {
    const budget = workLifecycle.getBudgetStatus();

    const closeToObservedDeadline =
      budget !== undefined &&
      budget.elapsedMinutes >= 24;

    await workLifecycle.interrupt(
      closeToObservedDeadline
        ? 'probable_budget_expiry'
        : reason,
      closeToObservedDeadline
        ? `Transport interrupted at ${budget.elapsedMinutes.toFixed(1)} minutes`
        : 'Remote transport interrupted',
    );
  },
);
```

This is where I would implement your twenty-five-minute **heuristic**, rather than assuming every channel closure at any time is a session deadline.

For example:

```text
4m17s + CLOSED
→ remote_channel_closed

24m46s + CLOSED
→ probable_budget_expiry

24m51s + MCP cancellation reason "..."
→ mcp_cancelled, near deadline

25m03s + CHANNEL_ERROR
→ probable_budget_expiry
```

You could retain both fields:

```ts
interface Interruption {
  rawReason: string;
  classification: string;
  nearConfiguredDeadline: boolean;
}
```

which is even better diagnostically.

### Hook server shutdown

Also persist the active checkpoint on normal Node shutdown:

```ts
async function gracefulLifecycleShutdown(
  signal: 'SIGINT' | 'SIGTERM',
): Promise<void> {
  await workLifecycle.interrupt(
    signal === 'SIGINT'
      ? 'server_sigint'
      : 'server_sigterm',
    `DesktopCommander received ${signal}`,
  );
}

process.once('SIGINT', () => {
  void gracefulLifecycleShutdown('SIGINT');
});

process.once('SIGTERM', () => {
  void gracefulLifecycleShutdown('SIGTERM');
});
```

Integrate this with your existing shutdown logic rather than installing competing handlers that independently call `process.exit()`.

## Making the twenty-minute warning actually useful to ChatGPT

The most important part of the feature is not measuring twenty minutes. Node can obviously do that.

The problem is **getting the knowledge back into the model before the connection disappears**.

I recommend the following behaviour.

At twenty minutes, the watchdog internally records:

```text
checkpointNeeded = true
```

and persists:

```json
{
  "elapsedMinutes": 20,
  "lastTool": "...",
  "lastFile": "...",
  "status": "checkpoint_due"
}
```

On the **next successful DesktopCommander MCP call**, append:

```text
[DCMCP_WORK_BUDGET checkpoint]
Approximately 20 minutes of this work window have elapsed.
Persist the current task state and identify the exact next operation before
continuing. Configured budget: 25 minutes.
```

At twenty-three minutes:

```text
[DCMCP_WORK_BUDGET warning]
Approximately 23 minutes have elapsed and about 2 minutes remain in the
configured work budget. Do not begin another large operation. Finish the
current atomic change and checkpoint the exact file/task state.
```

At twenty-four minutes:

```text
[DCMCP_WORK_BUDGET critical]
Approximately 24 minutes have elapsed and about 1 minute remains in the
configured work budget. Checkpoint now. Record unfinished files, active PID,
last completed operation and exact next action.
```

A helper for that can be completely generic:

```ts
function appendLifecycleNotice(
  result: ServerResult,
  notice: string | undefined,
): ServerResult {
  if (!notice) {
    return result;
  }

  return {
    ...result,
    content: [
      ...(result.content ?? []),
      {
        type: 'text',
        text: notice,
      },
    ],
  } as ServerResult;
}
```

and then:

```ts
const result = await dispatchToolCall(request);

workLifecycle.toolCompleted({
  tool: request.params.name,
  file: getPathFromToolRequest(request),
});

return appendLifecycleNotice(
  result,
  workLifecycle.consumePendingWarning(),
);
```

This has an important advantage over simply printing:

```ts
console.error('25 minutes soon!');
```

The latter warns **you**. The former warns the **MCP client/model that must change its behaviour**.

I would also include status data in a compact machine-readable form instead of a long human prompt:

```text
[DCMCP_WORK_BUDGET]
level=critical
elapsed_minutes=24.1
remaining_minutes=0.9
last_file=/project/src/server.ts
action=checkpoint_and_stop_large_operations
```

Models are quite capable of understanding this, and it wastes less context.

### Checkpoint after meaningful operations, not only after twenty minutes

This is an even stronger improvement.

For file-changing calls:

```text
write_file
edit_block
create_directory
move_file
```

persist state immediately after successful completion.

For long-running process calls, persist:

```text
PID
command
start time
whether process is still expected to be alive
```

For read-only calls, you can persist less aggressively.

For example:

```ts
function isMaterialTool(tool: string): boolean {
  return new Set([
    'write_file',
    'edit_block',
    'create_directory',
    'move_file',
    'start_process',
  ]).has(tool);
}
```

Then:

```ts
if (isMaterialTool(toolName)) {
  await workLifecycle.checkpoint(
    `Successfully completed ${toolName}`,
    'Continue from the next planned operation',
  );
}
```

That gives you recovery even if the web session unexpectedly disappears at minute thirteen rather than minute twenty-five.

### A dedicated `checkpoint_work` tool can make resumptions much better

An optional MCP tool could accept:

```ts
{
  summary: string;
  nextAction: string;
  files: string[];
}
```

Example:

```json
{
  "summary": "Implemented WorkLifecycleManager and integrated tool cancellation",
  "nextAction": "Add transport:interrupt events to remote-channel.ts",
  "files": [
    "src/utils/work-lifecycle.ts",
    "src/server.ts"
  ]
}
```

That is much more useful on reconnect than raw telemetry.

Its conceptual schema might be:

```ts
{
  name: 'checkpoint_work',
  description:
    'Persist a resumable checkpoint for the current DesktopCommander work session.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
      },
      nextAction: {
        type: 'string',
      },
      files: {
        type: 'array',
        items: {
          type: 'string',
        },
      },
    },
    required: ['summary', 'nextAction'],
  },
}
```

Then:

```ts
case 'checkpoint_work': {
  const {
    summary,
    nextAction,
  } = request.params.arguments as {
    summary: string;
    nextAction: string;
  };

  await workLifecycle.checkpoint(
    summary,
    nextAction,
  );

  return {
    content: [
      {
        type: 'text',
        text: 'Work checkpoint persisted successfully.',
      },
    ],
  };
}
```

This is optional. The automatic checkpoint mechanism is still more important because it does not depend on the model remembering to invoke the tool.

## What should count as “work start”, “work end”, and “interrupted”

The crucial design decision is deciding **what a “task” actually means**, because your repository currently gives you MCP requests and processes, not necessarily a unique ChatGPT web-conversation identifier.

I recommend the following semantics:

| Event | Signal in DesktopCommander | Meaning |
|---|---|---|
| `work:start` | First relevant `tools/call` when no work window is active | Start the twenty-five-minute defensive budget |
| `tool:start` | Entry into `CallToolRequestSchema` handler | One MCP operation started |
| `work:activity` | Any subsequent tool call / material process activity | Work continues |
| `tool:end` | Handler returned successfully | One MCP operation ended |
| `tool:error` | Tool dispatcher threw | Operation failed, work may continue |
| `work:checkpoint` | twenty-minute threshold or material operation | Durable recovery position |
| `work:warning` | twenty / twenty-three / twenty-four-minute thresholds | Tell model to wrap up |
| `work:interrupt` | MCP abort, channel loss, SIGINT/SIGTERM | Work stopped unexpectedly |
| `process:exit` | child process `'exit'` | A PID ended; not necessarily whole task |
| `work:end` | explicit completion | Logical task genuinely finished |

This separation reflects the actual layers in your code: the MCP server dispatch in `server.ts`, child-process management in `terminal-manager.ts`, and remote transport handling in `remote-channel.ts` are distinct subsystems. fileciteturn8file0turn14file0turn16file0

There is one thing I would **not** do:

```ts
// Don't do this:
const SERVER_STARTED_AT = Date.now();

if (Date.now() - SERVER_STARTED_AT > 20 * 60_000) {
    warnChatGPT();
}
```

The DesktopCommander server can live much longer than one ChatGPT work session. The clock must be associated with a **logical work window**, not the Node process lifetime.

Likewise, do not start the twenty-five-minute clock when a remote channel connects. A transport connection can persist independently of an individual user task; the remote-device layer is designed around connection persistence/reconnection rather than being equivalent to a single MCP tool operation. fileciteturn16file0

A better fallback is:

```text
first tools/call after no active work
          ↓
new work window
          ↓
20/23/24-minute checkpoints
          ↓
explicit complete OR interruption OR configured expiry
          ↓
next tools/call
          ↓
new work window
```

Eventually, if your remote relay/client can provide an explicit work/session identifier, use that rather than the process-global fallback:

```ts
function getWorkKey(
  request: CallToolRequest,
): string {
  const meta = request.params._meta as
    | Record<string, unknown>
    | undefined;

  const suppliedId = meta?.workSessionId;

  if (typeof suppliedId === 'string') {
    return suppliedId;
  }

  return 'default-active-work-window';
}
```

I would **not assume the existing remote metadata is a ChatGPT conversation ID** unless you explicitly introduce that contract yourself.

## Recommended implementation and remaining limitations

I would implement this in the following order.

**First, add the lifecycle manager and wrap the central `CallToolRequestSchema` handler.** This immediately gives you tool start/end, elapsed-time monitoring, durable state and protocol cancellation across virtually every DesktopCommander operation from one place. The central handler already exists, making this much cleaner than adding timers to each individual tool. fileciteturn8file0

**Second, add automatic twenty/twenty-three/twenty-four-minute notices to returned tool results.** This addresses your actual problem: ChatGPT needs to learn that the work window is nearing its observed limit, rather than the warning living solely in the MCP server log.

**Third, wire `TerminalManager` process lifecycle into the same state record.** Persisting the current PID is particularly important because your process lifecycle can outlive an individual tool wait/timeout. fileciteturn14file0

**Fourth, wire remote-channel `TIMED_OUT`, `CLOSED` and `CHANNEL_ERROR` into `work:interrupt`.** Treat a transport failure very near the configured deadline as `probable_budget_expiry`, not proven budget expiry. fileciteturn16file0

**Fifth, checkpoint after every material modification.** Twenty minutes should be the final safety checkpoint, not the first time progress is written to durable storage.

The resulting recovery experience can be considerably better than the current “session ended at this file/task” message. A new session could begin by reading:

```json
{
  "status": "interrupted",
  "classification": "probable_budget_expiry",

  "elapsedMinutes": 24.93,

  "lastTool": "edit_block",
  "lastFile": "/DesktopCommanderMCP/src/server.ts",
  "lastPid": 49117,

  "lastCheckpoint": {
    "summary": "Work lifecycle implemented and connected to MCP cancellation.",
    "nextAction": "Connect RemoteChannel CLOSED/TIMED_OUT events."
  },

  "recovery": {
    "inspectPidFirst": true,
    "resumeFile": "/DesktopCommanderMCP/src/server.ts"
  }
}
```

That is enough for the next model/session to resume deterministically.

The main limitation is that DesktopCommander itself cannot reliably prove that an unexpected disconnect was caused by a specific internal ChatGPT web-session deadline unless the client sends an explicit reason. MCP gives you a real cancellation mechanism for in-progress requests, while the remote transport gives you transport-state signals; those should be recorded independently. citeturn2search15turn2search1

Similarly, **there is no reason to wait until minute twenty-five to discover that you are in danger**. I would use twenty minutes as the durable checkpoint boundary, twenty-three as “finish the current unit of work”, twenty-four as “stop starting new work”, and the configured twenty-five-minute value purely as the final defensive budget.

The core change is therefore small in concept:

```ts
// work begins
workLifecycle.start(...);

// every MCP call
workLifecycle.touch(...);

// MCP cancellation
extra.signal.addEventListener(
  'abort',
  () => workLifecycle.interrupt('mcp_cancelled'),
);

// after tool
workLifecycle.toolCompleted(...);

// around 20m
await workLifecycle.checkpoint(...);

// next result after threshold
result = appendLifecycleNotice(
  result,
  workLifecycle.consumePendingWarning(),
);

// transport disappeared
await workLifecycle.interrupt(
  nearDeadline
    ? 'probable_budget_expiry'
    : 'remote_channel_closed',
);

// actual logical completion
await workLifecycle.complete();
```

That gives DesktopCommanderMCP the hooks you were looking for at **work start, during work, on individual tool completion, on operating-system process completion, on MCP cancellation, on remote-transport interruption, near the twenty-five-minute danger window, and at explicit work completion**—without incorrectly treating any single one of those lifecycles as all the others.