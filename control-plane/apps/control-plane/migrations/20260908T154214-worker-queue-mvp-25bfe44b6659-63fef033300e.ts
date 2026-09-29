import { schema as s } from "jazz-tools";

export default s.defineMigration({
  createTables: {
    "chatJobs": true,
    "workerSessions": true,
  },
  fromHash: "25bfe44b6659",
  toHash: "63fef033300e",
  from: {},
  to: {
  "chatJobs": s.table({
    "ownerId": s.string(),
    "requesterId": s.string(),
    "source": s.string(),
    "requestId": s.string(),
    "requestFingerprint": s.string(),
    "conversationId": s.string().optional(),
    "prompt": s.string(),
    "status": s.string(),
    "answer": s.string().optional(),
    "error": s.string().optional(),
    "claimedBySessionId": s.ref("workerSessions").optional(),
    "claimedAt": s.timestamp().optional(),
    "createdAt": s.timestamp(),
    "updatedAt": s.timestamp(),
    "completedAt": s.timestamp().optional(),
  }),
  "workerSessions": s.table({
    "ownerId": s.string(),
    "status": s.string(),
    "startedAt": s.timestamp(),
    "lastSeenAt": s.timestamp(),
    "expiresAt": s.timestamp(),
    "closedAt": s.timestamp().optional(),
  })
},
});
