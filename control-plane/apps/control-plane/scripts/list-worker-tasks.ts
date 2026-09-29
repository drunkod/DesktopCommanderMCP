import { runWorkerCli } from "./worker-cli";

const subject = process.env.WORKER_TASK_OWNER_ID?.trim();
if (!subject) throw new Error("WORKER_TASK_OWNER_ID is required");

await runWorkerCli(async () => {
  const [{ app }, { jazzBackendDb }] = await Promise.all([
    import("../schema"),
    import("../lib/jazz-principal"),
  ]);

  const db = jazzBackendDb();
  const rows = await db.all(
    app.chatJobs.where({ ownerId: subject }).orderBy("createdAt", "asc"),
    { tier: "global" },
  );

  console.log(JSON.stringify(rows.map((row) => ({
    id: row.id,
    status: row.status,
    prompt: row.prompt,
    answer: row.answer ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  })), null, 2));
});
