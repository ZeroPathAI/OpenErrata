import assert from "node:assert/strict";
import { test } from "node:test";
import { ZodError } from "zod";
import {
  claimValidationResultSchema,
  providerStructuredSourceUrlSchema,
  providerStructuredInvestigationClaimPayloadSchema,
  providerStructuredInvestigationResultSchema,
  buildUpdateInvestigationResultSchema,
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

test("providerStructuredInvestigationResultSchema accepts valid result", () => {
  const result = providerStructuredInvestigationResultSchema.parse({
    claims: [
      {
        text: "claim",
        context: "ctx",
        summary: "sum",
        reasoning: "reas",
        sources: [{ url: "https://a.com", title: "t", snippet: "s" }],
      },
    ],
  });
  assert.equal(result.claims.length, 1);
});

test("providerStructuredInvestigationResultSchema accepts empty claims array", () => {
  const result = providerStructuredInvestigationResultSchema.parse({ claims: [] });
  assert.equal(result.claims.length, 0);
});

test("buildUpdateInvestigationResultSchema with no old claims only allows new actions", () => {
  const schema = buildUpdateInvestigationResultSchema([]);
  const result = schema.parse({
    actions: [
      {
        type: "new",
        claim: {
          text: "t",
          context: "c",
          summary: "s",
          reasoning: "r",
          sources: [{ url: "https://a.com", title: "t", snippet: "s" }],
        },
      },
    ],
  });
  assert.equal(result.actions.length, 1);
});

test("buildUpdateInvestigationResultSchema with old claim ids allows carry actions", () => {
  const schema = buildUpdateInvestigationResultSchema(["claim-1", "claim-2"]);
  const result = schema.parse({
    actions: [
      { type: "carry", id: "claim-1" },
      {
        type: "new",
        claim: {
          text: "t",
          context: "c",
          summary: "s",
          reasoning: "r",
          sources: [{ url: "https://b.com", title: "t2", snippet: "s2" }],
        },
      },
    ],
  });
  assert.equal(result.actions.length, 2);
});

test("buildUpdateInvestigationResultSchema rejects carry with unknown id", () => {
  const schema = buildUpdateInvestigationResultSchema(["claim-1"]);
  assert.throws(() => schema.parse({ actions: [{ type: "carry", id: "unknown-id" }] }), ZodError);
});
