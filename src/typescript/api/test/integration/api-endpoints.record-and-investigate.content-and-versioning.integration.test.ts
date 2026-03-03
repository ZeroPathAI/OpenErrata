import {
  EMPTY_IMAGE_OCCURRENCES_HASH,
  INTEGRATION_DATA_PREFIX,
  INTEGRATION_LESSWRONG_FIXTURE_KEYS,
  InvestigatorExecutionError,
  MINIMUM_SUPPORTED_EXTENSION_VERSION,
  OpenAIInvestigator,
  WORD_COUNT_LIMIT,
  appRouter,
  assert,
  assertIntegrationDatabaseInvariants,
  buildFailedAttemptAudit,
  buildLesswrongViewInput,
  buildSucceededAttemptAudit,
  buildXViewInput,
  closeQueueUtils,
  createCaller,
  createContext,
  createDeterministicRandom,
  createMockRequestEvent,
  ensureInvestigationQueued,
  ensurePostVersionForSeed,
  errorHasOpenErrataCode,
  getPrisma,
  graphqlPost,
  hashContent,
  hashInstanceApiKey,
  healthGet,
  isNonNullObject,
  lesswrongHtmlToNormalizedText,
  loadLatestPostVersionByIdentity,
  normalizeContent,
  orchestrateInvestigation,
  prisma,
  queryPublicGraphql,
  randomChance,
  readLesswrongFixture,
  resetDatabase,
  runConcurrentInvestigateNowScenario,
  runSelector,
  seedClaimWithSource,
  seedCompleteInvestigation,
  seedCorroborationCredits,
  seedFailedInvestigation,
  seedInstanceApiKey,
  seedInvestigation,
  seedInvestigationForXViewInput,
  seedPendingInvestigation,
  seedPost,
  seedPostForXViewInput,
  seedProcessingInvestigation,
  seedPrompt,
  sha256,
  test,
  versionHashFromContentHash,
  withIntegrationPrefix,
  withMockLesswrongCanonicalHtml,
  withMockLesswrongFetch,
} from "./api-endpoints.integration.shared.js";
import { createInvestigateNowFuzzRoundScenario } from "./helpers/investigate-now-scenario-dsl.js";

void [
  EMPTY_IMAGE_OCCURRENCES_HASH,
  INTEGRATION_DATA_PREFIX,
  INTEGRATION_LESSWRONG_FIXTURE_KEYS,
  InvestigatorExecutionError,
  MINIMUM_SUPPORTED_EXTENSION_VERSION,
  OpenAIInvestigator,
  WORD_COUNT_LIMIT,
  appRouter,
  assert,
  assertIntegrationDatabaseInvariants,
  buildFailedAttemptAudit,
  buildLesswrongViewInput,
  buildSucceededAttemptAudit,
  buildXViewInput,
  closeQueueUtils,
  createCaller,
  createContext,
  createDeterministicRandom,
  createMockRequestEvent,
  ensureInvestigationQueued,
  ensurePostVersionForSeed,
  errorHasOpenErrataCode,
  getPrisma,
  graphqlPost,
  hashContent,
  hashInstanceApiKey,
  healthGet,
  isNonNullObject,
  lesswrongHtmlToNormalizedText,
  loadLatestPostVersionByIdentity,
  normalizeContent,
  orchestrateInvestigation,
  prisma,
  queryPublicGraphql,
  randomChance,
  readLesswrongFixture,
  resetDatabase,
  runConcurrentInvestigateNowScenario,
  runSelector,
  seedClaimWithSource,
  seedCompleteInvestigation,
  seedCorroborationCredits,
  seedFailedInvestigation,
  seedInstanceApiKey,
  seedInvestigation,
  seedInvestigationForXViewInput,
  seedPendingInvestigation,
  seedPost,
  seedPostForXViewInput,
  seedProcessingInvestigation,
  seedPrompt,
  sha256,
  test,
  versionHashFromContentHash,
  withIntegrationPrefix,
  withMockLesswrongCanonicalHtml,
  withMockLesswrongFetch,
  createInvestigateNowFuzzRoundScenario,
];

void test("GET /health returns ok", async () => {
  const requestEvent = null as unknown as Parameters<typeof healthGet>[0];
  const response = await healthGet(requestEvent);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    minimumSupportedExtensionVersion: MINIMUM_SUPPORTED_EXTENSION_VERSION,
  });
});

