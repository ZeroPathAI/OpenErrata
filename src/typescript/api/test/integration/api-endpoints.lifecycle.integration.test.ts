import type { InvestigatorInput } from "../../src/lib/investigators/interface.js";
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

void test("orchestrateInvestigation skips work when lease is held by another worker", async () => {
  const post = await seedPost({
    platform: "X",
    externalId: "orchestrator-lease-held-1",
    url: "https://x.com/openerrata/status/orchestrator-lease-held-1",
    contentText: "Active leases should short-circuit duplicate workers.",
  });
  const investigation = await seedInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
    status: "PROCESSING",
    promptLabel: "orchestrator-lease-held",
  });
  const leaseExpiresAt = new Date(Date.now() + 10 * 60_000);
  const run = await seedInvestigationRun({
    investigationId: investigation.id,
    leaseOwner: withIntegrationPrefix("lease-holder"),
    leaseExpiresAt,
    startedAt: new Date(Date.now() - 5_000),
    heartbeatAt: new Date(),
  });

  let investigateCalled = false;
  const originalInvestigateDescriptor = Object.getOwnPropertyDescriptor(
    OpenAIInvestigator.prototype,
    "investigate",
  );
  assert.ok(originalInvestigateDescriptor);
  assert.equal(typeof originalInvestigateDescriptor.value, "function");
  OpenAIInvestigator.prototype.investigate = async () => {
    investigateCalled = true;
    return {
      result: { claims: [] },
      attemptAudit: buildSucceededAttemptAudit("lease-held"),
      modelVersion: "test-model-version",
    };
  };

  try {
    await orchestrateInvestigation(
      run.id,
      { info() {}, error() {} },
      {
        isLastAttempt: false,
        attemptNumber: 1,
        workerIdentity: withIntegrationPrefix("contending-worker"),
      },
    );
  } finally {
    Object.defineProperty(
      OpenAIInvestigator.prototype,
      "investigate",
      originalInvestigateDescriptor,
    );
  }

  assert.equal(investigateCalled, false);
  const storedInvestigation = await prisma.investigation.findUnique({
    where: { id: investigation.id },
    select: { status: true },
  });
  assert.ok(storedInvestigation);
  assert.equal(storedInvestigation.status, "PROCESSING");
});

void test("orchestrateInvestigation passes update context to investigator for update investigations", async () => {
  const post = await seedPost({
    platform: "X",
    externalId: "orchestrator-update-context-1",
    url: "https://x.com/openerrata/status/orchestrator-update-context-1",
    contentText: "Original content before edit.",
  });
  const parentInvestigation = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "SERVER_VERIFIED",
  });
  const parentClaim = await seedClaimWithSource(parentInvestigation.id, 1);

  const updatedContentText = normalizeContent(
    "Original content before edit. Edited sentence added here.",
  );
  const updatedContentHash = await hashContent(updatedContentText);
  const contentDiff =
    "Diff summary (line context):\n- Removed lines:\nOriginal content before edit.\n+ Added lines:\nOriginal content before edit. Edited sentence added here.";
  const updateInvestigation = await seedInvestigation({
    postId: post.id,
    contentHash: updatedContentHash,
    contentText: updatedContentText,
    provenance: "SERVER_VERIFIED",
    status: "PENDING",
    promptLabel: "orchestrator-update-context",
    parentInvestigationId: parentInvestigation.id,
    contentDiff,
  });
  const run = await seedInvestigationRun({
    investigationId: updateInvestigation.id,
  });

  let sawExpectedUpdateContext = false;
  const originalInvestigateDescriptor = Object.getOwnPropertyDescriptor(
    OpenAIInvestigator.prototype,
    "investigate",
  );
  assert.ok(originalInvestigateDescriptor);
  assert.equal(typeof originalInvestigateDescriptor.value, "function");
  OpenAIInvestigator.prototype.investigate = async (input: InvestigatorInput) => {
    assert.equal(input.isUpdate, true);
    assert.equal(input.contentDiff, contentDiff);
    assert.deepStrictEqual(input.oldClaims, [
      {
        id: parentClaim.id,
        text: "Claim 1",
        context: "Context 1",
        summary: "Summary 1",
        reasoning: "Reasoning 1",
        sources: [
          {
            url: "https://example.com/source-1",
            title: "Source 1",
            snippet: "Snippet 1",
          },
        ],
      },
    ]);
    sawExpectedUpdateContext = true;
    return {
      result: { claims: [] },
      attemptAudit: buildSucceededAttemptAudit("update-context"),
      modelVersion: "test-model-version",
    };
  };

  try {
    await orchestrateInvestigation(
      run.id,
      { info() {}, error() {} },
      {
        isLastAttempt: false,
        attemptNumber: 1,
        workerIdentity: withIntegrationPrefix("worker-update-context"),
      },
    );
  } finally {
    Object.defineProperty(
      OpenAIInvestigator.prototype,
      "investigate",
      originalInvestigateDescriptor,
    );
  }

  assert.equal(sawExpectedUpdateContext, true);

  const storedInvestigation = await prisma.investigation.findUnique({
    where: { id: updateInvestigation.id },
    select: { status: true },
  });
  assert.ok(storedInvestigation);
  assert.equal(storedInvestigation.status, "COMPLETE");
});

