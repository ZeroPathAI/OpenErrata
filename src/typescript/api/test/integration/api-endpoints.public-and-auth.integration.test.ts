import type { Platform } from "@openerrata/shared";
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

void test("post.investigateNow allows user OpenAI key callers and returns inline claims for complete investigations", async () => {
  const caller = createCaller({
    isAuthenticated: false,
    userOpenAiApiKey: "sk-test-user-key",
  });
  const input = buildXViewInput({
    externalId: "investigate-now-openai-header-1",
    observedContentText: "Canonical content for user-key investigateNow.",
  });
  const seeded = await seedInvestigationForXViewInput({
    viewInput: input,
    status: "COMPLETE",
    provenance: "CLIENT_FALLBACK",
    claimCount: 1,
  });

  const result = await caller.post.investigateNow(input);

  assert.equal(result.investigationId, seeded.investigationId);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.provenance, "CLIENT_FALLBACK");
  assert.equal(result.claims.length, 1);
});

void test("post.investigateNow requeues existing failed investigations as PENDING", async () => {
  const caller = createCaller({ isAuthenticated: true });
  const input = buildXViewInput({
    externalId: "investigate-now-requeue-failed-1",
    observedContentText: "Canonical content should be retried after FAILED state.",
  });
  const seeded = await seedInvestigationForXViewInput({
    viewInput: input,
    status: "FAILED",
    provenance: "CLIENT_FALLBACK",
  });

  const result = await caller.post.investigateNow(input);

  assert.equal(result.investigationId, seeded.investigationId);
  assert.equal(result.status, "PENDING");
  assert.equal(result.provenance, "CLIENT_FALLBACK");

  const stored = await prisma.investigation.findUnique({
    where: { id: seeded.investigationId },
    select: { status: true, checkedAt: true },
  });
  assert.ok(stored);
  assert.equal(stored.status, "PENDING");
  assert.equal(stored.checkedAt, null);
});

void test("post.investigateNow attaches first user key source while investigation is PENDING", async () => {
  const firstCaller = createCaller({
    userOpenAiApiKey: "sk-test-user-key-first",
  });
  const secondCaller = createCaller({
    userOpenAiApiKey: "sk-test-user-key-second",
  });
  const input = buildXViewInput({
    externalId: "investigate-now-user-key-first-wins-1",
    observedContentText: "Pending investigation should keep the first user key source.",
  });
  const seeded = await seedInvestigationForXViewInput({
    viewInput: input,
    status: "PENDING",
    provenance: "CLIENT_FALLBACK",
  });

  const firstResult = await firstCaller.post.investigateNow(input);
  assert.equal(firstResult.investigationId, seeded.investigationId);
  assert.equal(firstResult.status, "PENDING");

  const run = await prisma.investigationRun.findUnique({
    where: { investigationId: seeded.investigationId },
    select: { id: true },
  });
  assert.ok(run);

  const storedAfterFirst = await prisma.investigationOpenAiKeySource.findUnique({
    where: { runId: run.id },
    select: {
      ciphertext: true,
      iv: true,
      authTag: true,
      keyId: true,
      expiresAt: true,
    },
  });
  assert.ok(storedAfterFirst);

  const secondResult = await secondCaller.post.investigateNow(input);
  assert.equal(secondResult.investigationId, seeded.investigationId);
  assert.equal(secondResult.status, "PENDING");

  const storedAfterSecond = await prisma.investigationOpenAiKeySource.findUnique({
    where: { runId: run.id },
    select: {
      ciphertext: true,
      iv: true,
      authTag: true,
      keyId: true,
      expiresAt: true,
    },
  });
  assert.ok(storedAfterSecond);
  assert.deepEqual(storedAfterSecond, storedAfterFirst);
});

