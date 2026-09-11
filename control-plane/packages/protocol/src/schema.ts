import { schema as s } from "jazz-tools";
import { applicationSchema } from "./application-schema.ts";

type AppSchema = s.Schema<typeof applicationSchema>;
export const app: s.App<AppSchema> = s.defineApp(applicationSchema);

export type Device = s.RowOf<typeof app.devices>;
export type RemoteCall = s.RowOf<typeof app.remoteCalls>;
export type WorkerSession = s.RowOf<typeof app.workerSessions>;
export type ChatJob = s.RowOf<typeof app.chatJobs>;
export type AuditEvent = s.RowOf<typeof app.auditEvents>;
