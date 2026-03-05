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
  seedInvestigationWithLeaseFields,
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
  seedInvestigationWithLeaseFields,
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
  const leaseExpiresAt = new Date(Date.now() + 10 * 60_000);
  const investigation = await seedInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
    status: "PROCESSING",
    promptLabel: "orchestrator-lease-held",
    leaseOwner: withIntegrationPrefix("lease-holder"),
    leaseExpiresAt,
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
      investigation.id,
      { info() {}, warn() {}, error() {} },
      {
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
      updateInvestigation.id,
      { info() {}, warn() {}, error() {} },
      {
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

void test("orchestrateInvestigation does not persist late progress updates after completion", async () => {
  const post = await seedPost({
    platform: "X",
    externalId: "orchestrator-late-progress-1",
    url: "https://x.com/openerrata/status/orchestrator-late-progress-1",
    contentText: "Late progress callbacks must not overwrite terminal null state.",
  });
  const investigation = await seedInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
    status: "PENDING",
    promptLabel: "orchestrator-late-progress",
  });

  let resolveLateCallbackFired: () => void = () => {};
  const lateCallbackFired = new Promise<void>((resolve) => {
    resolveLateCallbackFired = resolve;
  });

  const originalInvestigateDescriptor = Object.getOwnPropertyDescriptor(
    OpenAIInvestigator.prototype,
    "investigate",
  );
  assert.ok(originalInvestigateDescriptor);
  assert.equal(typeof originalInvestigateDescriptor.value, "function");
  OpenAIInvestigator.prototype.investigate = async (_input: InvestigatorInput, callbacks) => {
    const latePending = [
      {
        text: "Late pending claim",
        context: "Late pending context",
        summary: "Late pending summary",
        reasoning: "Late pending reasoning",
        sources: [
          {
            url: "https://example.com/late-pending",
            title: "Late Pending Source",
            snippet: "Late pending snippet",
          },
        ],
      },
    ];
    const lateConfirmed = [
      {
        text: "Late confirmed claim",
        context: "Late confirmed context",
        summary: "Late confirmed summary",
        reasoning: "Late confirmed reasoning",
        sources: [
          {
            url: "https://example.com/late-confirmed",
            title: "Late Confirmed Source",
            snippet: "Late confirmed snippet",
          },
        ],
      },
    ];

    setTimeout(() => {
      callbacks?.onProgressUpdate(latePending, lateConfirmed);
      resolveLateCallbackFired();
    }, 25);

    return {
      result: { claims: [] },
      attemptAudit: buildSucceededAttemptAudit("late-progress"),
      modelVersion: "test-model-version",
    };
  };

  try {
    await orchestrateInvestigation(
      investigation.id,
      { info() {}, warn() {}, error() {} },
      {
        workerIdentity: withIntegrationPrefix("worker-late-progress"),
      },
    );
    await lateCallbackFired;
    // Allow the asynchronous callback write attempt to settle.
    await sleep(50);
  } finally {
    Object.defineProperty(
      OpenAIInvestigator.prototype,
      "investigate",
      originalInvestigateDescriptor,
    );
  }

  const storedInvestigation = await prisma.investigation.findUnique({
    where: { id: investigation.id },
    select: { status: true },
  });
  assert.ok(storedInvestigation);
  assert.equal(storedInvestigation.status, "COMPLETE");

  // After completion, the lease row (which holds progressClaims) is deleted.
  const storedLease = await prisma.investigationLease.findUnique({
    where: { investigationId: investigation.id },
  });
  assert.equal(storedLease, null);
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
      investigation.id,
      { info() {}, warn() {}, error() {} },
      {
        workerIdentity: withIntegrationPrefix("worker-a"),
      },
    );
    await firstWorkerStarted;

    // Simulate a duplicate-job window by expiring the lease so another worker
    // can claim it while the first worker is still in flight.
    await prisma.investigationLease.update({
      where: { investigationId: investigation.id },
      data: {
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    });

    await orchestrateInvestigation(
      investigation.id,
      { info() {}, warn() {}, error() {} },
      {
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
  // The completing worker is the stale-lease reclaimer, so it records attempt #2.
  assert.equal(firstAttempt.attemptNumber, 2);
  assert.equal(firstAttempt.outcome, "SUCCEEDED");
});

void test("orchestrateInvestigation marks exhausted stale PROCESSING investigations FAILED and clears lease row", async () => {
  const post = await seedPost({
    platform: "X",
    externalId: withIntegrationPrefix("orchestrator-exhausted-stale-processing-1"),
    url: "https://x.com/openerrata/status/orchestrator-exhausted-stale-processing-1",
    contentText: "Exhausted investigations should transition to FAILED cleanly.",
  });
  const investigation = await seedInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
    status: "PROCESSING",
    promptLabel: "orchestrator-exhausted-stale-processing",
    leaseOwner: withIntegrationPrefix("stale-owner"),
    leaseExpiresAt: new Date(Date.now() - 60_000),
  });

  // 4 = MAX_INVESTIGATION_ATTEMPTS in investigation-lease.ts.
  await prisma.investigation.update({
    where: { id: investigation.id },
    data: { attemptCount: 4 },
  });

  await orchestrateInvestigation(
    investigation.id,
    { info() {}, warn() {}, error() {} },
    {
      workerIdentity: withIntegrationPrefix("worker-exhausted-stale"),
    },
  );

  const stored = await prisma.investigation.findUnique({
    where: { id: investigation.id },
    select: {
      status: true,
      lease: { select: { investigationId: true } },
    },
  });
  assert.ok(stored);
  assert.equal(stored.status, "FAILED");
  assert.equal(stored.lease, null);
});

