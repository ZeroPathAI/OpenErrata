import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { RequestEvent } from "@sveltejs/kit";
import {
  hashContent,
  normalizeContent,
  WORD_COUNT_LIMIT,
  type Platform,
} from "@truesight/shared";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??=
  "postgresql://truesight:truesight_dev@localhost:5433/truesight";
process.env.HMAC_SECRET ??= "test-hmac-secret";
process.env.VALID_API_KEYS ??= "test-api-key";
process.env.BLOB_STORAGE_BUCKET ??= "test-truesight-images";
process.env.BLOB_STORAGE_ACCESS_KEY_ID ??= "test-blob-access-key";
process.env.BLOB_STORAGE_SECRET_ACCESS_KEY ??= "test-blob-secret";
process.env.BLOB_STORAGE_PUBLIC_URL_PREFIX ??= "https://example.test/images";
process.env.DATABASE_ENCRYPTION_KEY ??= "integration-test-database-encryption-key";

const INTEGRATION_TEST_RUN_ID = [
  Date.now().toString(36),
  process.pid.toString(36),
  Math.random().toString(36).slice(2, 8),
].join("-");
const INTEGRATION_DATA_PREFIX = `integration-test-${INTEGRATION_TEST_RUN_ID}-`;

function withIntegrationPrefix(value: string): string {
  return value.startsWith(INTEGRATION_DATA_PREFIX)
    ? value
    : `${INTEGRATION_DATA_PREFIX}${value}`;
}

const [
  { appRouter },
  { prisma },
  { GET: healthGet },
  { closeQueueUtils },
  { runSelector },
] =
  await Promise.all([
    import("../../src/lib/trpc/router.js"),
    import("../../src/lib/db/client.js"),
    import("../../src/routes/health/+server.js"),
    import("../../src/lib/services/queue.js"),
    import("../../src/lib/services/selector.js"),
  ]);

type CallerOptions = {
  isAuthenticated?: boolean;
  userOpenAiApiKey?: string | null;
  viewerKey?: string;
  ipRangeKey?: string;
};

type SeededPost = {
  id: string;
  platform: Platform;
  externalId: string;
  url: string;
  contentText: string;
  contentHash: string;
};

let promptCounter = 0;

function createCaller(options: CallerOptions = {}) {
  const isAuthenticated = options.isAuthenticated ?? false;
  const userOpenAiApiKey = options.userOpenAiApiKey ?? null;

  return appRouter.createCaller({
    event: null as unknown as RequestEvent,
    prisma,
    viewerKey: options.viewerKey ?? "integration-viewer",
    ipRangeKey: options.ipRangeKey ?? "integration-ip-range",
    isAuthenticated,
    canInvestigate: isAuthenticated || userOpenAiApiKey !== null,
    userOpenAiApiKey,
    hasValidAttestation: false,
  });
}

