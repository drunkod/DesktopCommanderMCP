import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MINUTE = 60_000;

export type WorkStatus = 'running' | 'completed' | 'interrupted';
export type BudgetLevel = 'normal' | 'checkpoint' | 'warning' | 'critical' | 'expired';
export type BudgetNoticeLevel = Exclude<BudgetLevel, 'normal'>;
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
  lastFile?: string;
  lastPath?: string;
  lastRequestId?: string;
  completedOperations: number;
  noticesSent: BudgetNoticeLevel[];
  pendingNoticeLevel?: BudgetNoticeLevel;
  interruptionReason?: InterruptionReason;
  interruptionDetail?: string;
}

export interface WorkActivity {
  tool?: string;
  file?: string;
  requestId?: string | number;
}

export interface WorkLifecycleOptions {
  stateDirectory?: string;
  checkpointAfterMs?: number;
  warningAfterMs?: number;
  criticalAfterMs?: number;
  budgetMs?: number;
  pollIntervalMs?: number;
  loadExistingState?: boolean;
  onPersistenceError?: (error: unknown) => void;
}

function envMinutes(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * MINUTE : fallback * MINUTE;
}

const NOTICE_RANK: Record<BudgetNoticeLevel, number> = {
  checkpoint: 1, warning: 2, critical: 3, expired: 4,
};

export class WorkLifecycleManager {
  private state?: WorkState;
  private timer?: NodeJS.Timeout;
  private persistQueue: Promise<void> = Promise.resolve();
  private carriedNotice?: BudgetNoticeLevel;
  private readonly stateDir: string;
  private readonly checkpointAfterMs: number;
  private readonly warningAfterMs: number;
  private readonly criticalAfterMs: number;
  private readonly budgetMs: number;
  private readonly pollIntervalMs: number;
  private readonly onPersistenceError: (error: unknown) => void;

  constructor(options: WorkLifecycleOptions | number = {}) {
    const config: WorkLifecycleOptions = typeof options === 'number'
      ? {
          budgetMs: options,
          checkpointAfterMs: options * 0.8,
          warningAfterMs: options * 0.92,
          criticalAfterMs: options * 0.96,
        }
      : options;
    const explicitBudget = config.budgetMs;
    const budget = explicitBudget ?? envMinutes('DC_WORK_BUDGET_MINUTES', 25);
    this.stateDir = config.stateDirectory ?? path.join(os.homedir(), '.claude-server-commander', 'work-state');
    this.checkpointAfterMs = config.checkpointAfterMs ?? (explicitBudget !== undefined ? budget * 0.8 : envMinutes('DC_WORK_CHECKPOINT_MINUTES', 20));
    this.warningAfterMs = Math.max(config.warningAfterMs ?? (explicitBudget !== undefined ? budget * 0.92 : envMinutes('DC_WORK_WARNING_MINUTES', 23)), this.checkpointAfterMs);
    this.criticalAfterMs = Math.max(config.criticalAfterMs ?? (explicitBudget !== undefined ? budget * 0.96 : envMinutes('DC_WORK_CRITICAL_MINUTES', 24)), this.warningAfterMs);
    this.budgetMs = Math.max(budget, this.criticalAfterMs);
    this.pollIntervalMs = Math.max(1, config.pollIntervalMs ?? 5_000);
    this.onPersistenceError = config.onPersistenceError ?? ((error) => console.error('[work-lifecycle] persistence failed:', error));
    if (config.loadExistingState !== false) this.restore();
  }

  start(tool?: string, file?: string, requestId?: string | number): WorkState;
  start(activity?: WorkActivity): WorkState;
  start(toolOrActivity?: string | WorkActivity, file?: string, requestId?: string | number): WorkState {
    const activity = this.activity(toolOrActivity, file, requestId);
    if (this.state?.status === 'running') return this.touch(activity);
    if (this.state?.pendingNoticeLevel) this.carriedNotice = this.state.pendingNoticeLevel;

    const now = Date.now();
    this.state = {
      id: randomUUID(),
      status: 'running',
      startedAt: now,
      lastActivityAt: now,
      deadlineAt: now + this.budgetMs,
      lastTool: activity.tool,
      lastFile: activity.file,
      lastPath: activity.file,
      lastRequestId: activity.requestId === undefined ? undefined : String(activity.requestId),
      completedOperations: 0,
      noticesSent: [],
    };
    this.startTimer();
    void this.persist();
    return this.state;
  }

  touch(tool?: string, file?: string, requestId?: string | number): WorkState;
  touch(activity?: WorkActivity): WorkState;
  touch(toolOrActivity?: string | WorkActivity, file?: string, requestId?: string | number): WorkState {
    const activity = this.activity(toolOrActivity, file, requestId);
    if (!this.state || this.state.status !== 'running') return this.start(activity);
    this.applyActivity(this.state, activity);
    void this.persist();
    return this.state;
  }

  toolCompleted(tool?: string, file?: string, requestId?: string | number): WorkState | undefined;
  toolCompleted(activity?: WorkActivity): WorkState | undefined;
  toolCompleted(toolOrActivity?: string | WorkActivity, file?: string, requestId?: string | number): WorkState | undefined {
    if (!this.state) this.start(this.activity(toolOrActivity, file, requestId));
    if (!this.state || this.state.status !== 'running') return this.state;

    const activity = this.activity(toolOrActivity, file, requestId);
    this.applyActivity(this.state, activity);
    this.state.completedOperations += 1;
    this.evaluateThresholds();
    void this.persist();
    return this.state;
  }

