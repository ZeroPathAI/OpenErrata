import { makeWorkerUtils } from "graphile-worker";
import { getEnv } from "$lib/config/env.js";
import { normalizePgConnectionStringForNode } from "$lib/db/connection-string.js";
import { createQueueManager } from "./queue-lifecycle.js";

const manager = createQueueManager(() =>
  makeWorkerUtils({
    connectionString: normalizePgConnectionStringForNode(getEnv().DATABASE_URL),
  }),
);

export async function enqueueInvestigation(
  investigationId: string,
  options?: { runAt?: Date },
): Promise<void> {
  const utils = await manager.acquire();
  const spec = {
    maxAttempts: 1,
    jobKey: `investigate:${investigationId}`,
    ...(options?.runAt !== undefined && { runAt: options.runAt }),
  };
  await utils.addJob("investigate", { investigationId }, spec);
}

export async function closeQueueUtils(): Promise<void> {
  await manager.close();
}
