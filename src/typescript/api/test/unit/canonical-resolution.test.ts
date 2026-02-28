import assert from "node:assert/strict";
import { test } from "node:test";
import { viewPostInputSchema } from "@openerrata/shared";
import type { ViewPostInput } from "@openerrata/shared";
import { resolveCanonicalContentVersion } from "../../src/lib/services/canonical-resolution.js";
import type { CanonicalFetchInput } from "../../src/lib/services/content-fetcher.js";

function buildXViewInput(observedContentText: string): Extract<ViewPostInput, { platform: "X" }> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Zod parse validates the shape; Extract narrows the discriminated union
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
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Zod parse validates the shape; Extract narrows the discriminated union
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

test("resolveCanonicalContentVersion returns server-verified canonical content when hashes match", async () => {
  const viewInput = buildXViewInput("Observed text");
  const observed = {
    contentText: "Observed text",
    contentHash: "matching-hash",
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
        contentHash: "matching-hash",
      };
    },
  });

  assert.deepEqual(capturedFetchInput, {
    platform: "X",
    url: viewInput.url,
    externalId: viewInput.externalId,
  });
  assert.deepEqual(result, {
    state: "RESOLVED",
    canonical: {
      provenance: "SERVER_VERIFIED",
      contentText: "Server canonical text",
      contentHash: "matching-hash",
    },
  });
});

test("resolveCanonicalContentVersion returns CONTENT_MISMATCH for differing server hash", async () => {
  const viewInput = buildXViewInput("Observed text");
  const observed = {
    contentText: "Observed text",
    contentHash: "observed-hash",
  };

  const result = await resolveCanonicalContentVersion({
    viewInput,
    observed,
    fetchCanonicalContent: async () => ({
      provenance: "SERVER_VERIFIED",
      contentText: "Server canonical text",
      contentHash: "different-server-hash",
    }),
  });

  assert.deepEqual(result, { state: "CONTENT_MISMATCH" });
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
    state: "RESOLVED",
    canonical: {
      contentText: observed.contentText,
      contentHash: observed.contentHash,
      provenance: "CLIENT_FALLBACK",
      fetchFailureReason: "canonical fetch unavailable",
    },
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
      revisionId: "67890",
    },
  });
});