void test("post.investigateNow recovers stale PROCESSING investigations to PENDING", async () => {
  const caller = createCaller({ isAuthenticated: true });
  const input = buildXViewInput({
    externalId: "investigate-now-recovers-stale-processing-1",
    observedContentText: "Stale processing investigations should be recoverable.",
  });
  const seeded = await seedInvestigationForXViewInput({
    viewInput: input,
    status: "PROCESSING",
    provenance: "CLIENT_FALLBACK",
  });
  await seedInvestigationRun({
    investigationId: seeded.investigationId,
    leaseOwner: "worker-stale",
    leaseExpiresAt: new Date(Date.now() - 5 * 60_000),
    startedAt: new Date(Date.now() - 10 * 60_000),
    heartbeatAt: new Date(Date.now() - 5 * 60_000),
  });

  const result = await caller.post.investigateNow(input);

  assert.equal(result.investigationId, seeded.investigationId);
  assert.equal(result.status, "PENDING");

  const storedInvestigation = await prisma.investigation.findUnique({
    where: { id: seeded.investigationId },
    select: { status: true },
  });
  assert.ok(storedInvestigation);
  assert.equal(storedInvestigation.status, "PENDING");

  const storedRun = await prisma.investigationRun.findUnique({
    where: { investigationId: seeded.investigationId },
    select: {
      leaseOwner: true,
      leaseExpiresAt: true,
      queuedAt: true,
    },
  });
  assert.ok(storedRun);
  assert.equal(storedRun.leaseOwner, null);
  assert.equal(storedRun.leaseExpiresAt, null);
  assert.notEqual(storedRun.queuedAt, null);
});

void test("post.investigateNow does not recover PROCESSING runs during transient retry recovery window", async () => {
  const caller = createCaller({ isAuthenticated: true });
  const input = buildXViewInput({
    externalId: "investigate-now-keeps-processing-recovery-window-1",
    observedContentText: "Transient retry windows should not be externally recovered.",
  });
  const seeded = await seedInvestigationForXViewInput({
    viewInput: input,
    status: "PROCESSING",
    provenance: "CLIENT_FALLBACK",
  });
  const recoverAfterAt = new Date(Date.now() + 5 * 60_000);
  await seedInvestigationRun({
    investigationId: seeded.investigationId,
    leaseOwner: null,
    leaseExpiresAt: null,
    recoverAfterAt,
    startedAt: new Date(Date.now() - 60_000),
    heartbeatAt: new Date(),
  });

  const result = await caller.post.investigateNow(input);

  assert.equal(result.investigationId, seeded.investigationId);
  assert.equal(result.status, "PROCESSING");

  const storedInvestigation = await prisma.investigation.findUnique({
    where: { id: seeded.investigationId },
    select: { status: true },
  });
  assert.ok(storedInvestigation);
  assert.equal(storedInvestigation.status, "PROCESSING");

  const storedRun = await prisma.investigationRun.findUnique({
    where: { investigationId: seeded.investigationId },
    select: {
      leaseOwner: true,
      leaseExpiresAt: true,
      recoverAfterAt: true,
    },
  });
  assert.ok(storedRun);
  assert.equal(storedRun.leaseOwner, null);
  assert.equal(storedRun.leaseExpiresAt, null);
  assert.equal(storedRun.recoverAfterAt?.getTime(), recoverAfterAt.getTime());
});

void test("post.investigateNow leaves active PROCESSING investigations unchanged", async () => {
  const caller = createCaller({ isAuthenticated: true });
  const input = buildXViewInput({
    externalId: "investigate-now-keeps-active-processing-1",
    observedContentText: "Active processing investigations should remain processing.",
  });
  const seeded = await seedInvestigationForXViewInput({
    viewInput: input,
    status: "PROCESSING",
    provenance: "CLIENT_FALLBACK",
  });
  const leaseExpiresAt = new Date(Date.now() + 10 * 60_000);
  await seedInvestigationRun({
    investigationId: seeded.investigationId,
    leaseOwner: "worker-active",
    leaseExpiresAt,
    startedAt: new Date(Date.now() - 60_000),
    heartbeatAt: new Date(),
  });

  const result = await caller.post.investigateNow(input);

  assert.equal(result.investigationId, seeded.investigationId);
  assert.equal(result.status, "PROCESSING");

  const storedInvestigation = await prisma.investigation.findUnique({
    where: { id: seeded.investigationId },
    select: { status: true },
  });
  assert.ok(storedInvestigation);
  assert.equal(storedInvestigation.status, "PROCESSING");

  const storedRun = await prisma.investigationRun.findUnique({
    where: { investigationId: seeded.investigationId },
    select: {
      leaseOwner: true,
      leaseExpiresAt: true,
    },
  });
  assert.ok(storedRun);
  assert.equal(storedRun.leaseOwner, "worker-active");
  assert.equal(storedRun.leaseExpiresAt?.getTime(), leaseExpiresAt.getTime());
});

