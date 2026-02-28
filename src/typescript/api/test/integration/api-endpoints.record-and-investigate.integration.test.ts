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
  randomInt,
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
  seedInvestigationRun,
  seedPendingInvestigation,
  seedPost,
  seedPostForXViewInput,
  seedProcessingInvestigation,
  seedPrompt,
  sha256,
  sleep,
  test,
  versionHashFromContentHash,
  withIntegrationPrefix,
  withMockLesswrongCanonicalHtml,
  withMockLesswrongFetch,
} from "./api-endpoints.integration.shared.js";

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
  randomInt,
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
  seedInvestigationRun,
  seedPendingInvestigation,
  seedPost,
  seedPostForXViewInput,
  seedProcessingInvestigation,
  seedPrompt,
  sha256,
  sleep,
  test,
  versionHashFromContentHash,
  withIntegrationPrefix,
  withMockLesswrongCanonicalHtml,
  withMockLesswrongFetch,
];

void test("GET /health returns ok", async () => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- health route test bypasses SvelteKit event
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
  assert.equal(result.claims, null);

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
  assert.equal(result.claims, null);

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

void test("post.recordViewAndGetStatus rejects canonical hash mismatches for server-verified content", async () => {
  const caller = createCaller();
  const input = buildLesswrongViewInput({
    externalId: "view-post-content-mismatch-1",
    htmlContent: "<article><p>Observed browser content.</p></article>",
  });

  await assert.rejects(
    async () =>
      withMockLesswrongCanonicalHtml(
        "<article><p>Different canonical server content.</p></article>",
        () => caller.post.recordViewAndGetStatus(input),
      ),
    /Observed content does not match canonical content/,
  );

  const post = await prisma.post.findUnique({
    where: {
      platform_externalId: {
        platform: input.platform,
        externalId: input.externalId,
      },
    },
    select: { id: true },
  });

  assert.equal(post, null);
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
    (error: unknown) =>
      /minimum supported version is 0\.2\.0/i.test(String(error)) &&
      errorHasOpenErrataCode(error, "UPGRADE_REQUIRED"),
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
    (error: unknown) =>
      /Malformed extension version header/i.test(String(error)) &&
      errorHasOpenErrataCode(error, "MALFORMED_EXTENSION_VERSION"),
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
  assert.equal(result.claims, null);
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

void test("post.recordViewAndGetStatus returns interim old claims from latest complete server-verified investigation without queueing", async () => {
  const caller = createCaller();
  const externalId = "view-post-update-interim-1";
  const previousHtml = "<article><p>The moon is made of green cheese.</p></article>";
  const currentHtml = "<article><p>The moon is made of cheddar cheese.</p></article>";
  const previousInput = buildLesswrongViewInput({
    externalId,
    htmlContent: previousHtml,
  });
  await withMockLesswrongCanonicalHtml(previousHtml, () =>
    caller.post.recordViewAndGetStatus(previousInput),
  );

  const post = await prisma.post.findUnique({
    where: {
      platform_externalId: {
        platform: previousInput.platform,
        externalId: previousInput.externalId,
      },
    },
    select: { id: true },
  });
  assert.ok(post);

  const previousCanonicalText = lesswrongHtmlToNormalizedText(previousHtml);
  const previousCanonicalHash = await hashContent(previousCanonicalText);
  const sourceInvestigation = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: previousCanonicalHash,
    contentText: previousCanonicalText,
    provenance: "SERVER_VERIFIED",
  });
  await seedClaimWithSource(sourceInvestigation.id, 1);
  await seedClaimWithSource(sourceInvestigation.id, 2);

  const currentInput = buildLesswrongViewInput({
    externalId,
    htmlContent: currentHtml,
  });
  const result = await withMockLesswrongCanonicalHtml(currentHtml, () =>
    caller.post.recordViewAndGetStatus(currentInput),
  );

  assert.equal(result.investigationState, "NOT_INVESTIGATED");
  assert.equal(result.claims, null);
  const interimResult = result.priorInvestigationResult;
  assert.notEqual(interimResult, null);
  assert.ok(interimResult);
  assert.equal(interimResult.sourceInvestigationId, sourceInvestigation.id);
  assert.equal(interimResult.oldClaims.length, 2);

  const currentCanonicalText = lesswrongHtmlToNormalizedText(currentHtml);
  const currentCanonicalHash = await hashContent(currentCanonicalText);
  const currentVersionInvestigations = await prisma.investigation.findMany({
    where: {
      postVersion: {
        postId: post.id,
        contentBlob: {
          contentHash: currentCanonicalHash,
        },
      },
    },
    select: { id: true },
  });
  assert.equal(currentVersionInvestigations.length, 0);

  const allInvestigations = await prisma.investigation.findMany({
    where: {
      postVersion: {
        postId: post.id,
      },
    },
    select: { id: true },
  });
  const runCount = await prisma.investigationRun.count({
    where: {
      investigationId: {
        in: allInvestigations.map((investigation) => investigation.id),
      },
    },
  });
  assert.equal(runCount, 0);
});

void test("post.recordViewAndGetStatus does not reuse CLIENT_FALLBACK investigations as interim update claims", async () => {
  const caller = createCaller();
  const externalId = "view-post-update-interim-fallback-source-1";
  const previousHtml = "<article><p>Venus has one moon.</p></article>";
  const currentHtml = "<article><p>Venus has two moons.</p></article>";
  const previousInput = buildLesswrongViewInput({
    externalId,
    htmlContent: previousHtml,
  });
  const previousCanonicalText = lesswrongHtmlToNormalizedText(previousHtml);
  const previousCanonicalHash = await hashContent(previousCanonicalText);
  const post = await seedPost({
    platform: previousInput.platform,
    externalId,
    url: previousInput.url,
    contentText: previousCanonicalText,
  });
  const fallbackOnlySource = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: previousCanonicalHash,
    contentText: previousCanonicalText,
    provenance: "CLIENT_FALLBACK",
  });
  await seedClaimWithSource(fallbackOnlySource.id, 11);

  const currentInput = buildLesswrongViewInput({
    externalId,
    htmlContent: currentHtml,
  });
  const result = await withMockLesswrongCanonicalHtml(currentHtml, () =>
    caller.post.recordViewAndGetStatus(currentInput),
  );

  assert.equal(result.investigationState, "NOT_INVESTIGATED");
  assert.equal(result.claims, null);
  assert.equal(result.priorInvestigationResult, null);
});

