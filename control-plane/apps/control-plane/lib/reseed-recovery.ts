import { createHash } from "node:crypto";
import {
  app,
  type AuditEvent,
  type ChatJob,
  type Device,
  type RemoteCall,
  type WorkerSession,
} from "../schema";

export type TableName = "devices" | "remoteCalls" | "workerSessions" | "chatJobs" | "auditEvents";

export type LogicalSnapshot = {
  devices: Device[];
  remoteCalls: RemoteCall[];
  workerSessions: WorkerSession[];
  chatJobs: ChatJob[];
  auditEvents: AuditEvent[];
};

export type SnapshotIssue = {
  table: TableName;
  id: string;
  kind: "missing-backend" | "missing-admin" | "divergent";
  fields?: string[];
};

export type KnownDivergence = {
  table: "devices";
  id: string;
  fields: ["stableId"];
};

export type SnapshotTableSummary = {
  backendCount: number;
  adminCount: number;
  backendHash: string;
  adminHash: string;
};

export type SourceComparison = {
  sourceComplete: boolean;
  tables: Record<TableName, SnapshotTableSummary>;
  knownDivergences: KnownDivergence[];
  unexplainedIssues: SnapshotIssue[];
};

export type ExactComparison = {
  equivalent: boolean;
  expectedCount: number;
  actualCount: number;
  expectedHash: string;
  actualHash: string;
  missingIds: string[];
  extraIds: string[];
  divergentRows: { id: string; fields: string[] }[];
};

const TABLES: TableName[] = ["devices", "remoteCalls", "workerSessions", "chatJobs", "auditEvents"];

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, normalize(item)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function serializeDevice(row: Device): Device {
  return {
    id: row.id,
    ownerId: row.ownerId,
    stableId: row.stableId,
    oauthClientId: row.oauthClientId,
    name: row.name,
    platform: row.platform,
    appVersion: row.appVersion,
    capabilities: row.capabilities,
    status: row.status,
    lastSeenAt: row.lastSeenAt,
    lastError: row.lastError,
    reconnectGeneration: row.reconnectGeneration,
    reconnectRequestedAt: row.reconnectRequestedAt,
    revokedAt: row.revokedAt,
    authRevocationState: row.authRevocationState,
    authRevocationLastAttemptAt: row.authRevocationLastAttemptAt,
    authRevocationError: row.authRevocationError,
  } as Device;
}

export function serializeRemoteCall(row: RemoteCall): RemoteCall {
  return {
    id: row.id,
    ownerId: row.ownerId,
    requestId: row.requestId,
    requestFingerprint: row.requestFingerprint,
    deviceId: row.deviceId,
    toolName: row.toolName,
    toolArgs: row.toolArgs,
    metadata: row.metadata,
    status: row.status,
    result: row.result,
    error: row.error,
    claimedByClientId: row.claimedByClientId,
    claimedAt: row.claimedAt,
    completedAt: row.completedAt,
    expiresAt: row.expiresAt,
  } as RemoteCall;
}

export function serializeWorkerSession(row: WorkerSession): WorkerSession {
  return {
    id: row.id,
    ownerId: row.ownerId,
    status: row.status,
    startedAt: row.startedAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    closedAt: row.closedAt,
  } as WorkerSession;
}

export function serializeChatJob(row: ChatJob): ChatJob {
  return {
    id: row.id,
    ownerId: row.ownerId,
    requesterId: row.requesterId,
    source: row.source,
    requestId: row.requestId,
    requestFingerprint: row.requestFingerprint,
    conversationId: row.conversationId,
    prompt: row.prompt,
    status: row.status,
    answer: row.answer,
    error: row.error,
    claimedBySessionId: row.claimedBySessionId,
    claimedAt: row.claimedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  } as ChatJob;
}

export function serializeAuditEvent(row: AuditEvent): AuditEvent {
  return {
    id: row.id,
    ownerId: row.ownerId,
    kind: row.kind,
    deviceId: row.deviceId,
    remoteCallId: row.remoteCallId,
    summary: row.summary,
    details: row.details,
    occurredAt: row.occurredAt,
  } as AuditEvent;
}

