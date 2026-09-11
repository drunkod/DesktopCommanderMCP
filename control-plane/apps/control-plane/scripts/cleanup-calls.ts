import type { Db } from "jazz-tools";
import { app } from "../schema";
import { jazzContext } from "../lib/jazz-context";
import { EXECUTION_STALE_GRACE_MS } from "@remote-dc/protocol";

const TERMINAL_RETENTION_MS = Number(
  process.env.REMOTE_CALL_RETENTION_MS ?? 7 * 24 * 60 * 60 * 1000,
);

const TERMINAL = new Set([
  "completed",
  "failed",
  "cancelled",
  "indeterminate",
]);

async function main() {
  const db = jazzContext().asBackend(app);
  const now = Date.now();
  const rows = await db.all(app.remoteCalls, { tier: "global" });
  const counters = {
    cancelled: 0,
    indeterminate: 0,
    deleted: 0,
  };

  for (const row of rows) {
    if (row.status === "pending" && row.expiresAt.getTime() <= now) {
      if (await transition(db, row.id, "pending", "cancelled", now)) counters.cancelled++;
      continue;
    }
    if (
      row.status === "executing"
      && row.expiresAt.getTime() + EXECUTION_STALE_GRACE_MS <= now
    ) {
      if (await transition(db, row.id, "executing", "indeterminate", now)) {
        counters.indeterminate++;
      }
      continue;
    }

    if (
      TERMINAL.has(row.status)
      && row.completedAt
      && row.completedAt.getTime() + TERMINAL_RETENTION_MS <= now
    ) {
      if (await deleteIfStillOldTerminal(db, row.id, now)) counters.deleted++;
    }
  }

  console.log(JSON.stringify({ scanned: rows.length, ...counters }));
}

async function transition(
  db: Db,
  id: string,
  expected: string,
  next: "cancelled" | "indeterminate",
  now: number,
): Promise<boolean> {
  const result = await db.transaction(async (tx) => {
    const current = await tx.one(app.remoteCalls.where({ id }));
    if (!current || current.status !== expected) return false;

    tx.update(app.remoteCalls, id, {
      status: next,
      completedAt: new Date(now),
      error: next === "indeterminate"
        ? "Execution outcome unknown: device stopped reporting after claim"
        : "Call expired before execution",
    });
    return true;
  });
  return await result.wait({ tier: "global" });
}

async function deleteIfStillOldTerminal(
  db: Db,
  id: string,
  now: number,
): Promise<boolean> {
  const result = await db.transaction(async (tx) => {
    const current = await tx.one(app.remoteCalls.where({ id }));
    if (!current || !TERMINAL.has(current.status) || !current.completedAt) return false;
    if (current.completedAt.getTime() + TERMINAL_RETENTION_MS > now) return false;
    tx.delete(app.remoteCalls, id);
    return true;
  });
  return await result.wait({ tier: "global" });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
