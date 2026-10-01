import { app, type Device, type RemoteCall } from "../schema";
import { disableOAuthClient } from "./authorization-service";
import { dispatchRemoteCall } from "./call-router";
import { jazzAuthorityDb } from "./jazz-authority";
import { writeAuditEvent } from "./audit";
import {
  isReconnectReady,
  reconnectTargetGeneration,
} from "./device-reconnect-state";

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
  idempotencyKey?: string,
): Promise<RemoteCall> {
  const device = await getOwnedDevice(subject, rowId);
  if (device.revokedAt) throw new Error("Device is revoked");

  const targetGeneration = await resolveReconnectTargetGeneration(
    subject,
    device,
    idempotencyKey,
  );
  const call = await dispatchRemoteCall(subject, {
    deviceId: device.id,
    toolName: "__control.reconnect",
    toolArgs: { reconnectGeneration: targetGeneration },
    timeoutMs: 30_000,
    idempotencyKey,
  });
  if (call.status !== "completed" || !call.completedAt) {
    throw new Error(call.error ?? `Reconnect call ended as ${call.status}`);
  }

  await waitForReconnectReady(
    subject,
    device.id,
    call.completedAt,
    targetGeneration,
  );

  await writeAuditEvent(subject, {
    kind: "device.reconnect.requested",
    summary: `Reconnect requested for ${device.name}`,
    details: {
      stableId: device.stableId,
      reconnectGeneration: targetGeneration,
      readyAt: new Date().toISOString(),
    },
    deviceId: device.id,
  });
  return call;
}

async function resolveReconnectTargetGeneration(
  subject: string,
  device: Device,
  idempotencyKey?: string,
): Promise<number> {
  if (!idempotencyKey) return device.reconnectGeneration + 1;

  const db = await jazzAuthorityDb();
  const matches = await db.all(
    app.remoteCalls.where({
      ownerId: subject,
      deviceId: device.id,
      requestId: idempotencyKey,
    }),
    { tier: "global" },
  );
  const existing = matches[0];
  if (!existing) return device.reconnectGeneration + 1;
  if (existing.toolName !== "__control.reconnect") {
    throw new Error("Idempotency key '" + idempotencyKey + "' is already used by another request");
  }
  const target = reconnectTargetGeneration(existing.toolArgs);
  if (!target) {
    throw new Error(
      "Reconnect idempotency key '" + idempotencyKey + "' predates the readiness handshake; use a new key",
    );
  }
  return target;
}

async function waitForReconnectReady(
  subject: string,
  rowId: string,
  completedAt: Date,
  targetGeneration: number,
  timeoutMs = 45_000,
): Promise<void> {
  const db = await jazzAuthorityDb();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const device = await db.one(app.devices.where({ id: rowId }), { tier: "global" });
    if (!device || device.ownerId !== subject || device.revokedAt) {
      throw new Error("Device not found or revoked during reconnect");
    }
    if (isReconnectReady(device, completedAt, targetGeneration)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Device reconnect was accepted but did not become ready in time");
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
