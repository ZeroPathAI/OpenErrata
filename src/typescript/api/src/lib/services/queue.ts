import { makeWorkerUtils, type WorkerUtils } from "graphile-worker";
import { getEnv } from "$lib/config/env.js";

let workerUtils: WorkerUtils | null = null;
const databaseUrl = getEnv().DATABASE_URL;

async function getWorkerUtils(): Promise<WorkerUtils> {
  if (!workerUtils) {
    workerUtils = await makeWorkerUtils({
      connectionString: databaseUrl,
    });
  }
  return workerUtils;
}

export async function enqueueInvestigationRun(
  runId: string,
): Promise<void> {
  const utils = await getWorkerUtils();
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
  if (!workerUtils) return;
  const activeUtils = workerUtils;
  workerUtils = null;
  await activeUtils.release();
}
