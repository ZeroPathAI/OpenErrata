import assert from "node:assert/strict";
import { test } from "node:test";
import { viewPostInputSchema } from "@openerrata/shared";
import type { ViewPostInput } from "@openerrata/shared";
import {
  resolveCanonicalContentVersion,
  type ServerVerifiedContentMismatch,
} from "../../src/lib/services/canonical-resolution.js";
import type { CanonicalFetchInput } from "../../src/lib/services/content-fetcher.js";

function buildXViewInput(observedContentText: string): Extract<ViewPostInput, { platform: "X" }> {
  return viewPostInputSchema.parse({
    platform: "X",
    externalId: "unit-test-post-x-1",
    url: "https://x.com/openerrata/status/unit-test-post-x-1",
    observedContentText,
    metadata: {
      authorHandle: "openerrata",
      authorDisplayName: "OpenErrata",
      text: observedContentText,
      mediaUrls: [],
    },
  }) as Extract<ViewPostInput, { platform: "X" }>;
}

function buildWikipediaViewInput(
  observedContentText: string,
): Extract<ViewPostInput, { platform: "WIKIPEDIA" }> {
  return viewPostInputSchema.parse({
    platform: "WIKIPEDIA",
    url: "https://en.wikipedia.org/wiki/OpenErrata",
    observedContentText,
    metadata: {
      language: "en",
      title: "OpenErrata",
      pageId: "12345",
      revisionId: "67890",
      displayTitle: "OpenErrata",
    },
  }) as Extract<ViewPostInput, { platform: "WIKIPEDIA" }>;
}

function buildLesswrongViewInput(
  htmlContent: string,
): Extract<ViewPostInput, { platform: "LESSWRONG" }> {
  return viewPostInputSchema.parse({
    platform: "LESSWRONG",
    externalId: "unit-test-post-lw-1",
    url: "https://www.lesswrong.com/posts/unit-test-post-lw-1/openerrata",
    metadata: {
      slug: "unit-test-post-lw-1-openerrata",
      title: "OpenErrata",
      htmlContent,
      tags: [],
    },
  }) as Extract<ViewPostInput, { platform: "LESSWRONG" }>;
}

test("resolveCanonicalContentVersion returns server-verified canonical content", async () => {
  const viewInput = buildXViewInput("Observed text");
  const observed = {
    contentText: "Observed text",
    contentHash: "observed-hash",
  };
  let capturedFetchInput: CanonicalFetchInput | null = null;

  const result = await resolveCanonicalContentVersion({
    viewInput,
    observed,
    fetchCanonicalContent: async (input) => {
      capturedFetchInput = input;
      return {
        provenance: "SERVER_VERIFIED",
        contentText: "Server canonical text",
        contentHash: "server-hash",
      };
    },
  });

  assert.deepEqual(capturedFetchInput, {
    platform: "X",
    url: viewInput.url,
    externalId: viewInput.externalId,
  });
  assert.deepEqual(result, {
    provenance: "SERVER_VERIFIED",
    contentText: "Server canonical text",
    contentHash: "server-hash",
  });
});

test("resolveCanonicalContentVersion uses server content even when client hash differs", async () => {
  // The server independently fetches canonical content (e.g. Wikipedia Parse API,
  // LessWrong GraphQL). Client DOM extraction can differ due to JS-injected elements,
  // tracking pixels, etc. Mismatches are anomalies to monitor, but server-verified
  // canonical content remains authoritative for this resolution step.
  const viewInput = buildXViewInput("Observed text");
  const observed = {
    contentText: "Observed text that differs from server",
    contentHash: "observed-hash-that-differs",
  };

  const result = await resolveCanonicalContentVersion({
    viewInput,
    observed,
    fetchCanonicalContent: async () => ({
      provenance: "SERVER_VERIFIED",
      contentText: "Server canonical text",
      contentHash: "server-hash",
    }),
  });

  assert.deepEqual(result, {
    provenance: "SERVER_VERIFIED",
    contentText: "Server canonical text",
    contentHash: "server-hash",
  });
});

test("resolveCanonicalContentVersion reports mismatches for server-verified LessWrong content", async () => {
  const viewInput = buildLesswrongViewInput("<p>Observed text</p>");
  const observed = {
    contentText: "Observed text",
    contentHash: "observed-hash",
  };
  let capturedMismatch: ServerVerifiedContentMismatch | null = null;

  const result = await resolveCanonicalContentVersion({
    viewInput,
    observed,
    fetchCanonicalContent: async () => ({
      provenance: "SERVER_VERIFIED",
      contentText: "Server canonical text",
      contentHash: "server-hash",
    }),
    onServerVerifiedContentMismatch: (mismatch) => {
      capturedMismatch = mismatch;
    },
  });

  assert.deepEqual(capturedMismatch, {
    platform: "LESSWRONG",
    externalId: viewInput.externalId,
    url: viewInput.url,
    observedHash: "observed-hash",
    serverHash: "server-hash",
  });
  assert.deepEqual(result, {
    provenance: "SERVER_VERIFIED",
    contentText: "Server canonical text",
    contentHash: "server-hash",
  });
});

test("resolveCanonicalContentVersion falls back to observed content when canonical fetch is unavailable", async () => {
  const viewInput = buildXViewInput("Observed text");
  const observed = {
    contentText: "Observed text",
    contentHash: "observed-hash",
  };

  const result = await resolveCanonicalContentVersion({
    viewInput,
    observed,
    fetchCanonicalContent: async () => ({
      provenance: "CLIENT_FALLBACK",
      fetchFailureReason: "canonical fetch unavailable",
    }),
  });

  assert.deepEqual(result, {
    contentText: observed.contentText,
    contentHash: observed.contentHash,
    provenance: "CLIENT_FALLBACK",
    fetchFailureReason: "canonical fetch unavailable",
  });
});

test("resolveCanonicalContentVersion forwards required Wikipedia canonical fetch metadata", async () => {
  const viewInput = buildWikipediaViewInput("Observed text");
  const observed = {
    contentText: "Observed text",
    contentHash: "observed-hash",
  };
  let capturedFetchInput: CanonicalFetchInput | null = null;

  await resolveCanonicalContentVersion({
    viewInput,
    observed,
    fetchCanonicalContent: async (input) => {
      capturedFetchInput = input;
      return {
        provenance: "CLIENT_FALLBACK",
        fetchFailureReason: "canonical fetch unavailable",
      };
    },
  });

  assert.deepEqual(capturedFetchInput, {
    platform: "WIKIPEDIA",
    url: viewInput.url,
    metadata: {
      language: "en",
      title: "OpenErrata",
      pageId: "12345",
      revisionId: "67890",
    },
  });
});
