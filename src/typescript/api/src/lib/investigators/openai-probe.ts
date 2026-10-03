import type OpenAI from "openai";
import {
  buildProbeRequestParams,
  type InvestigationRequestConfig,
} from "./openai-request-config.js";

/**
 * Checks that the provider accepts investigation requests from this client:
 * the key authenticates, has access to the model, and the request shape
 * (tools, include, reasoning options) is valid for it. Rejects with the
 * provider's error otherwise.
 *
 * An "incomplete" response counts as accepted: the probe's tiny output cap
 * routinely cuts reasoning short, which says nothing about the request shape.
 */
export async function probeInvestigationRequest(
  client: OpenAI,
  requestConfig: InvestigationRequestConfig,
): Promise<void> {
  const response = await client.responses.create(buildProbeRequestParams(requestConfig));
  if (response.status !== "completed" && response.status !== "incomplete") {
    throw new Error(
      `OpenAI probe response ${response.id} ended with status ${response.status ?? "missing"}`,
    );
  }
}
