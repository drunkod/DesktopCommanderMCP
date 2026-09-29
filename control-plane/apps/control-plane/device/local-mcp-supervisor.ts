export interface LocalMcpBridge {
  initialize(): Promise<void>;
  listClientTools(): Promise<{ tools: unknown[] }>;
  callClientTool(name: string, args: unknown, metadata?: unknown): Promise<unknown>;
  shutdown(): Promise<void>;
}

export class LocalMcpSupervisor {
  private bridge: LocalMcpBridge | null = null;
  private restartInFlight: Promise<void> | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly factory: () => LocalMcpBridge,
    private readonly onState: (online: boolean, error?: unknown) => void = () => undefined,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.restart("initial start");
    this.probeTimer = setInterval(() => void this.probe(), 15_000);
  }

  async callTool(name: string, args: unknown, metadata?: unknown): Promise<unknown> {
    if (!this.bridge) await this.restart("call while disconnected");
    try {
      return await this.bridge!.callClientTool(name, args, metadata);
    } catch (error) {      this.onState(false, error);
      await this.restart(`tool failure: ${name}`);
      throw error;
    }
  }

  async listTools(): Promise<{ tools: unknown[] }> {
    if (!this.bridge) await this.restart("listTools while disconnected");
    return this.bridge!.listClientTools();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
    const bridge = this.bridge;
    this.bridge = null;
    await bridge?.shutdown().catch(() => undefined);
    this.onState(false);
  }

  private async probe(): Promise<void> {
    if (this.stopped || !this.bridge) return;
    try {
      await this.bridge.listClientTools();
      this.onState(true);
    } catch (error) {
      this.onState(false, error);
      await this.restart("health probe failed");
    }
  }
  private async restart(reason: string): Promise<void> {
    if (this.restartInFlight) return this.restartInFlight;
    this.restartInFlight = this.doRestart(reason)
      .finally(() => { this.restartInFlight = null; });
    return this.restartInFlight;
  }

  private async doRestart(reason: string): Promise<void> {
    const old = this.bridge;
    this.bridge = null;
    await old?.shutdown().catch(() => undefined);

    let attempt = 0;
    while (!this.stopped) {
      attempt += 1;
      try {
        const next = this.factory();
        await next.initialize();
        this.bridge = next;
        this.onState(true);
        return;
      } catch (error) {
        this.onState(false, new Error(`${reason}: ${String(error)}`));
        const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
