import { app } from "../schema";
import { jazzBackendDb } from "./jazz-principal";
import { toJsonValue } from "./json";

export type AuditInput = {
  kind: string;
  summary: string;
  details?: Record<string, unknown>;
  deviceId?: string;
  remoteCallId?: string;
};

export async function writeAuditEvent(
  subject: string,
  input: AuditInput,
): Promise<void> {
  const db = jazzBackendDb();
  const write = db.insert(app.auditEvents, {
    ownerId: subject,
    kind: input.kind,
    summary: input.summary,
    details: toJsonValue(input.details ?? {}, "audit details"),
    deviceId: input.deviceId,
    remoteCallId: input.remoteCallId,
    occurredAt: new Date(),
  });
  await write.wait({ tier: "global" });
}