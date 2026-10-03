import OpenAI from "openai";
import type { Investigator } from "../../src/lib/investigators/interface.js";
import {
  EMPTY_IMAGE_OCCURRENCES_HASH,
  INTEGRATION_DATA_PREFIX,
  INTEGRATION_LESSWRONG_FIXTURE_KEYS,
  InvestigatorExecutionError,
  MINIMUM_SUPPORTED_EXTENSION_VERSION,
  WORD_COUNT_LIMIT,
  appRouter,
  assert,
  assertIntegrationDatabaseInvariants,
  buildFailedAttemptAudit,
  buildLesswrongViewInput,
  buildSucceededAttemptAudit,
  buildSucceededInvestigatorOutput,
  buildXViewInput,
  closeQueueUtils,
  createCaller,
  createContext,
  createDeterministicRandom,
  createMockRequestEvent,
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
  LeaseLostError,
  LESSWRONG_MOCK_SERVER_AUTHOR_NAME,
  LESSWRONG_MOCK_SERVER_SLUG,
  requestInvestigation,
  UserOpenAiKeyRejectedError,
} from "./api-endpoints.integration.shared.js";

void [
  EMPTY_IMAGE_OCCURRENCES_HASH,
  INTEGRATION_DATA_PREFIX,
  INTEGRATION_LESSWRONG_FIXTURE_KEYS,
  InvestigatorExecutionError,
  MINIMUM_SUPPORTED_EXTENSION_VERSION,
  WORD_COUNT_LIMIT,
  appRouter,
  assert,
  assertIntegrationDatabaseInvariants,
  buildFailedAttemptAudit,
  buildLesswrongViewInput,
  buildSucceededAttemptAudit,
  buildSucceededInvestigatorOutput,
  buildXViewInput,
  closeQueueUtils,
  createCaller,
  createContext,
  createDeterministicRandom,
  createMockRequestEvent,
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
  const createInvestigator = (): Investigator => ({
    investigate: async () => {
      investigateCalled = true;
      return buildSucceededInvestigatorOutput("lease-held");
    },
  });

  await orchestrateInvestigation(
    investigation.id,
    { info() {}, warn() {}, error() {} },
    {
      workerIdentity: withIntegrationPrefix("contending-worker"),
      createInvestigator,
    },
  );

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
  const createInvestigator = (): Investigator => ({
    investigate: async (input) => {
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
      return buildSucceededInvestigatorOutput("update-context");
    },
  });

  await orchestrateInvestigation(
    updateInvestigation.id,
    { info() {}, warn() {}, error() {} },
    {
      workerIdentity: withIntegrationPrefix("worker-update-context"),
      createInvestigator,
    },
  );

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

  const createInvestigator = (): Investigator => ({
    investigate: async (_input, options) => {
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
        options.callbacks?.onProgressUpdate(latePending, lateConfirmed);
        resolveLateCallbackFired();
      }, 25);

      return buildSucceededInvestigatorOutput("late-progress");
    },
  });

  await orchestrateInvestigation(
    investigation.id,
    { info() {}, warn() {}, error() {} },
    {
      workerIdentity: withIntegrationPrefix("worker-late-progress"),
      createInvestigator,
    },
  );
  await lateCallbackFired;
  // Allow the asynchronous callback write attempt to settle.
  await sleep(50);

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

  const createInvestigator = (): Investigator => ({
    investigate: async () => {
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
      return buildSucceededInvestigatorOutput("winner");
    },
  });

  try {
    const firstWorker = orchestrateInvestigation(
      investigation.id,
      { info() {}, warn() {}, error() {} },
      {
        workerIdentity: withIntegrationPrefix("worker-a"),
        createInvestigator,
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
        createInvestigator,
      },
    );

    releaseFirstWorker();
    await firstWorker;
  } finally {
    releaseFirstWorker();
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
      createInvestigator: () => assert.fail("an exhausted investigation must not run"),
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

void test("investigateNow leaves FAILED investigations terminal and never resets attempt numbering", async () => {
  const post = await seedPost({
    platform: "X",
    externalId: "investigate-now-failed-terminal-1",
    url: "https://x.com/openerrata/status/investigate-now-failed-terminal-1",
    contentText: "Failed investigations stay failed for this content version.",
  });
  const investigation = await seedInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
    status: "FAILED",
    promptLabel: "investigate-now-failed-terminal",
    attemptCount: 4,
  });

  const caller = createCaller({ isAuthenticated: true });
  const result = await caller.post.investigateNow({ postVersionId: post.postVersionId });

  assert.equal(result.investigationId, investigation.id);
  assert.equal(result.status, "FAILED");
  const stored = await prisma.investigation.findUniqueOrThrow({
    where: { id: investigation.id },
    select: { status: true, attemptCount: true },
  });
  assert.deepEqual(stored, { status: "FAILED", attemptCount: 4 });
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
      origin: true,
      input: {
        select: {
          investigationId: true,
          provenance: true,
          markdownSource: true,
          markdown: true,
          markdownRendererVersion: true,
          postUrl: true,
          authorName: true,
          hasVideo: true,
          imagePlaceholderSourceUrls: true,
        },
      },
    },
  });
  assert.ok(investigation);
  assert.equal(investigation.inputId, investigation.id);
  assert.equal(investigation.origin, "INSTANCE_REQUEST");
  assert.equal(investigation.input.investigationId, investigation.id);
  assert.equal(investigation.input.provenance, "SERVER_VERIFIED");
  assert.equal(investigation.input.markdownSource, "SERVER_HTML");
  assert.equal(typeof investigation.input.markdown, "string");
  assert.equal(typeof investigation.input.markdownRendererVersion, "string");
  // Prompt context comes from the server-verified identity, frozen at queue time.
  assert.equal(
    investigation.input.postUrl,
    `https://www.lesswrong.com/posts/${viewInput.externalId}/${LESSWRONG_MOCK_SERVER_SLUG}`,
  );
  assert.equal(investigation.input.authorName, LESSWRONG_MOCK_SERVER_AUTHOR_NAME);
  assert.equal(investigation.input.hasVideo, false);
  assert.deepEqual(investigation.input.imagePlaceholderSourceUrls, []);

  // Later changes to the live Post row do not reach the snapshot.
  await prisma.post.updateMany({
    where: { externalId: viewInput.externalId },
    data: { url: "https://www.lesswrong.com/posts/changed" },
  });
  const snapshotAfterEdit = await prisma.investigationInput.findUniqueOrThrow({
    where: { investigationId: investigation.id },
    select: { postUrl: true },
  });
  assert.equal(snapshotAfterEdit.postUrl, investigation.input.postUrl);
});

