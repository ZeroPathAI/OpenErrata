import { makeWorkerUtils } from "graphile-worker";
import { getEnv } from "$lib/config/env.js";
import { createQueueManager } from "./queue-lifecycle.js";

const databaseUrl = getEnv().DATABASE_URL;
const manager = createQueueManager(() =>
  makeWorkerUtils({ connectionString: databaseUrl }),
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

export const closeQueueUtils = manager.close;