void test("ensureInvestigationQueued requeueing FAILED resets retry counters and clears stale lease row", async () => {
  const post = await seedPost({
    platform: "X",
    externalId: withIntegrationPrefix("ensure-queued-requeue-failed-reset-1"),
    url: "https://x.com/openerrata/status/ensure-queued-requeue-failed-reset-1",
    contentText: "Failed investigations should become runnable when requeued.",
  });
  const investigation = await seedInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
    status: "FAILED",
    promptLabel: "ensure-queued-requeue-failed-reset",
  });
  const prompt = await seedPrompt("ensure-queued-requeue-failed-reset-prompt");

  await prisma.investigation.update({
    where: { id: investigation.id },
    data: {
      attemptCount: 4, // MAX_INVESTIGATION_ATTEMPTS
      retryAfter: new Date(Date.now() + 10 * 60_000),
    },
  });
  await prisma.investigationLease.create({
    data: {
      investigationId: investigation.id,
      leaseOwner: withIntegrationPrefix("stale-failed-lease"),
      leaseExpiresAt: new Date(Date.now() - 5 * 60_000),
      startedAt: new Date(Date.now() - 10 * 60_000),
      heartbeatAt: new Date(Date.now() - 5 * 60_000),
    },
  });

  const storedBefore = await prisma.investigation.findUnique({
    where: { id: investigation.id },
    select: { postVersionId: true },
  });
  assert.ok(storedBefore);

  const result = await ensureInvestigationQueued({
    prisma,
    postVersionId: storedBefore.postVersionId,
    promptId: prompt.id,
    allowRequeueFailed: true,
    enqueue: false,
  });

  assert.equal(result.investigation.id, investigation.id);
  assert.equal(result.investigation.status, "PENDING");

  const storedAfter = await prisma.investigation.findUnique({
    where: { id: investigation.id },
    select: {
      status: true,
      attemptCount: true,
      retryAfter: true,
      lease: { select: { investigationId: true } },
    },
  });
  assert.ok(storedAfter);
  assert.equal(storedAfter.status, "PENDING");
  assert.equal(storedAfter.attemptCount, 0);
  assert.equal(storedAfter.retryAfter, null);
  assert.equal(storedAfter.lease, null);
});