async function resetDatabase(): Promise<void> {
  const integrationPosts = await prisma.post.findMany({
    where: {
      externalId: { startsWith: INTEGRATION_DATA_PREFIX },
    },
    select: { id: true },
  });
  const integrationPostIds = integrationPosts.map((post) => post.id);
  const integrationInvestigations =
    integrationPostIds.length === 0
      ? []
      : await prisma.investigation.findMany({
          where: {
            postId: { in: integrationPostIds },
          },
          select: { id: true },
        });
  const integrationInvestigationIds = integrationInvestigations.map(
    (investigation) => investigation.id,
  );
  const integrationClaims =
    integrationInvestigationIds.length === 0
      ? []
      : await prisma.claim.findMany({
          where: {
            investigationId: { in: integrationInvestigationIds },
          },
          select: { id: true },
        });
  const integrationClaimIds = integrationClaims.map((claim) => claim.id);

  await prisma.$transaction(async (tx) => {
    if (integrationClaimIds.length > 0) {
      await tx.source.deleteMany({
        where: {
          claimId: { in: integrationClaimIds },
        },
      });
      await tx.claim.deleteMany({
        where: {
          id: { in: integrationClaimIds },
        },
      });
    }

    if (integrationInvestigationIds.length > 0) {
      await tx.corroborationCredit.deleteMany({
        where: {
          investigationId: { in: integrationInvestigationIds },
        },
      });
      await tx.investigation.deleteMany({
        where: {
          id: { in: integrationInvestigationIds },
        },
      });
    }

    if (integrationPostIds.length > 0) {
      await tx.xMeta.deleteMany({
        where: {
          postId: { in: integrationPostIds },
        },
      });
      await tx.lesswrongMeta.deleteMany({
        where: {
          postId: { in: integrationPostIds },
        },
      });
      await tx.postViewCredit.deleteMany({
        where: {
          postId: { in: integrationPostIds },
        },
      });
      await tx.post.deleteMany({
        where: {
          id: { in: integrationPostIds },
        },
      });
    }

    await tx.prompt.deleteMany({
      where: {
        version: { startsWith: INTEGRATION_DATA_PREFIX },
      },
    });

    await tx.author.deleteMany({
      where: {
        platformUserId: { startsWith: INTEGRATION_DATA_PREFIX },
      },
    });
  });
}

async function seedPrompt(label: string): Promise<{ id: string }> {
  promptCounter += 1;
  const text = `integration prompt ${label} ${promptCounter.toString()}`;
  const hash = await hashContent(text);

  return prisma.prompt.create({
    data: {
      version: withIntegrationPrefix(`${label}-${promptCounter.toString()}`),
      hash,
      text,
    },
    select: { id: true },
  });
}

async function seedPost(input: {
  platform: Platform;
  externalId: string;
  url: string;
  contentText: string;
}): Promise<SeededPost> {
  const externalId = withIntegrationPrefix(input.externalId);
  const contentText = normalizeContent(input.contentText);
  const contentHash = await hashContent(contentText);
  const wordCount = contentText.split(/\s+/).filter(Boolean).length;

  const post = await prisma.post.create({
    data: {
      platform: input.platform,
      externalId,
      url: input.url,
      latestContentText: contentText,
      latestContentHash: contentHash,
      wordCount,
    },
    select: {
      id: true,
      platform: true,
      externalId: true,
      url: true,
    },
  });

  return {
    ...post,
    contentText,
    contentHash,
  };
}

async function seedCompleteInvestigation(input: {
  postId: string;
  contentHash: string;
  contentText: string;
  provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
  checkedAt?: Date;
}): Promise<{ id: string; checkedAt: Date }> {
  const prompt = await seedPrompt(`investigation-${input.postId}`);
  const checkedAt = input.checkedAt ?? new Date("2026-02-19T00:00:00.000Z");

  const investigation = await prisma.investigation.create({
    data: {
      postId: input.postId,
      contentHash: input.contentHash,
      contentText: input.contentText,
      contentProvenance: input.provenance,
      fetchFailureReason:
        input.provenance === "CLIENT_FALLBACK" ? "fetch unavailable" : null,
      serverVerifiedAt:
        input.provenance === "SERVER_VERIFIED" ? checkedAt : null,
      status: "COMPLETE",
      promptId: prompt.id,
      provider: "OPENAI",
      model: "OPENAI_GPT_5",
      checkedAt,
    },
    select: { id: true, checkedAt: true },
  });

  return {
    id: investigation.id,
    checkedAt: investigation.checkedAt ?? checkedAt,
  };
}

async function seedFailedInvestigation(input: {
  postId: string;
  contentHash: string;
  contentText: string;
  provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
}): Promise<{ id: string }> {
  const prompt = await seedPrompt(`failed-investigation-${input.postId}`);

  const investigation = await prisma.investigation.create({
    data: {
      postId: input.postId,
      contentHash: input.contentHash,
      contentText: input.contentText,
      contentProvenance: input.provenance,
      fetchFailureReason:
        input.provenance === "CLIENT_FALLBACK" ? "fetch unavailable" : null,
      serverVerifiedAt:
        input.provenance === "SERVER_VERIFIED" ? new Date() : null,
      status: "FAILED",
      promptId: prompt.id,
      provider: "OPENAI",
      model: "OPENAI_GPT_5",
      checkedAt: null,
    },
    select: { id: true },
  });

  return { id: investigation.id };
}

