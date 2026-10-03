import OpenAI from "openai";
import { getPrisma } from "$lib/db/client";
import { INVESTIGATION_REQUEST_CONFIG } from "$lib/investigators/openai-request-config.js";
import { probeInvestigationRequest } from "$lib/investigators/openai-probe.js";
import { getEnv, requireOpenAiApiKey } from "./env.js";

type StartupComponent = "api" | "worker" | "selector";

interface StartupCheckPolicy {
  checkDatabase: boolean;
  checkOpenAiCredentials: boolean;
  checkClientAddressSource: boolean;
}

const startupCheckPolicyByComponent: Record<StartupComponent, StartupCheckPolicy> = {
  api: { checkDatabase: true, checkOpenAiCredentials: false, checkClientAddressSource: true },
  selector: { checkDatabase: true, checkOpenAiCredentials: false, checkClientAddressSource: false },
  worker: { checkDatabase: true, checkOpenAiCredentials: true, checkClientAddressSource: false },
};

const startupCheckPromises = new Map<string, Promise<void>>();

function startupCheckKey(component: StartupComponent, policy: StartupCheckPolicy): string {
  return [
    component,
    policy.checkDatabase ? "db:1" : "db:0",
    policy.checkOpenAiCredentials ? "openai:1" : "openai:0",
    policy.checkClientAddressSource ? "client-address:1" : "client-address:0",
  ].join("|");
}

/**
 * In production the API runs behind the chart's ingress proxy, so the socket
 * peer is the proxy, not the viewer. adapter-node must be told which header
 * carries the client address (ADDRESS_HEADER, plus XFF_DEPTH for
 * X-Forwarded-For); without it every anonymous viewer shares the proxy's IP
 * range and the per-range view-credit cap (SPEC §2.10) collapses selector
 * ranking. Exported for unit tests.
 */
export function assertClientAddressSourceConfigured(env: NodeJS.ProcessEnv): void {
  const addressHeader = env["ADDRESS_HEADER"]?.trim().toLowerCase() ?? "";
  if (addressHeader.length === 0) {
    throw new Error(
      "ADDRESS_HEADER must name the proxy header carrying the client IP (e.g. x-forwarded-for) when NODE_ENV=production",
    );
  }
  if (addressHeader === "x-forwarded-for") {
    const xffDepth = env["XFF_DEPTH"]?.trim() ?? "";
    if (!/^[1-9]\d*$/.test(xffDepth)) {
      throw new Error(
        "XFF_DEPTH must be set to the number of trusted proxies in front of the API when ADDRESS_HEADER=x-forwarded-for",
      );
    }
  }
}

async function assertDatabaseCredentials(component: StartupComponent): Promise<void> {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
  } catch (error) {
    throw new Error(`[startup:${component}] Database credential check failed`, { cause: error });
  }
}

async function assertOpenAiCredentials(component: StartupComponent): Promise<void> {
  try {
    // Probes the investigation request shape, not just the key, so a model or
    // request-parameter mismatch stops the worker before it fails every job.
    await probeInvestigationRequest(
      new OpenAI({ apiKey: requireOpenAiApiKey() }),
      INVESTIGATION_REQUEST_CONFIG,
    );
  } catch (error) {
    throw new Error(`[startup:${component}] OpenAI credential check failed`, { cause: error });
  }
}

export async function runStartupChecks(component: StartupComponent): Promise<void> {
  const policy = startupCheckPolicyByComponent[component];
  const key = startupCheckKey(component, policy);
  let startupPromise = startupCheckPromises.get(key);
  if (!startupPromise) {
    startupPromise = (async () => {
      if (policy.checkClientAddressSource && getEnv().NODE_ENV === "production") {
        assertClientAddressSourceConfigured(process.env);
      }
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