void test("post.recordViewAndGetStatus reuses latest complete SERVER_VERIFIED interim claims when canonical provenance is CLIENT_FALLBACK", async () => {
  const caller = createCaller();
  const externalId = "view-post-update-interim-client-fallback-canonical-1";
  const previousInput = buildXViewInput({
    externalId,
    observedContentText: "Mercury has one moon.",
  });
  await caller.post.recordViewAndGetStatus(previousInput);

  const post = await prisma.post.findUnique({
    where: {
      platform_externalId: {
        platform: previousInput.platform,
        externalId: previousInput.externalId,
      },
    },
    select: { id: true },
  });
  assert.ok(post);

  const previousCanonicalText = normalizeContent(previousInput.observedContentText);
  const previousCanonicalHash = await hashContent(previousCanonicalText);
  const sourceInvestigation = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: previousCanonicalHash,
    contentText: previousCanonicalText,
    provenance: "SERVER_VERIFIED",
  });
  await seedClaimWithSource(sourceInvestigation.id, 41);

  const currentInput = buildXViewInput({
    externalId,
    observedContentText: "Mercury has two moons.",
  });
  const result = await caller.post.recordViewAndGetStatus(currentInput);

  assert.equal(result.investigationState, "NOT_INVESTIGATED");
  assert.equal(result.claims, null);
  const interimResult = result.priorInvestigationResult;
  assert.notEqual(interimResult, null);
  assert.ok(interimResult);
  assert.equal(interimResult.sourceInvestigationId, sourceInvestigation.id);
  assert.equal(interimResult.oldClaims.length, 1);
  assert.equal(interimResult.oldClaims[0]?.text, "Claim 41");
});

