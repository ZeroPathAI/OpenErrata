import { runStartupChecks } from "$lib/config/startup.js";
import { startWorker } from "./worker-runner.js";

async function main(): Promise<void> {
  console.log("Starting OpenErrata investigation worker...");
  await runStartupChecks("worker");
  await startWorker();
}

main().catch((err: unknown) => {
  console.error("Worker failed:", err);
  process.exit(1);
});
