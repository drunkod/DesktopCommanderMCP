import type { Device } from "../schema";

type ReconnectState = Pick<
  Device,
  "reconnectGeneration" | "reconnectRequestedAt" | "status" | "lastSeenAt"
>;

export function registrationReconnectPatch(
  device: Pick<ReconnectState, "reconnectGeneration" | "reconnectRequestedAt">,
): {
  reconnectGeneration: number;
  reconnectRequestedAt: undefined;
} {
  return {
    reconnectGeneration: device.reconnectRequestedAt
      ? device.reconnectGeneration + 1
      : device.reconnectGeneration,
    reconnectRequestedAt: undefined,
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

export function isReconnectReady(
  device: Pick<ReconnectState, "reconnectRequestedAt" | "status" | "lastSeenAt">,
  completedAt: Date,
): boolean {
  return device.status === "online"
    && !device.reconnectRequestedAt
    && device.lastSeenAt.getTime() > completedAt.getTime();
}