void test("post.recordViewAndGetStatus uses newest complete SERVER_VERIFIED investigation as interim source", async () => {
  const caller = createCaller();
  const externalId = "view-post-update-interim-newest-source-1";
  const baselineHtml = "<article><p>Jupiter has 79 moons.</p></article>";
  const currentHtml = "<article><p>Jupiter has 95 moons.</p></article>";
  const baselineInput = buildLesswrongViewInput({
    externalId,
    htmlContent: baselineHtml,
  });
  await withMockLesswrongCanonicalHtml(baselineHtml, () =>
    caller.post.recordViewAndGetStatus(baselineInput),
  );

  const post = await prisma.post.findUnique({
    where: {
      platform_externalId: {
        platform: baselineInput.platform,
        externalId: baselineInput.externalId,
      },
    },
    select: { id: true },
  });
  assert.ok(post);

  const baselineCanonicalText = lesswrongHtmlToNormalizedText(baselineHtml);
  const baselineCanonicalHash = await hashContent(baselineCanonicalText);
  const olderSource = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: baselineCanonicalHash,
    contentText: baselineCanonicalText,
    provenance: "SERVER_VERIFIED",
    checkedAt: new Date("2026-02-01T00:00:00.000Z"),
  });
  await seedClaimWithSource(olderSource.id, 21);

  const newerSourceText = normalizeContent("Jupiter has exactly 92 moons.");
  const newerSourceHash = await hashContent(newerSourceText);
  const newerSource = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: newerSourceHash,
    contentText: newerSourceText,
    provenance: "SERVER_VERIFIED",
    checkedAt: new Date("2026-02-20T00:00:00.000Z"),
  });
  await seedClaimWithSource(newerSource.id, 22);

  const currentInput = buildLesswrongViewInput({
    externalId,
    htmlContent: currentHtml,
  });
  const result = await withMockLesswrongCanonicalHtml(currentHtml, () =>
    caller.post.recordViewAndGetStatus(currentInput),
  );

  assert.equal(result.investigationState, "NOT_INVESTIGATED");
  assert.equal(result.claims, null);
  const newestInterimResult = result.priorInvestigationResult;
  assert.notEqual(newestInterimResult, null);
  assert.ok(newestInterimResult);
  assert.equal(newestInterimResult.sourceInvestigationId, newerSource.id);
  assert.equal(newestInterimResult.oldClaims.length, 1);
  assert.equal(newestInterimResult.oldClaims[0]?.text, "Claim 22");
});

void test("post.recordViewAndGetStatus returns INVESTIGATED for current-version complete result even when an older interim source exists", async () => {
  const caller = createCaller();
  const externalId = "view-post-update-current-complete-precedence-1";
  const previousHtml = "<article><p>Saturn has 82 moons.</p></article>";
  const currentHtml = "<article><p>Saturn has 145 moons.</p></article>";
  const previousInput = buildLesswrongViewInput({
    externalId,
    htmlContent: previousHtml,
  });
  await withMockLesswrongCanonicalHtml(previousHtml, () =>
    caller.post.recordViewAndGetStatus(previousInput),
  );

  const post = await prisma.post.findUnique({
    where: {
      platform_externalId: {
        platform: previousInput.platform,
        externalId: previousInput.externalId,
      },
    },
    select: { id: true },
  });
  assert.ok(post);

  const previousCanonicalText = lesswrongHtmlToNormalizedText(previousHtml);
  const previousCanonicalHash = await hashContent(previousCanonicalText);
  const olderSource = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: previousCanonicalHash,
    contentText: previousCanonicalText,
    provenance: "SERVER_VERIFIED",
  });
  await seedClaimWithSource(olderSource.id, 31);

  const currentCanonicalText = lesswrongHtmlToNormalizedText(currentHtml);
  const currentCanonicalHash = await hashContent(currentCanonicalText);
  const currentComplete = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: currentCanonicalHash,
    contentText: currentCanonicalText,
    provenance: "SERVER_VERIFIED",
  });
  await seedClaimWithSource(currentComplete.id, 32);

  const currentInput = buildLesswrongViewInput({
    externalId,
    htmlContent: currentHtml,
  });
  const result = await caller.post.recordViewAndGetStatus(currentInput);

  assert.equal(result.investigationState, "INVESTIGATED");
  assert.equal(result.provenance, "SERVER_VERIFIED");
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0]?.text, "Claim 32");
});

void test("post.getInvestigation returns complete investigation with claims", async () => {
  const caller = createCaller();
  const post = await seedPost({
    platform: "X",
    externalId: "get-investigation-1",
    url: "https://x.com/openerrata/status/get-investigation-1",
    contentText: "Existing canonical content for getInvestigation.",
  });
  const investigation = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
  });
  await seedClaimWithSource(investigation.id, 1);

  const result = await caller.post.getInvestigation({
    investigationId: investigation.id,
  });

  assert.equal(result.investigationState, "INVESTIGATED");
  assert.equal(result.provenance, "CLIENT_FALLBACK");
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0]?.sources.length, 1);
  assert.equal(result.checkedAt, "2026-02-19T00:00:00.000Z");
});

