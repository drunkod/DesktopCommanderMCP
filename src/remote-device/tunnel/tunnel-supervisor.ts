import type { TunnelProvider, TunnelState } from "./types.js";

export type TunnelSupervisorOptions = {
  monitorIntervalMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  jitterRatio?: number;
  onState?: (state: TunnelState) => void;
};

/** Coalesces tunnel recovery attempts; providers remain the owner of provider-specific recovery. */
export class TunnelSupervisor {
  private inFlight: Promise<TunnelState> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private attempt = 0;
  private state: TunnelState | null = null;
  private readonly retryWakeups = new Set<() => void>();

  constructor(
    private readonly provider: TunnelProvider,
    private readonly options: TunnelSupervisorOptions = {},
  ) {}

  get currentState(): TunnelState | null { return this.state; }

  async start(): Promise<TunnelState> {
    if (this.stopped) throw new Error("Tunnel supervisor is stopped");
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.provider.start()
      .then((state) => {
        if (!this.stopped) {
          this.publish(state);
          this.attempt = 0;
          this.beginMonitoring();
        }
        return state;
      })
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async requestRecovery(reason: string): Promise<TunnelState> {
    if (this.stopped) throw new Error("Tunnel supervisor is stopped");
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.recover(reason).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const wake of [...this.retryWakeups]) wake();
    this.retryWakeups.clear();
    // Wait for a provider operation that was already in progress. This keeps
    // rollback/stop from racing an in-flight recovery attempt.
    await this.inFlight?.catch(() => undefined);
  }

  async teardown(): Promise<void> {
    await this.close();
    await this.provider.stop();
  }

  async rollbackStartup(): Promise<void> {
    await this.close();
    await this.provider.rollbackStartup?.();
  }

  private async recover(reason: string): Promise<TunnelState> {
    for (;;) {
      if (this.stopped) return this.state ?? offlineState(this.provider.name, reason);
      try {
        const state = await this.provider.start();
        if (this.stopped) return state;
        this.publish({ ...state, detail: state.detail ?? reason });
        this.attempt = 0;
        this.beginMonitoring();
        return state;
      } catch (error) {
        this.attempt++;
        const delay = this.backoffMs(this.attempt);
        if (this.stopped) return this.state ?? offlineState(this.provider.name, reason);
        this.publish({
          provider: this.provider.name,
          status: "offline",
          healthy: false,
          transportHealthy: false,
          backendHealthy: false,
          publicHealthy: false,
          localTarget: this.state?.localTarget ?? "",
          detail: `${reason}: ${String(error)}`,
        });
        await new Promise<void>((resolve) => {
          const wake = () => {
            this.retryWakeups.delete(wake);
            if (this.timer) clearTimeout(this.timer);
            this.timer = null;
            resolve();
          };
          this.retryWakeups.add(wake);
          this.timer = setTimeout(() => {
            this.retryWakeups.delete(wake);
            this.timer = null;
            resolve();
          }, delay);
        });
      }
    }
  }

  private beginMonitoring(): void {
    const interval = this.options.monitorIntervalMs ?? 15_000;
    if (interval <= 0 || this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.provider.status()
        .then((state) => {
          if (this.stopped) return;
          this.publish(state);
          // Application/public readiness can degrade without requiring a
          // provider restart. Only transport loss merits recovery here.
          if (!state.transportHealthy) {
            void this.requestRecovery("tunnel transport degraded")
              .catch((error) => {
                if (!this.stopped) console.warn(`Tunnel recovery failed: ${String(error)}`);
              });
            return;
          }
          this.beginMonitoring();
        })
        .catch((error) => {
          if (this.stopped) return;
          void this.requestRecovery(`tunnel status failed: ${String(error)}`)
            .catch((recoveryError) => {
              if (!this.stopped) console.warn(`Tunnel recovery failed: ${String(recoveryError)}`);
            });
        });
    }, interval);
  }

  private publish(state: TunnelState): void {
    this.state = state;
    this.options.onState?.(state);
  }

  private backoffMs(attempt: number): number {
    const base = Math.min(
      this.options.maxBackoffMs ?? 30_000,
      (this.options.baseBackoffMs ?? 500) * 2 ** Math.min(attempt - 1, 6),
    );
    const ratio = this.options.jitterRatio ?? 0.25;
    return base + Math.floor(Math.random() * Math.max(1, base * ratio));
  }
}

function offlineState(provider: TunnelProvider["name"], detail: string): TunnelState {
  return {
    provider,
    status: "offline",
    healthy: false,
    transportHealthy: false,
    backendHealthy: false,
    publicHealthy: false,
    localTarget: "",
    detail,
  };
}