void test("investigateNow persists InvestigationInput snapshot at queue time", async () => {
  const caller = createCaller({ isAuthenticated: true });
  const lesswrongHtml = "<h1>Persisted snapshot</h1><p>Alpha beta gamma.</p>";
  const viewInput = buildLesswrongViewInput({
    externalId: "investigation-input-snapshot-persisted-1",
    htmlContent: lesswrongHtml,
  });

  const investigateNowResult = await withMockLesswrongCanonicalHtml(lesswrongHtml, () =>
    caller.post.investigateNow(viewInput),
  );
  assert.equal(investigateNowResult.status, "PENDING");

  const investigation = await prisma.investigation.findUnique({
    where: { id: investigateNowResult.investigationId },
    select: {
      id: true,
      inputId: true,
      input: {
        select: {
          investigationId: true,
          provenance: true,
          markdownSource: true,
          markdown: true,
          markdownRendererVersion: true,
        },
      },
    },
  });
  assert.ok(investigation);
  assert.equal(investigation.inputId, investigation.id);
  assert.equal(investigation.input.investigationId, investigation.id);
  assert.equal(investigation.input.provenance, "SERVER_VERIFIED");
  assert.equal(investigation.input.markdownSource, "SERVER_HTML");
  assert.equal(typeof investigation.input.markdown, "string");
  assert.equal(typeof investigation.input.markdownRendererVersion, "string");
});