void test("selector recovers stale PROCESSING investigations using shared lifecycle rules", async () => {
  const post = await seedPost({
    platform: "X",
    externalId: "selector-recovers-stale-processing-1",
    url: "https://x.com/openerrata/status/selector-recovers-stale-processing-1",
    contentText: "Selector should recover stale processing runs.",
  });
  await prisma.post.update({
    where: { id: post.id },
    data: { uniqueViewScore: 10_000 },
  });

  const processingInvestigation = await seedProcessingInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
  });
  await seedInvestigationRun({
    investigationId: processingInvestigation.id,
    leaseOwner: "worker-stale",
    leaseExpiresAt: new Date(Date.now() - 5 * 60_000),
    startedAt: new Date(Date.now() - 10 * 60_000),
    heartbeatAt: new Date(Date.now() - 5 * 60_000),
  });

  const enqueued = await runSelector();
  assert.ok(enqueued >= 1);

  const storedInvestigation = await prisma.investigation.findUnique({
    where: { id: processingInvestigation.id },
    select: { status: true },
  });
  assert.ok(storedInvestigation);
  assert.equal(storedInvestigation.status, "PENDING");

  const storedRun = await prisma.investigationRun.findUnique({
    where: { investigationId: processingInvestigation.id },
    select: {
      leaseOwner: true,
      leaseExpiresAt: true,
      queuedAt: true,
    },
  });
  assert.ok(storedRun);
  assert.equal(storedRun.leaseOwner, null);
  assert.equal(storedRun.leaseExpiresAt, null);
  assert.notEqual(storedRun.queuedAt, null);
});

void test("post.investigateNow rejects unauthenticated callers", async () => {
  const caller = createCaller({ isAuthenticated: false });
  const input = buildXViewInput({
    externalId: "investigate-now-auth-required-1",
    observedContentText: "Content that should require API key auth.",
  });

  await assert.rejects(
    async () => caller.post.investigateNow(input),
    /Valid API key or x-openai-api-key required/,
  );
});