void test("post.getInvestigation returns priorInvestigationResult for update investigations and null for non-updates", async () => {
  const caller = createCaller();
  const post = await seedPost({
    platform: "X",
    externalId: "get-investigation-update-projection-1",
    url: "https://x.com/openerrata/status/get-investigation-update-projection-1",
    contentText: "Initial content for update projection coverage.",
  });
  const parent = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "SERVER_VERIFIED",
  });
  await seedClaimWithSource(parent.id, 1);

  const updateContentText = normalizeContent(
    "Initial content for update projection coverage. Edited sentence.",
  );
  const updateContentHash = await hashContent(updateContentText);
  const updateInvestigation = await seedInvestigation({
    postId: post.id,
    contentHash: updateContentHash,
    contentText: updateContentText,
    provenance: "SERVER_VERIFIED",
    status: "PENDING",
    promptLabel: "get-investigation-update-projection-update",
    parentInvestigationId: parent.id,
    contentDiff: "Diff summary (line context):\n- Removed lines:\nOld\n+ Added lines:\nNew",
  });

  const nonUpdateContentText = normalizeContent(
    "Fresh pending investigation that is not an update.",
  );
  const nonUpdateContentHash = await hashContent(nonUpdateContentText);
  const nonUpdateInvestigation = await seedInvestigation({
    postId: post.id,
    contentHash: nonUpdateContentHash,
    contentText: nonUpdateContentText,
    provenance: "SERVER_VERIFIED",
    status: "PENDING",
    promptLabel: "get-investigation-update-projection-non-update",
  });

  const updateResult = await caller.post.getInvestigation({
    investigationId: updateInvestigation.id,
  });
  assert.equal(updateResult.investigationState, "INVESTIGATING");
  assert.equal(updateResult.status, "PENDING");
  assert.equal(updateResult.provenance, "SERVER_VERIFIED");
  const updatePrior = updateResult.priorInvestigationResult;
  assert.notEqual(updatePrior, null);
  assert.ok(updatePrior);
  assert.equal(updatePrior.oldClaims.length, 1);
  assert.equal(updatePrior.sourceInvestigationId, parent.id);

  const nonUpdateResult = await caller.post.getInvestigation({
    investigationId: nonUpdateInvestigation.id,
  });
  assert.equal(nonUpdateResult.investigationState, "INVESTIGATING");
  assert.equal(nonUpdateResult.status, "PENDING");
  assert.equal(nonUpdateResult.provenance, "SERVER_VERIFIED");
  assert.equal(nonUpdateResult.claims, null);
  assert.equal(nonUpdateResult.priorInvestigationResult, null);
});

void test("post.investigateNow returns existing investigation for authenticated callers", async () => {
  const caller = createCaller({ isAuthenticated: true });
  const input = buildXViewInput({
    externalId: "investigate-now-1",
    observedContentText: "Canonical content reused by investigateNow.",
  });
  const seeded = await seedInvestigationForXViewInput({
    viewInput: input,
    status: "COMPLETE",
    provenance: "CLIENT_FALLBACK",
  });

  const result = await caller.post.investigateNow(input);

  assert.equal(result.investigationId, seeded.investigationId);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.provenance, "CLIENT_FALLBACK");
});

void test("post.investigateNow creates update lineage metadata for edited server-verified content", async () => {
  const caller = createCaller({ isAuthenticated: true });
  const externalId = "investigate-now-update-lineage-1";
  const previousHtml = "<article><p>Mars has two moons called Phobos and Deimos.</p></article>";
  const currentHtml =
    "<article><p>Mars has three moons called Phobos, Deimos, and Harmonia.</p></article>";
  const previousInput = buildLesswrongViewInput({
    externalId,
    htmlContent: previousHtml,
  });
  await withMockLesswrongCanonicalHtml(previousHtml, () =>
    caller.post.recordViewAndGetStatus(previousInput),
  );

  const post = await prisma.post.findUnique({
    where: {
      platform_externalId: {
        platform: previousInput.platform,
        externalId: previousInput.externalId,
      },
    },
    select: { id: true },
  });
  assert.ok(post);

  const previousCanonicalText = lesswrongHtmlToNormalizedText(previousHtml);
  const previousCanonicalHash = await hashContent(previousCanonicalText);
  const sourceInvestigation = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: previousCanonicalHash,
    contentText: previousCanonicalText,
    provenance: "SERVER_VERIFIED",
  });
  await seedClaimWithSource(sourceInvestigation.id, 1);

  const currentInput = buildLesswrongViewInput({
    externalId,
    htmlContent: currentHtml,
  });
  const result = await withMockLesswrongCanonicalHtml(currentHtml, () =>
    caller.post.investigateNow(currentInput),
  );

  assert.equal(result.status, "PENDING");
  assert.equal(result.provenance, "SERVER_VERIFIED");

  const currentCanonicalText = lesswrongHtmlToNormalizedText(currentHtml);
  const currentCanonicalHash = await hashContent(currentCanonicalText);
  const storedInvestigation = await prisma.investigation.findUnique({
    where: { id: result.investigationId },
    select: {
      status: true,
      parentInvestigationId: true,
      contentDiff: true,
      postVersion: {
        select: {
          contentProvenance: true,
          contentBlob: {
            select: {
              contentHash: true,
            },
          },
        },
      },
    },
  });

  assert.ok(storedInvestigation);
  assert.equal(storedInvestigation.status, "PENDING");
  assert.equal(storedInvestigation.postVersion.contentBlob.contentHash, currentCanonicalHash);
  assert.equal(storedInvestigation.postVersion.contentProvenance, "SERVER_VERIFIED");
  assert.equal(storedInvestigation.parentInvestigationId, sourceInvestigation.id);
  assert.notEqual(storedInvestigation.contentDiff, null);
  assert.equal(storedInvestigation.contentDiff?.startsWith("Diff summary (line context):"), true);

  const runCount = await prisma.investigationRun.count({
    where: {
      investigationId: result.investigationId,
    },
  });
  assert.equal(runCount, 1);
});

