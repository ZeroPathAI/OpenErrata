import type { Platform } from "@openerrata/shared";
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

void test("post.investigateNow returns existing FAILED investigations unchanged", async () => {
  const caller = createCaller({ isAuthenticated: true });
  const input = buildXViewInput({
    externalId: "investigate-now-failed-terminal-1",
    observedContentText: "FAILED is terminal for this content version.",
  });
  const seeded = await seedInvestigationForXViewInput({
    viewInput: input,
    status: "FAILED",
    provenance: "CLIENT_FALLBACK",
  });

  const result = await caller.post.investigateNow(input);

  assert.equal(result.investigationId, seeded.investigationId);
  assert.equal(result.status, "FAILED");
  assert.equal(result.provenance, "CLIENT_FALLBACK");

  const stored = await prisma.investigation.findUniqueOrThrow({
    where: { id: seeded.investigationId },
    select: { status: true },
  });
  assert.equal(stored.status, "FAILED");
});

void test("post.investigateNow attaches a user key only to the investigation its request creates", async () => {
  const firstCaller = createCaller({
    userOpenAiApiKey: "sk-test-user-key-first-0123456789",
  });
  const secondCaller = createCaller({
    userOpenAiApiKey: "sk-test-user-key-second-0123456789",
  });
  const input = buildXViewInput({
    externalId: "investigate-now-user-key-first-wins-1",
    observedContentText: "The creating request's key funds the investigation.",
  });

  const firstResult = await firstCaller.post.investigateNow(input);
  assert.equal(firstResult.status, "PENDING");
  const created = await prisma.investigation.findUniqueOrThrow({
    where: { id: firstResult.investigationId },
    select: {
      origin: true,
      openAiKeySource: { select: { ciphertext: true, iv: true, authTag: true, keyId: true } },
    },
  });
  assert.equal(created.origin, "USER_KEY_REQUEST");
  assert.ok(created.openAiKeySource);

  const secondResult = await secondCaller.post.investigateNow(input);
  assert.equal(secondResult.investigationId, firstResult.investigationId);
  const afterSecond = await prisma.investigationOpenAiKeySource.findUniqueOrThrow({
    where: { investigationId: firstResult.investigationId },
    select: { ciphertext: true, iv: true, authTag: true, keyId: true },
  });
  assert.deepEqual(afterSecond, created.openAiKeySource);
});

void test("post.investigateNow never attaches a user key to an investigation the server is paying for", async () => {
  const caller = createCaller({ userOpenAiApiKey: "sk-test-user-key-late-0123456789" });
  const input = buildXViewInput({
    externalId: "investigate-now-user-key-no-takeover-1",
    observedContentText: "A selector-admitted investigation keeps its server funding.",
  });
  const seeded = await seedInvestigationForXViewInput({
    viewInput: input,
    status: "PENDING",
    provenance: "CLIENT_FALLBACK",
  });
  await prisma.investigation.update({
    where: { id: seeded.investigationId },
    data: { origin: "SELECTOR" },
  });

  const result = await caller.post.investigateNow(input);

  assert.equal(result.investigationId, seeded.investigationId);
  assert.equal(result.status, "PENDING");
  const stored = await prisma.investigation.findUniqueOrThrow({
    where: { id: seeded.investigationId },
    select: { origin: true, openAiKeySource: { select: { investigationId: true } } },
  });
  assert.equal(stored.origin, "SELECTOR");
  assert.equal(stored.openAiKeySource, null);
});