function sortById<T extends { id: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export async function readLogicalSnapshot(db: any): Promise<LogicalSnapshot> {
  const [devices, remoteCalls, workerSessions, chatJobs, auditEvents] = await Promise.all([
    db.all(app.devices, { tier: "global" }),
    db.all(app.remoteCalls, { tier: "global" }),
    db.all(app.workerSessions, { tier: "global" }),
    db.all(app.chatJobs, { tier: "global" }),
    db.all(app.auditEvents, { tier: "global" }),
  ]);
  return {
    devices: sortById((devices as Device[]).map(serializeDevice)),
    remoteCalls: sortById((remoteCalls as RemoteCall[]).map(serializeRemoteCall)),
    workerSessions: sortById((workerSessions as WorkerSession[]).map(serializeWorkerSession)),
    chatJobs: sortById((chatJobs as ChatJob[]).map(serializeChatJob)),
    auditEvents: sortById((auditEvents as AuditEvent[]).map(serializeAuditEvent)),
  };
}

function differingFields(left: Record<string, unknown>, right: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].filter((key) => stableJson(left[key]) !== stableJson(right[key])).sort();
}

function omitStableId(row: Device): Record<string, unknown> {
  const copy = serializeDevice(row) as unknown as Record<string, unknown>;
  delete copy.stableId;
  return copy;
}

export function compareSourceSnapshots(
  backend: LogicalSnapshot,
  admin: LogicalSnapshot,
  input: { deviceId: string; expectedBackendStableId: string; expectedCanonicalStableId: string },
): SourceComparison {
  const tables = {} as Record<TableName, SnapshotTableSummary>;
  const knownDivergences: KnownDivergence[] = [];
  const unexplainedIssues: SnapshotIssue[] = [];

  for (const table of TABLES) {
    const backendRows = backend[table] as Array<{ id: string }>;
    const adminRows = admin[table] as Array<{ id: string }>;
    tables[table] = {
      backendCount: backendRows.length,
      adminCount: adminRows.length,
      backendHash: sha256Json(backendRows),
      adminHash: sha256Json(adminRows),
    };
    const backendById = new Map(backendRows.map((row) => [row.id, row]));
    const adminById = new Map(adminRows.map((row) => [row.id, row]));
    const ids = [...new Set([...backendById.keys(), ...adminById.keys()])].sort();
    for (const id of ids) {
      const left = backendById.get(id);
      const right = adminById.get(id);
      if (!left) {
        unexplainedIssues.push({ table, id, kind: "missing-backend" });
        continue;
      }
      if (!right) {
        unexplainedIssues.push({ table, id, kind: "missing-admin" });
        continue;
      }
      if (stableJson(left) === stableJson(right)) continue;
      if (table === "devices" && id === input.deviceId) {
        const backendDevice = left as Device;
        const adminDevice = right as Device;
        if (
          backendDevice.stableId === input.expectedBackendStableId
          && adminDevice.stableId === input.expectedCanonicalStableId
          && stableJson(omitStableId(backendDevice)) === stableJson(omitStableId(adminDevice))
        ) {
          knownDivergences.push({ table: "devices", id, fields: ["stableId"] });
          continue;
        }
      }
      unexplainedIssues.push({
        table,
        id,
        kind: "divergent",
        fields: differingFields(left as Record<string, unknown>, right as Record<string, unknown>),
      });
    }
  }

  return {
    sourceComplete: unexplainedIssues.length === 0 && knownDivergences.length === 1,
    tables,
    knownDivergences,
    unexplainedIssues,
  };
}

