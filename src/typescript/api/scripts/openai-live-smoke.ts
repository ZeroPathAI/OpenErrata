/**
 * Live smoke test of the investigation pipeline against the real OpenAI API.
 * Spends real tokens; needs no database.
 *
 *   OPENAI_API_KEY=sk-... pnpm --filter @openerrata/api smoke:openai
 *
 * SMOKE_REASONING_SUMMARY=none|auto|concise|detailed overrides the reasoning
 * summary setting for this run only, to check which values the model accepts
 * before changing INVESTIGATION_REASONING_SUMMARY.
 *
 * Runs (a) the request probe the worker runs at startup and (b) one full
 * investigation through OpenAIInvestigator of a short synthetic post with one
 * false and one true checkable claim, then prints what came back.
 */
import "dotenv/config";
import process from "node:process";
import OpenAI, { APIError } from "openai";
import type { Reasoning } from "openai/resources/shared";
import { InvestigatorExecutionError } from "../src/lib/investigators/errors.js";
import type {
  InvestigatorInput,
  InvestigatorRequestAudit,
} from "../src/lib/investigators/interface.js";
import { OpenAIInvestigator } from "../src/lib/investigators/openai.js";
import { probeInvestigationRequest } from "../src/lib/investigators/openai-probe.js";
import {
  INVESTIGATION_REQUEST_CONFIG,
  type InvestigationRequestConfig,
} from "../src/lib/investigators/openai-request-config.js";

// Plenty for a two-claim post; production uses OPENAI_MAX_RESPONSE_TOOL_ROUNDS.
const SMOKE_MAX_TOOL_ROUNDS = 40;

const SYNTHETIC_POST: InvestigatorInput = {
  platform: "LESSWRONG",
  url: "https://www.lesswrong.com/posts/smoke0test/notes-on-engineering-timelines",
  authorName: "Smoke Test",
  postPublishedAt: "2026-09-30T12:00:00.000Z",
  contentText: [
    "Notes on engineering timelines",
    "People routinely underestimate how long large projects take, and the planning fallacy shows up even in famous megaprojects.",
    "The Eiffel Tower, for example, was completed in 1925 after more than a decade of construction delays.",
    "By contrast, the Empire State Building went up remarkably fast: it opened in 1931, barely over a year after construction began.",
    "The lesson I take from this is to pad estimates generously when the work is novel.",
  ].join("\n\n"),
};

type ReasoningSummarySetting = NonNullable<Reasoning["summary"]> | null;

function parseReasoningSummaryOverride(value: string | undefined): ReasoningSummarySetting {
  switch (value) {
    case undefined:
      return INVESTIGATION_REQUEST_CONFIG.reasoningSummary;
    case "none":
      return null;
    case "auto":
    case "concise":
    case "detailed":
      return value;
    default:
      throw new Error(
        `SMOKE_REASONING_SUMMARY must be one of none|auto|concise|detailed (got "${value}")`,
      );
  }
}

function isOpenAiApiError(error: unknown): error is APIError {
  return error instanceof APIError;
}

