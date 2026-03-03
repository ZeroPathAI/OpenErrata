import assert from "node:assert/strict";
import { test } from "node:test";
import type OpenAI from "openai";
import { OpenAIInvestigator } from "../../src/lib/investigators/openai.js";
import type { InvestigatorInput } from "../../src/lib/investigators/interface.js";

/**
 * Invariant under test:
 *
 * The final `result.claims` array must be ordered by **submission order**
 * (the order the model produced submit_correction / retain_correction tool
 * calls), regardless of which per-claim validation promises settle first.
 *
 * Without explicit sorting, `confirmedClaims` is populated by `.then()`
 * callbacks on bounded-concurrency promises, whose settlement order depends
 * on wall-clock timing — a non-deterministic race.
 */

function makeClaim(label: string) {
  return {
    text: `Incorrect claim: ${label}`,
    context: `The article states ${label}`,
    summary: `${label} is wrong because of evidence`,
    reasoning: `Detailed reasoning for ${label}`,
    sources: [
      {
        url: `https://example.com/${label.toLowerCase()}`,
        title: `Source ${label}`,
        snippet: `Evidence for ${label}`,
      },
    ],
  };
}

function makeSubmitCorrectionFunctionCall(callId: string, claim: ReturnType<typeof makeClaim>) {
  return {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name: "submit_correction",
    arguments: JSON.stringify(claim),
    status: "completed",
  };
}

function makeToolLoopResponse(claims: ReturnType<typeof makeClaim>[]) {
  return {
    id: "resp_round1",
    status: "completed",
    model: "test-model",
    output: claims.map((claim, i) =>
      makeSubmitCorrectionFunctionCall(`call-${i.toString()}`, claim),
    ),
    output_text: null,
    usage: { input_tokens: 200, output_tokens: 200, total_tokens: 400 },
  };
}

function makeFinalToolLoopResponse() {
  return {
    id: "resp_round2",
    status: "completed",
    model: "test-model",
    output: [
      { type: "message", id: "msg_final", status: "completed", role: "assistant", content: [] },
    ],
    output_text: null,
    usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
  };
}

function makeValidationResponse(approved: boolean) {
  return {
    id: "resp_validation",
    status: "completed",
    model: "test-model",
    output: [
      {
        type: "message",
        id: "msg_val",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify({ approved }) }],
      },
    ],
    output_text: JSON.stringify({ approved }),
    usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const minimalInput: InvestigatorInput = {
  contentText: "Some test content for fact-checking.",
  platform: "LESSWRONG",
  url: "https://www.lesswrong.com/posts/abc123/test-post",
};

test("investigate returns claims in submission order regardless of validation settlement order", async () => {
  const claimA = makeClaim("Alpha");
  const claimB = makeClaim("Beta");
  const claimC = makeClaim("Gamma");

  let toolLoopCallCount = 0;
  let validationCallIndex = 0;

  const mockClient = {
    responses: {
      create: async (request: Record<string, unknown>) => {
        // Stage 2 validation calls use text.format (no tools array)
        if (request["text"] !== undefined) {
          const idx = validationCallIndex;
          validationCallIndex += 1;

          // Settle in REVERSE order: claim 2 fastest, claim 0 slowest.
          // With 3 claims and pLimit(4), all start immediately.
          const delays = [40, 20, 5];
          await delay(delays[idx] ?? 0);

          return makeValidationResponse(true);
        }

        // Stage 1 tool loop calls have a tools array
        toolLoopCallCount += 1;
        if (toolLoopCallCount === 1) {
          return makeToolLoopResponse([claimA, claimB, claimC]);
        }
        return makeFinalToolLoopResponse();
      },
    },
  } as unknown as OpenAI;

  const investigator = new OpenAIInvestigator("fake-key", {
    client: mockClient,
    modelId: "test-model",
    maxToolRounds: 10,
  });

  const output = await investigator.investigate(minimalInput);

  assert.equal(output.result.claims.length, 3);
  // Claims must be in submission order (A, B, C) — not settlement order (C, B, A).
  assert.equal(output.result.claims[0]?.text, claimA.text);
  assert.equal(output.result.claims[1]?.text, claimB.text);
  assert.equal(output.result.claims[2]?.text, claimC.text);
});

test("investigate preserves submission order when some validations reject", async () => {
  const claimA = makeClaim("Alpha");
  const claimB = makeClaim("Beta");
  const claimC = makeClaim("Gamma");

  let toolLoopCallCount = 0;
  let validationCallIndex = 0;

  const mockClient = {
    responses: {
      create: async (request: Record<string, unknown>) => {
        if (request["text"] !== undefined) {
          const idx = validationCallIndex;
          validationCallIndex += 1;

          // Claim 0 (Alpha): slow, approved
          // Claim 1 (Beta): fast, REJECTED
          // Claim 2 (Gamma): medium, approved
          const delays = [30, 5, 15];
          const approvals = [true, false, true];
          await delay(delays[idx] ?? 0);
          return makeValidationResponse(approvals[idx] ?? false);
        }

        toolLoopCallCount += 1;
        if (toolLoopCallCount === 1) {
          return makeToolLoopResponse([claimA, claimB, claimC]);
        }
        return makeFinalToolLoopResponse();
      },
    },
  } as unknown as OpenAI;

  const investigator = new OpenAIInvestigator("fake-key", {
    client: mockClient,
    modelId: "test-model",
    maxToolRounds: 10,
  });

  const output = await investigator.investigate(minimalInput);

  // Beta was rejected; Alpha and Gamma approved — must be in submission order.
  assert.equal(output.result.claims.length, 2);
  assert.equal(output.result.claims[0]?.text, claimA.text);
  assert.equal(output.result.claims[1]?.text, claimC.text);
});