void test("post.investigateNow creates update lineage metadata using latest complete SERVER_VERIFIED source when canonical provenance is CLIENT_FALLBACK", async () => {
  const caller = createCaller({ isAuthenticated: true });
  const externalId = "investigate-now-update-lineage-client-fallback-canonical-1";
  const previousInput = buildXViewInput({
    externalId,
    observedContentText: "Neptune has ten moons.",
  });
  await caller.post.recordViewAndGetStatus(previousInput);

  const post = await prisma.post.findUnique({
    where: {
      platform_externalId: {
        platform: previousInput.platform,
        externalId: previousInput.externalId,
      },
    },
    select: { id: true },
  });
  assert.ok(post);

  const previousCanonicalText = normalizeContent(previousInput.observedContentText);
  const previousCanonicalHash = await hashContent(previousCanonicalText);
  const sourceInvestigation = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: previousCanonicalHash,
    contentText: previousCanonicalText,
    provenance: "SERVER_VERIFIED",
  });
  await seedClaimWithSource(sourceInvestigation.id, 42);

  const currentInput = buildXViewInput({
    externalId,
    observedContentText: "Neptune has fourteen moons.",
  });
  const result = await caller.post.investigateNow(currentInput);

  assert.equal(result.status, "PENDING");
  assert.equal(result.provenance, "CLIENT_FALLBACK");

  const currentCanonicalText = normalizeContent(currentInput.observedContentText);
  const currentCanonicalHash = await hashContent(currentCanonicalText);
  const storedInvestigation = await prisma.investigation.findUnique({
    where: { id: result.investigationId },
    select: {
      status: true,
      parentInvestigationId: true,
      contentDiff: true,
      postVersion: {
        select: {
          contentProvenance: true,
          contentBlob: {
            select: {
              contentHash: true,
            },
          },
        },
      },
    },
  });
  assert.ok(storedInvestigation);
  assert.equal(storedInvestigation.status, "PENDING");
  assert.equal(storedInvestigation.postVersion.contentBlob.contentHash, currentCanonicalHash);
  assert.equal(storedInvestigation.postVersion.contentProvenance, "CLIENT_FALLBACK");
  assert.equal(storedInvestigation.parentInvestigationId, sourceInvestigation.id);
  assert.notEqual(storedInvestigation.contentDiff, null);
  assert.equal(storedInvestigation.contentDiff?.startsWith("Diff summary (line context):"), true);

  const runCount = await prisma.investigationRun.count({
    where: { investigationId: result.investigationId },
  });
  assert.equal(runCount, 1);
});