function describeError(error: unknown): string {
  if (isOpenAiApiError(error)) {
    return [
      `${error.constructor.name}: HTTP ${error.status?.toString() ?? "(no status)"}`,
      `request id: ${error.requestID ?? "(none)"}`,
      `body: ${JSON.stringify(error.error, null, 2)}`,
    ].join("\n");
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}${error.stack === undefined ? "" : `\n${error.stack}`}`;
  }
  return String(error);
}

function readValidationVerdict(request: InvestigatorRequestAudit): string {
  if (request.response === null) return "no response (request failed)";
  const text = request.response.outputItems
    .flatMap((item) => (item.content.kind === "MESSAGE" ? item.content.textParts : []))
    .map((part) => part.text)
    .join("");
  return text.length > 0 ? text : `no verdict text (status=${String(request.response.status)})`;
}

function summarizeRequests(requests: InvestigatorRequestAudit[]): void {
  const responses = requests.flatMap((request) =>
    request.response === null ? [] : [request.response],
  );
  console.log(
    `\nProvider requests: ${requests.length.toString()} sent, ${responses.length.toString()} answered`,
  );
  for (const request of requests) {
    const label =
      request.subject.kind === "FACT_CHECK_ROUND"
        ? `fact-check round ${request.subject.round.toString()}`
        : `validation of claim ${request.subject.claimIndex.toString()}`;
    const response = request.response;
    console.log(
      `  - ${label}: ${
        response === null
          ? "no response"
          : `${response.providerResponseId} status=${String(response.status)} model=${response.modelVersion}`
      }`,
    );
  }

  const webSearches = responses.flatMap((response) =>
    response.outputItems.flatMap((item) =>
      item.itemType === "web_search_call" && item.content.kind === "TOOL_CALL"
        ? [item.content.rawPayload]
        : [],
    ),
  );
  const sourceCount = webSearches
    .map((payload) => {
      const action = payload["action"];
      const sources =
        typeof action === "object" && action !== null && !Array.isArray(action)
          ? action["sources"]
          : undefined;
      return Array.isArray(sources) ? sources.length : 0;
    })
    .reduce((total, count) => total + count, 0);
  console.log(
    `\nWeb search calls: ${webSearches.length.toString()}, sources returned: ${sourceCount.toString()}`,
  );

  const summaries = responses.flatMap((response) =>
    response.outputItems.flatMap((item) =>
      item.content.kind === "REASONING" ? item.content.summaries : [],
    ),
  );
  const reasoningItemCount = responses
    .flatMap((response) => response.outputItems)
    .filter((item) => item.content.kind === "REASONING").length;
  console.log(
    `Reasoning summaries: ${summaries.length > 0 ? "yes" : "no"} (${summaries.length.toString()} summary parts across ${reasoningItemCount.toString()} reasoning items)`,
  );
  const [firstSummary] = summaries;
  if (firstSummary !== undefined) {
    console.log(`  first summary: ${firstSummary.slice(0, 300)}`);
  }

  console.log("\nClaim validations:");
  const validations = requests.filter((request) => request.subject.kind === "CLAIM_VALIDATION");
  if (validations.length === 0) console.log("  (none — no claims were submitted)");
  for (const validation of validations) {
    const claimIndex =
      validation.subject.kind === "CLAIM_VALIDATION" ? validation.subject.claimIndex : -1;
    console.log(`  - claim ${claimIndex.toString()}: ${readValidationVerdict(validation)}`);
  }

  const usages = responses.map((response) => response.usage);
  const totals = usages.every((usage) => usage !== null)
    ? usages.reduce(
        (sum, usage) => ({
          input: sum.input + usage.inputTokens,
          cached: sum.cached + usage.cachedInputTokens,
          output: sum.output + usage.outputTokens,
          reasoning: sum.reasoning + usage.reasoningOutputTokens,
          total: sum.total + usage.totalTokens,
        }),
        { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 },
      )
    : null;
  console.log(
    totals === null
      ? "\nToken usage: unknown (a response reported no usage)"
      : `\nToken usage: input=${totals.input.toString()} (cached ${totals.cached.toString()}), output=${totals.output.toString()} (reasoning ${totals.reasoning.toString()}), total=${totals.total.toString()}`,
  );
}

async function main(): Promise<boolean> {
  const requestConfig: InvestigationRequestConfig = {
    ...INVESTIGATION_REQUEST_CONFIG,
    reasoningSummary: parseReasoningSummaryOverride(process.env["SMOKE_REASONING_SUMMARY"]),
  };
  const apiKey = process.env["OPENAI_API_KEY"]?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    console.error("OPENAI_API_KEY is required (set it in the environment or api/.env).");
    return false;
  }
  console.log(
    `Model ${requestConfig.model}, reasoning effort=${requestConfig.reasoningEffort}, summary=${String(requestConfig.reasoningSummary)}, include=${requestConfig.include.join(",")}`,
  );
  const client = new OpenAI({ apiKey });

  console.log("\n(a) Request probe");
  try {
    await probeInvestigationRequest(client, requestConfig);
    console.log("  accepted");
  } catch (error) {
    console.log(`  REJECTED\n${describeError(error)}`);
    return false;
  }

  console.log("\n(b) Full investigation of a synthetic post");
  const investigator = new OpenAIInvestigator({
    client,
    requestConfig,
    maxToolRounds: SMOKE_MAX_TOOL_ROUNDS,
  });
  const startedAt = Date.now();
  try {
    const output = await investigator.investigate(SYNTHETIC_POST, {
      signal: new AbortController().signal,
    });
    console.log(
      `  completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s; model=${output.model}, modelVersion=${output.modelVersion}`,
    );
    summarizeRequests(output.attemptAudit.requests);
    console.log(`\nConfirmed claims: ${output.result.claims.length.toString()}`);
    for (const claim of output.result.claims) {
      console.log(`  - "${claim.text}"\n    ${claim.summary}`);
      for (const source of claim.sources) {
        console.log(`    source: ${source.url} (${source.title})`);
      }
    }
    return true;
  } catch (error) {
    console.log(`  FAILED after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    if (error instanceof InvestigatorExecutionError) {
      console.log(`  ${error.message}\n${describeError(error.cause)}`);
      summarizeRequests(error.attemptAudit.requests);
    } else {
      console.log(describeError(error));
    }
    return false;
  }
}

main().then(
  (passed) => {
    process.exit(passed ? 0 : 1);
  },
  (error: unknown) => {
    console.error(describeError(error));
    process.exit(1);
  },
);
