import { makeWorkerUtils, type WorkerUtils } from "graphile-worker";
import { getEnv } from "$lib/config/env.js";

let workerUtils: WorkerUtils | null = null;
let workerUtilsPromise: Promise<WorkerUtils> | null = null;
const databaseUrl = getEnv().DATABASE_URL;

async function getWorkerUtils(): Promise<WorkerUtils> {
  if (workerUtils) {
    return workerUtils;
  }

  if (!workerUtilsPromise) {
    const initializationPromise = makeWorkerUtils({
      connectionString: databaseUrl,
    })
      .then((utils) => {
        // Only publish if this is still the active initialization promise.
        if (workerUtilsPromise === initializationPromise) {
          workerUtils = utils;
        }
        return utils;
      })
      .catch((error) => {
        if (workerUtilsPromise === initializationPromise) {
          workerUtilsPromise = null;
        }
        throw error;
      });
    workerUtilsPromise = initializationPromise;
  }

  return workerUtilsPromise;
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
  const activeUtils = workerUtils;
  const pendingUtils = workerUtilsPromise;
  if (!activeUtils && !pendingUtils) return;

  workerUtils = null;
  workerUtilsPromise = null;

  if (activeUtils) {
    await activeUtils.release();
    return;
  }

  if (!pendingUtils) return;

  const initializedUtils = await pendingUtils;
  await initializedUtils.release();

  // Defensive clear in case a stale promise resolved after close started.
  if (workerUtils === initializedUtils) {
    workerUtils = null;
  }
}