void test("orchestrateInvestigation ignores stale transient failure after another worker completes", async () => {
  const post = await seedPost({
    platform: "X",
    externalId: "orchestrator-race-guard-1",
    url: "https://x.com/openerrata/status/orchestrator-race-guard-1",
    contentText: "Duplicate workers must not overwrite successful attempt audit.",
  });
  const investigation = await seedInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
    status: "PENDING",
    promptLabel: "orchestrator-race-guard",
  });
  const run = await seedInvestigationRun({
    investigationId: investigation.id,
  });

  let callCount = 0;
  let releaseFirstWorker: () => void = () => {};
  let markFirstStarted: () => void = () => {};
  const firstWorkerStarted = new Promise<void>((resolve) => {
    markFirstStarted = () => {
      resolve();
    };
  });
  const firstWorkerContinue = new Promise<void>((resolve) => {
    releaseFirstWorker = () => {
      resolve();
    };
  });

  const originalInvestigateDescriptor = Object.getOwnPropertyDescriptor(
    OpenAIInvestigator.prototype,
    "investigate",
  );
  assert.ok(originalInvestigateDescriptor);
  assert.equal(typeof originalInvestigateDescriptor.value, "function");
  OpenAIInvestigator.prototype.investigate = async () => {
    callCount += 1;
    if (callCount === 1) {
      markFirstStarted();
      await firstWorkerContinue;
      throw new InvestigatorExecutionError(
        "simulated transient failure from stale worker",
        buildFailedAttemptAudit("stale"),
        new Error("network timeout"),
      );
    }
    return {
      result: { claims: [] },
      attemptAudit: buildSucceededAttemptAudit("winner"),
      modelVersion: "test-model-version",
    };
  };

  try {
    const firstWorker = orchestrateInvestigation(
      run.id,
      { info() {}, error() {} },
      {
        isLastAttempt: false,
        attemptNumber: 1,
        workerIdentity: withIntegrationPrefix("worker-a"),
      },
    );
    await firstWorkerStarted;

    // Simulate a duplicate-job window where another worker can claim while the
    // first worker is still in flight.
    await prisma.investigationRun.update({
      where: { id: run.id },
      data: {
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });

    await orchestrateInvestigation(
      run.id,
      { info() {}, error() {} },
      {
        isLastAttempt: false,
        attemptNumber: 1,
        workerIdentity: withIntegrationPrefix("worker-b"),
      },
    );

    releaseFirstWorker();
    await firstWorker;
  } finally {
    releaseFirstWorker();
    Object.defineProperty(
      OpenAIInvestigator.prototype,
      "investigate",
      originalInvestigateDescriptor,
    );
  }

  assert.equal(callCount, 2);
  const storedInvestigation = await prisma.investigation.findUnique({
    where: { id: investigation.id },
    select: { status: true },
  });
  assert.ok(storedInvestigation);
  assert.equal(storedInvestigation.status, "COMPLETE");

  const attempts = await prisma.investigationAttempt.findMany({
    where: { investigationId: investigation.id },
    select: { attemptNumber: true, outcome: true },
  });
  assert.equal(attempts.length, 1);
  const firstAttempt = attempts[0];
  assert.ok(firstAttempt);
  assert.equal(firstAttempt.attemptNumber, 1);
  assert.equal(firstAttempt.outcome, "SUCCEEDED");
});