  getState(): Readonly<WorkState> | undefined {
    if (!this.state) return undefined;
    return { ...this.state, noticesSent: [...this.state.noticesSent] };
  }

  getBudgetLevel(now = Date.now()): BudgetLevel {
    if (!this.state) return 'normal';
    const elapsed = now - this.state.startedAt;
    if (elapsed >= this.budgetMs) return 'expired';
    if (elapsed >= this.criticalAfterMs) return 'critical';
    if (elapsed >= this.warningAfterMs) return 'warning';
    if (elapsed >= this.checkpointAfterMs) return 'checkpoint';
    return 'normal';
  }

  consumePendingWarning(now = Date.now()): string | undefined {
    this.evaluateThresholds(now);

    if (this.state?.pendingNoticeLevel) {
      const level = this.state.pendingNoticeLevel;
      this.state.pendingNoticeLevel = undefined;
      if (!this.state.noticesSent.includes(level)) this.state.noticesSent.push(level);
      void this.persist();
      return this.noticeText(level);
    }

    if (this.carriedNotice) {
      const level = this.carriedNotice;
      this.carriedNotice = undefined;
      return this.noticeText(level);
    }

    return undefined;
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

  async flushPersistence(): Promise<void> {
    await this.persistQueue;
  }

  dispose(): void {
    this.stopTimer();
  }

  private activity(toolOrActivity?: string | WorkActivity, file?: string, requestId?: string | number): WorkActivity {
    return typeof toolOrActivity === 'object' ? toolOrActivity : { tool: toolOrActivity, file, requestId };
  }

  private applyActivity(state: WorkState, activity: WorkActivity): void {
    state.lastActivityAt = Date.now();
    if (activity.tool) state.lastTool = activity.tool;
    if (activity.file) {
      state.lastFile = activity.file;
      state.lastPath = activity.file;
    }
    if (activity.requestId !== undefined) state.lastRequestId = String(activity.requestId);
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => this.evaluateThresholds(), this.pollIntervalMs);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private evaluateThresholds(now = Date.now()): void {
    if (!this.state || this.state.status !== 'running') return;
    const level = this.getBudgetLevel(now);

    if (level === 'expired') {
      this.queueNotice('expired');
      this.state.status = 'interrupted';
      this.state.lastActivityAt = now;
      this.state.interruptionReason = 'budget_expired';
      this.state.interruptionDetail = 'Configured defensive work budget reached';
      this.stopTimer();
      void this.persist();
      return;
    }

    if (level !== 'normal') this.queueNotice(level);
  }

  private queueNotice(level: BudgetNoticeLevel): void {
    if (!this.state || this.state.noticesSent.includes(level)) return;
    const current = this.state.pendingNoticeLevel;
    if (current && NOTICE_RANK[current] >= NOTICE_RANK[level]) return;
    this.state.pendingNoticeLevel = level;
    void this.persist();
  }

  private noticeText(level: BudgetNoticeLevel): string {
    switch (level) {
      case 'checkpoint':
        return '[DCMCP_WORK_BUDGET checkpoint] action=save_progress_and_record_next_step';
      case 'warning':
        return '[DCMCP_WORK_BUDGET warning] action=avoid_starting_large_new_operation';
      case 'critical':
        return '[DCMCP_WORK_BUDGET critical] action=checkpoint_now_and_finish_current_atomic_operation';
      case 'expired':
        return '[DCMCP_WORK_BUDGET expired] action=checkpoint_now_and_resume_in_a_new_work_window';
    }
  }

  private restore(): void {
    try {
      const raw = readFileSync(path.join(this.stateDir, 'current.json'), 'utf8');
      const parsed = JSON.parse(raw) as Partial<WorkState>;
      if (!parsed.id || !parsed.status || !parsed.startedAt || !parsed.lastActivityAt || !parsed.deadlineAt) return;
      this.state = {
        ...parsed,
        id: parsed.id,
        status: parsed.status,
        startedAt: parsed.startedAt,
        lastActivityAt: parsed.lastActivityAt,
        deadlineAt: parsed.deadlineAt,
        completedOperations: parsed.completedOperations ?? 0,
        noticesSent: Array.isArray(parsed.noticesSent) ? parsed.noticesSent : [],
      } as WorkState;
      if (!this.state.lastPath && this.state.lastFile) this.state.lastPath = this.state.lastFile;
      if (!this.state.lastFile && this.state.lastPath) this.state.lastFile = this.state.lastPath;
      if (this.state.status === 'running') {
        this.evaluateThresholds();
        if (this.state.status === 'running') this.startTimer();
      }
    } catch {
      // Missing, corrupt, or unreadable state must never prevent server startup.
    }
  }

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
    }).catch((error) => {
      try {
        this.onPersistenceError(error);
      } catch {
        // Error reporting must not turn a persistence failure into an unhandled rejection.
      }
    });

    return this.persistQueue;
  }
}

export const workLifecycle = new WorkLifecycleManager();
