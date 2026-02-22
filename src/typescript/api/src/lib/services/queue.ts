import { makeWorkerUtils, type WorkerUtils } from "graphile-worker";
import { getEnv } from "$lib/config/env.js";

let workerUtils: WorkerUtils | null = null;
let workerUtilsPromise: Promise<WorkerUtils> | null = null;
let closeQueueUtilsPromise: Promise<void> | null = null;
let queueClosed = false;
const databaseUrl = getEnv().DATABASE_URL;

async function getWorkerUtils(): Promise<WorkerUtils> {
  while (true) {
    if (closeQueueUtilsPromise) {
      await closeQueueUtilsPromise;
      continue;
    }
    if (queueClosed) {
      throw new Error("Queue utilities are closed");
    }

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

    const resolvedWorkerUtils = await workerUtilsPromise;
    if (closeQueueUtilsPromise) {
      await closeQueueUtilsPromise;
      continue;
    }
    return resolvedWorkerUtils;
  }
}

async function closeQueueUtilsOnce(): Promise<void> {
  while (true) {
    const activeUtils = workerUtils;
    const pendingUtils = workerUtilsPromise;
    if (!activeUtils && !pendingUtils) {
      return;
    }

    workerUtils = null;
    workerUtilsPromise = null;

    if (activeUtils) {
      await activeUtils.release();
      continue;
    }

    if (!pendingUtils) {
      continue;
    }

    const initializedUtils = await pendingUtils;
    await initializedUtils.release();

    // Defensive clear in case a stale promise resolved after close started.
    if (workerUtils === initializedUtils) {
      workerUtils = null;
    }
  }
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
  if (!closeQueueUtilsPromise) {
    closeQueueUtilsPromise = (async () => {
      try {
        await closeQueueUtilsOnce();
        queueClosed = true;
      } catch (error) {
        // Only transition to closed after a successful resource release.
        queueClosed = false;
        throw error;
      } finally {
        closeQueueUtilsPromise = null;
      }
    })();
  }

  await closeQueueUtilsPromise;
}