void test("post.investigateNow rejects content over word-count limit", async () => {
  const caller = createCaller({ isAuthenticated: true });
  const overLimitText = new Array(WORD_COUNT_LIMIT + 1).fill("word").join(" ");
  const input = buildXViewInput({
    externalId: "investigate-now-word-limit-1",
    observedContentText: overLimitText,
  });

  await assert.rejects(
    async () => caller.post.investigateNow(input),
    /Post exceeds word count limit/,
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

  if (!post) return;

  const investigationCount = await prisma.investigation.count({
    where: {
      postVersion: {
        postId: post.id,
      },
    },
  });
  assert.equal(investigationCount, 0);
});

void test("post.batchStatus returns investigation state and incorrect claim counts", async () => {
  const caller = createCaller();

  const investigatedPost = await seedPost({
    platform: "X",
    externalId: "batch-investigated-1",
    url: "https://x.com/openerrata/status/batch-investigated-1",
    contentText: "Investigated post content for batchStatus.",
  });
  const pendingPost = await seedPost({
    platform: "X",
    externalId: "batch-not-investigated-1",
    url: "https://x.com/openerrata/status/batch-not-investigated-1",
    contentText: "Not investigated post content for batchStatus.",
  });

  const investigation = await seedCompleteInvestigation({
    postId: investigatedPost.id,
    contentHash: investigatedPost.contentHash,
    contentText: investigatedPost.contentText,
    provenance: "CLIENT_FALLBACK",
  });
  await seedClaimWithSource(investigation.id, 1);
  await seedClaimWithSource(investigation.id, 2);

  const result = await caller.post.batchStatus({
    posts: [
      {
        platform: investigatedPost.platform,
        externalId: investigatedPost.externalId,
        versionHash: investigatedPost.versionHash,
      },
      {
        platform: pendingPost.platform,
        externalId: pendingPost.externalId,
        versionHash: pendingPost.versionHash,
      },
    ],
  });

  assert.equal(result.statuses.length, 2);
  const byExternalId = new Map<string, (typeof result.statuses)[number]>(
    result.statuses.map((status) => [status.externalId, status]),
  );

  const investigated = byExternalId.get(investigatedPost.externalId);
  assert.ok(investigated);
  assert.equal(investigated.investigationState, "INVESTIGATED");
  assert.equal(investigated.incorrectClaimCount, 2);

  const notInvestigated = byExternalId.get(pendingPost.externalId);
  assert.ok(notInvestigated);
  assert.equal(notInvestigated.investigationState, "NOT_INVESTIGATED");
  assert.equal(notInvestigated.incorrectClaimCount, 0);
});

void test("public.getInvestigation hides non-COMPLETE investigations", async () => {
  const caller = createCaller();
  const post = await seedPost({
    platform: "LESSWRONG",
    externalId: "public-investigation-non-complete-hidden-1",
    url: "https://www.lesswrong.com/posts/public-investigation-non-complete-hidden-1",
    contentText: "Public read-model should hide non-complete investigations.",
  });

  const pending = await seedPendingInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "SERVER_VERIFIED",
  });
  const failedText = normalizeContent(
    "Public read-model should hide non-complete investigations. Failed revision.",
  );
  const failedHash = await hashContent(failedText);
  const failed = await seedFailedInvestigation({
    postId: post.id,
    contentHash: failedHash,
    contentText: failedText,
    provenance: "CLIENT_FALLBACK",
  });

  for (const investigationId of [pending.id, failed.id]) {
    const trpcResult = await caller.public.getInvestigation({
      investigationId,
    });
    assert.equal(trpcResult, null);

    const graphqlResult = await queryPublicGraphql<{
      publicInvestigation: {
        investigation: {
          id: string;
        };
      } | null;
    }>(
      `
        query PublicInvestigation($investigationId: ID!) {
          publicInvestigation(investigationId: $investigationId) {
            investigation {
              id
            }
          }
        }
      `,
      { investigationId },
    );
    assert.equal(graphqlResult.publicInvestigation, null);
  }
});

void test("public.getInvestigation returns complete investigation and trust signals", async () => {
  const caller = createCaller();
  const post = await seedPost({
    platform: "LESSWRONG",
    externalId: "public-investigation-1",
    url: "https://www.lesswrong.com/posts/public-investigation-1",
    contentText: "Public investigation content text.",
  });

  const investigation = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "SERVER_VERIFIED",
  });
  await seedClaimWithSource(investigation.id, 1);

  const result = await caller.public.getInvestigation({
    investigationId: investigation.id,
  });

  assert.ok(result);
  assert.equal(result.investigation.id, investigation.id);
  assert.equal(result.investigation.origin.provenance, "SERVER_VERIFIED");
  assert.equal(result.investigation.corroborationCount, 0);
  assert.equal(typeof result.investigation.origin.serverVerifiedAt, "string");
  assert.equal(result.post.platform, post.platform);
  assert.equal(result.post.externalId, post.externalId);
  assert.equal(result.claims.length, 1);

  const graphqlResult = await queryPublicGraphql<{
    publicInvestigation: {
      investigation: {
        id: string;
        origin:
          | {
              __typename: "ServerVerifiedOrigin";
              provenance: "SERVER_VERIFIED";
              serverVerifiedAt: string;
            }
          | {
              __typename: "ClientFallbackOrigin";
              provenance: "CLIENT_FALLBACK";
              fetchFailureReason: string;
            };
        corroborationCount: number;
      };
      post: {
        platform: Platform;
        externalId: string;
      };
      claims: { id: string }[];
    } | null;
  }>(
    `
      query PublicInvestigation($investigationId: ID!) {
        publicInvestigation(investigationId: $investigationId) {
          investigation {
            id
            origin {
              __typename
              ... on ServerVerifiedOrigin {
                provenance
                serverVerifiedAt
              }
              ... on ClientFallbackOrigin {
                provenance
                fetchFailureReason
              }
            }
            corroborationCount
          }
          post {
            platform
            externalId
          }
          claims {
            id
          }
        }
      }
    `,
    { investigationId: investigation.id },
  );

  assert.ok(graphqlResult.publicInvestigation);
  const graphqlInvestigation = graphqlResult.publicInvestigation.investigation;
  assert.equal(graphqlInvestigation.id, investigation.id);
  assert.equal(graphqlInvestigation.origin.provenance, "SERVER_VERIFIED");
  assert.equal(graphqlInvestigation.corroborationCount, 0);
  assert.equal(graphqlInvestigation.origin.__typename, "ServerVerifiedOrigin");
});