void test("post.investigateNow deduplicates concurrent callers to one pending investigation run", async () => {
  const input = buildXViewInput({
    externalId: "investigate-now-concurrent-dedupe-1",
    observedContentText:
      "Concurrent investigateNow requests should converge to one pending investigation.",
  });
  const callers = Array.from({ length: 12 }, (_, index) =>
    createCaller({
      isAuthenticated: true,
      viewerKey: withIntegrationPrefix(`concurrent-viewer-${index.toString()}`),
      ipRangeKey: withIntegrationPrefix(`concurrent-ip-${index.toString()}`),
    }),
  );

  const concurrentResult = await runConcurrentInvestigateNowScenario({
    viewInput: input,
    callers,
  });

  const post = await prisma.post.findUnique({
    where: {
      platform_externalId: {
        platform: input.platform,
        externalId: input.externalId,
      },
    },
    select: { id: true },
  });
  assert.ok(post);

  const storedInvestigations = await prisma.investigation.findMany({
    where: {
      postVersion: {
        postId: post.id,
      },
    },
    select: {
      id: true,
      status: true,
    },
  });
  assert.equal(storedInvestigations.length, 1);
  const storedInvestigation = storedInvestigations[0];
  assert.ok(storedInvestigation);
  assert.equal(storedInvestigation.id, concurrentResult.investigationId);
  assert.equal(storedInvestigation.status, "PENDING");

  const storedRuns = await prisma.investigationRun.findMany({
    where: { investigationId: storedInvestigation.id },
    select: { id: true, queuedAt: true },
  });
  assert.equal(storedRuns.length, 1);
  const storedRun = storedRuns[0];
  assert.ok(storedRun);
  assert.notEqual(storedRun.queuedAt, null);
});

void test("post.investigateNow deduplicates concurrent edited-content requests to one pending update investigation", async () => {
  const externalId = "investigate-now-update-concurrent-1";
  const previousHtml = "<article><p>Earth has one moon.</p></article>";
  const currentHtml = "<article><p>Earth has two moons.</p></article>";
  const authSeedCaller = createCaller({ isAuthenticated: true });
  const previousInput = buildLesswrongViewInput({
    externalId,
    htmlContent: previousHtml,
  });
  await withMockLesswrongCanonicalHtml(previousHtml, () =>
    authSeedCaller.post.recordViewAndGetStatus(previousInput),
  );

  const post = await prisma.post.findUnique({
    where: {
      platform_externalId: {
        platform: previousInput.platform,
        externalId: previousInput.externalId,
      },
    },
    select: { id: true },
  });
  assert.ok(post);

  const previousCanonicalText = lesswrongHtmlToNormalizedText(previousHtml);
  const previousCanonicalHash = await hashContent(previousCanonicalText);
  const sourceInvestigation = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: previousCanonicalHash,
    contentText: previousCanonicalText,
    provenance: "SERVER_VERIFIED",
  });
  await seedClaimWithSource(sourceInvestigation.id, 1);

  const currentInput = buildLesswrongViewInput({
    externalId,
    htmlContent: currentHtml,
  });
  const callers = Array.from({ length: 10 }, (_, index) =>
    createCaller({
      isAuthenticated: true,
      viewerKey: withIntegrationPrefix(`update-concurrent-viewer-${index.toString()}`),
      ipRangeKey: withIntegrationPrefix(`update-concurrent-ip-${index.toString()}`),
    }),
  );
  const results = await withMockLesswrongCanonicalHtml(currentHtml, () =>
    Promise.all(callers.map((caller) => caller.post.investigateNow(currentInput))),
  );

  const uniqueIds = new Set(results.map((result) => result.investigationId));
  assert.equal(uniqueIds.size, 1);
  assert.equal(
    results.every((result) => result.status === "PENDING"),
    true,
  );
  const updateInvestigationId = [...uniqueIds][0];
  if (updateInvestigationId === undefined) {
    assert.fail("missing update investigation id from concurrent investigateNow");
  }

  const currentCanonicalText = lesswrongHtmlToNormalizedText(currentHtml);
  const currentCanonicalHash = await hashContent(currentCanonicalText);
  const storedUpdateInvestigations = await prisma.investigation.findMany({
    where: {
      postVersion: {
        postId: post.id,
        contentBlob: {
          contentHash: currentCanonicalHash,
        },
      },
    },
    select: {
      id: true,
      status: true,
      parentInvestigationId: true,
    },
  });
  assert.equal(storedUpdateInvestigations.length, 1);
  const storedUpdateInvestigation = storedUpdateInvestigations[0];
  assert.ok(storedUpdateInvestigation);
  assert.equal(storedUpdateInvestigation.id, updateInvestigationId);
  assert.equal(storedUpdateInvestigation.status, "PENDING");
  assert.equal(storedUpdateInvestigation.parentInvestigationId, sourceInvestigation.id);

  const updateRunCount = await prisma.investigationRun.count({
    where: {
      investigationId: updateInvestigationId,
    },
  });
  assert.equal(updateRunCount, 1);
});