async function seedPendingInvestigation(input: {
  postId: string;
  contentHash: string;
  contentText: string;
  provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
}): Promise<{ id: string }> {
  const prompt = await seedPrompt(`pending-investigation-${input.postId}`);

  const investigation = await prisma.investigation.create({
    data: {
      postId: input.postId,
      contentHash: input.contentHash,
      contentText: input.contentText,
      contentProvenance: input.provenance,
      fetchFailureReason:
        input.provenance === "CLIENT_FALLBACK" ? "fetch unavailable" : null,
      serverVerifiedAt:
        input.provenance === "SERVER_VERIFIED" ? new Date() : null,
      status: "PENDING",
      promptId: prompt.id,
      provider: "OPENAI",
      model: "OPENAI_GPT_5",
      checkedAt: null,
    },
    select: { id: true },
  });

  return { id: investigation.id };
}

async function seedProcessingInvestigation(input: {
  postId: string;
  contentHash: string;
  contentText: string;
  provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
}): Promise<{ id: string }> {
  const prompt = await seedPrompt(`processing-investigation-${input.postId}`);

  const investigation = await prisma.investigation.create({
    data: {
      postId: input.postId,
      contentHash: input.contentHash,
      contentText: input.contentText,
      contentProvenance: input.provenance,
      fetchFailureReason:
        input.provenance === "CLIENT_FALLBACK" ? "fetch unavailable" : null,
      serverVerifiedAt:
        input.provenance === "SERVER_VERIFIED" ? new Date() : null,
      status: "PROCESSING",
      promptId: prompt.id,
      provider: "OPENAI",
      model: "OPENAI_GPT_5",
      checkedAt: null,
    },
    select: { id: true },
  });

  return { id: investigation.id };
}

async function seedInvestigationRun(input: {
  investigationId: string;
  leaseOwner?: string | null;
  leaseExpiresAt?: Date | null;
  queuedAt?: Date | null;
  startedAt?: Date | null;
  heartbeatAt?: Date | null;
}): Promise<{ id: string }> {
  const run = await prisma.investigationRun.create({
    data: {
      investigationId: input.investigationId,
      leaseOwner: input.leaseOwner ?? null,
      leaseExpiresAt: input.leaseExpiresAt ?? null,
      queuedAt: input.queuedAt ?? null,
      startedAt: input.startedAt ?? null,
      heartbeatAt: input.heartbeatAt ?? null,
    },
    select: { id: true },
  });

  return { id: run.id };
}

async function seedClaimWithSource(
  investigationId: string,
  index: number,
): Promise<void> {
  const claim = await prisma.claim.create({
    data: {
      investigationId,
      text: `Claim ${index.toString()}`,
      context: `Context ${index.toString()}`,
      summary: `Summary ${index.toString()}`,
      reasoning: `Reasoning ${index.toString()}`,
    },
    select: { id: true },
  });

  await prisma.source.create({
    data: {
      claimId: claim.id,
      url: `https://example.com/source-${index.toString()}`,
      title: `Source ${index.toString()}`,
      snippet: `Snippet ${index.toString()}`,
      retrievedAt: new Date("2026-02-19T00:00:00.000Z"),
    },
  });
}

async function seedCorroborationCredits(
  investigationId: string,
  count: number,
): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await prisma.corroborationCredit.create({
      data: {
        investigationId,
        reporterKey: withIntegrationPrefix(
          `reporter-${index.toString()}-${investigationId}`,
        ),
      },
    });
  }
}