void test("public.getInvestigation returns CLIENT_FALLBACK without corroboration", async () => {
  const caller = createCaller();
  const post = await seedPost({
    platform: "LESSWRONG",
    externalId: "public-investigation-fallback-1",
    url: "https://www.lesswrong.com/posts/public-investigation-fallback-1",
    contentText: "Client fallback content should still be returned publicly.",
  });
  const investigation = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
  });

  const result = await caller.public.getInvestigation({
    investigationId: investigation.id,
  });

  assert.ok(result);
  assert.equal(result.investigation.id, investigation.id);
  assert.equal(result.investigation.origin.provenance, "CLIENT_FALLBACK");
  assert.equal(result.investigation.corroborationCount, 0);
  assert.equal(result.investigation.origin.fetchFailureReason, "fetch unavailable");

  const graphqlResult = await queryPublicGraphql<{
    publicInvestigation: {
      investigation: {
        origin:
          | {
              __typename: "ServerVerifiedOrigin";
              provenance: "SERVER_VERIFIED";
              serverVerifiedAt: string;
            }
          | {
              __typename: "ClientFallbackOrigin";
              provenance: "CLIENT_FALLBACK";
              fetchFailureReason: string;
            };
        corroborationCount: number;
      };
    } | null;
  }>(
    `
      query PublicInvestigation($investigationId: ID!) {
        publicInvestigation(investigationId: $investigationId) {
          investigation {
            origin {
              __typename
              ... on ServerVerifiedOrigin {
                provenance
                serverVerifiedAt
              }
              ... on ClientFallbackOrigin {
                provenance
                fetchFailureReason
              }
            }
            corroborationCount
          }
        }
      }
    `,
    { investigationId: investigation.id },
  );

  assert.ok(graphqlResult.publicInvestigation);
  assert.equal(
    graphqlResult.publicInvestigation.investigation.origin.provenance,
    "CLIENT_FALLBACK",
  );
  assert.equal(graphqlResult.publicInvestigation.investigation.corroborationCount, 0);
  assert.equal(
    graphqlResult.publicInvestigation.investigation.origin.__typename,
    "ClientFallbackOrigin",
  );
  assert.equal(
    graphqlResult.publicInvestigation.investigation.origin.fetchFailureReason,
    "fetch unavailable",
  );
});

void test("public.getInvestigation reports corroborationCount for CLIENT_FALLBACK investigations", async () => {
  const caller = createCaller();
  const post = await seedPost({
    platform: "LESSWRONG",
    externalId: "public-investigation-corroborated-1",
    url: "https://www.lesswrong.com/posts/public-investigation-corroborated-1",
    contentText: "Corroborated fallback content.",
  });
  const investigation = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
  });
  await seedClaimWithSource(investigation.id, 1);
  await seedCorroborationCredits(investigation.id, 3);

  const result = await caller.public.getInvestigation({
    investigationId: investigation.id,
  });

  assert.ok(result);
  assert.equal(result.investigation.id, investigation.id);
  assert.equal(result.investigation.origin.provenance, "CLIENT_FALLBACK");
  assert.equal(result.investigation.corroborationCount, 3);
  assert.equal(result.claims.length, 1);
});