void test("post.investigateNow deduplicates concurrent user-key callers to one attached key source", async () => {
  const input = buildXViewInput({
    externalId: "investigate-now-concurrent-user-keys-1",
    observedContentText:
      "Concurrent user-key investigateNow requests should attach at most one key source.",
  });
  const callers = Array.from({ length: 10 }, (_, index) =>
    createCaller({
      userOpenAiApiKey: `sk-test-concurrent-user-key-${index.toString()}`,
      viewerKey: withIntegrationPrefix(`concurrent-user-key-viewer-${index.toString()}`),
      ipRangeKey: withIntegrationPrefix(`concurrent-user-key-ip-${index.toString()}`),
    }),
  );

  const concurrentResult = await runConcurrentInvestigateNowScenario({
    viewInput: input,
    callers,
  });

  const run = await prisma.investigationRun.findUnique({
    where: { investigationId: concurrentResult.investigationId },
    select: { id: true },
  });
  assert.ok(run);

  const keySources = await prisma.investigationOpenAiKeySource.findMany({
    where: { runId: run.id },
    select: {
      runId: true,
      keyId: true,
      expiresAt: true,
    },
  });
  assert.equal(keySources.length, 1);
  const keySource = keySources[0];
  assert.ok(keySource);
  assert.equal(typeof keySource.keyId, "string");
  assert.equal(keySource.keyId.length > 0, true);
  assert.notEqual(keySource.expiresAt, null);
});

