import { runWorkerCli } from "./worker-cli";

const subject = process.env.WORKER_TASK_OWNER_ID?.trim();
const taskText = process.argv.slice(2).join(" ").trim();

if (!subject) {
  throw new Error("WORKER_TASK_OWNER_ID is required");
}
if (!taskText) {
  throw new Error("Usage: pnpm worker:enqueue -- <task text>");
}

await runWorkerCli(async () => {
  const { enqueueWorkerTask } = await import("../lib/worker-queue");
  const job = await enqueueWorkerTask(subject, taskText);

  console.log(JSON.stringify({
    id: job.id,
    status: job.status,
    prompt: job.prompt,
    createdAt: job.createdAt.toISOString(),
  }, null, 2));
});