async function buildXViewInput(input: {
  externalId: string;
  observedContentText: string;
}) {
  const externalId = withIntegrationPrefix(input.externalId);
  const observedContentText = input.observedContentText;

  return {
    platform: "X" as const,
    externalId,
    url: `https://x.com/truesight/status/${externalId}`,
    observedContentText,
    metadata: {
      authorHandle: withIntegrationPrefix("author"),
      authorDisplayName: "Integration Author",
      text: observedContentText,
      mediaUrls: [],
    },
  };
}

after(async () => {
  await resetDatabase();
  await closeQueueUtils();
  await prisma.$disconnect();
});

void test("GET /health returns ok", async () => {
  const requestEvent = null as unknown as Parameters<typeof healthGet>[0];
  const response = await healthGet(requestEvent);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

void test("post.viewPost stores content and reports not investigated without matching investigation", async () => {
  const caller = createCaller();
  const input = await buildXViewInput({
    externalId: "view-post-1",
    observedContentText: "  This   is a post body for viewPost.  ",
  });
  const expectedObservedHash = await hashContent(
    normalizeContent(input.observedContentText),
  );

  const result = await caller.post.viewPost(input);

  assert.equal(result.investigated, false);
  assert.equal(result.claims, null);

  const post = await prisma.post.findUnique({
    where: {
      platform_externalId: {
        platform: input.platform,
        externalId: input.externalId,
      },
    },
    select: {
      latestContentHash: true,
      latestContentText: true,
      uniqueViewScore: true,
      viewCount: true,
    },
  });

  assert.ok(post);
  assert.equal(post.latestContentHash, expectedObservedHash);
  assert.equal(post.latestContentText, normalizeContent(input.observedContentText));
  assert.equal(post.uniqueViewScore, 1);
  assert.equal(post.viewCount, 1);
});

void test("post.viewPost applies strict hash lookup and does not reuse stale investigations", async () => {
  const caller = createCaller();
  const initialInput = await buildXViewInput({
    externalId: "view-post-strict-hash-1",
    observedContentText: "Original canonical content.",
  });

  await caller.post.viewPost(initialInput);

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

  const updatedInput = await buildXViewInput({
    externalId: "view-post-strict-hash-1",
    observedContentText: "Edited post content with a different hash.",
  });

  const result = await caller.post.viewPost(updatedInput);

  assert.equal(result.investigated, false);
  assert.equal(result.claims, null);
});

void test("post.viewPost deduplicates unique-view credit for repeated views by same viewer", async () => {
  const caller = createCaller({
    viewerKey: "integration-viewer-repeat",
    ipRangeKey: "integration-ip-range-repeat",
  });
  const input = await buildXViewInput({
    externalId: "view-post-credit-dedupe-1",
    observedContentText: "Repeated view content.",
  });

  await caller.post.viewPost(input);
  await caller.post.viewPost(input);

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

void test("post.getInvestigation returns complete investigation with claims", async () => {
  const caller = createCaller();
  const post = await seedPost({
    platform: "X",
    externalId: "get-investigation-1",
    url: "https://x.com/truesight/status/get-investigation-1",
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

  assert.equal(result.investigated, true);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.provenance, "CLIENT_FALLBACK");
  assert.ok(result.claims);
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0]?.sources.length, 1);
  assert.equal(result.checkedAt, "2026-02-19T00:00:00.000Z");
});

void test("post.investigateNow returns existing investigation for authenticated callers", async () => {
  const caller = createCaller({ isAuthenticated: true });
  const input = await buildXViewInput({
    externalId: "investigate-now-1",
    observedContentText: "Canonical content reused by investigateNow.",
  });

  const post = await seedPost({
    platform: input.platform,
    externalId: input.externalId,
    url: input.url,
    contentText: input.observedContentText,
  });
  const investigation = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
  });

  const result = await caller.post.investigateNow(input);

  assert.equal(result.investigationId, investigation.id);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.provenance, "CLIENT_FALLBACK");
});