void test("post.investigateNow randomized concurrency fuzz preserves dedupe invariants", async () => {
  const random = createDeterministicRandom(0x1a2b3c4d);
  const rounds = 12;
  const scenarios = [
    "NONE",
    "FAILED",
    "PENDING",
    "PROCESSING_STALE",
    "PROCESSING_ACTIVE",
    "COMPLETE",
  ] as const;
  const callerModes = ["authenticated", "user_key", "mixed"] as const;

  for (let round = 0; round < rounds; round += 1) {
    const scenario = scenarios[randomInt(random, 0, scenarios.length - 1)];
    const callerMode = callerModes[randomInt(random, 0, callerModes.length - 1)];
    const roundTag = `round=${round.toString()} scenario=${scenario} callerMode=${callerMode}`;
    const input = buildXViewInput({
      externalId: `investigate-now-fuzz-${round.toString()}`,
      observedContentText: `Concurrency fuzz payload for ${roundTag}`,
    });

    let seededInvestigationId: string | null = null;
    if (scenario !== "NONE") {
      const seeded = await seedInvestigationForXViewInput({
        viewInput: input,
        status:
          scenario === "COMPLETE"
            ? "COMPLETE"
            : scenario === "FAILED"
              ? "FAILED"
              : scenario === "PENDING"
                ? "PENDING"
                : "PROCESSING",
        provenance: "CLIENT_FALLBACK",
      });
      seededInvestigationId = seeded.investigationId;

      if (scenario === "PROCESSING_STALE") {
        await seedInvestigationRun({
          investigationId: seeded.investigationId,
          leaseOwner: withIntegrationPrefix(`stale-worker-${round.toString()}`),
          leaseExpiresAt: new Date(Date.now() - 10 * 60_000),
          startedAt: new Date(Date.now() - 20 * 60_000),
          heartbeatAt: new Date(Date.now() - 10 * 60_000),
        });
      }

      if (scenario === "PROCESSING_ACTIVE") {
        await seedInvestigationRun({
          investigationId: seeded.investigationId,
          leaseOwner: withIntegrationPrefix(`active-worker-${round.toString()}`),
          leaseExpiresAt: new Date(Date.now() + 10 * 60_000),
          startedAt: new Date(Date.now() - 60_000),
          heartbeatAt: new Date(),
        });
      }
    }

    const callerCount = randomInt(random, 4, 14);
    const callerPlans = Array.from({ length: callerCount }, (_, index) => {
      const jitterMs = randomInt(random, 0, 12);
      const viewerKey = withIntegrationPrefix(
        `fuzz-viewer-${round.toString()}-${index.toString()}`,
      );
      const ipRangeKey = withIntegrationPrefix(`fuzz-ip-${round.toString()}-${index.toString()}`);

      if (callerMode === "authenticated") {
        return {
          jitterMs,
          caller: createCaller({
            isAuthenticated: true,
            viewerKey,
            ipRangeKey,
          }),
        };
      }

      if (callerMode === "user_key") {
        return {
          jitterMs,
          caller: createCaller({
            userOpenAiApiKey: `sk-test-fuzz-${round.toString()}-${index.toString()}`,
            viewerKey,
            ipRangeKey,
          }),
        };
      }

      if (index % 2 === 0) {
        return {
          jitterMs,
          caller: createCaller({
            isAuthenticated: true,
            viewerKey,
            ipRangeKey,
          }),
        };
      }

      return {
        jitterMs,
        caller: createCaller({
          userOpenAiApiKey: `sk-test-fuzz-mixed-${round.toString()}-${index.toString()}`,
          viewerKey,
          ipRangeKey,
        }),
      };
    });

    const results = await Promise.all(
      callerPlans.map(async ({ caller, jitterMs }) => {
        await sleep(jitterMs);
        return caller.post.investigateNow(input);
      }),
    );

    const investigationIds = new Set(results.map((result) => result.investigationId));
    assert.equal(
      investigationIds.size,
      1,
      `all callers should converge to one investigation (${roundTag})`,
    );
    const firstResult = results[0];
    assert.ok(firstResult, `missing first result (${roundTag})`);
    const investigationId = firstResult.investigationId;
    if (seededInvestigationId !== null) {
      assert.equal(
        investigationId,
        seededInvestigationId,
        `existing investigation identity should be preserved (${roundTag})`,
      );
    }

    const expectedStoredStatus =
      scenario === "COMPLETE"
        ? "COMPLETE"
        : scenario === "PROCESSING_ACTIVE"
          ? "PROCESSING"
          : "PENDING";
    const returnedStatuses = new Set(results.map((result) => result.status));
    const allowedReturnedStatuses =
      scenario === "PROCESSING_STALE"
        ? new Set(["PENDING", "PROCESSING"])
        : new Set([expectedStoredStatus]);
    assert.equal(
      Array.from(returnedStatuses).every((status) => allowedReturnedStatuses.has(status)),
      true,
      `returned statuses fell outside allowed transition window (${roundTag})`,
    );
    if (scenario === "PROCESSING_STALE") {
      assert.equal(
        returnedStatuses.has("PENDING"),
        true,
        `stale-processing scenario should include at least one recovered PENDING result (${roundTag})`,
      );
    }

    const post = await prisma.post.findUnique({
      where: {
        platform_externalId: {
          platform: input.platform,
          externalId: input.externalId,
        },
      },
      select: { id: true },
    });
    assert.ok(post, `post should exist after investigateNow (${roundTag})`);

    const storedInvestigations = await prisma.investigation.findMany({
      where: {
        postVersion: {
          postId: post.id,
        },
      },
      select: { id: true, status: true },
    });
    assert.equal(
      storedInvestigations.length,
      1,
      `there should be exactly one investigation row (${roundTag})`,
    );
    const storedInvestigation = storedInvestigations[0];
    assert.ok(storedInvestigation, `missing stored investigation (${roundTag})`);
    assert.equal(
      storedInvestigation.id,
      investigationId,
      `stored investigation id mismatch (${roundTag})`,
    );
    assert.equal(
      storedInvestigation.status,
      expectedStoredStatus,
      `stored investigation status mismatch (${roundTag})`,
    );

    const storedRuns = await prisma.investigationRun.findMany({
      where: { investigationId },
      select: {
        id: true,
        queuedAt: true,
        leaseOwner: true,
        leaseExpiresAt: true,
      },
    });

    if (scenario === "COMPLETE") {
      assert.equal(
        storedRuns.length,
        0,
        `complete scenarios should not create runs via investigateNow path (${roundTag})`,
      );
      continue;
    }

    assert.equal(storedRuns.length, 1, `there should be exactly one run row (${roundTag})`);
    const run = storedRuns[0];
    assert.ok(run, `missing run record (${roundTag})`);

    if (expectedStoredStatus === "PENDING") {
      assert.notEqual(
        run.queuedAt,
        null,
        `pending investigations must have queuedAt (${roundTag})`,
      );
    }

    if (expectedStoredStatus === "PROCESSING") {
      assert.notEqual(
        run.leaseOwner,
        null,
        `active processing investigations must retain lease ownership (${roundTag})`,
      );
      assert.notEqual(
        run.leaseExpiresAt,
        null,
        `active processing investigations must retain lease expiry (${roundTag})`,
      );
    }

    const keySourceCount = await prisma.investigationOpenAiKeySource.count({
      where: { runId: run.id },
    });
    const hasUserKeyCaller = callerMode !== "authenticated";
    if (expectedStoredStatus === "PENDING" && hasUserKeyCaller) {
      assert.equal(
        keySourceCount <= 1,
        true,
        `pending investigateNow with user keys should attach at most one source (${roundTag})`,
      );
    } else {
      assert.equal(
        keySourceCount,
        0,
        `non-pending or no-user-key scenarios should not attach key source (${roundTag})`,
      );
    }
  }
});