void test("post.investigateNow rejects a user key OpenAI refuses before creating anything", async () => {
  const caller = createCaller({ userOpenAiApiKey: "sk-test-rejected-user-key" });
  const input = buildXViewInput({
    externalId: "investigate-now-user-key-rejected-1",
    observedContentText: "A refused key must not create an investigation.",
  });

  await assert.rejects(caller.post.investigateNow(input), /x-openai-api-key was rejected/);

  const registered = await prisma.post.findUniqueOrThrow({
    where: { platform_externalId: { platform: "X", externalId: input.externalId } },
    select: { versions: { select: { investigation: { select: { id: true } } } } },
  });
  assert.deepEqual(
    registered.versions.map((version) => version.investigation),
    [null],
  );
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
  await seedInvestigationWithLeaseFields({
    investigationId: seeded.investigationId,
    leaseOwner: "worker-stale",
    leaseExpiresAt: new Date(Date.now() - 5 * 60_000),
    startedAt: new Date(Date.now() - 10 * 60_000),
    heartbeatAt: new Date(Date.now() - 5 * 60_000),
  });

  const result = await caller.post.investigateNow(input);

  assert.equal(result.investigationId, seeded.investigationId);
  assert.equal(result.status, "PENDING");

  const stored = await prisma.investigation.findUnique({
    where: { id: seeded.investigationId },
    select: {
      status: true,
      queuedAt: true,
    },
  });
  assert.ok(stored);
  assert.equal(stored.status, "PENDING");
  assert.notEqual(stored.queuedAt, null);

  // Lease row should be deleted after recovery
  const storedLease = await prisma.investigationLease.findUnique({
    where: { investigationId: seeded.investigationId },
  });
  assert.equal(storedLease, null);
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
  await seedInvestigationWithLeaseFields({
    investigationId: seeded.investigationId,
    leaseOwner: "worker-active",
    leaseExpiresAt,
    startedAt: new Date(Date.now() - 60_000),
    heartbeatAt: new Date(),
  });

  const result = await caller.post.investigateNow(input);

  assert.equal(result.investigationId, seeded.investigationId);
  assert.equal(result.status, "PROCESSING");

  const stored = await prisma.investigation.findUnique({
    where: { id: seeded.investigationId },
    select: { status: true },
  });
  assert.ok(stored);
  assert.equal(stored.status, "PROCESSING");

  const storedLease = await prisma.investigationLease.findUnique({
    where: { investigationId: seeded.investigationId },
    select: { leaseOwner: true, leaseExpiresAt: true },
  });
  assert.ok(storedLease);
  assert.equal(storedLease.leaseOwner, "worker-active");
  assert.equal(storedLease.leaseExpiresAt.getTime(), leaseExpiresAt.getTime());
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
  await seedInvestigationWithLeaseFields({
    investigationId: processingInvestigation.id,
    leaseOwner: "worker-stale",
    leaseExpiresAt: new Date(Date.now() - 5 * 60_000),
    startedAt: new Date(Date.now() - 10 * 60_000),
    heartbeatAt: new Date(Date.now() - 5 * 60_000),
  });

  const summary = await runSelector({ dailyBudget: 0 });
  assert.ok(summary.recovered >= 1);
  assert.deepEqual(summary.failures, []);

  const stored = await prisma.investigation.findUnique({
    where: { id: processingInvestigation.id },
    select: {
      status: true,
      queuedAt: true,
    },
  });
  assert.ok(stored);
  assert.equal(stored.status, "PENDING");
  assert.notEqual(stored.queuedAt, null);

  // Lease row should be deleted after recovery
  const storedLease = await prisma.investigationLease.findUnique({
    where: { investigationId: processingInvestigation.id },
  });
  assert.equal(storedLease, null);
});

async function selectorAdmissionsToday(): Promise<number> {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  return prisma.investigation.count({
    where: { origin: "SELECTOR", admittedAt: { gte: dayStart } },
  });
}

async function seedTopScoredPost(externalId: string, uniqueViewScore: number) {
  const post = await seedPost({
    platform: "X",
    externalId,
    url: `https://x.com/openerrata/status/${withIntegrationPrefix(externalId)}`,
    contentText: `Selector admission candidate ${externalId}.`,
  });
  await prisma.post.update({ where: { id: post.id }, data: { uniqueViewScore } });
  return post;
}

void test("selector admits at most its daily budget of new investigations per UTC day", async () => {
  const post = await seedTopScoredPost("selector-daily-budget-1", 2_000_000_000);
  const dailyBudget = (await selectorAdmissionsToday()) + 1;

  const first = await runSelector({ dailyBudget });
  assert.equal(first.admitted, 1);
  assert.equal(first.budgetRemaining, 0);
  assert.deepEqual(first.failures, []);
  const admitted = await prisma.investigation.findUniqueOrThrow({
    where: { postVersionId: post.postVersionId },
    select: {
      status: true,
      origin: true,
      input: { select: { postUrl: true } },
    },
  });
  assert.deepEqual(admitted, {
    status: "PENDING",
    origin: "SELECTOR",
    input: { postUrl: post.url },
  });

  // Running again the same day admits nothing more, however often it runs.
  await seedTopScoredPost("selector-daily-budget-2", 2_000_000_001);
  const second = await runSelector({ dailyBudget });
  assert.equal(second.admitted, 0);
  assert.equal(second.budgetRemaining, 0);
});

void test("selector funds an investigation whose user key was dropped, within its budget", async () => {
  const post = await seedTopScoredPost("selector-adopts-unfunded-1", 2_000_000_010);
  const unfunded = await seedPendingInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
  });
  await prisma.investigation.update({
    where: { id: unfunded.id },
    data: { origin: "USER_KEY_REQUEST" },
  });

  const summary = await runSelector({ dailyBudget: (await selectorAdmissionsToday()) + 1 });

  assert.equal(summary.admitted, 1);
  const stored = await prisma.investigation.findUniqueOrThrow({
    where: { id: unfunded.id },
    select: { origin: true, status: true },
  });
  assert.deepEqual(stored, { origin: "SELECTOR", status: "PENDING" });
});

