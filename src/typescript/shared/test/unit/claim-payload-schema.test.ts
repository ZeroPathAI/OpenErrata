import assert from "node:assert/strict";
import { test } from "node:test";
import {
  httpUrlSchema,
  investigationClaimPayloadSchema,
  investigationResultSchema,
} from "../../src/index.js";

const NON_HTTP_URLS = [
  "data:text/plain,hello",
  "mailto:someone@example.com",
  "ftp://example.com/file",
  "file:///etc/passwd",
];

function claimWithSourceUrl(url: string) {
  return {
    text: "Claim",
    context: "Context",
    summary: "Summary",
    reasoning: "Reasoning",
    sources: [{ url, title: "Title", snippet: "Snippet" }],
  };
}

test("httpUrlSchema accepts only absolute http(s) URLs", () => {
  for (const url of ["https://example.com/a?b=c", "http://example.com", "HTTPS://EXAMPLE.COM/"]) {
    assert.equal(httpUrlSchema.safeParse(url).success, true, url);
  }
  for (const url of [...NON_HTTP_URLS, "example.com/page", ""]) {
    assert.equal(httpUrlSchema.safeParse(url).success, false, url);
  }
});

test("claim sources must link to http(s) URLs", () => {
  assert.equal(
    investigationClaimPayloadSchema.safeParse(claimWithSourceUrl("https://example.com")).success,
    true,
  );
  for (const url of NON_HTTP_URLS) {
    assert.equal(investigationClaimPayloadSchema.safeParse(claimWithSourceUrl(url)).success, false);
    assert.equal(
      investigationResultSchema.safeParse({ claims: [claimWithSourceUrl(url)] }).success,
      false,
      url,
    );
  }
});