void test("public.getPostInvestigations lists all complete investigations for a post", async () => {
  const caller = createCaller();
  const post = await seedPost({
    platform: "LESSWRONG",
    externalId: "public-post-investigations-all-complete-1",
    url: "https://www.lesswrong.com/posts/public-post-investigations-all-complete-1",
    contentText: "Post-level investigations content text.",
  });

  const fallbackInvestigation = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
  });
  await seedCorroborationCredits(fallbackInvestigation.id, 2);

  const serverVerifiedText = normalizeContent("Server-verified content revision for same post.");
  const serverVerifiedHash = await hashContent(serverVerifiedText);
  const serverVerifiedInvestigation = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: serverVerifiedHash,
    contentText: serverVerifiedText,
    provenance: "SERVER_VERIFIED",
  });
  await seedClaimWithSource(serverVerifiedInvestigation.id, 1);

  const result = await caller.public.getPostInvestigations({
    platform: post.platform,
    externalId: post.externalId,
  });

  assert.ok(result.post);
  assert.equal(result.post.platform, post.platform);
  assert.equal(result.post.externalId, post.externalId);
  assert.equal(result.investigations.length, 2);

  const byId = new Map<string, (typeof result.investigations)[number]>(
    result.investigations.map((item) => [item.id, item]),
  );
  const fallback = byId.get(fallbackInvestigation.id);
  assert.ok(fallback);
  assert.equal(fallback.origin.provenance, "CLIENT_FALLBACK");
  assert.equal(fallback.corroborationCount, 2);

  const serverVerified = byId.get(serverVerifiedInvestigation.id);
  assert.ok(serverVerified);
  assert.equal(serverVerified.origin.provenance, "SERVER_VERIFIED");
  assert.equal(serverVerified.claimCount, 1);

  const graphqlResult = await queryPublicGraphql<{
    postInvestigations: {
      investigations: {
        id: string;
        origin:
          | {
              __typename: "ServerVerifiedOrigin";
              provenance: "SERVER_VERIFIED";
              serverVerifiedAt: string;
            }
          | {
              __typename: "ClientFallbackOrigin";
              provenance: "CLIENT_FALLBACK";
              fetchFailureReason: string;
            };
        corroborationCount: number;
      }[];
    };
  }>(
    `
      query PostInvestigations($platform: Platform!, $externalId: String!) {
        postInvestigations(platform: $platform, externalId: $externalId) {
          investigations {
            id
            origin {
              __typename
              ... on ServerVerifiedOrigin {
                provenance
                serverVerifiedAt
              }
              ... on ClientFallbackOrigin {
                provenance
                fetchFailureReason
              }
            }
            corroborationCount
          }
        }
      }
    `,
    {
      platform: post.platform,
      externalId: post.externalId,
    },
  );

  assert.equal(graphqlResult.postInvestigations.investigations.length, 2);
});