type RequestedState =
  | "NONE"
  | "COMPLETE"
  | "FAILED"
  | "PENDING_FUNDED"
  | "PENDING_UNFUNDED"
  | "PROCESSING_ACTIVE"
  | "PROCESSING_STALE"
  | "PROCESSING_STALE_EXHAUSTED";

interface RequestInvestigationCase {
  state: RequestedState;
  requester: "INSTANCE_API_KEY" | "USER_OPENAI_KEY";
  expected: {
    status: "PENDING" | "PROCESSING" | "COMPLETE" | "FAILED";
    origin: "SELECTOR" | "INSTANCE_REQUEST" | "USER_KEY_REQUEST";
    hasKeySource: boolean;
    hasLease: boolean;
  };
}

const REQUEST_INVESTIGATION_CASES: RequestInvestigationCase[] = [
  {
    state: "NONE",
    requester: "INSTANCE_API_KEY",
    expected: {
      status: "PENDING",
      origin: "INSTANCE_REQUEST",
      hasKeySource: false,
      hasLease: false,
    },
  },
  {
    state: "NONE",
    requester: "USER_OPENAI_KEY",
    expected: {
      status: "PENDING",
      origin: "USER_KEY_REQUEST",
      hasKeySource: true,
      hasLease: false,
    },
  },
  {
    state: "COMPLETE",
    requester: "USER_OPENAI_KEY",
    expected: { status: "COMPLETE", origin: "SELECTOR", hasKeySource: false, hasLease: false },
  },
  {
    state: "FAILED",
    requester: "USER_OPENAI_KEY",
    expected: { status: "FAILED", origin: "SELECTOR", hasKeySource: false, hasLease: false },
  },
  // A user key never takes over an investigation someone else is paying for.
  {
    state: "PENDING_FUNDED",
    requester: "USER_OPENAI_KEY",
    expected: { status: "PENDING", origin: "SELECTOR", hasKeySource: false, hasLease: false },
  },
  {
    state: "PENDING_UNFUNDED",
    requester: "INSTANCE_API_KEY",
    expected: {
      status: "PENDING",
      origin: "INSTANCE_REQUEST",
      hasKeySource: false,
      hasLease: false,
    },
  },
  {
    state: "PENDING_UNFUNDED",
    requester: "USER_OPENAI_KEY",
    expected: {
      status: "PENDING",
      origin: "USER_KEY_REQUEST",
      hasKeySource: true,
      hasLease: false,
    },
  },
  {
    state: "PROCESSING_ACTIVE",
    requester: "USER_OPENAI_KEY",
    expected: { status: "PROCESSING", origin: "SELECTOR", hasKeySource: false, hasLease: true },
  },
  {
    state: "PROCESSING_STALE",
    requester: "INSTANCE_API_KEY",
    expected: { status: "PENDING", origin: "SELECTOR", hasKeySource: false, hasLease: false },
  },
  {
    state: "PROCESSING_STALE_EXHAUSTED",
    requester: "INSTANCE_API_KEY",
    expected: { status: "FAILED", origin: "SELECTOR", hasKeySource: false, hasLease: false },
  },
];

