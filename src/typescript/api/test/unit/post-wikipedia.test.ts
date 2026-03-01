import assert from "node:assert/strict";
import { test } from "node:test";
import { viewPostInputSchema } from "@openerrata/shared";
import type { ViewPostInput } from "@openerrata/shared";
import { TRPCError } from "@trpc/server";
import {
  prepareViewPostInput,
  type PreparedWikipediaViewInput,
} from "../../src/lib/trpc/routes/post/wikipedia.js";

function buildWikipediaInput(
  overrides: Partial<Extract<ViewPostInput, { platform: "WIKIPEDIA" }>> = {},
): Extract<ViewPostInput, { platform: "WIKIPEDIA" }> {
  const input = viewPostInputSchema.parse({
    platform: "WIKIPEDIA",
    url: "https://en.wikipedia.org/wiki/OpenErrata",
    observedContentText: "OpenErrata article body",
    metadata: {
      language: "en",
      title: "OpenErrata",
      pageId: "12345",
      revisionId: "67890",
      displayTitle: "OpenErrata",
    },
    ...overrides,
  });
  if (input.platform !== "WIKIPEDIA") {
    throw new Error(`Expected WIKIPEDIA input, got ${input.platform}`);
  }
  return input;
}

function buildXInput(): Extract<ViewPostInput, { platform: "X" }> {
  return viewPostInputSchema.parse({
    platform: "X",
    externalId: "unit-test-post-x-1",
    url: "https://x.com/openerrata/status/1",
    observedContentText: "x post text",
    metadata: {
      authorHandle: "openerrata",
      authorDisplayName: "OpenErrata",
      text: "x post text",
      mediaUrls: [],
    },
  }) as Extract<ViewPostInput, { platform: "X" }>;
}

function expectTrpcBadRequest(error: unknown, expectedMessage: RegExp): void {
  assert.equal(error instanceof TRPCError, true);
  if (!(error instanceof TRPCError)) {
    return;
  }
  assert.equal(error.code, "BAD_REQUEST");
  assert.match(error.message, expectedMessage);
}

function assertIsPreparedWikipediaInput(
  value: ReturnType<typeof prepareViewPostInput>,
): asserts value is PreparedWikipediaViewInput {
  assert.equal(value.platform, "WIKIPEDIA");
}

test("prepareViewPostInput passes through non-Wikipedia inputs unchanged", () => {
  const input = buildXInput();
  const prepared = prepareViewPostInput(input);
  assert.deepEqual(prepared, input);
});

test("prepareViewPostInput canonicalizes Wikipedia metadata and derives external id", () => {
  const prepared = prepareViewPostInput(
    buildWikipediaInput({
      url: "https://EN.m.wikipedia.org/wiki/Open_Errata",
      metadata: {
        language: " EN ",
        title: "Open Errata",
        pageId: " 12345 ",
        revisionId: " 67890 ",
        displayTitle: "OpenErrata",
      },
    }),
  );

  assertIsPreparedWikipediaInput(prepared);
  assert.equal(prepared.metadata.language, "en");
  assert.equal(prepared.metadata.title, "Open_Errata");
  assert.equal(prepared.metadata.pageId, "12345");
  assert.equal(prepared.metadata.revisionId, "67890");
  assert.equal(prepared.derivedExternalId, "en:12345");
});

test("prepareViewPostInput accepts /w/index.php title URLs and validates title parity", () => {
  const prepared = prepareViewPostInput(
    buildWikipediaInput({
      url: "https://en.wikipedia.org/w/index.php?title=Open_Errata",
      metadata: {
        language: "en",
        title: "Open Errata",
        pageId: "12345",
        revisionId: "67890",
        displayTitle: "OpenErrata",
      },
    }),
  );

  assertIsPreparedWikipediaInput(prepared);
  assert.equal(prepared.metadata.title, "Open_Errata");
  assert.equal(prepared.derivedExternalId, "en:12345");
});

test("prepareViewPostInput prioritizes URL page ID checks when present", () => {
  const prepared = prepareViewPostInput(
    buildWikipediaInput({
      url: "https://en.wikipedia.org/wiki/Completely_Different?curid=12345",
      metadata: {
        language: "en",
        title: "OpenErrata",
        pageId: "12345",
        revisionId: "67890",
        displayTitle: "OpenErrata",
      },
    }),
  );

  assertIsPreparedWikipediaInput(prepared);
  assert.equal(prepared.derivedExternalId, "en:12345");
});

test("prepareViewPostInput rejects malformed Wikipedia metadata title", () => {
  assert.throws(
    () =>
      prepareViewPostInput(
        buildWikipediaInput({
          metadata: {
            language: "en",
            title: "   ",
            pageId: "12345",
            revisionId: "67890",
            displayTitle: "OpenErrata",
          },
        }),
      ),
    (error: unknown) => {
      expectTrpcBadRequest(error, /metadata\.title is invalid/);
      return true;
    },
  );
});

test("prepareViewPostInput rejects Wikipedia language mismatch against host", () => {
  assert.throws(
    () =>
      prepareViewPostInput(
        buildWikipediaInput({
          url: "https://de.wikipedia.org/wiki/OpenErrata",
          metadata: {
            language: "en",
            title: "OpenErrata",
            pageId: "12345",
            revisionId: "67890",
            displayTitle: "OpenErrata",
          },
        }),
      ),
    (error: unknown) => {
      expectTrpcBadRequest(error, /language does not match URL host language/);
      return true;
    },
  );
});

test("prepareViewPostInput rejects Wikipedia page ID mismatch against URL", () => {
  assert.throws(
    () =>
      prepareViewPostInput(
        buildWikipediaInput({
          url: "https://en.wikipedia.org/wiki/OpenErrata?pageid=98765",
          metadata: {
            language: "en",
            title: "OpenErrata",
            pageId: "12345",
            revisionId: "67890",
            displayTitle: "OpenErrata",
          },
        }),
      ),
    (error: unknown) => {
      expectTrpcBadRequest(error, /metadata\.pageId does not match URL page ID/);
      return true;
    },
  );
});

test("prepareViewPostInput rejects Wikipedia title mismatch when URL has no page ID", () => {
  assert.throws(
    () =>
      prepareViewPostInput(
        buildWikipediaInput({
          url: "https://en.wikipedia.org/wiki/Some_Other_Page",
          metadata: {
            language: "en",
            title: "OpenErrata",
            pageId: "12345",
            revisionId: "67890",
            displayTitle: "OpenErrata",
          },
        }),
      ),
    (error: unknown) => {
      expectTrpcBadRequest(error, /metadata\.title does not match URL article title/);
      return true;
    },
  );
});

test("prepareViewPostInput rejects Wikipedia URLs that do not identify an article", () => {
  assert.throws(
    () =>
      prepareViewPostInput(
        buildWikipediaInput({
          url: "https://en.wikipedia.org/wiki/",
        }),
      ),
    (error: unknown) => {
      expectTrpcBadRequest(error, /URL must identify an article title or page ID/);
      return true;
    },
  );
});