void test("public.searchInvestigations filters by query/platform and includes fallback matches", async () => {
  const caller = createCaller();

  const moonMarker = "graphql-search-marker-astronomy-moon";
  const moonPost = await seedPost({
    platform: "LESSWRONG",
    externalId: "public-search-moon-1",
    url: "https://www.lesswrong.com/posts/public-search-moon-1",
    contentText: `${moonMarker} alpha`,
  });
  const moonInvestigation = await seedCompleteInvestigation({
    postId: moonPost.id,
    contentHash: moonPost.contentHash,
    contentText: moonPost.contentText,
    provenance: "SERVER_VERIFIED",
  });
  await seedClaimWithSource(moonInvestigation.id, 1);

  const xPost = await seedPost({
    platform: "X",
    externalId: "public-search-x-1",
    url: "https://x.com/openerrata/status/public-search-x-1",
    contentText: "Traffic data trends are stable this week.",
  });
  const xInvestigation = await seedCompleteInvestigation({
    postId: xPost.id,
    contentHash: xPost.contentHash,
    contentText: xPost.contentText,
    provenance: "SERVER_VERIFIED",
  });

  const fallbackMoonPost = await seedPost({
    platform: "LESSWRONG",
    externalId: "public-search-fallback-moon-1",
    url: "https://www.lesswrong.com/posts/public-search-fallback-moon-1",
    contentText: `${moonMarker} beta`,
  });
  const fallbackMoonInvestigation = await seedCompleteInvestigation({
    postId: fallbackMoonPost.id,
    contentHash: fallbackMoonPost.contentHash,
    contentText: fallbackMoonPost.contentText,
    provenance: "CLIENT_FALLBACK",
  });

  const queryResult = await caller.public.searchInvestigations({
    query: moonMarker,
    limit: 20,
    offset: 0,
  });

  const queryIds = new Set<string>(queryResult.investigations.map((item) => item.id));
  assert.equal(queryIds.has(moonInvestigation.id), true);
  assert.equal(queryIds.has(fallbackMoonInvestigation.id), true);
  assert.equal(
    queryResult.investigations.every((item) => item.platform === "LESSWRONG"),
    true,
  );

  const platformResult = await caller.public.searchInvestigations({
    platform: "X",
    limit: 20,
    offset: 0,
  });

  const platformIds = new Set<string>(platformResult.investigations.map((item) => item.id));
  assert.equal(platformIds.has(xInvestigation.id), true);
  assert.equal(platformIds.has(moonInvestigation.id), false);

  const graphqlResult = await queryPublicGraphql<{
    searchInvestigations: {
      investigations: {
        id: string;
        origin:
          | {
              __typename: "ServerVerifiedOrigin";
              provenance: "SERVER_VERIFIED";
              serverVerifiedAt: string;
            }
          | {
              __typename: "ClientFallbackOrigin";
              provenance: "CLIENT_FALLBACK";
              fetchFailureReason: string;
            };
      }[];
    };
  }>(
    `
      query SearchInvestigations($query: String!, $limit: Int!, $offset: Int!) {
        searchInvestigations(query: $query, limit: $limit, offset: $offset) {
          investigations {
            id
            origin {
              __typename
              ... on ServerVerifiedOrigin {
                provenance
                serverVerifiedAt
              }
              ... on ClientFallbackOrigin {
                provenance
                fetchFailureReason
              }
            }
          }
        }
      }
    `,
    {
      query: moonMarker,
      limit: 20,
      offset: 0,
    },
  );
  const graphqlIds = new Set(
    graphqlResult.searchInvestigations.investigations.map((item) => item.id),
  );
  assert.equal(graphqlIds.has(moonInvestigation.id), true);
  assert.equal(graphqlIds.has(fallbackMoonInvestigation.id), true);
});

void test("public.getMetrics counts all complete investigations and honors filters", async () => {
  const caller = createCaller();
  const metricsWindowStart = "2026-02-23T00:00:00.000Z";
  const metricsWindowEnd = "2026-02-23T23:59:59.999Z";

  const xPost = await seedPost({
    platform: "X",
    externalId: "public-metrics-x-1",
    url: "https://x.com/openerrata/status/public-metrics-x-1",
    contentText: "Metrics platform X post.",
  });
  const xInvestigation = await seedCompleteInvestigation({
    postId: xPost.id,
    contentHash: xPost.contentHash,
    contentText: xPost.contentText,
    provenance: "SERVER_VERIFIED",
    checkedAt: new Date("2026-02-23T12:00:00.000Z"),
  });
  await seedClaimWithSource(xInvestigation.id, 1);

  const lesswrongPost = await seedPost({
    platform: "LESSWRONG",
    externalId: "public-metrics-lw-1",
    url: "https://www.lesswrong.com/posts/public-metrics-lw-1",
    contentText: "Metrics LessWrong post.",
  });
  await seedCompleteInvestigation({
    postId: lesswrongPost.id,
    contentHash: lesswrongPost.contentHash,
    contentText: lesswrongPost.contentText,
    provenance: "SERVER_VERIFIED",
    checkedAt: new Date("2026-02-23T13:00:00.000Z"),
  });

  const fallbackPost = await seedPost({
    platform: "X",
    externalId: "public-metrics-fallback-1",
    url: "https://x.com/openerrata/status/public-metrics-fallback-1",
    contentText: "Client fallback should count in public metrics.",
  });
  const fallbackInvestigation = await seedCompleteInvestigation({
    postId: fallbackPost.id,
    contentHash: fallbackPost.contentHash,
    contentText: fallbackPost.contentText,
    provenance: "CLIENT_FALLBACK",
    checkedAt: new Date("2026-02-23T14:00:00.000Z"),
  });
  await seedCorroborationCredits(fallbackInvestigation.id, 1);

  const allMetrics = await caller.public.getMetrics({
    windowStart: metricsWindowStart,
    windowEnd: metricsWindowEnd,
  });
  assert.equal(allMetrics.totalInvestigatedPosts, 3);
  assert.equal(allMetrics.investigatedPostsWithFlags, 1);
  assert.equal(allMetrics.factCheckIncidence, 1 / 3);

  const xMetrics = await caller.public.getMetrics({
    platform: "X",
    windowStart: metricsWindowStart,
    windowEnd: metricsWindowEnd,
  });
  assert.equal(xMetrics.totalInvestigatedPosts, 2);
  assert.equal(xMetrics.investigatedPostsWithFlags, 1);
  assert.equal(xMetrics.factCheckIncidence, 0.5);

  const emptyWindowMetrics = await caller.public.getMetrics({
    windowStart: "2026-02-24T00:00:00.000Z",
    windowEnd: "2026-02-24T23:59:59.999Z",
  });
  assert.equal(emptyWindowMetrics.totalInvestigatedPosts, 0);
  assert.equal(emptyWindowMetrics.investigatedPostsWithFlags, 0);
  assert.equal(emptyWindowMetrics.factCheckIncidence, 0);

  const graphqlResult = await queryPublicGraphql<{
    publicMetrics: {
      totalInvestigatedPosts: number;
      investigatedPostsWithFlags: number;
      factCheckIncidence: number;
    };
  }>(
    `
      query PublicMetrics($windowStart: DateTime, $windowEnd: DateTime, $platform: Platform) {
        publicMetrics(windowStart: $windowStart, windowEnd: $windowEnd, platform: $platform) {
          totalInvestigatedPosts
          investigatedPostsWithFlags
          factCheckIncidence
        }
      }
    `,
    {
      windowStart: metricsWindowStart,
      windowEnd: metricsWindowEnd,
      platform: "X",
    },
  );
  assert.equal(graphqlResult.publicMetrics.totalInvestigatedPosts, 2);
  assert.equal(graphqlResult.publicMetrics.investigatedPostsWithFlags, 1);
  assert.equal(graphqlResult.publicMetrics.factCheckIncidence, 0.5);
});