void test("post.recordViewAndGetStatus stores content and reports not investigated without matching investigation", async () => {
  const caller = createCaller();
  const input = buildXViewInput({
    externalId: "view-post-1",
    observedContentText: "  This   is a post body for viewPost.  ",
  });
  const expectedObservedHash = await hashContent(normalizeContent(input.observedContentText));

  const result = await caller.post.recordViewAndGetStatus(input);

  assert.equal(result.investigationState, "NOT_INVESTIGATED");

  const post = await prisma.post.findUnique({
    where: {
      platform_externalId: {
        platform: input.platform,
        externalId: input.externalId,
      },
    },
    select: {
      uniqueViewScore: true,
      viewCount: true,
    },
  });
  const latestVersion = await loadLatestPostVersionByIdentity({
    platform: input.platform,
    externalId: input.externalId,
  });

  assert.ok(post);
  assert.ok(latestVersion);
  assert.equal(latestVersion.contentBlob.contentHash, expectedObservedHash);
  assert.equal(latestVersion.contentBlob.contentText, normalizeContent(input.observedContentText));
  assert.equal(post.uniqueViewScore, 1);
  assert.equal(post.viewCount, 1);
});

void test("post.recordViewAndGetStatus for LessWrong derives observed content from html metadata", async () => {
  const caller = createCaller();
  const lesswrongFixture = await readLesswrongFixture(
    INTEGRATION_LESSWRONG_FIXTURE_KEYS.POST_VIEW_HTML,
  );
  const input = buildLesswrongViewInput({
    externalId: lesswrongFixture.externalId,
    htmlContent: lesswrongFixture.html,
  });

  const result = await withMockLesswrongFetch(
    INTEGRATION_LESSWRONG_FIXTURE_KEYS.POST_VIEW_HTML,
    () => caller.post.recordViewAndGetStatus(input),
  );

  assert.equal(result.investigationState, "NOT_INVESTIGATED");

  const post = await prisma.post.findUnique({
    where: {
      platform_externalId: {
        platform: input.platform,
        externalId: input.externalId,
      },
    },
    select: {
      uniqueViewScore: true,
      viewCount: true,
    },
  });
  const latestVersion = await loadLatestPostVersionByIdentity({
    platform: input.platform,
    externalId: input.externalId,
  });

  const expectedCanonicalText = lesswrongHtmlToNormalizedText(lesswrongFixture.html);
  const expectedCanonicalHash = await hashContent(expectedCanonicalText);

  assert.ok(post);
  assert.ok(latestVersion);
  assert.equal(latestVersion.contentBlob.contentText, expectedCanonicalText);
  assert.equal(latestVersion.contentBlob.contentHash, expectedCanonicalHash);
  assert.equal(post.uniqueViewScore, 1);
  assert.equal(post.viewCount, 1);
});

void test("post.registerObservedVersion uses server canonical content when client content differs", async () => {
  // When the server can independently verify content, it is authoritative regardless of
  // what the client observed. The client's browser DOM extraction (which may include
  // JS-injected elements, tracking pixels, and other browser-specific content) is only
  // a fallback for platforms without server-side canonical fetching. For platforms where
  // the server CAN fetch canonical content (LessWrong, Wikipedia), the server's version
  // is always stored, and the client's differing observation is silently superseded.
  const caller = createCaller();
  const serverCanonicalHtml = "<article><p>Server canonical content.</p></article>";
  const input = buildLesswrongViewInput({
    externalId: "view-post-server-wins-1",
    htmlContent: "<article><p>Observed browser content that differs from server.</p></article>",
  });

  const loggedWarnings: string[] = [];
  const originalConsoleWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    loggedWarnings.push(args.map((value) => String(value)).join(" "));
  };

  const result = await (async () => {
    try {
      return await withMockLesswrongCanonicalHtml(serverCanonicalHtml, () =>
        caller.post.registerObservedVersion(input),
      );
    } finally {
      console.warn = originalConsoleWarn;
    }
  })();

  assert.equal(result.provenance, "SERVER_VERIFIED");
  assert.equal(loggedWarnings.length, 1);
  assert.match(loggedWarnings[0] ?? "", /LESSWRONG/);
  assert.match(loggedWarnings[0] ?? "", /observedHash=/);
  assert.match(loggedWarnings[0] ?? "", /serverHash=/);

  const latestVersion = await loadLatestPostVersionByIdentity({
    platform: input.platform,
    externalId: input.externalId,
  });
  const expectedCanonicalText = lesswrongHtmlToNormalizedText(serverCanonicalHtml);
  const expectedCanonicalHash = await hashContent(expectedCanonicalText);

  assert.ok(latestVersion);
  assert.equal(latestVersion.contentBlob.contentText, expectedCanonicalText);
  assert.equal(latestVersion.contentBlob.contentHash, expectedCanonicalHash);
});

