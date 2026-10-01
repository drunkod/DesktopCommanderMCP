import crypto from "node:crypto";
import type { Db } from "jazz-tools";
import { app, type RemoteCall } from "../schema";
import { jazzAuthorityDb } from "./jazz-authority";
import { toJsonValue } from "./json";
import { deterministicUuid } from "./ids";
import { EffectAdmissionFrozenError, isEffectAdmissionFrozen } from "./cutover-mode";

const ONLINE_MAX_AGE_MS = 45_000;

export type DispatchInput = {
  deviceId: string;
  toolName: string;
  toolArgs: unknown;
  metadata?: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
};

export async function dispatchRemoteCall(
  subject: string,
  input: DispatchInput,
): Promise<RemoteCall> {
  const db = await jazzAuthorityDb();
  const device = await db.one(
    app.devices.where({ id: input.deviceId }),
    { tier: "global" },
  );
  if (!device || device.ownerId !== subject || device.revokedAt) throw new Error("Device not found or revoked");
  if (Date.now() - device.lastSeenAt.getTime() > ONLINE_MAX_AGE_MS) {
    throw new Error("Device heartbeat is stale; refusing remote execution");
  }
  const timeoutMs = input.timeoutMs ?? 120_000;
  const metadata = input.metadata ?? {};
  const fingerprint = sha256(stableStringify({
    deviceId: input.deviceId,
    toolName: input.toolName,
    toolArgs: toJsonValue(input.toolArgs, "tool arguments"),
    metadata: toJsonValue(metadata, "call metadata"),
  }));

  const callId = input.idempotencyKey
    ? await getOrCreateIdempotentCall(db, subject, device.id, input, metadata, fingerprint, timeoutMs)
    : await createOrdinaryCall(db, subject, device.id, input, metadata, fingerprint, timeoutMs);

  return waitForTerminal(db, callId, timeoutMs);
}

async function createOrdinaryCall(
  db: Db,
  subject: string,
  deviceRowId: string,
  input: DispatchInput,
  metadata: unknown,
  fingerprint: string,
  timeoutMs: number,
): Promise<string> {
  if (isEffectAdmissionFrozen()) throw new EffectAdmissionFrozenError();
  const write = db.insert(app.remoteCalls, {
    ownerId: subject,
    requestId: crypto.randomUUID(),
    requestFingerprint: fingerprint,
    deviceId: deviceRowId,
    toolName: input.toolName,
    toolArgs: toJsonValue(input.toolArgs, "tool arguments"),
    metadata: toJsonValue(metadata, "call metadata"),
    status: "pending",
    expiresAt: new Date(Date.now() + timeoutMs),
  });
  await write.wait({ tier: "global" });
  return write.value.id;
}

async function getOrCreateIdempotentCall(
  db: Db,
  subject: string,
  deviceRowId: string,
  input: DispatchInput,
  metadata: unknown,
  fingerprint: string,
  timeoutMs: number,
): Promise<string> {
  const key = input.idempotencyKey!;
  const rowId = deterministicUuid(
    "mcp-call",
    `${subject}\0${input.deviceId}\0${key}`,
  );

  try {
    const exclusive = await db.transaction(async (tx) => {
      const existing = await tx.one(app.remoteCalls.where({ id: rowId }), { tier: "global" });
      if (existing) {
        assertSameRequest(existing, fingerprint, key);
        return existing.id;
      }
      if (isEffectAdmissionFrozen()) throw new EffectAdmissionFrozenError();
      const row = tx.insert(app.remoteCalls, {
        ownerId: subject,
        requestId: key,
        requestFingerprint: fingerprint,
        deviceId: deviceRowId,
        toolName: input.toolName,
        toolArgs: toJsonValue(input.toolArgs, "tool arguments"),
        metadata: toJsonValue(metadata, "call metadata"),
        status: "pending",
        expiresAt: new Date(Date.now() + timeoutMs),
      }, { id: rowId });
      return row.id;
    });
    return await exclusive.wait({ tier: "global" });
  } catch (error) {
    // A simultaneous transaction can lose authority validation after both read
    // "missing". Re-read the deterministic row and converge on the winner.
    const winner = await db.one(app.remoteCalls.where({ id: rowId }), { tier: "global" });
    if (!winner) throw error;
    assertSameRequest(winner, fingerprint, key);
    return winner.id;
  }
}

function assertSameRequest(call: RemoteCall, fingerprint: string, key: string): void {
  if (call.requestFingerprint !== fingerprint) {
    throw new Error(`Idempotency key '${key}' was reused with a different request`);
  }
}
async function waitForTerminal(db: Db, callId: string, timeoutMs: number): Promise<RemoteCall> {
  const query = app.remoteCalls.where({ id: callId });
  const existing = await db.one(query, { tier: "global" });
  if (existing && isTerminal(existing.status)) return existing;

  return new Promise<RemoteCall>((resolve, reject) => {
    let done = false;
    let unsubscribe: (() => void) | null = null;
    let timer: NodeJS.Timeout | null = null;
    const deferUnsubscribe = (stop: () => void) => { setTimeout(stop, 0); };
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      const stop = unsubscribe;
      unsubscribe = null;
      fn();
      if (stop) deferUnsubscribe(stop);
    };
    const stop = db.subscribeAll(query, (delta) => {
      const row = delta.all[0];
      if (row && isTerminal(row.status)) finish(() => resolve(row));
    }, { tier: "global" });
    unsubscribe = stop;
    if (done) {
      unsubscribe = null;
      deferUnsubscribe(stop);
    }
    timer = setTimeout(() => {
      finish(() => reject(new Error("Remote call " + callId + " timed out")));
    }, timeoutMs);
  });
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "indeterminate";
}
function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(input)
      .sort()
      .map((key) => [key, sortValue(input[key])]),
  );
}