void test("post.validateSettings reports instance api-key acceptance", async () => {
  const authenticatedCaller = createCaller({ isAuthenticated: true });
  const anonymousCaller = createCaller({ isAuthenticated: false });

  const authenticatedResult = await authenticatedCaller.post.validateSettings();
  const anonymousResult = await anonymousCaller.post.validateSettings();

  assert.equal(authenticatedResult.instanceApiKeyAccepted, true);
  assert.equal(authenticatedResult.openaiApiKeyStatus, "missing");

  assert.equal(anonymousResult.instanceApiKeyAccepted, false);
  assert.equal(anonymousResult.openaiApiKeyStatus, "missing");
});

void test("createContext authenticates active instance API keys from database", async () => {
  const rawKey = withIntegrationPrefix("instance-api-key-active");
  await seedInstanceApiKey({
    name: "instance-api-key-active",
    rawKey,
  });

  const context = await createContext(
    createMockRequestEvent({
      "x-api-key": rawKey,
    }),
  );

  assert.equal(context.isAuthenticated, true);
  assert.equal(context.canInvestigate, true);
});

void test("createContext rejects unknown and revoked instance API keys", async () => {
  const revokedRawKey = withIntegrationPrefix("instance-api-key-revoked");
  await seedInstanceApiKey({
    name: "instance-api-key-revoked",
    rawKey: revokedRawKey,
    revokedAt: new Date("2026-02-23T00:00:00.000Z"),
  });

  const rejectedKeyCases = [
    {
      label: "missing key",
      rawKey: withIntegrationPrefix("instance-api-key-missing"),
    },
    {
      label: "revoked key",
      rawKey: revokedRawKey,
    },
  ];

  for (const rejectedKeyCase of rejectedKeyCases) {
    const context = await createContext(
      createMockRequestEvent({
        "x-api-key": rejectedKeyCase.rawKey,
      }),
    );
    assert.equal(
      context.isAuthenticated,
      false,
      `Expected unauthenticated context for ${rejectedKeyCase.label}`,
    );
    assert.equal(
      context.canInvestigate,
      false,
      `Expected non-investigating context for ${rejectedKeyCase.label}`,
    );
  }
});