void test("post.registerObservedVersion corrects Wikipedia identity to server-verified pageId when client pageId differs", async () => {
  const caller = createCaller();
  const input = {
    platform: "WIKIPEDIA" as const,
    url: "https://en.wikipedia.org/wiki/OpenErrata",
    observedContentText: "Client-observed content that may differ from server canonical content.",
    metadata: {
      language: "en",
      title: "OpenErrata",
      pageId: "12345",
      revisionId: "67890",
      displayTitle: "OpenErrata",
    },
  };

  const originalFetch = globalThis.fetch;
  let sawWikipediaRequest = false;
  globalThis.fetch = async (fetchInput, fetchInit) => {
    const url =
      typeof fetchInput === "string"
        ? fetchInput
        : fetchInput instanceof URL
          ? fetchInput.toString()
          : fetchInput.url;
    if (!url.startsWith("https://en.wikipedia.org/w/api.php")) {
      return originalFetch(fetchInput, fetchInit);
    }
    sawWikipediaRequest = true;

    return new Response(
      JSON.stringify({
        parse: {
          text: "<div class='mw-parser-output'><p>Server canonical article text.</p></div>",
          pageid: 99999,
          revid: 67890,
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  };

  const result = await (async () => {
    try {
      return await caller.post.registerObservedVersion(input);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })();

  assert.equal(sawWikipediaRequest, true);
  assert.equal(result.provenance, "SERVER_VERIFIED");
  assert.equal(result.platform, "WIKIPEDIA");
  assert.equal(result.externalId, "en:99999");

  const corrected = await loadLatestPostVersionByIdentity({
    platform: "WIKIPEDIA",
    externalId: "en:99999",
  });
  assert.ok(corrected);
  assert.notEqual(corrected.serverVerifiedAt, null);

  const staleClientIdentityPost = await prisma.post.findUnique({
    where: {
      platform_externalId: {
        platform: "WIKIPEDIA",
        externalId: "en:12345",
      },
    },
    select: { id: true },
  });
  assert.equal(staleClientIdentityPost, null);
});

void test("post.registerObservedVersion enriches existing Wikipedia version htmlContent when first observation is fallback", async () => {
  const caller = createCaller();
  const canonicalHtml = "<div class='mw-parser-output'><p>Server canonical article text.</p></div>";
  const clientHtml = "<div class='mw-parser-output'><p>Server canonical article text.</p></div>";
  const pageId = Date.now().toString();
  const input = {
    platform: "WIKIPEDIA" as const,
    url: "https://en.wikipedia.org/wiki/OpenErrata_html_enrichment",
    observedContentText: normalizeContent("Server canonical article text."),
    metadata: {
      language: "en",
      title: "OpenErrata html enrichment",
      pageId,
      revisionId: "888888",
      displayTitle: "OpenErrata html enrichment",
      htmlContent: clientHtml,
    },
  };

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (fetchInput, fetchInit) => {
    const url =
      typeof fetchInput === "string"
        ? fetchInput
        : fetchInput instanceof URL
          ? fetchInput.toString()
          : fetchInput.url;
    if (!url.startsWith("https://en.wikipedia.org/w/api.php")) {
      return originalFetch(fetchInput, fetchInit);
    }
    return new Response(JSON.stringify({ error: "temporary upstream failure" }), {
      status: 503,
      headers: {
        "Content-Type": "application/json",
      },
    });
  };

  const fallbackResult = await (async () => {
    try {
      return await caller.post.registerObservedVersion(input);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })();

  assert.equal(fallbackResult.provenance, "CLIENT_FALLBACK");

  const fallbackVersion = await loadLatestPostVersionByIdentity({
    platform: "WIKIPEDIA",
    externalId: `en:${pageId}`,
  });
  assert.ok(fallbackVersion);
  const fallbackMeta = await prisma.wikipediaVersionMeta.findUnique({
    where: { postVersionId: fallbackVersion.id },
    select: {
      serverHtmlBlob: { select: { htmlContent: true } },
      clientHtmlBlob: { select: { htmlContent: true } },
    },
  });
  assert.ok(fallbackMeta);
  assert.equal(fallbackMeta.serverHtmlBlob?.htmlContent ?? null, null);
  assert.equal(fallbackMeta.clientHtmlBlob?.htmlContent ?? null, clientHtml);

  globalThis.fetch = async (fetchInput, fetchInit) => {
    const url =
      typeof fetchInput === "string"
        ? fetchInput
        : fetchInput instanceof URL
          ? fetchInput.toString()
          : fetchInput.url;
    if (!url.startsWith("https://en.wikipedia.org/w/api.php")) {
      return originalFetch(fetchInput, fetchInit);
    }
    return new Response(
      JSON.stringify({
        parse: {
          text: canonicalHtml,
          pageid: Number(pageId),
          revid: 888888,
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  };

  const verifiedResult = await (async () => {
    try {
      return await caller.post.registerObservedVersion(input);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })();

  assert.equal(verifiedResult.provenance, "SERVER_VERIFIED");

  const verifiedVersion = await loadLatestPostVersionByIdentity({
    platform: "WIKIPEDIA",
    externalId: `en:${pageId}`,
  });
  assert.ok(verifiedVersion);
  assert.equal(verifiedVersion.id, fallbackVersion.id);
  assert.notEqual(verifiedVersion.serverVerifiedAt, null);
  const verifiedMeta = await prisma.wikipediaVersionMeta.findUnique({
    where: { postVersionId: verifiedVersion.id },
    select: {
      serverHtmlBlob: { select: { htmlContent: true } },
      clientHtmlBlob: { select: { htmlContent: true } },
    },
  });
  assert.ok(verifiedMeta);
  assert.equal(verifiedMeta.serverHtmlBlob?.htmlContent, canonicalHtml);
  // Client HTML persists from the initial fallback observation.
  assert.equal(verifiedMeta.clientHtmlBlob?.htmlContent ?? null, clientHtml);
});

void test("post.registerObservedVersion keeps LessWrong mutable version metadata current for stable versions", async () => {
  const caller = createCaller();
  const canonicalHtml =
    "<article><h1>Stable LessWrong Title</h1><p>Stable canonical article body.</p></article>";
  const firstClientHtml = "<article><p>Client HTML snapshot one.</p></article>";
  const secondClientHtml = "<article><p>Client HTML snapshot two.</p></article>";

  const firstInputBase = buildLesswrongViewInput({
    externalId: "view-post-lesswrong-mutable-metadata-1",
    htmlContent: firstClientHtml,
  });
  const firstInput = {
    ...firstInputBase,
    observedImageUrls: ["https://images.example.test/lesswrong-old.png"],
    metadata: {
      ...firstInputBase.metadata,
      slug: `${firstInputBase.externalId}-old-slug`,
      title: "Old LessWrong Title",
      authorName: "Old Author",
      authorSlug: "old-author",
      tags: ["old-tag"],
      publishedAt: "2026-02-20T00:00:00.000Z",
    },
  };

  const firstResult = await withMockLesswrongCanonicalHtml(canonicalHtml, () =>
    caller.post.registerObservedVersion(firstInput),
  );
  assert.equal(firstResult.provenance, "SERVER_VERIFIED");

  const secondInputBase = buildLesswrongViewInput({
    externalId: "view-post-lesswrong-mutable-metadata-1",
    htmlContent: secondClientHtml,
  });
  const secondInput = {
    ...secondInputBase,
    observedImageUrls: ["https://images.example.test/lesswrong-new.png"],
    metadata: {
      ...secondInputBase.metadata,
      slug: `${secondInputBase.externalId}-new-slug`,
      title: "New LessWrong Title",
      authorName: "New Author",
      authorSlug: "new-author",
      tags: ["new-tag-a", "new-tag-b"],
      publishedAt: "2026-02-21T00:00:00.000Z",
    },
  };

  const secondResult = await withMockLesswrongCanonicalHtml(canonicalHtml, () =>
    caller.post.registerObservedVersion(secondInput),
  );
  assert.equal(secondResult.provenance, "SERVER_VERIFIED");
  assert.equal(secondResult.postVersionId, firstResult.postVersionId);

  const latestVersion = await loadLatestPostVersionByIdentity({
    platform: "LESSWRONG",
    externalId: firstInput.externalId,
  });
  assert.ok(latestVersion);
  const meta = await prisma.lesswrongVersionMeta.findUnique({
    where: { postVersionId: latestVersion.id },
    select: {
      slug: true,
      title: true,
      authorName: true,
      authorSlug: true,
      tags: true,
      publishedAt: true,
      imageUrls: true,
      serverHtmlBlob: { select: { htmlContent: true } },
      clientHtmlBlob: { select: { htmlContent: true } },
    },
  });
  assert.ok(meta);
  assert.equal(meta.slug, secondInput.metadata.slug);
  assert.equal(meta.title, secondInput.metadata.title);
  assert.equal(meta.authorName, secondInput.metadata.authorName);
  assert.equal(meta.authorSlug, secondInput.metadata.authorSlug);
  assert.deepEqual(meta.tags, secondInput.metadata.tags);
  assert.equal(meta.publishedAt?.toISOString(), "2026-02-21T00:00:00.000Z");
  assert.deepEqual(meta.imageUrls, secondInput.observedImageUrls);
  assert.equal(meta.serverHtmlBlob?.htmlContent, canonicalHtml);
  // Client HTML remains first-write-wins.
  assert.equal(meta.clientHtmlBlob?.htmlContent ?? null, firstClientHtml);
});

void test("post.registerObservedVersion keeps Substack mutable version metadata current for stable versions", async () => {
  const caller = createCaller();
  const externalId = withIntegrationPrefix("view-post-substack-mutable-metadata-1");
  const stableContent = normalizeContent("Stable Substack article body.");
  const firstClientHtml = "<article><p>Substack snapshot one.</p></article>";
  const secondClientHtml = "<article><p>Substack snapshot two.</p></article>";

  const firstInput = {
    platform: "SUBSTACK" as const,
    externalId,
    url: "https://openerrata-integration.substack.com/p/mutable-version-meta",
    observedContentText: stableContent,
    observedImageUrls: ["https://images.example.test/substack-old.png"],
    metadata: {
      substackPostId: "40001",
      publicationSubdomain: "openerrata-integration",
      slug: "mutable-version-meta-old",
      title: "Old Substack Title",
      subtitle: "Old Substack Subtitle",
      htmlContent: firstClientHtml,
      authorName: "Old Substack Author",
      authorSubstackHandle: "old-substack-author",
      publishedAt: "2026-02-10T00:00:00.000Z",
      likeCount: 2,
      commentCount: 3,
    },
  };

  const firstResult = await caller.post.registerObservedVersion(firstInput);
  assert.equal(firstResult.provenance, "CLIENT_FALLBACK");

  const secondInput = {
    platform: "SUBSTACK" as const,
    externalId,
    url: "https://openerrata-integration.substack.com/p/mutable-version-meta",
    observedContentText: stableContent,
    observedImageUrls: ["https://images.example.test/substack-new.png"],
    metadata: {
      substackPostId: "40001",
      publicationSubdomain: "openerrata-updated",
      slug: "mutable-version-meta-new",
      title: "New Substack Title",
      htmlContent: secondClientHtml,
      authorName: "New Substack Author",
      publishedAt: "2026-02-11T00:00:00.000Z",
      likeCount: 9,
      commentCount: 11,
    },
  };

  const secondResult = await caller.post.registerObservedVersion(secondInput);
  assert.equal(secondResult.provenance, "CLIENT_FALLBACK");
  assert.equal(secondResult.postVersionId, firstResult.postVersionId);

  const latestVersion = await loadLatestPostVersionByIdentity({
    platform: "SUBSTACK",
    externalId,
  });
  assert.ok(latestVersion);
  const meta = await prisma.substackVersionMeta.findUnique({
    where: { postVersionId: latestVersion.id },
    select: {
      publicationSubdomain: true,
      slug: true,
      title: true,
      subtitle: true,
      authorName: true,
      authorSubstackHandle: true,
      publishedAt: true,
      likeCount: true,
      commentCount: true,
      imageUrls: true,
      serverHtmlBlob: { select: { htmlContent: true } },
      clientHtmlBlob: { select: { htmlContent: true } },
    },
  });
  assert.ok(meta);
  assert.equal(meta.publicationSubdomain, secondInput.metadata.publicationSubdomain);
  assert.equal(meta.slug, secondInput.metadata.slug);
  assert.equal(meta.title, secondInput.metadata.title);
  assert.equal(meta.subtitle, null);
  assert.equal(meta.authorName, secondInput.metadata.authorName);
  assert.equal(meta.authorSubstackHandle, null);
  assert.equal(meta.publishedAt?.toISOString(), "2026-02-11T00:00:00.000Z");
  assert.equal(meta.likeCount, secondInput.metadata.likeCount);
  assert.equal(meta.commentCount, secondInput.metadata.commentCount);
  assert.deepEqual(meta.imageUrls, secondInput.observedImageUrls);
  assert.equal(meta.serverHtmlBlob?.htmlContent ?? null, null);
  // Client HTML remains first-write-wins.
  assert.equal(meta.clientHtmlBlob?.htmlContent ?? null, firstClientHtml);
});

void test("post.registerObservedVersion updates Wikipedia revision metadata for stable versions", async () => {
  const caller = createCaller();
  const canonicalHtml = "<div class='mw-parser-output'><p>Stable article text.</p></div>";
  const firstClientHtml = "<div class='mw-parser-output'><p>Client snapshot one.</p></div>";
  const secondClientHtml = "<div class='mw-parser-output'><p>Client snapshot two.</p></div>";
  const pageId = (Date.now() + 1).toString();
  const url = `https://en.wikipedia.org/wiki/OpenErrata_revision_meta_sync?curid=${pageId}`;
  const firstInput = {
    platform: "WIKIPEDIA" as const,
    url,
    observedContentText: normalizeContent("Stable article text."),
    observedImageUrls: ["https://images.example.test/wiki-old.png"],
    metadata: {
      language: "en",
      title: "OpenErrata_revision_meta_sync",
      pageId,
      revisionId: "10001",
      displayTitle: "OpenErrata Revision Meta Sync",
      lastModifiedAt: "2026-02-25T00:00:00.000Z",
      htmlContent: firstClientHtml,
    },
  };

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (fetchInput, fetchInit) => {
    const requestUrl =
      typeof fetchInput === "string"
        ? fetchInput
        : fetchInput instanceof URL
          ? fetchInput.toString()
          : fetchInput.url;
    if (!requestUrl.startsWith("https://en.wikipedia.org/w/api.php")) {
      return originalFetch(fetchInput, fetchInit);
    }
    return new Response(
      JSON.stringify({
        parse: {
          text: canonicalHtml,
          pageid: Number(pageId),
          revid: 10001,
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  const firstResult = await (async () => {
    try {
      return await caller.post.registerObservedVersion(firstInput);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })();
  assert.equal(firstResult.provenance, "SERVER_VERIFIED");

  const secondInput = {
    platform: "WIKIPEDIA" as const,
    url,
    observedContentText: normalizeContent("Stable article text."),
    observedImageUrls: ["https://images.example.test/wiki-new.png"],
    metadata: {
      language: "en",
      title: "OpenErrata_revision_meta_sync_v2",
      pageId,
      revisionId: "10002",
      displayTitle: "OpenErrata Revision Meta Sync v2",
      lastModifiedAt: "2026-02-26T00:00:00.000Z",
      htmlContent: secondClientHtml,
    },
  };

  globalThis.fetch = async (fetchInput, fetchInit) => {
    const requestUrl =
      typeof fetchInput === "string"
        ? fetchInput
        : fetchInput instanceof URL
          ? fetchInput.toString()
          : fetchInput.url;
    if (!requestUrl.startsWith("https://en.wikipedia.org/w/api.php")) {
      return originalFetch(fetchInput, fetchInit);
    }
    return new Response(
      JSON.stringify({
        parse: {
          text: canonicalHtml,
          pageid: Number(pageId),
          revid: 10002,
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  const secondResult = await (async () => {
    try {
      return await caller.post.registerObservedVersion(secondInput);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })();
  assert.equal(secondResult.provenance, "SERVER_VERIFIED");
  assert.equal(secondResult.postVersionId, firstResult.postVersionId);

  const latestVersion = await loadLatestPostVersionByIdentity({
    platform: "WIKIPEDIA",
    externalId: `en:${pageId}`,
  });
  assert.ok(latestVersion);
  const meta = await prisma.wikipediaVersionMeta.findUnique({
    where: { postVersionId: latestVersion.id },
    select: {
      title: true,
      displayTitle: true,
      revisionId: true,
      lastModifiedAt: true,
      imageUrls: true,
      serverHtmlBlob: { select: { htmlContent: true } },
      clientHtmlBlob: { select: { htmlContent: true } },
    },
  });
  assert.ok(meta);
  assert.equal(meta.title, secondInput.metadata.title);
  assert.equal(meta.displayTitle, secondInput.metadata.displayTitle);
  assert.equal(meta.revisionId, secondInput.metadata.revisionId);
  assert.equal(meta.lastModifiedAt?.toISOString(), "2026-02-26T00:00:00.000Z");
  assert.deepEqual(meta.imageUrls, secondInput.observedImageUrls);
  assert.equal(meta.serverHtmlBlob?.htmlContent, canonicalHtml);
  // Client HTML remains first-write-wins.
  assert.equal(meta.clientHtmlBlob?.htmlContent ?? null, firstClientHtml);
});

void test("post.registerObservedVersion rejects extension clients below minimum supported version", async () => {
  const caller = createCaller({
    extensionVersion: "0.1.4",
  });
  const input = buildXViewInput({
    externalId: "view-post-upgrade-required-1",
    observedContentText: "Version-gated content.",
  });

  await assert.rejects(
    async () => caller.post.registerObservedVersion(input),
    (error: unknown) => errorHasOpenErrataCode(error, "UPGRADE_REQUIRED"),
  );
});

void test("post.registerObservedVersion rejects malformed extension version header with distinct runtime code", async () => {
  const caller = createCaller({
    extensionVersion: "v0.2.0",
  });
  const input = buildXViewInput({
    externalId: "view-post-malformed-extension-version-1",
    observedContentText: "Version-gated content.",
  });

  await assert.rejects(
    async () => caller.post.registerObservedVersion(input),
    (error: unknown) => errorHasOpenErrataCode(error, "MALFORMED_EXTENSION_VERSION"),
  );
});

void test("post.recordViewAndGetStatus applies strict hash lookup and does not reuse stale investigations", async () => {
  const caller = createCaller();
  const initialInput = buildXViewInput({
    externalId: "view-post-strict-hash-1",
    observedContentText: "Original canonical content.",
  });

  await caller.post.recordViewAndGetStatus(initialInput);

  const seededPost = await prisma.post.findUnique({
    where: {
      platform_externalId: {
        platform: initialInput.platform,
        externalId: initialInput.externalId,
      },
    },
    select: { id: true },
  });

  assert.ok(seededPost);

  await seedCompleteInvestigation({
    postId: seededPost.id,
    contentHash: await hashContent(normalizeContent(initialInput.observedContentText)),
    contentText: normalizeContent(initialInput.observedContentText),
    provenance: "CLIENT_FALLBACK",
  });

  const updatedInput = buildXViewInput({
    externalId: "view-post-strict-hash-1",
    observedContentText: "Edited post content with a different hash.",
  });

  const result = await caller.post.recordViewAndGetStatus(updatedInput);

  assert.equal(result.investigationState, "NOT_INVESTIGATED");
});

void test("post.recordViewAndGetStatus deduplicates unique-view credit for repeated views by same viewer", async () => {
  const caller = createCaller({
    viewerKey: "integration-viewer-repeat",
    ipRangeKey: "integration-ip-range-repeat",
  });
  const input = buildXViewInput({
    externalId: "view-post-credit-dedupe-1",
    observedContentText: "Repeated view content.",
  });

  await caller.post.recordViewAndGetStatus(input);
  await caller.post.recordViewAndGetStatus(input);

  const post = await prisma.post.findUnique({
    where: {
      platform_externalId: {
        platform: input.platform,
        externalId: input.externalId,
      },
    },
    select: {
      id: true,
      uniqueViewScore: true,
      viewCount: true,
    },
  });

  assert.ok(post);
  assert.equal(post.viewCount, 2);
  assert.equal(post.uniqueViewScore, 1);

  const creditCount = await prisma.postViewCredit.count({
    where: { postId: post.id },
  });
  assert.equal(creditCount, 1);
});
