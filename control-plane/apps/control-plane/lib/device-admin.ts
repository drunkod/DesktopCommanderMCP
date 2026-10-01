import { app, type Device } from "../schema";
import { disableOAuthClient } from "./authorization-service";
import { dispatchRemoteCall } from "./call-router";
import { jazzAuthorityDb } from "./jazz-authority";
import { writeAuditEvent } from "./audit";

export async function getOwnedDevice(
  subject: string,
  rowId: string,
): Promise<Device> {
  const db = await jazzAuthorityDb();
  const device = await db.one(app.devices.where({ id: rowId }), {
    tier: "global",
  });
  if (!device || device.ownerId !== subject) throw new Error("Device not found");
  return device;
}

export async function requestReconnect(
  subject: string,
  rowId: string,
): Promise<void> {
  const device = await getOwnedDevice(subject, rowId);
  if (device.revokedAt) throw new Error("Device is revoked");

  await dispatchRemoteCall(subject, {
    deviceId: device.id,
    toolName: "__control.reconnect",
    toolArgs: {},
    timeoutMs: 30_000,
  });

  await writeAuditEvent(subject, {
    kind: "device.reconnect.requested",
    summary: `Reconnect requested for ${device.name}`,
    details: { stableId: device.stableId },
    deviceId: device.id,
  });
}

export async function revokeDevice(
  subject: string,
  rowId: string,
): Promise<void> {
  const device = await getOwnedDevice(subject, rowId);
  const backend = await jazzAuthorityDb();

  if (!device.revokedAt) {
    const write = backend.update(app.devices, device.id, {
      status: "revoked",
      revokedAt: new Date(),
      lastError: "Device access revoked by user",
      authRevocationState: "pending",
      authRevocationError: undefined,
    });
    await write.wait({ tier: "global" });
  }

  let authRevocationState = "completed";
  try {
    await disableOAuthClient(device.oauthClientId);
    const write = backend.update(app.devices, device.id, {
      authRevocationState: "completed",
      authRevocationLastAttemptAt: new Date(),
      authRevocationError: undefined,
    });
    await write.wait({ tier: "global" });
  } catch (error) {
    authRevocationState = "error";
    const write = backend.update(app.devices, device.id, {
      authRevocationState,
      authRevocationLastAttemptAt: new Date(),
      authRevocationError: safeError(error),
    });
    await write.wait({ tier: "global" });
  }

  await writeAuditEvent(subject, {
    kind: "device.revoked",
    summary: `Revoked ${device.name}`,
    details: {
      stableId: device.stableId,
      oauthClientId: device.oauthClientId,
      authRevocationState,
    },
    deviceId: device.id,
  });
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 500);
}
