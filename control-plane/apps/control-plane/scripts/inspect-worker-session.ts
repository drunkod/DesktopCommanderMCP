import { runWorkerCli } from "./worker-cli";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.length !== 1 || !args[0]?.trim()) {
  throw new Error("Usage: pnpm worker:inspect -- <session-id>");
}
const sessionId = args[0].trim();
const expectedOwner = process.env.WORKER_TASK_OWNER_ID?.trim() || undefined;

await runWorkerCli(async () => {
  const { inspectWorkerSession } = await import("../lib/worker-inspection");
  console.log(JSON.stringify(await inspectWorkerSession(sessionId, expectedOwner), null, 2));
});