void test("selector-created investigations of edited posts get update lineage", async () => {
  const post = await seedTopScoredPost("selector-update-lineage-1", 2_000_000_020);
  const parent = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "SERVER_VERIFIED",
  });
  const editedText = normalizeContent(`${post.contentText} An edited sentence.`);
  const editedVersion = await ensurePostVersionForSeed({
    postId: post.id,
    contentHash: await hashContent(editedText),
    contentText: editedText,
    provenance: "CLIENT_FALLBACK",
  });

  const summary = await runSelector({ dailyBudget: (await selectorAdmissionsToday()) + 1 });

  assert.equal(summary.admitted, 1);
  const update = await prisma.investigation.findUniqueOrThrow({
    where: { postVersionId: editedVersion.id },
    select: { parentInvestigationId: true, contentDiff: true },
  });
  assert.equal(update.parentInvestigationId, parent.id);
  assert.match(update.contentDiff ?? "", /An edited sentence\./);
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

interface GraphqlOrigin {
  provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
  serverVerifiedAt: string | null;
}

async function queryPublicInvestigation(investigationId: string) {
  const result = await queryPublicGraphql<{
    publicInvestigation: {
      investigation: { id: string; origin: GraphqlOrigin; corroborationCount: number };
      post: { platform: Platform; externalId: string; url: string };
      claims: { id: string }[];
    } | null;
  }>(
    `
      query PublicInvestigation($investigationId: ID!) {
        publicInvestigation(investigationId: $investigationId) {
          investigation {
            id
            origin {
              provenance
              serverVerifiedAt
            }
            corroborationCount
          }
          post {
            platform
            externalId
            url
          }
          claims {
            id
          }
        }
      }
    `,
    { investigationId },
  );
  return result.publicInvestigation;
}

async function querySearchInvestigations(variables: {
  query?: string;
  platform?: Platform;
  minClaimCount?: number;
}): Promise<{ id: string; platform: Platform; origin: GraphqlOrigin }[]> {
  const result = await queryPublicGraphql<{
    searchInvestigations: {
      investigations: { id: string; platform: Platform; origin: GraphqlOrigin }[];
    };
  }>(
    `
      query SearchInvestigations($query: String, $platform: Platform, $minClaimCount: Int) {
        searchInvestigations(
          query: $query
          platform: $platform
          minClaimCount: $minClaimCount
          limit: 20
          offset: 0
        ) {
          investigations {
            id
            platform
            origin {
              provenance
              serverVerifiedAt
            }
          }
        }
      }
    `,
    variables,
  );
  return result.searchInvestigations.investigations;
}

async function queryPublicMetrics(variables: {
  windowStart: string;
  windowEnd: string;
  platform?: Platform;
}) {
  const result = await queryPublicGraphql<{
    publicMetrics: {
      totalInvestigatedPosts: number;
      investigatedPostsWithFlags: number;
      factCheckIncidence: number | null;
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
    variables,
  );
  return result.publicMetrics;
}

void test("publicInvestigation hides non-COMPLETE investigations", async () => {
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
    assert.equal(await queryPublicInvestigation(investigationId), null);
  }
});

void test("publicInvestigation returns complete investigation and trust signals", async () => {
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

  const result = await queryPublicInvestigation(investigation.id);
  assert.ok(result);
  assert.equal(result.investigation.id, investigation.id);
  assert.equal(result.investigation.origin.provenance, "SERVER_VERIFIED");
  assert.equal(result.investigation.corroborationCount, 0);
  assert.notEqual(result.investigation.origin.serverVerifiedAt, null);
  assert.equal(result.post.platform, post.platform);
  assert.equal(result.post.externalId, post.externalId);
  assert.equal(result.claims.length, 1);
});

void test("publicInvestigation returns CLIENT_FALLBACK without corroboration", async () => {
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

  const result = await queryPublicInvestigation(investigation.id);
  assert.ok(result);
  assert.equal(result.investigation.origin.provenance, "CLIENT_FALLBACK");
  assert.equal(result.investigation.corroborationCount, 0);
  assert.equal(result.investigation.origin.serverVerifiedAt, null);
});

