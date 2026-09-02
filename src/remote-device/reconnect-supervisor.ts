export type ReconnectHooks = {
  disconnect: () => Promise<void>;
  connect: () => Promise<void>;
  onState?: (state: "connecting" | "online" | "offline", reason: string) => void;
};

export class ReconnectSupervisor {
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private attempt = 0;

  constructor(private readonly hooks: ReconnectHooks) {}

  async request(reason: string): Promise<void> {
    if (this.stopped) throw new Error("Reconnect supervisor is stopped");
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.reconnect(reason)
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  stop(): void {
    this.stopped = true;
  }

  private async reconnect(reason: string): Promise<void> {
    this.hooks.onState?.("connecting", reason);
    await this.hooks.disconnect().catch(() => undefined);
    for (;;) {
      if (this.stopped) throw new Error("Reconnect aborted: supervisor stopped");
      try {
        await this.hooks.connect();
        this.attempt = 0;
        this.hooks.onState?.("online", reason);
        return;
      } catch (error) {
        this.attempt += 1;
        this.hooks.onState?.("offline", `${reason}: ${String(error)}`);
        const delay = this.backoffMs(this.attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private backoffMs(attempt: number): number {
    const base = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
    const jitter = Math.floor(Math.random() * Math.max(250, base * 0.25));
    return base + jitter;
  }
}