function seedStatusFor(state: Exclude<RequestedState, "NONE">) {
  switch (state) {
    case "COMPLETE":
      return "COMPLETE" as const;
    case "FAILED":
      return "FAILED" as const;
    case "PENDING_FUNDED":
    case "PENDING_UNFUNDED":
      return "PENDING" as const;
    case "PROCESSING_ACTIVE":
    case "PROCESSING_STALE":
    case "PROCESSING_STALE_EXHAUSTED":
      return "PROCESSING" as const;
  }
}

void test("requestInvestigation follows the investigateNow state table for every starting state", async () => {
  const prompt = await seedPrompt("request-investigation-state-table");
  for (const [index, testCase] of REQUEST_INVESTIGATION_CASES.entries()) {
    const caseTag = `${testCase.state}/${testCase.requester}`;
    const post = await seedPost({
      platform: "X",
      externalId: `request-investigation-state-${index.toString()}`,
      url: `https://x.com/openerrata/status/${withIntegrationPrefix(`request-investigation-state-${index.toString()}`)}`,
      contentText: `requestInvestigation state table ${caseTag}`,
    });

    let seededId: string | null = null;
    if (testCase.state !== "NONE") {
      const stale = testCase.state.startsWith("PROCESSING_STALE");
      const seeded = await seedInvestigation({
        postId: post.id,
        contentHash: post.contentHash,
        contentText: post.contentText,
        provenance: "CLIENT_FALLBACK",
        status: seedStatusFor(testCase.state),
        promptLabel: `request-investigation-state-${index.toString()}`,
        origin: testCase.state === "PENDING_UNFUNDED" ? "USER_KEY_REQUEST" : "SELECTOR",
        attemptCount: testCase.state === "PROCESSING_STALE_EXHAUSTED" ? 4 : 1,
        ...(stale ? { leaseExpiresAt: new Date(Date.now() - 60_000) } : {}),
      });
      seededId = seeded.id;
    }

    const postVersion = await prisma.postVersion.findUniqueOrThrow({
      where: { id: post.postVersionId },
      select: {
        id: true,
        postId: true,
        contentBlob: { select: { contentText: true, wordCount: true } },
      },
    });
    const { investigationId } = await requestInvestigation(prisma, {
      postVersion,
      promptId: prompt.id,
      requester:
        testCase.requester === "INSTANCE_API_KEY"
          ? { kind: "INSTANCE_API_KEY" }
          : {
              kind: "USER_OPENAI_KEY",
              apiKey: `sk-test-state-table-${index.toString()}-0123456789`,
            },
    });

    if (seededId !== null) {
      assert.equal(investigationId, seededId, `existing investigation reused (${caseTag})`);
    }
    const stored = await prisma.investigation.findUniqueOrThrow({
      where: { id: investigationId },
      select: {
        status: true,
        origin: true,
        openAiKeySource: { select: { investigationId: true } },
        lease: { select: { investigationId: true } },
      },
    });
    assert.deepEqual(
      {
        status: stored.status,
        origin: stored.origin,
        hasKeySource: stored.openAiKeySource !== null,
        hasLease: stored.lease !== null,
      },
      testCase.expected,
      caseTag,
    );
  }
});

void test("requestInvestigation verifies a user key before it funds anything", async () => {
  const prompt = await seedPrompt("request-investigation-rejected-key");
  const post = await seedPost({
    platform: "X",
    externalId: "request-investigation-rejected-key-1",
    url: `https://x.com/openerrata/status/${withIntegrationPrefix("request-investigation-rejected-key-1")}`,
    contentText: "A key OpenAI rejects must not create or fund an investigation.",
  });
  const postVersion = await prisma.postVersion.findUniqueOrThrow({
    where: { id: post.postVersionId },
    select: {
      id: true,
      postId: true,
      contentBlob: { select: { contentText: true, wordCount: true } },
    },
  });

  await assert.rejects(
    requestInvestigation(prisma, {
      postVersion,
      promptId: prompt.id,
      requester: { kind: "USER_OPENAI_KEY", apiKey: "sk-test-rejected-key-0123456789" },
    }),
    (error: unknown) =>
      error instanceof UserOpenAiKeyRejectedError && error.outcome.openaiApiKeyStatus === "invalid",
  );
  assert.equal(
    await prisma.investigation.count({ where: { postVersionId: post.postVersionId } }),
    0,
  );
});