void test("ensureInvestigationQueued randomized state model preserves lifecycle invariants", async () => {
  const random = createDeterministicRandom(0x94ab73d1);
  const rounds = 18;
  const seedCases = [
    { name: "new", status: null },
    { name: "failed", status: "FAILED" },
    { name: "pending", status: "PENDING" },
    { name: "processing-stale", status: "PROCESSING", leaseKind: "STALE" },
    { name: "processing-active", status: "PROCESSING", leaseKind: "ACTIVE" },
  ] as const;

  for (let round = 0; round < rounds; round += 1) {
    const seedCaseIndex = randomInt(random, 0, seedCases.length - 1);
    const seedCase = seedCases[seedCaseIndex];
    assert.ok(seedCase, `seed case index out of bounds: ${seedCaseIndex.toString()}`);
    const allowRequeueFailed = randomChance(random, 0.5);
    const enqueue = randomChance(random, 0.7);
    const includeOnPendingInvestigation = randomChance(random, 0.6);
    const canonicalProvenance = randomChance(random, 0.5) ? "SERVER_VERIFIED" : "CLIENT_FALLBACK";
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
    let seededExistingProvenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK" | null = null;
    let seededActiveLeaseOwner: string | null = null;
    let seededActiveLeaseExpiresAt: Date | null = null;

    if (seedCase.status !== null) {
      seededExistingProvenance = randomChance(random, 0.5) ? "SERVER_VERIFIED" : "CLIENT_FALLBACK";
      const leaseKind = "leaseKind" in seedCase ? seedCase.leaseKind : null;

      const activeLeaseOwner =
        leaseKind === "ACTIVE" ? withIntegrationPrefix(`active-worker-${round.toString()}`) : null;
      const activeLeaseExpiresAt =
        leaseKind === "ACTIVE" ? new Date(Date.now() + 10 * 60_000) : null;
      seededActiveLeaseOwner = activeLeaseOwner;
      seededActiveLeaseExpiresAt = activeLeaseExpiresAt;

      const investigation = await seedInvestigation({
        postId: post.id,
        contentHash: post.contentHash,
        contentText: post.contentText,
        provenance: seededExistingProvenance,
        status: seedCase.status,
        promptLabel: `ensure-queued-existing-${round.toString()}`,
        ...(leaseKind === "ACTIVE" && activeLeaseOwner !== null && activeLeaseExpiresAt !== null
          ? {
              leaseOwner: activeLeaseOwner,
              leaseExpiresAt: activeLeaseExpiresAt,
            }
          : leaseKind === "STALE"
            ? {
                leaseOwner: withIntegrationPrefix(`stale-worker-${round.toString()}`),
                leaseExpiresAt: new Date(Date.now() - 5 * 60_000),
              }
            : {}),
      });
      seededInvestigationId = investigation.id;
      // The lease row (including leaseOwner, leaseExpiresAt) is fully created
      // by seedInvestigation above. No follow-up seedInvestigationWithLeaseFields
      // call is needed here — startedAt/heartbeatAt are not asserted in this test.
    }

    let onPendingInvestigationCalls = 0;
    let onPendingInvestigationId: string | null = null;
    const canonicalPostVersion = await ensurePostVersionForSeed({
      postId: post.id,
      contentHash: post.contentHash,
      contentText: post.contentText,
      provenance: canonicalProvenance,
    });
    const result = await ensureInvestigationQueued({
      prisma,
      postVersionId: canonicalPostVersion.id,
      promptId: prompt.id,
      allowRequeueFailed,
      enqueue,
      ...(includeOnPendingInvestigation
        ? {
            onPendingInvestigation: async ({ investigation }) => {
              onPendingInvestigationCalls += 1;
              onPendingInvestigationId = investigation.id;
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
    const leaseKind = "leaseKind" in seedCase ? seedCase.leaseKind : null;
    const expectedRecoveredFromStaleProcessing =
      statusAfterRecord === "PROCESSING" && leaseKind === "STALE";
    const expectedFinalStatus = expectedRecoveredFromStaleProcessing
      ? "PENDING"
      : statusAfterRecord;
    const expectedEnqueued = enqueue && expectedFinalStatus === "PENDING";

    assert.equal(result.created, expectedCreated, `created mismatch (${roundTag})`);
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

    const expectedOnPendingInvestigationCalls =
      includeOnPendingInvestigation && expectedEnqueued ? 1 : 0;
    assert.equal(
      onPendingInvestigationCalls,
      expectedOnPendingInvestigationCalls,
      `onPendingInvestigation invocation mismatch (${roundTag})`,
    );
    if (expectedOnPendingInvestigationCalls === 1) {
      assert.equal(
        onPendingInvestigationId,
        result.investigation.id,
        `onPendingInvestigation investigation mismatch (${roundTag})`,
      );
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
        queuedAt: true,
        postVersion: {
          select: {
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

    const expectedServerVerified =
      seedCase.status === null
        ? canonicalProvenance === "SERVER_VERIFIED"
        : seededExistingProvenance === "SERVER_VERIFIED" ||
          canonicalProvenance === "SERVER_VERIFIED";
    if (expectedServerVerified) {
      assert.notEqual(
        storedInvestigation.postVersion.serverVerifiedAt,
        null,
        `server-verified rows should have serverVerifiedAt (${roundTag})`,
      );
    } else {
      assert.equal(
        storedInvestigation.postVersion.serverVerifiedAt,
        null,
        `client-fallback rows should not have serverVerifiedAt (${roundTag})`,
      );
    }

    // queuedAt is now always non-null (@default(now())), so just verify it's set
    assert.notEqual(
      storedInvestigation.queuedAt,
      null,
      `queuedAt should always be populated (${roundTag})`,
    );

    // Check lease state via InvestigationLease table
    const storedLease = await prisma.investigationLease.findUnique({
      where: { investigationId: storedInvestigation.id },
      select: { leaseOwner: true, leaseExpiresAt: true },
    });

    if (expectedRecoveredFromStaleProcessing) {
      assert.equal(
        storedLease,
        null,
        `recovered stale investigations should have no lease row (${roundTag})`,
      );
    }

    if (statusAfterRecord === "PROCESSING" && !expectedRecoveredFromStaleProcessing) {
      assert.equal(
        leaseKind,
        "ACTIVE",
        `non-recovered processing cases must come from active lease seeds (${roundTag})`,
      );
      assert.ok(storedLease, `active processing investigation should have lease row (${roundTag})`);
      assert.equal(
        storedLease.leaseOwner,
        seededActiveLeaseOwner,
        `active processing investigation should keep lease owner (${roundTag})`,
      );
      assert.ok(seededActiveLeaseExpiresAt, `active lease should have seeded expiry (${roundTag})`);
      assert.equal(
        storedLease.leaseExpiresAt.getTime(),
        seededActiveLeaseExpiresAt.getTime(),
        `active processing investigation should keep lease expiry (${roundTag})`,
      );
    }
  }
});