void test("publicInvestigation reports corroborationCount for CLIENT_FALLBACK investigations", async () => {
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

  const result = await queryPublicInvestigation(investigation.id);
  assert.ok(result);
  assert.equal(result.investigation.id, investigation.id);
  assert.equal(result.investigation.origin.provenance, "CLIENT_FALLBACK");
  assert.equal(result.investigation.corroborationCount, 3);
  assert.equal(result.claims.length, 1);
});

void test("postInvestigations lists all complete investigations for a post", async () => {
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

  const result = await queryPublicGraphql<{
    postInvestigations: {
      post: { platform: Platform; externalId: string } | null;
      investigations: {
        id: string;
        origin: GraphqlOrigin;
        corroborationCount: number;
        claimCount: number;
      }[];
    };
  }>(
    `
      query PostInvestigations($platform: Platform!, $externalId: String!) {
        postInvestigations(platform: $platform, externalId: $externalId) {
          post {
            platform
            externalId
          }
          investigations {
            id
            origin {
              provenance
              serverVerifiedAt
            }
            corroborationCount
            claimCount
          }
        }
      }
    `,
    {
      platform: post.platform,
      externalId: post.externalId,
    },
  );

  assert.deepEqual(result.postInvestigations.post, {
    platform: post.platform,
    externalId: post.externalId,
  });
  const byId = new Map(result.postInvestigations.investigations.map((item) => [item.id, item]));
  assert.equal(byId.size, 2);

  const fallback = byId.get(fallbackInvestigation.id);
  assert.ok(fallback);
  assert.equal(fallback.origin.provenance, "CLIENT_FALLBACK");
  assert.equal(fallback.corroborationCount, 2);

  const serverVerified = byId.get(serverVerifiedInvestigation.id);
  assert.ok(serverVerified);
  assert.equal(serverVerified.origin.provenance, "SERVER_VERIFIED");
  assert.equal(serverVerified.claimCount, 1);
});

void test("searchInvestigations filters by query/platform and includes fallback matches", async () => {
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

  const multiClaimMoonPost = await seedPost({
    platform: "LESSWRONG",
    externalId: "public-search-moon-2",
    url: "https://www.lesswrong.com/posts/public-search-moon-2",
    contentText: `${moonMarker} gamma`,
  });
  const multiClaimMoonInvestigation = await seedCompleteInvestigation({
    postId: multiClaimMoonPost.id,
    contentHash: multiClaimMoonPost.contentHash,
    contentText: multiClaimMoonPost.contentText,
    provenance: "SERVER_VERIFIED",
  });
  await seedClaimWithSource(multiClaimMoonInvestigation.id, 2);
  await seedClaimWithSource(multiClaimMoonInvestigation.id, 3);

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

  const queryResult = await querySearchInvestigations({ query: moonMarker });
  const queryIds = new Set(queryResult.map((item) => item.id));
  assert.equal(queryIds.has(moonInvestigation.id), true);
  assert.equal(queryIds.has(multiClaimMoonInvestigation.id), true);
  assert.equal(queryIds.has(fallbackMoonInvestigation.id), true);
  assert.equal(
    queryResult.every((item) => item.platform === "LESSWRONG"),
    true,
  );

  const minClaimCountResult = await querySearchInvestigations({
    query: moonMarker,
    minClaimCount: 2,
  });
  assert.deepEqual(
    minClaimCountResult.map((item) => item.id),
    [multiClaimMoonInvestigation.id],
  );

  const platformIds = new Set(
    (await querySearchInvestigations({ platform: "X" })).map((item) => item.id),
  );
  assert.equal(platformIds.has(xInvestigation.id), true);
  assert.equal(platformIds.has(moonInvestigation.id), false);
});

void test("publicMetrics counts all complete investigations and honors filters", async () => {
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

  assert.deepEqual(
    await queryPublicMetrics({ windowStart: metricsWindowStart, windowEnd: metricsWindowEnd }),
    { totalInvestigatedPosts: 3, investigatedPostsWithFlags: 1, factCheckIncidence: 1 / 3 },
  );
  assert.deepEqual(
    await queryPublicMetrics({
      windowStart: metricsWindowStart,
      windowEnd: metricsWindowEnd,
      platform: "X",
    }),
    { totalInvestigatedPosts: 2, investigatedPostsWithFlags: 1, factCheckIncidence: 0.5 },
  );
  // No investigations in the window: incidence is undefined, not 0.
  assert.deepEqual(
    await queryPublicMetrics({
      windowStart: "2026-02-24T00:00:00.000Z",
      windowEnd: "2026-02-24T23:59:59.999Z",
    }),
    { totalInvestigatedPosts: 0, investigatedPostsWithFlags: 0, factCheckIncidence: null },
  );
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
  }
});
