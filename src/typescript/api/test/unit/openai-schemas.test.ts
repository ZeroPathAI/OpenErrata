import assert from "node:assert/strict";
import { test } from "node:test";
import { ZodError } from "zod";
import {
  claimValidationResultSchema,
  providerStructuredSourceUrlSchema,
  providerStructuredInvestigationClaimPayloadSchema,
} from "../../src/lib/investigators/openai-schemas.js";

test("claimValidationResultSchema accepts { approved: true }", () => {
  const result = claimValidationResultSchema.parse({ approved: true });
  assert.deepStrictEqual(result, { approved: true });
});

test("claimValidationResultSchema accepts { approved: false }", () => {
  const result = claimValidationResultSchema.parse({ approved: false });
  assert.deepStrictEqual(result, { approved: false });
});

test("claimValidationResultSchema rejects extra keys (strict mode)", () => {
  assert.throws(
    () => claimValidationResultSchema.parse({ approved: true, extra: "nope" }),
    ZodError,
  );
});

test("providerStructuredSourceUrlSchema accepts valid http url", () => {
  const url = providerStructuredSourceUrlSchema.parse("https://example.com/page");
  assert.equal(url, "https://example.com/page");
});

test("providerStructuredSourceUrlSchema rejects non-http url", () => {
  assert.throws(() => providerStructuredSourceUrlSchema.parse("ftp://example.com"), ZodError);
});

test("providerStructuredSourceUrlSchema rejects empty string", () => {
  assert.throws(() => providerStructuredSourceUrlSchema.parse(""), ZodError);
});

test("providerStructuredInvestigationClaimPayloadSchema accepts valid claim", () => {
  const claim = providerStructuredInvestigationClaimPayloadSchema.parse({
    text: "claim text",
    context: "claim context",
    summary: "summary",
    reasoning: "reasoning",
    sources: [{ url: "https://example.com", title: "Title", snippet: "Snippet" }],
  });
  assert.equal(claim.text, "claim text");
  assert.equal(claim.sources.length, 1);
});

test("providerStructuredInvestigationClaimPayloadSchema rejects empty sources", () => {
  assert.throws(
    () =>
      providerStructuredInvestigationClaimPayloadSchema.parse({
        text: "claim text",
        context: "claim context",
        summary: "summary",
        reasoning: "reasoning",
        sources: [],
      }),
    ZodError,
  );
});
