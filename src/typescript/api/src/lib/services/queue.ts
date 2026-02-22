import { makeWorkerUtils } from "graphile-worker";
import { getEnv } from "$lib/config/env.js";
import { createQueueManager } from "./queue-lifecycle.js";

const manager = createQueueManager(() =>
  makeWorkerUtils({ connectionString: getEnv().DATABASE_URL }),
);

export async function enqueueInvestigationRun(
  runId: string,
): Promise<void> {
  const utils = await manager.acquire();
  await utils.addJob(
    "investigate",
    { runId },
    {
      maxAttempts: 4, // 1 initial + 3 retries
      jobKey: `investigate-run:${runId}`,
    },
  );
}

export async function closeQueueUtils(): Promise<void> {
  await manager.close();
}