void test("post.investigateNow allows user OpenAI key callers and returns inline claims for complete investigations", async () => {
  const caller = createCaller({
    isAuthenticated: false,
    userOpenAiApiKey: "sk-test-user-key",
  });
  const input = await buildXViewInput({
    externalId: "investigate-now-openai-header-1",
    observedContentText: "Canonical content for user-key investigateNow.",
  });

  const post = await seedPost({
    platform: input.platform,
    externalId: input.externalId,
    url: input.url,
    contentText: input.observedContentText,
  });
  const investigation = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
  });
  await seedClaimWithSource(investigation.id, 1);

  const result = await caller.post.investigateNow(input);

  assert.equal(result.investigationId, investigation.id);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.provenance, "CLIENT_FALLBACK");
  assert.ok(result.claims);
  assert.equal(result.claims.length, 1);
});

void test("post.investigateNow requeues existing failed investigations as PENDING", async () => {
  const caller = createCaller({ isAuthenticated: true });
  const input = await buildXViewInput({
    externalId: "investigate-now-requeue-failed-1",
    observedContentText: "Canonical content should be retried after FAILED state.",
  });

  const post = await seedPost({
    platform: input.platform,
    externalId: input.externalId,
    url: input.url,
    contentText: input.observedContentText,
  });
  const failedInvestigation = await seedFailedInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
  });

  const result = await caller.post.investigateNow(input);

  assert.equal(result.investigationId, failedInvestigation.id);
  assert.equal(result.status, "PENDING");
  assert.equal(result.provenance, "CLIENT_FALLBACK");

  const stored = await prisma.investigation.findUnique({
    where: { id: failedInvestigation.id },
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
  const input = await buildXViewInput({
    externalId: "investigate-now-user-key-first-wins-1",
    observedContentText: "Pending investigation should keep the first user key source.",
  });

  const post = await seedPost({
    platform: input.platform,
    externalId: input.externalId,
    url: input.url,
    contentText: input.observedContentText,
  });
  const pendingInvestigation = await seedPendingInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
  });

  const firstResult = await firstCaller.post.investigateNow(input);
  assert.equal(firstResult.investigationId, pendingInvestigation.id);
  assert.equal(firstResult.status, "PENDING");

  const run = await prisma.investigationRun.findUnique({
    where: { investigationId: pendingInvestigation.id },
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
  assert.equal(secondResult.investigationId, pendingInvestigation.id);
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
  const input = await buildXViewInput({
    externalId: "investigate-now-recovers-stale-processing-1",
    observedContentText: "Stale processing investigations should be recoverable.",
  });

  const post = await seedPost({
    platform: input.platform,
    externalId: input.externalId,
    url: input.url,
    contentText: input.observedContentText,
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

  const result = await caller.post.investigateNow(input);

  assert.equal(result.investigationId, processingInvestigation.id);
  assert.equal(result.status, "PENDING");

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

void test("post.investigateNow leaves active PROCESSING investigations unchanged", async () => {
  const caller = createCaller({ isAuthenticated: true });
  const input = await buildXViewInput({
    externalId: "investigate-now-keeps-active-processing-1",
    observedContentText: "Active processing investigations should remain processing.",
  });

  const post = await seedPost({
    platform: input.platform,
    externalId: input.externalId,
    url: input.url,
    contentText: input.observedContentText,
  });
  const processingInvestigation = await seedProcessingInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
  });
  const leaseExpiresAt = new Date(Date.now() + 10 * 60_000);
  await seedInvestigationRun({
    investigationId: processingInvestigation.id,
    leaseOwner: "worker-active",
    leaseExpiresAt,
    startedAt: new Date(Date.now() - 60_000),
    heartbeatAt: new Date(),
  });

  const result = await caller.post.investigateNow(input);

  assert.equal(result.investigationId, processingInvestigation.id);
  assert.equal(result.status, "PROCESSING");

  const storedInvestigation = await prisma.investigation.findUnique({
    where: { id: processingInvestigation.id },
    select: { status: true },
  });
  assert.ok(storedInvestigation);
  assert.equal(storedInvestigation.status, "PROCESSING");

  const storedRun = await prisma.investigationRun.findUnique({
    where: { investigationId: processingInvestigation.id },
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
    url: "https://x.com/truesight/status/selector-recovers-stale-processing-1",
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
  const input = await buildXViewInput({
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
  const input = await buildXViewInput({
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
    where: { postId: post.id },
  });
  assert.equal(investigationCount, 0);
});

void test("post.batchStatus returns investigated flag and incorrect claim counts", async () => {
  const caller = createCaller();

  const investigatedPost = await seedPost({
    platform: "X",
    externalId: "batch-investigated-1",
    url: "https://x.com/truesight/status/batch-investigated-1",
    contentText: "Investigated post content for batchStatus.",
  });
  const pendingPost = await seedPost({
    platform: "X",
    externalId: "batch-not-investigated-1",
    url: "https://x.com/truesight/status/batch-not-investigated-1",
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
      },
      {
        platform: pendingPost.platform,
        externalId: pendingPost.externalId,
      },
    ],
  });

  assert.equal(result.statuses.length, 2);
  const byExternalId = new Map(
    result.statuses.map((status) => [status.externalId, status]),
  );

  const investigated = byExternalId.get(investigatedPost.externalId);
  assert.ok(investigated);
  assert.equal(investigated.investigated, true);
  assert.equal(investigated.incorrectClaimCount, 2);

  const notInvestigated = byExternalId.get(pendingPost.externalId);
  assert.ok(notInvestigated);
  assert.equal(notInvestigated.investigated, false);
  assert.equal(notInvestigated.incorrectClaimCount, 0);
});

void test("public.getInvestigation returns eligible complete investigation", async () => {
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
  assert.equal(result.investigation.status, "COMPLETE");
  assert.equal(result.post.platform, post.platform);
  assert.equal(result.post.externalId, post.externalId);
  assert.equal(result.claims.length, 1);
});

void test("public.getInvestigation hides ineligible CLIENT_FALLBACK investigations", async () => {
  const caller = createCaller();
  const post = await seedPost({
    platform: "LESSWRONG",
    externalId: "public-investigation-ineligible-1",
    url: "https://www.lesswrong.com/posts/public-investigation-ineligible-1",
    contentText: "Ineligible client-fallback content.",
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

  assert.equal(result, null);
});

void test("public.getInvestigation exposes CLIENT_FALLBACK investigation after 3 corroborations", async () => {
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
  assert.equal(result.investigation.provenance, "CLIENT_FALLBACK");
  assert.equal(result.claims.length, 1);
});

void test("public.getPostInvestigations lists only eligible complete investigations for a post", async () => {
  const caller = createCaller();
  const post = await seedPost({
    platform: "LESSWRONG",
    externalId: "public-post-investigations-eligible-only-1",
    url: "https://www.lesswrong.com/posts/public-post-investigations-eligible-only-1",
    contentText: "Post-level investigations content text.",
  });

  const ineligible = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "CLIENT_FALLBACK",
  });

  const eligibleText = normalizeContent("Eligible content revision for same post.");
  const eligibleHash = await hashContent(eligibleText);
  const eligible = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: eligibleHash,
    contentText: eligibleText,
    provenance: "SERVER_VERIFIED",
  });
  await seedClaimWithSource(eligible.id, 1);

  const result = await caller.public.getPostInvestigations({
    platform: post.platform,
    externalId: post.externalId,
  });

  assert.ok(result.post);
  assert.equal(result.post.platform, post.platform);
  assert.equal(result.post.externalId, post.externalId);
  assert.equal(result.investigations.length, 1);
  assert.equal(result.investigations[0]?.id, eligible.id);
  assert.equal(result.investigations[0]?.claimCount, 1);
  assert.notEqual(result.investigations[0]?.id, ineligible.id);
});

void test("public.searchInvestigations filters by eligibility, query, and platform", async () => {
  const caller = createCaller();

  const moonPost = await seedPost({
    platform: "LESSWRONG",
    externalId: "public-search-moon-1",
    url: "https://www.lesswrong.com/posts/public-search-moon-1",
    contentText: "The moon landing evidence is publicly documented.",
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
    url: "https://x.com/truesight/status/public-search-x-1",
    contentText: "Traffic data trends are stable this week.",
  });
  const xInvestigation = await seedCompleteInvestigation({
    postId: xPost.id,
    contentHash: xPost.contentHash,
    contentText: xPost.contentText,
    provenance: "SERVER_VERIFIED",
  });

  const ineligiblePost = await seedPost({
    platform: "LESSWRONG",
    externalId: "public-search-ineligible-1",
    url: "https://www.lesswrong.com/posts/public-search-ineligible-1",
    contentText: "Moon myths should not leak into search results.",
  });
  await seedCompleteInvestigation({
    postId: ineligiblePost.id,
    contentHash: ineligiblePost.contentHash,
    contentText: ineligiblePost.contentText,
    provenance: "CLIENT_FALLBACK",
  });

  const queryResult = await caller.public.searchInvestigations({
    query: "moon",
    limit: 20,
    offset: 0,
  });

  assert.equal(queryResult.investigations.length, 1);
  assert.equal(queryResult.investigations[0]?.id, moonInvestigation.id);
  assert.equal(queryResult.investigations[0]?.platform, "LESSWRONG");
  assert.equal(queryResult.investigations[0]?.claimCount, 1);

  const platformResult = await caller.public.searchInvestigations({
    platform: "X",
    limit: 20,
    offset: 0,
  });

  const platformIds = new Set(platformResult.investigations.map((item) => item.id));
  assert.equal(platformIds.has(xInvestigation.id), true);
  assert.equal(platformIds.has(moonInvestigation.id), false);
});

void test("public.getMetrics counts only eligible complete investigations and honors filters", async () => {
  const caller = createCaller();
  const metricsWindowStart = "2026-02-23T00:00:00.000Z";
  const metricsWindowEnd = "2026-02-23T23:59:59.999Z";

  const xPost = await seedPost({
    platform: "X",
    externalId: "public-metrics-x-1",
    url: "https://x.com/truesight/status/public-metrics-x-1",
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

  const ineligiblePost = await seedPost({
    platform: "X",
    externalId: "public-metrics-ineligible-1",
    url: "https://x.com/truesight/status/public-metrics-ineligible-1",
    contentText: "Should not count in public metrics.",
  });
  await seedCompleteInvestigation({
    postId: ineligiblePost.id,
    contentHash: ineligiblePost.contentHash,
    contentText: ineligiblePost.contentText,
    provenance: "CLIENT_FALLBACK",
    checkedAt: new Date("2026-02-23T14:00:00.000Z"),
  });

  const allMetrics = await caller.public.getMetrics({
    windowStart: metricsWindowStart,
    windowEnd: metricsWindowEnd,
  });
  assert.equal(allMetrics.totalInvestigatedPosts, 2);
  assert.equal(allMetrics.investigatedPostsWithFlags, 1);
  assert.equal(allMetrics.factCheckIncidence, 0.5);

  const xMetrics = await caller.public.getMetrics({
    platform: "X",
    windowStart: metricsWindowStart,
    windowEnd: metricsWindowEnd,
  });
  assert.equal(xMetrics.totalInvestigatedPosts, 1);
  assert.equal(xMetrics.investigatedPostsWithFlags, 1);
  assert.equal(xMetrics.factCheckIncidence, 1);

  const emptyWindowMetrics = await caller.public.getMetrics({
    windowStart: "2026-02-24T00:00:00.000Z",
    windowEnd: "2026-02-24T23:59:59.999Z",
  });
  assert.equal(emptyWindowMetrics.totalInvestigatedPosts, 0);
  assert.equal(emptyWindowMetrics.investigatedPostsWithFlags, 0);
  assert.equal(emptyWindowMetrics.factCheckIncidence, 0);
});
