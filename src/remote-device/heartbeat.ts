export type HeartbeatOptions = {
  intervalMs?: number;
  unhealthyAfterMs?: number;
  onUnhealthy: (reason: string) => void;
};

export class DeviceHeartbeat {
  private timer: NodeJS.Timeout | null = null;
  private tickInFlight = false;
  private lastAcceptedAt = Date.now();

  constructor(
    private readonly send: () => Promise<void>,
    private readonly options: HeartbeatOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    const interval = this.options.intervalMs ?? 15_000;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), interval);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      await this.send();
      this.lastAcceptedAt = Date.now();
    } catch (error) {
      const unhealthyAfter = this.options.unhealthyAfterMs ?? 45_000;
      if (Date.now() - this.lastAcceptedAt >= unhealthyAfter) {
        this.options.onUnhealthy(
          `Heartbeat has not reached control plane for ${unhealthyAfter}ms: ${String(error)}`,
        );
      }
    } finally {
      this.tickInFlight = false;
    }
  }
}
