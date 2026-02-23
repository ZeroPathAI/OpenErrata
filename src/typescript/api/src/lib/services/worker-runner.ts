import { run } from "graphile-worker";
import { getEnv } from "$lib/config/env.js";
import { normalizePgConnectionStringForNode } from "$lib/db/connection-string.js";
import { orchestrateInvestigation } from "./orchestrator.js";

function isInvestigatePayload(
  payload: unknown,
): payload is { runId: string } {
  if (typeof payload !== "object" || payload === null) return false;
  if (!("runId" in payload)) return false;
  return typeof payload.runId === "string" && payload.runId.length > 0;
}

export async function startWorker(): Promise<void> {
  const env = getEnv();
  const runner = await run({
    connectionString: normalizePgConnectionStringForNode(env.DATABASE_URL),
    concurrency: env.WORKER_CONCURRENCY,
    pollInterval: 1000,
    taskList: {
      investigate: async (payload, helpers) => {
        if (!isInvestigatePayload(payload)) {
          throw new Error("Invalid investigate payload");
        }

        const attemptNumber = helpers.job.attempts;
        const isLastAttempt = attemptNumber >= helpers.job.max_attempts;
        await orchestrateInvestigation(payload.runId, helpers.logger, {
          isLastAttempt,
          attemptNumber,
          workerIdentity: `worker-job-${helpers.job.id}`,
        });
      },
    },
  });

  const shutdown = () => {
    void runner.stop();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await runner.promise;
}
