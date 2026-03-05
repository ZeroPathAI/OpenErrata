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
  hashContent,
  hashInstanceApiKey,
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
  hashContent,
  hashInstanceApiKey,
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
  const interimResult = result.priorInvestigationResult;
  assert.notEqual(interimResult, null);
  assert.ok(interimResult);
  assert.equal(interimResult.sourceInvestigationId, sourceInvestigation.id);
  assert.equal(interimResult.oldClaims.length, 2);

  const currentCanonicalText = lesswrongHtmlToNormalizedText(currentHtml);
  const currentCanonicalHash = await hashContent(currentCanonicalText);
  // recordViewAndGetStatus must NOT create or queue an investigation for the
  // current content version. We verify both:
  //   (a) no Investigation row exists for this version's content hash, and
  //   (b) no InvestigationLease row exists (which would indicate a worker
  //       had started processing a queued investigation).
  // Note: (b) is implied by (a) via FK, but the explicit check documents intent.
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
  assert.equal(
    currentVersionInvestigations.length,
    0,
    "recordViewAndGetStatus must not create investigations for the current version",
  );

  const currentVersionLeases = await prisma.investigationLease.findMany({
    where: {
      investigation: {
        postVersion: {
          postId: post.id,
          contentBlob: { contentHash: currentCanonicalHash },
        },
      },
    },
    select: { investigationId: true },
  });
  assert.equal(
    currentVersionLeases.length,
    0,
    "recordViewAndGetStatus must not queue (lease) investigations for the current version",
  );
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