void test("ensureInvestigationQueued randomized state model preserves lifecycle invariants", async () => {
  const random = createDeterministicRandom(0x94ab73d1);
  const rounds = 18;
  const seedCases = [
    { name: "new", status: null, runKind: "NONE" },
    { name: "failed-no-run", status: "FAILED", runKind: "NONE" },
    { name: "failed-with-run", status: "FAILED", runKind: "INERT" },
    { name: "pending-no-run", status: "PENDING", runKind: "NONE" },
    { name: "pending-with-run", status: "PENDING", runKind: "INERT" },
    { name: "processing-no-run", status: "PROCESSING", runKind: "NONE" },
    { name: "processing-stale-run", status: "PROCESSING", runKind: "STALE" },
    { name: "processing-active-run", status: "PROCESSING", runKind: "ACTIVE" },
  ] as const;

  for (let round = 0; round < rounds; round += 1) {
    const seedCaseIndex = randomInt(random, 0, seedCases.length - 1);
    const seedCase = seedCases[seedCaseIndex];
    assert.ok(seedCase, `seed case index out of bounds: ${seedCaseIndex.toString()}`);
    const allowRequeueFailed = randomChance(random, 0.5);
    const enqueue = randomChance(random, 0.7);
    const includeOnPendingRun = randomChance(random, 0.6);
    const canonicalProvenance = randomChance(random, 0.5) ? "SERVER_VERIFIED" : "CLIENT_FALLBACK";
    const canonicalFetchFailureReason =
      canonicalProvenance === "CLIENT_FALLBACK"
        ? `fuzz-fetch-failure-${round.toString()}`
        : undefined;
    const roundTag = [
      `round=${round.toString()}`,
      `seedCase=${seedCase.name}`,
      `allowRequeueFailed=${allowRequeueFailed.toString()}`,
      `enqueue=${enqueue.toString()}`,
      `canonicalProvenance=${canonicalProvenance}`,
    ].join(" ");

    const post = await seedPost({
      platform: "X",
      externalId: `ensure-queued-fuzz-${round.toString()}`,
      url: `https://x.com/openerrata/status/${withIntegrationPrefix(`ensure-queued-fuzz-${round.toString()}`)}`,
      contentText: `ensureInvestigationQueued fuzz payload ${roundTag}`,
    });
    const prompt = await seedPrompt(`ensure-queued-fuzz-${round.toString()}`);

    let seededInvestigationId: string | null = null;
    let seededRunId: string | null = null;
    let seededExistingProvenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK" | null = null;
    let seededActiveLeaseOwner: string | null = null;
    let seededActiveLeaseExpiresAt: Date | null = null;

    if (seedCase.status !== null) {
      seededExistingProvenance = randomChance(random, 0.5) ? "SERVER_VERIFIED" : "CLIENT_FALLBACK";
      const investigation = await seedInvestigation({
        postId: post.id,
        contentHash: post.contentHash,
        contentText: post.contentText,
        provenance: seededExistingProvenance,
        status: seedCase.status,
        promptLabel: `ensure-queued-existing-${round.toString()}`,
      });
      seededInvestigationId = investigation.id;

      if (seedCase.runKind !== "NONE") {
        if (seedCase.runKind === "ACTIVE") {
          seededActiveLeaseOwner = withIntegrationPrefix(`active-worker-${round.toString()}`);
          seededActiveLeaseExpiresAt = new Date(Date.now() + 10 * 60_000);
          const run = await seedInvestigationRun({
            investigationId: investigation.id,
            leaseOwner: seededActiveLeaseOwner,
            leaseExpiresAt: seededActiveLeaseExpiresAt,
            startedAt: new Date(Date.now() - 2 * 60_000),
            heartbeatAt: new Date(),
          });
          seededRunId = run.id;
        } else if (seedCase.runKind === "STALE") {
          const run = await seedInvestigationRun({
            investigationId: investigation.id,
            leaseOwner: withIntegrationPrefix(`stale-worker-${round.toString()}`),
            leaseExpiresAt: new Date(Date.now() - 5 * 60_000),
            startedAt: new Date(Date.now() - 15 * 60_000),
            heartbeatAt: new Date(Date.now() - 5 * 60_000),
          });
          seededRunId = run.id;
        } else {
          const run = await seedInvestigationRun({
            investigationId: investigation.id,
          });
          seededRunId = run.id;
        }
      }
    }

    let onPendingRunCalls = 0;
    let onPendingInvestigationId: string | null = null;
    let onPendingRunId: string | null = null;
    const canonicalPostVersion = await ensurePostVersionForSeed({
      postId: post.id,
      contentHash: post.contentHash,
      contentText: post.contentText,
      provenance: canonicalProvenance,
      ...(canonicalProvenance === "CLIENT_FALLBACK"
        ? {
            fetchFailureReason:
              canonicalFetchFailureReason ?? `fuzz-fetch-failure-fallback-${round.toString()}`,
          }
        : {}),
    });
    const result = await ensureInvestigationQueued({
      prisma,
      postVersionId: canonicalPostVersion.id,
      promptId: prompt.id,
      allowRequeueFailed,
      enqueue,
      ...(includeOnPendingRun
        ? {
            onPendingRun: async ({ investigation, run }) => {
              onPendingRunCalls += 1;
              onPendingInvestigationId = investigation.id;
              onPendingRunId = run.id;
            },
          }
        : {}),
    });

    const startedWithoutInvestigation = seedCase.status === null;
    const expectedCreated = startedWithoutInvestigation;
    const statusAfterRecord = startedWithoutInvestigation
      ? "PENDING"
      : seedCase.status === "FAILED" && allowRequeueFailed
        ? "PENDING"
        : seedCase.status;
    const runExistedBeforeCall = seedCase.status !== null && seedCase.runKind !== "NONE";
    const expectedRunCreated = !runExistedBeforeCall;
    const expectedRecoveredFromStaleProcessing =
      statusAfterRecord === "PROCESSING" &&
      (seedCase.runKind === "STALE" || seedCase.runKind === "NONE");
    const expectedFinalStatus = expectedRecoveredFromStaleProcessing
      ? "PENDING"
      : statusAfterRecord;
    const expectedEnqueued = enqueue && expectedFinalStatus === "PENDING";

    assert.equal(result.created, expectedCreated, `created mismatch (${roundTag})`);
    assert.equal(result.runCreated, expectedRunCreated, `runCreated mismatch (${roundTag})`);
    assert.equal(result.enqueued, expectedEnqueued, `enqueued mismatch (${roundTag})`);
    assert.equal(
      result.investigation.status,
      expectedFinalStatus,
      `result status mismatch (${roundTag})`,
    );
    if (seededInvestigationId !== null) {
      assert.equal(
        result.investigation.id,
        seededInvestigationId,
        `existing investigation identity mismatch (${roundTag})`,
      );
    }
    if (seededRunId !== null) {
      assert.equal(result.run.id, seededRunId, `existing run identity mismatch (${roundTag})`);
    }

    const expectedOnPendingRunCalls = includeOnPendingRun && expectedEnqueued ? 1 : 0;
    assert.equal(
      onPendingRunCalls,
      expectedOnPendingRunCalls,
      `onPendingRun invocation mismatch (${roundTag})`,
    );
    if (expectedOnPendingRunCalls === 1) {
      assert.equal(
        onPendingInvestigationId,
        result.investigation.id,
        `onPendingRun investigation mismatch (${roundTag})`,
      );
      assert.equal(onPendingRunId, result.run.id, `onPendingRun run mismatch (${roundTag})`);
    }

    const storedInvestigations = await prisma.investigation.findMany({
      where: {
        postVersion: {
          postId: post.id,
        },
      },
      select: {
        id: true,
        status: true,
        postVersion: {
          select: {
            contentProvenance: true,
            fetchFailureReason: true,
            serverVerifiedAt: true,
          },
        },
      },
    });
    assert.equal(
      storedInvestigations.length,
      1,
      `exactly one investigation row expected (${roundTag})`,
    );
    const storedInvestigation = storedInvestigations[0];
    assert.ok(storedInvestigation, `missing stored investigation (${roundTag})`);
    assert.equal(
      storedInvestigation.id,
      result.investigation.id,
      `stored investigation id mismatch (${roundTag})`,
    );
    assert.equal(
      storedInvestigation.status,
      expectedFinalStatus,
      `stored status mismatch (${roundTag})`,
    );

    const expectedProvenance =
      seedCase.status === null
        ? canonicalProvenance
        : seededExistingProvenance === "SERVER_VERIFIED"
          ? "SERVER_VERIFIED"
          : canonicalProvenance === "SERVER_VERIFIED"
            ? "SERVER_VERIFIED"
            : "CLIENT_FALLBACK";
    assert.equal(
      storedInvestigation.postVersion.contentProvenance,
      expectedProvenance,
      `stored provenance mismatch (${roundTag})`,
    );
    if (expectedProvenance === "SERVER_VERIFIED") {
      assert.notEqual(
        storedInvestigation.postVersion.serverVerifiedAt,
        null,
        `server-verified rows should have serverVerifiedAt (${roundTag})`,
      );
      assert.equal(
        storedInvestigation.postVersion.fetchFailureReason,
        null,
        `server-verified rows should not retain fetch failures (${roundTag})`,
      );
    } else {
      assert.equal(
        storedInvestigation.postVersion.serverVerifiedAt,
        null,
        `client-fallback rows should not have serverVerifiedAt (${roundTag})`,
      );
      if (seedCase.status === null) {
        assert.equal(
          storedInvestigation.postVersion.fetchFailureReason,
          canonicalFetchFailureReason ?? null,
          `new client-fallback row should preserve canonical failure reason (${roundTag})`,
        );
      } else {
        assert.equal(
          storedInvestigation.postVersion.fetchFailureReason,
          "fetch unavailable",
          `existing client-fallback row should preserve prior failure reason (${roundTag})`,
        );
      }
    }

    const storedRuns = await prisma.investigationRun.findMany({
      where: { investigationId: result.investigation.id },
      select: {
        id: true,
        queuedAt: true,
        leaseOwner: true,
        leaseExpiresAt: true,
        heartbeatAt: true,
      },
    });
    assert.equal(storedRuns.length, 1, `exactly one run row expected (${roundTag})`);
    const storedRun = storedRuns[0];
    assert.ok(storedRun, `missing run row (${roundTag})`);
    assert.equal(storedRun.id, result.run.id, `stored run id mismatch (${roundTag})`);

    const expectQueuedAtNotNull =
      expectedRecoveredFromStaleProcessing ||
      (expectedRunCreated && statusAfterRecord === "PENDING");
    if (expectQueuedAtNotNull) {
      assert.notEqual(storedRun.queuedAt, null, `queuedAt should be populated (${roundTag})`);
    } else {
      assert.equal(storedRun.queuedAt, null, `queuedAt should remain null (${roundTag})`);
    }

    if (expectedRecoveredFromStaleProcessing) {
      assert.equal(
        storedRun.leaseOwner,
        null,
        `recovered stale runs should clear lease owner (${roundTag})`,
      );
      assert.equal(
        storedRun.leaseExpiresAt,
        null,
        `recovered stale runs should clear lease expiry (${roundTag})`,
      );
      assert.equal(
        storedRun.heartbeatAt,
        null,
        `recovered stale runs should clear heartbeat (${roundTag})`,
      );
    }

    if (statusAfterRecord === "PROCESSING" && !expectedRecoveredFromStaleProcessing) {
      assert.equal(
        seedCase.runKind,
        "ACTIVE",
        `non-recovered processing cases must come from active run seeds (${roundTag})`,
      );
      assert.equal(
        storedRun.leaseOwner,
        seededActiveLeaseOwner,
        `active processing run should keep lease owner (${roundTag})`,
      );
      assert.equal(
        storedRun.leaseExpiresAt?.getTime(),
        seededActiveLeaseExpiresAt?.getTime(),
        `active processing run should keep lease expiry (${roundTag})`,
      );
    }
  }
});
