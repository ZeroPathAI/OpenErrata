import { makeWorkerUtils, type WorkerUtils } from "graphile-worker";
import { getEnv } from "$lib/config/env.js";
import { normalizePgConnectionStringForNode } from "$lib/db/connection-string.js";

let workerUtils: Promise<WorkerUtils> | null = null;

/** Lazily connect once per process; a failed connection is retried on the next call. */
function getWorkerUtils(): Promise<WorkerUtils> {
  workerUtils ??= makeWorkerUtils({
    connectionString: normalizePgConnectionStringForNode(getEnv().DATABASE_URL),
  }).catch((error: unknown) => {
    workerUtils = null;
    throw error;
  });
  return workerUtils;
}

/**
 * Enqueue (or replace) the single graphile-worker job for an investigation.
 * The per-investigation jobKey collapses concurrent enqueues from
 * investigateNow, the selector and retry scheduling into one job; retries are
 * application-controlled, so graphile-worker never retries a job itself.
 */
export async function enqueueInvestigation(
  investigationId: string,
  options?: { runAt?: Date },
): Promise<void> {
  const utils = await getWorkerUtils();
  await utils.addJob(
    "investigate",
    { investigationId },
    {
      maxAttempts: 1,
      jobKey: `investigate:${investigationId}`,
      ...(options?.runAt !== undefined && { runAt: options.runAt }),
    },
  );
}

/** Release the queue's database pool (lets short-lived processes such as tests exit). */
export async function closeQueueUtils(): Promise<void> {
  const pending = workerUtils;
  workerUtils = null;
  if (pending !== null) {
    await (await pending).release();
  }
}