export function compareExactTable(expectedRows: any[], actualRows: any[]): ExactComparison {
  const expected = [...expectedRows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const actual = [...actualRows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const expectedById = new Map(expected.map((row) => [String(row.id), row]));
  const actualById = new Map(actual.map((row) => [String(row.id), row]));
  const missingIds = [...expectedById.keys()].filter((id) => !actualById.has(id)).sort();
  const extraIds = [...actualById.keys()].filter((id) => !expectedById.has(id)).sort();
  const divergentRows: { id: string; fields: string[] }[] = [];
  for (const id of [...expectedById.keys()].filter((key) => actualById.has(key)).sort()) {
    const left = expectedById.get(id)!;
    const right = actualById.get(id)!;
    if (stableJson(left) !== stableJson(right)) {
      divergentRows.push({ id, fields: differingFields(left, right) });
    }
  }
  return {
    equivalent: missingIds.length === 0 && extraIds.length === 0 && divergentRows.length === 0,
    expectedCount: expected.length,
    actualCount: actual.length,
    expectedHash: sha256Json(expected),
    actualHash: sha256Json(actual),
    missingIds,
    extraIds,
    divergentRows,
  };
}

export function compareExactSnapshots(
  expected: LogicalSnapshot,
  actual: LogicalSnapshot,
): Record<TableName, ExactComparison> {
  return {
    devices: compareExactTable(expected.devices, actual.devices),
    remoteCalls: compareExactTable(expected.remoteCalls, actual.remoteCalls),
    workerSessions: compareExactTable(expected.workerSessions, actual.workerSessions),
    chatJobs: compareExactTable(expected.chatJobs, actual.chatJobs),
    auditEvents: compareExactTable(expected.auditEvents, actual.auditEvents),
  };
}

export function snapshotEquivalent(report: Record<TableName, ExactComparison>): boolean {
  return TABLES.every((table) => report[table].equivalent);
}

function devicePayload(row: Device) {
  return {
    ownerId: row.ownerId,
    stableId: row.stableId,
    oauthClientId: row.oauthClientId,
    name: row.name,
    platform: row.platform,
    appVersion: row.appVersion,
    capabilities: row.capabilities,
    status: row.status,
    lastSeenAt: row.lastSeenAt,
    lastError: row.lastError,
    reconnectGeneration: row.reconnectGeneration,
    reconnectRequestedAt: row.reconnectRequestedAt,
    revokedAt: row.revokedAt,
    authRevocationState: row.authRevocationState,
    authRevocationLastAttemptAt: row.authRevocationLastAttemptAt,
    authRevocationError: row.authRevocationError,
  };
}

function workerSessionPayload(row: WorkerSession) {
  return {
    ownerId: row.ownerId,
    status: row.status,
    startedAt: row.startedAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    closedAt: row.closedAt,
  };
}

function remoteCallPayload(row: RemoteCall) {
  return {
    ownerId: row.ownerId,
    requestId: row.requestId,
    requestFingerprint: row.requestFingerprint,
    deviceId: row.deviceId,
    toolName: row.toolName,
    toolArgs: row.toolArgs,
    metadata: row.metadata,
    status: row.status,
    result: row.result,
    error: row.error,
    claimedByClientId: row.claimedByClientId,
    claimedAt: row.claimedAt,
    completedAt: row.completedAt,
    expiresAt: row.expiresAt,
  };
}

function chatJobPayload(row: ChatJob) {
  return {
    ownerId: row.ownerId,
    requesterId: row.requesterId,
    source: row.source,
    requestId: row.requestId,
    requestFingerprint: row.requestFingerprint,
    conversationId: row.conversationId,
    prompt: row.prompt,
    status: row.status,
    answer: row.answer,
    error: row.error,
    claimedBySessionId: row.claimedBySessionId,
    claimedAt: row.claimedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

function auditEventPayload(row: AuditEvent) {
  return {
    ownerId: row.ownerId,
    kind: row.kind,
    deviceId: row.deviceId,
    remoteCallId: row.remoteCallId,
    summary: row.summary,
    details: row.details,
    occurredAt: row.occurredAt,
  };
}

async function importTable(
  table: TableName,
  rows: Array<{ id: string }>,
  write: (row: any) => { wait(options: { tier: "global" }): Promise<unknown> },
  onProgress?: (phase: string) => void,
): Promise<void> {
  onProgress?.(table + ":start:" + rows.length);
  for (let index = 0; index < rows.length; index += 1) {
    const handle = write(rows[index]!);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        handle.wait({ tier: "global" }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(
              "logical reseed import timed out for table " + table
              + " at row " + (index + 1) + "/" + rows.length,
            )),
            20_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    onProgress?.(table + ":row:" + (index + 1) + "/" + rows.length);
  }
  onProgress?.(table + ":complete");
}

export async function importLogicalSnapshot(
  adminDb: any,
  snapshot: LogicalSnapshot,
  onProgress?: (phase: string) => void,
): Promise<void> {
  await importTable("devices", snapshot.devices, (row: Device) =>
    adminDb.upsert(app.devices, devicePayload(row), { id: row.id }), onProgress);
  await importTable("workerSessions", snapshot.workerSessions, (row: WorkerSession) =>
    adminDb.upsert(app.workerSessions, workerSessionPayload(row), { id: row.id }), onProgress);
  await importTable("remoteCalls", snapshot.remoteCalls, (row: RemoteCall) =>
    adminDb.upsert(app.remoteCalls, remoteCallPayload(row), { id: row.id }), onProgress);
  await importTable("chatJobs", snapshot.chatJobs, (row: ChatJob) =>
    adminDb.upsert(app.chatJobs, chatJobPayload(row), { id: row.id }), onProgress);
  await importTable("auditEvents", snapshot.auditEvents, (row: AuditEvent) =>
    adminDb.upsert(app.auditEvents, auditEventPayload(row), { id: row.id }), onProgress);
}

export function safeDeviceIdentity(row: Device | null) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.ownerId,
    oauthClientId: row.oauthClientId,
    stableId: row.stableId,
    status: row.status,
    revoked: Boolean(row.revokedAt),
  };
}

export function fourDeviceIdentitiesCanonical(
  rows: Array<Device | null>,
  expectedCanonicalStableId: string,
): boolean {
  if (rows.length !== 4 || rows.some((row) => row === null)) return false;
  const identities = rows.map((row) => safeDeviceIdentity(row as Device));
  const first = identities[0]!;
  if (first.stableId !== expectedCanonicalStableId || first.revoked) return false;
  return identities.every((identity) => stableJson(identity) === stableJson(first));
}



export type CompositeTableSelection = {
  backendOnly: number;
  adminOnly: number;
  identicalOverlap: number;
  mergedOverlap: number;
};

export type CompositeIssue = {
  table: TableName;
  id: string;
  reason: string;
  fields?: string[];
};

export type CompositeReferenceClosure = {
  ok: boolean;
  issues: { table: string; id: string; field: string }[];
};

export function supportedSourceProvenance(
  tables: Record<TableName, CompositeTableSelection>,
): boolean {
  return (
    tables.devices.backendOnly === 0
    && tables.devices.identicalOverlap === 0
    && tables.devices.mergedOverlap === 1
    && tables.remoteCalls.backendOnly === 0
    && tables.remoteCalls.identicalOverlap === 0
    && tables.remoteCalls.mergedOverlap === 0
    && tables.auditEvents.backendOnly === 0
    && tables.auditEvents.identicalOverlap === 0
    && tables.auditEvents.mergedOverlap === 0
    && tables.workerSessions.adminOnly === 0
    && tables.workerSessions.identicalOverlap === 0
    && tables.workerSessions.mergedOverlap === 0
    && tables.chatJobs.adminOnly === 0
    && tables.chatJobs.identicalOverlap === 0
    && tables.chatJobs.mergedOverlap === 0
  );
}

export type CompositeRecovery = {
  recoverable: boolean;
  snapshot: LogicalSnapshot;
  tables: Record<TableName, CompositeTableSelection>;
  targetMerge: null | {
    id: string;
    stableIdSource: "admin";
    lastSeenAtSource: "backend" | "admin";
    backendLastSeenAt: string;
    adminLastSeenAt: string;
    selectedLastSeenAt: string;
  };
  issues: CompositeIssue[];
  referenceClosure: CompositeReferenceClosure;
};

export function snapshotReferenceClosure(snapshot: LogicalSnapshot): CompositeReferenceClosure {
  const deviceIds = new Set(snapshot.devices.map((row) => row.id));
  const sessionIds = new Set(snapshot.workerSessions.map((row) => row.id));
  const callIds = new Set(snapshot.remoteCalls.map((row) => row.id));
  const issues = new Map<string, { table: string; id: string; field: string }>();

  for (const row of snapshot.remoteCalls) {
    if (!deviceIds.has(String(row.deviceId))) {
      issues.set("remoteCalls:" + row.id + ":deviceId", { table: "remoteCalls", id: row.id, field: "deviceId" });
    }
  }
  for (const row of snapshot.chatJobs) {
    if (row.claimedBySessionId && !sessionIds.has(String(row.claimedBySessionId))) {
      issues.set("chatJobs:" + row.id + ":claimedBySessionId", {
        table: "chatJobs",
        id: row.id,
        field: "claimedBySessionId",
      });
    }
  }
  for (const row of snapshot.auditEvents) {
    if (row.deviceId && !deviceIds.has(String(row.deviceId))) {
      issues.set("auditEvents:" + row.id + ":deviceId", { table: "auditEvents", id: row.id, field: "deviceId" });
    }
    if (row.remoteCallId && !callIds.has(String(row.remoteCallId))) {
      issues.set("auditEvents:" + row.id + ":remoteCallId", {
        table: "auditEvents",
        id: row.id,
        field: "remoteCallId",
      });
    }
  }

  const list = [...issues.values()].sort((a, b) =>
    a.table.localeCompare(b.table) || a.id.localeCompare(b.id) || a.field.localeCompare(b.field));
  return { ok: list.length === 0, issues: list };
}

export function buildCompositeRecoverySnapshot(
  backend: LogicalSnapshot,
  admin: LogicalSnapshot,
  input: { deviceId: string; expectedBackendStableId: string; expectedCanonicalStableId: string },
): CompositeRecovery {
  const tables = {} as Record<TableName, CompositeTableSelection>;
  const issues: CompositeIssue[] = [];
  let targetMerge: CompositeRecovery["targetMerge"] = null;

  const mergeTable = (table: TableName): any[] => {
    const backendRows = backend[table] as any[];
    const adminRows = admin[table] as any[];
    const backendById = new Map(backendRows.map((row) => [row.id, row]));
    const adminById = new Map(adminRows.map((row) => [row.id, row]));
    const selection: CompositeTableSelection = {
      backendOnly: 0,
      adminOnly: 0,
      identicalOverlap: 0,
      mergedOverlap: 0,
    };
    const merged: any[] = [];

    for (const id of [...new Set([...backendById.keys(), ...adminById.keys()])].sort()) {
      const backendRow = backendById.get(id);
      const adminRow = adminById.get(id);
      if (!backendRow) {
        selection.adminOnly += 1;
        merged.push(adminRow);
        continue;
      }
      if (!adminRow) {
        selection.backendOnly += 1;
        merged.push(backendRow);
        continue;
      }
      if (stableJson(backendRow) === stableJson(adminRow)) {
        selection.identicalOverlap += 1;
        merged.push(adminRow);
        continue;
      }

      if (table === "devices" && id === input.deviceId) {
        const backendDevice = backendRow as Device;
        const adminDevice = adminRow as Device;
        const fields = differingFields(
          backendDevice as unknown as Record<string, unknown>,
          adminDevice as unknown as Record<string, unknown>,
        );
        const allowedFields = new Set(["stableId", "lastSeenAt"]);
        const onlyAllowedFields = fields.includes("stableId") && fields.every((field) => allowedFields.has(field));
        const backendWithoutMergeFields = serializeDevice(backendDevice) as unknown as Record<string, unknown>;
        const adminWithoutMergeFields = serializeDevice(adminDevice) as unknown as Record<string, unknown>;
        delete backendWithoutMergeFields.stableId;
        delete backendWithoutMergeFields.lastSeenAt;
        delete adminWithoutMergeFields.stableId;
        delete adminWithoutMergeFields.lastSeenAt;

        if (
          onlyAllowedFields
          && backendDevice.stableId === input.expectedBackendStableId
          && adminDevice.stableId === input.expectedCanonicalStableId
          && stableJson(backendWithoutMergeFields) === stableJson(adminWithoutMergeFields)
        ) {
          const mergedDevice = serializeDevice(adminDevice);
          const useBackendTime = backendDevice.lastSeenAt.getTime() >= adminDevice.lastSeenAt.getTime();
          mergedDevice.lastSeenAt = useBackendTime ? backendDevice.lastSeenAt : adminDevice.lastSeenAt;
          selection.mergedOverlap += 1;
          targetMerge = {
            id,
            stableIdSource: "admin",
            lastSeenAtSource: useBackendTime ? "backend" : "admin",
            backendLastSeenAt: backendDevice.lastSeenAt.toISOString(),
            adminLastSeenAt: adminDevice.lastSeenAt.toISOString(),
            selectedLastSeenAt: mergedDevice.lastSeenAt.toISOString(),
          };
          merged.push(mergedDevice);
          continue;
        }

        issues.push({ table, id, reason: "target-device-overlap-not-explainable", fields });
        merged.push(adminRow);
        continue;
      }

      issues.push({
        table,
        id,
        reason: "unexplained-overlap-divergence",
        fields: differingFields(backendRow, adminRow),
      });
      merged.push(adminRow);
    }

    tables[table] = selection;
    return merged.sort((a, b) => a.id.localeCompare(b.id));
  };

  const snapshot: LogicalSnapshot = {
    devices: mergeTable("devices") as Device[],
    remoteCalls: mergeTable("remoteCalls") as RemoteCall[],
    workerSessions: mergeTable("workerSessions") as WorkerSession[],
    chatJobs: mergeTable("chatJobs") as ChatJob[],
    auditEvents: mergeTable("auditEvents") as AuditEvent[],
  };
  const referenceClosure = snapshotReferenceClosure(snapshot);
  return {
    recoverable: issues.length === 0 && targetMerge !== null && referenceClosure.ok,
    snapshot,
    tables,
    targetMerge,
    issues,
    referenceClosure,
  };
}