async function requestUserKeyInvestigation(externalId: string): Promise<string> {
  const caller = createCaller({ userOpenAiApiKey: `sk-test-${externalId}` });
  const result = await caller.post.investigateNow(
    buildXViewInput({ externalId, observedContentText: `User key funding for ${externalId}.` }),
  );
  assert.equal(result.status, "PENDING");
  return result.investigationId;
}

void test("orchestrateInvestigation drops a user key OpenAI refuses instead of failing the investigation", async () => {
  const investigationId = await requestUserKeyInvestigation("user-key-refused-1");

  await orchestrateInvestigation(
    investigationId,
    { info() {}, warn() {}, error() {} },
    {
      workerIdentity: withIntegrationPrefix("worker-user-key-refused"),
      createInvestigator: () => ({
        investigate: () =>
          Promise.reject(
            new InvestigatorExecutionError(
              "OpenAI rejected the key",
              buildFailedAttemptAudit("user-key-refused"),
              OpenAI.APIError.generate(
                401,
                { error: { message: "Incorrect API key provided" } },
                undefined,
                new Headers(),
              ),
            ),
          ),
      }),
    },
  );

  const stored = await prisma.investigation.findUniqueOrThrow({
    where: { id: investigationId },
    select: {
      status: true,
      origin: true,
      attemptCount: true,
      openAiKeySource: { select: { investigationId: true } },
      attempts: { select: { attemptNumber: true, outcome: true } },
    },
  });
  assert.equal(stored.status, "PENDING");
  assert.equal(stored.origin, "USER_KEY_REQUEST");
  assert.equal(stored.openAiKeySource, null);
  assert.deepEqual(stored.attempts, [{ attemptNumber: 1, outcome: "FAILED" }]);

  // Unfunded: a worker that picks the job up again does nothing, and never
  // falls back to the server key.
  await orchestrateInvestigation(
    investigationId,
    { info() {}, warn() {}, error() {} },
    {
      workerIdentity: withIntegrationPrefix("worker-user-key-unfunded"),
      createInvestigator: () => assert.fail("an unfunded investigation must not run"),
    },
  );
  const afterSkip = await prisma.investigation.findUniqueOrThrow({
    where: { id: investigationId },
    select: { status: true, attemptCount: true },
  });
  assert.deepEqual(afterSkip, { status: "PENDING", attemptCount: stored.attemptCount });
});

void test("orchestrateInvestigation drops an expired user key before calling OpenAI", async () => {
  const investigationId = await requestUserKeyInvestigation("user-key-expired-1");
  await prisma.investigationOpenAiKeySource.update({
    where: { investigationId },
    data: { expiresAt: new Date(Date.now() - 1_000) },
  });

  await orchestrateInvestigation(
    investigationId,
    { info() {}, warn() {}, error() {} },
    {
      workerIdentity: withIntegrationPrefix("worker-user-key-expired"),
      createInvestigator: () => assert.fail("an expired user key must not reach OpenAI"),
    },
  );

  const stored = await prisma.investigation.findUniqueOrThrow({
    where: { id: investigationId },
    select: { status: true, openAiKeySource: { select: { investigationId: true } } },
  });
  assert.equal(stored.status, "PENDING");
  assert.equal(stored.openAiKeySource, null);
});

void test("orchestrateInvestigation abandons an attempt whose lease was lost without writing", async () => {
  const post = await seedPost({
    platform: "X",
    externalId: "orchestrator-lease-lost-1",
    url: "https://x.com/openerrata/status/orchestrator-lease-lost-1",
    contentText: "A run that lost its lease must not write results.",
  });
  const investigation = await seedPendingInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
  });
  const workerIdentity = withIntegrationPrefix("worker-lease-lost");

  await orchestrateInvestigation(
    investigation.id,
    { info() {}, warn() {}, error() {} },
    {
      workerIdentity,
      createInvestigator: () => ({
        investigate: () =>
          Promise.reject(new LeaseLostError(investigation.id, "simulated lost lease")),
      }),
    },
  );

  const stored = await prisma.investigation.findUniqueOrThrow({
    where: { id: investigation.id },
    select: {
      status: true,
      attempts: { select: { id: true } },
      lease: { select: { leaseOwner: true } },
    },
  });
  // Left for expired-lease recovery: still PROCESSING under this worker's
  // lease, with no attempt audit or status change written.
  assert.equal(stored.status, "PROCESSING");
  assert.deepEqual(stored.attempts, []);
  assert.equal(stored.lease?.leaseOwner, workerIdentity);
});
