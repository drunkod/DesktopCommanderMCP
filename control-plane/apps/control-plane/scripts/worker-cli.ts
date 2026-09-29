import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Keep each CLI runtime separate from the web process's persistent cache. */
export async function withWorkerBackend(run: () => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "remote-mcp-worker-cli-"));
  const previousPath = process.env.JAZZ_BACKEND_DATA_PATH;
  process.env.JAZZ_BACKEND_DATA_PATH = join(directory, "runtime.db");
  try {
    // Import the queue/env only inside run, after selecting the isolated store.
    await run();
  } finally {
    try {
      await globalThis.__remoteMcpJazzContext?.shutdown();
      globalThis.__remoteMcpJazzContext = undefined;
    } finally {
      if (previousPath === undefined) delete process.env.JAZZ_BACKEND_DATA_PATH;
      else process.env.JAZZ_BACKEND_DATA_PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    }
  }
}


/** CLI entrypoints exit explicitly after Jazz cleanup because alpha.53 NAPI can retain process handles. */
export async function runWorkerCliWithExitCode(run: () => Promise<number>): Promise<never> {
  let exitCode = 1;
  try {
    await withWorkerBackend(async () => {
      exitCode = await run();
    });
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
  process.exit(exitCode);
}

export async function runWorkerCli(run: () => Promise<void>): Promise<never> {
  return runWorkerCliWithExitCode(async () => {
    await run();
    return 0;
  });
}
