import OpenAI from "openai";
import { getPrisma } from "$lib/db/client";
import { requireOpenAiApiKey } from "./env.js";

type StartupComponent = "api" | "worker" | "selector";

type StartupCheckPolicy = {
  checkDatabase: boolean;
  checkOpenAiCredentials: boolean;
};

const startupCheckPolicyByComponent: Record<StartupComponent, StartupCheckPolicy> = {
  api: { checkDatabase: true, checkOpenAiCredentials: false },
  selector: { checkDatabase: true, checkOpenAiCredentials: false },
  worker: { checkDatabase: true, checkOpenAiCredentials: true },
};

const startupCheckPromises = new Map<string, Promise<void>>();

function startupCheckKey(
  component: StartupComponent,
  policy: StartupCheckPolicy,
): string {
  return [
    component,
    policy.checkDatabase ? "db:1" : "db:0",
    policy.checkOpenAiCredentials ? "openai:1" : "openai:0",
  ].join("|");
}

async function assertDatabaseCredentials(component: StartupComponent): Promise<void> {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
  } catch (error) {
    throw new Error(
      `[startup:${component}] Database credential check failed`,
      { cause: error },
    );
  }
}

async function assertOpenAiCredentials(component: StartupComponent): Promise<void> {
  try {
    const client = new OpenAI({ apiKey: requireOpenAiApiKey() });
    await client.models.list();
  } catch (error) {
    throw new Error(
      `[startup:${component}] OpenAI credential check failed`,
      { cause: error },
    );
  }
}

export async function runStartupChecks(component: StartupComponent): Promise<void> {
  const policy = startupCheckPolicyByComponent[component];
  const key = startupCheckKey(component, policy);
  let startupPromise = startupCheckPromises.get(key);
  if (!startupPromise) {
    startupPromise = (async () => {
      if (policy.checkDatabase) {
        await assertDatabaseCredentials(component);
      }
      if (policy.checkOpenAiCredentials) {
        await assertOpenAiCredentials(component);
      }
    })();
    startupCheckPromises.set(key, startupPromise);
  }

  try {
    await startupPromise;
  } catch (error) {
    // Retry on next call after a failed startup check. Guard by identity so a
    // newer in-flight promise for the same key is not removed accidentally.
    if (startupCheckPromises.get(key) === startupPromise) {
      startupCheckPromises.delete(key);
    }
    throw error;
  }
}
