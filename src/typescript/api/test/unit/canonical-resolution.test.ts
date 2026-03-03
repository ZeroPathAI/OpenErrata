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

function buildSubstackViewInput(
  observedContentText: string,
): Extract<ViewPostInput, { platform: "SUBSTACK" }> {
  return viewPostInputSchema.parse({
    platform: "SUBSTACK",
    externalId: "unit-test-post-sub-1",
    url: "https://example.substack.com/p/unit-test-post",
    observedContentText,
    metadata: {
      substackPostId: "111111",
      publicationSubdomain: "example",
      slug: "unit-test-post",
      title: "OpenErrata",
      authorName: "Test Author",
    },
  }) as Extract<ViewPostInput, { platform: "SUBSTACK" }>;
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
        sourceHtml: "<p>Server canonical text</p>",
        canonicalIdentity: null,
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
    sourceHtml: "<p>Server canonical text</p>",
    canonicalIdentity: null,
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
      sourceHtml: "<p>Server canonical text</p>",
      canonicalIdentity: null,
    }),
  });

  assert.deepEqual(result, {
    provenance: "SERVER_VERIFIED",
    contentText: "Server canonical text",
    contentHash: "server-hash",
    sourceHtml: "<p>Server canonical text</p>",
    canonicalIdentity: null,
  });
});

test("resolveCanonicalContentVersion reports mismatches for all server-verified platforms", async () => {
  // Platforms with externalId (LESSWRONG, X, SUBSTACK) include it in the mismatch report;
  // WIKIPEDIA has no externalId so the mismatch omits it. Both shapes are tested here.
  const viewInputs = [
    buildLesswrongViewInput("<p>Observed text</p>"),
    buildXViewInput("Observed text"),
    buildSubstackViewInput("Observed text"),
    buildWikipediaViewInput("Observed text"),
  ] satisfies ViewPostInput[];

  for (const viewInput of viewInputs) {
    let capturedMismatch: ServerVerifiedContentMismatch | null = null;

    const result = await resolveCanonicalContentVersion({
      viewInput,
      observed: {
        contentText: "Observed text",
        contentHash: "observed-hash",
      },
      fetchCanonicalContent: async () => ({
        provenance: "SERVER_VERIFIED",
        contentText: "Server canonical text",
        contentHash: "server-hash",
        sourceHtml: "<p>Server canonical text</p>",
        canonicalIdentity: null,
      }),
      onServerVerifiedContentMismatch: (mismatch) => {
        capturedMismatch = mismatch;
      },
    });

    assert.deepEqual(
      capturedMismatch,
      {
        platform: viewInput.platform,
        url: viewInput.url,
        observedHash: "observed-hash",
        serverHash: "server-hash",
        ...("externalId" in viewInput ? { externalId: viewInput.externalId } : {}),
      },
      `platform=${viewInput.platform}`,
    );
    // Server content remains authoritative regardless of the mismatch
    assert.equal(result.provenance, "SERVER_VERIFIED", `platform=${viewInput.platform}`);
  }
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

// ── onClientFallback callback ─────────────────────────────────────────────────

test("resolveCanonicalContentVersion calls onClientFallback with failure reason when fetch fails", async () => {
  const viewInput = buildWikipediaViewInput("Observed text");
  const observed = {
    contentText: "Observed text",
    contentHash: "observed-hash",
  };
  let capturedReason: string | null = null;

  await resolveCanonicalContentVersion({
    viewInput,
    observed,
    fetchCanonicalContent: async () => ({
      provenance: "CLIENT_FALLBACK",
      fetchFailureReason: "Wikipedia parse API returned 503",
    }),
    onClientFallback: (reason) => {
      capturedReason = reason;
    },
  });

  assert.equal(capturedReason, "Wikipedia parse API returned 503");
});

test("resolveCanonicalContentVersion does not call onClientFallback on successful server verification", async () => {
  const viewInput = buildXViewInput("Observed text");
  const observed = {
    contentText: "Observed text",
    contentHash: "observed-hash",
  };
  let callbackCalled = false;

  await resolveCanonicalContentVersion({
    viewInput,
    observed,
    fetchCanonicalContent: async () => ({
      provenance: "SERVER_VERIFIED",
      contentText: "Observed text",
      contentHash: "observed-hash",
      sourceHtml: "<p>Observed text</p>",
      canonicalIdentity: null,
    }),
    onClientFallback: () => {
      callbackCalled = true;
    },
  });

  assert.equal(callbackCalled, false);
});
