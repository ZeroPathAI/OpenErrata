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
  assert.deepStrictEqual(nonUpdateResult.pendingClaims, []);
  assert.deepStrictEqual(nonUpdateResult.confirmedClaims, []);
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
          serverVerifiedAt: true,
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
  assert.notEqual(storedInvestigation.postVersion.serverVerifiedAt, null);
  assert.equal(storedInvestigation.parentInvestigationId, sourceInvestigation.id);
  assert.notEqual(storedInvestigation.contentDiff, null);

  const queuedInvestigation = await prisma.investigation.findUnique({
    where: { id: result.investigationId },
    select: { queuedAt: true },
  });
  assert.ok(queuedInvestigation);
  assert.notEqual(queuedInvestigation.queuedAt, null);
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
          serverVerifiedAt: true,
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
  assert.equal(storedInvestigation.postVersion.serverVerifiedAt, null);
  assert.equal(storedInvestigation.parentInvestigationId, sourceInvestigation.id);
  assert.notEqual(storedInvestigation.contentDiff, null);

  const queuedInvestigation2 = await prisma.investigation.findUnique({
    where: { id: result.investigationId },
    select: { queuedAt: true },
  });
  assert.ok(queuedInvestigation2);
  assert.notEqual(queuedInvestigation2.queuedAt, null);
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

  const storedInvestigationDetails = await prisma.investigation.findUnique({
    where: { id: storedInvestigation.id },
    select: { queuedAt: true },
  });
  assert.ok(storedInvestigationDetails);
  assert.notEqual(storedInvestigationDetails.queuedAt, null);
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

  const storedUpdateDetails = await prisma.investigation.findUnique({
    where: { id: updateInvestigationId },
    select: { queuedAt: true },
  });
  assert.ok(storedUpdateDetails);
  assert.notEqual(storedUpdateDetails.queuedAt, null);
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

  const keySources = await prisma.investigationOpenAiKeySource.findMany({
    where: { investigationId: concurrentResult.investigationId },
    select: {
      investigationId: true,
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

  for (let round = 0; round < rounds; round += 1) {
    const fuzzRound = createInvestigateNowFuzzRoundScenario({ round, random });
    const { roundTag, input, expectedStoredStatus } = fuzzRound;
    const { seededInvestigationId } = await fuzzRound.seedExistingInvestigation();
    const { investigationId, returnedStatuses } = await fuzzRound.runConcurrentInvestigateNow();
    if (seededInvestigationId !== null) {
      assert.equal(
        investigationId,
        seededInvestigationId,
        `existing investigation identity should be preserved (${roundTag})`,
      );
    }

    assert.equal(
      Array.from(returnedStatuses).every((status) => fuzzRound.allowedReturnedStatuses.has(status)),
      true,
      `returned statuses fell outside allowed transition window (${roundTag})`,
    );
    if (fuzzRound.requiresPendingRecoveryEvidence) {
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

    if (fuzzRound.scenario === "COMPLETE") {
      continue;
    }

    const storedDetails = await prisma.investigation.findUnique({
      where: { id: investigationId },
      select: { queuedAt: true },
    });
    assert.ok(storedDetails, `missing investigation details (${roundTag})`);

    if (expectedStoredStatus === "PENDING") {
      assert.notEqual(
        storedDetails.queuedAt,
        null,
        `pending investigations must have queuedAt (${roundTag})`,
      );
    }

    if (expectedStoredStatus === "PROCESSING") {
      const storedLease = await prisma.investigationLease.findUnique({
        where: { investigationId },
        select: { leaseOwner: true, leaseExpiresAt: true },
      });
      assert.ok(storedLease, `active processing investigations must have lease row (${roundTag})`);
      assert.notEqual(
        storedLease.leaseOwner,
        null,
        `active processing investigations must retain lease ownership (${roundTag})`,
      );
      assert.notEqual(
        storedLease.leaseExpiresAt,
        null,
        `active processing investigations must retain lease expiry (${roundTag})`,
      );
    }

    const keySourceCount = await prisma.investigationOpenAiKeySource.count({
      where: { investigationId },
    });
    if (expectedStoredStatus === "PENDING" && fuzzRound.hasUserKeyCaller) {
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
