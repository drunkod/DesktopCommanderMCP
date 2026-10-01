import type { Device } from "../schema";

type ReconnectState = Pick<
  Device,
  "reconnectGeneration" | "reconnectRequestedAt" | "status" | "lastSeenAt"
>;

export function registrationReconnectPatch(
  device: Pick<ReconnectState, "reconnectGeneration" | "reconnectRequestedAt">,
): {
  reconnectGeneration: number;
  reconnectRequestedAt: null;
} {
  return {
    reconnectGeneration: device.reconnectRequestedAt
      ? device.reconnectGeneration + 1
      : device.reconnectGeneration,
    reconnectRequestedAt: null,
  };
}

export function heartbeatStatusDuringReconnect(
  device: Pick<ReconnectState, "reconnectRequestedAt">,
  requestedStatus: "online" | "offline",
): "online" | "offline" | "reconnecting" {
  if (device.reconnectRequestedAt && requestedStatus === "online") {
    return "reconnecting";
  }
  return requestedStatus;
}

export function reconnectTargetGeneration(toolArgs: unknown): number | null {
  if (!toolArgs || typeof toolArgs !== "object" || Array.isArray(toolArgs)) return null;
  const value = (toolArgs as Record<string, unknown>).reconnectGeneration;
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    ? value
    : null;
}

export function isReconnectReady(
  device: Pick<
    ReconnectState,
    "reconnectGeneration" | "reconnectRequestedAt" | "status" | "lastSeenAt"
  >,
  completedAt: Date,
  targetGeneration: number,
): boolean {
  return device.status === "online"
    && !device.reconnectRequestedAt
    && device.reconnectGeneration >= targetGeneration
    && device.lastSeenAt.getTime() > completedAt.getTime();
}
