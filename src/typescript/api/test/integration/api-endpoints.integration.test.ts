import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { RequestEvent } from "@sveltejs/kit";
import {
  hashContent,
  normalizeContent,
  WORD_COUNT_LIMIT,
  type Platform,
} from "@openerrata/shared";

process.env['NODE_ENV'] ??= "test";
process.env['DATABASE_URL'] ??=
  "postgresql://openerrata:openerrata_dev@localhost:5433/openerrata";
process.env['HMAC_SECRET'] ??= "test-hmac-secret";
process.env['BLOB_STORAGE_BUCKET'] ??= "test-openerrata-images";
process.env['BLOB_STORAGE_ACCESS_KEY_ID'] ??= "test-blob-access-key";
process.env['BLOB_STORAGE_SECRET_ACCESS_KEY'] ??= "test-blob-secret";
process.env['BLOB_STORAGE_PUBLIC_URL_PREFIX'] ??= "https://example.test/images";
process.env['DATABASE_ENCRYPTION_KEY'] ??= "integration-test-database-encryption-key";

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
  { getPrisma },
  { createContext },
  { hashInstanceApiKey },
  { GET: healthGet },
  { POST: graphqlPost },
  { closeQueueUtils },
  { runSelector },
] =
  await Promise.all([
    import("../../src/lib/trpc/router.js"),
    import("../../src/lib/db/client.js"),
    import("../../src/lib/trpc/context.js"),
    import("../../src/lib/services/instance-api-key.js"),
    import("../../src/routes/health/+server.js"),
    import("../../src/routes/graphql/+server.js"),
    import("../../src/lib/services/queue.js"),
    import("../../src/lib/services/selector.js"),
  ]);

const prisma = getPrisma();

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

type AppCaller = ReturnType<typeof createCaller>;
type InvestigateNowResult = Awaited<
  ReturnType<AppCaller["post"]["investigateNow"]>
>;
type XViewInput = Awaited<ReturnType<typeof buildXViewInput>>;

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

type GraphqlError = {
  message: string;
};

type GraphqlEnvelope<TData> = {
  data?: TData;
  errors?: GraphqlError[];
};

type GraphqlRequestEvent = Parameters<typeof graphqlPost>[0];

async function queryPublicGraphql<TData>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<TData> {
  const requestBody = JSON.stringify(
    variables === undefined ? { query } : { query, variables },
  );
  const response = await graphqlPost({
    request: new Request("http://localhost/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: requestBody,
    }),
  } as unknown as GraphqlRequestEvent);

  assert.equal(response.status, 200);
  const payload = (await response.json()) as GraphqlEnvelope<TData>;
  if (payload.errors && payload.errors.length > 0) {
    assert.fail(
      `GraphQL errors: ${payload.errors.map((error) => error.message).join("; ")}`,
    );
  }
  assert.ok(payload.data);
  return payload.data;
}

function createMockRequestEvent(headers?: HeadersInit): RequestEvent {
  return {
    request: new Request("http://localhost/trpc/post.validateSettings", {
      method: "POST",
      ...(headers !== undefined && { headers }),
    }),
    getClientAddress: () => "203.0.113.1",
  } as unknown as RequestEvent;
}

async function seedInstanceApiKey(input: {
  name: string;
  rawKey: string;
  revokedAt?: Date;
}): Promise<void> {
  await prisma.instanceApiKey.create({
    data: {
      name: withIntegrationPrefix(input.name),
      keyHash: hashInstanceApiKey(input.rawKey),
      revokedAt: input.revokedAt ?? null,
    },
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

    await tx.instanceApiKey.deleteMany({
      where: {
        name: { startsWith: INTEGRATION_DATA_PREFIX },
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
  const checkedAt = input.checkedAt ?? new Date("2026-02-19T00:00:00.000Z");
  const investigation = await seedInvestigation({
    postId: input.postId,
    contentHash: input.contentHash,
    contentText: input.contentText,
    provenance: input.provenance,
    status: "COMPLETE",
    promptLabel: `investigation-${input.postId}`,
    checkedAt,
  });
  return { id: investigation.id, checkedAt };
}

async function seedFailedInvestigation(input: {
  postId: string;
  contentHash: string;
  contentText: string;
  provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
}): Promise<{ id: string }> {
  return seedInvestigation({
    postId: input.postId,
    contentHash: input.contentHash,
    contentText: input.contentText,
    provenance: input.provenance,
    status: "FAILED",
    promptLabel: `failed-investigation-${input.postId}`,
  });
}

async function seedPendingInvestigation(input: {
  postId: string;
  contentHash: string;
  contentText: string;
  provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
}): Promise<{ id: string }> {
  return seedInvestigation({
    postId: input.postId,
    contentHash: input.contentHash,
    contentText: input.contentText,
    provenance: input.provenance,
    status: "PENDING",
    promptLabel: `pending-investigation-${input.postId}`,
  });
}

async function seedProcessingInvestigation(input: {
  postId: string;
  contentHash: string;
  contentText: string;
  provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
}): Promise<{ id: string }> {
  return seedInvestigation({
    postId: input.postId,
    contentHash: input.contentHash,
    contentText: input.contentText,
    provenance: input.provenance,
    status: "PROCESSING",
    promptLabel: `processing-investigation-${input.postId}`,
  });
}

async function seedInvestigation(input: {
  postId: string;
  contentHash: string;
  contentText: string;
  provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
  status: "COMPLETE" | "FAILED" | "PENDING" | "PROCESSING";
  promptLabel: string;
  checkedAt?: Date;
}): Promise<{ id: string }> {
  const prompt = await seedPrompt(input.promptLabel);
  const checkedAt = input.status === "COMPLETE" ? (input.checkedAt ?? new Date()) : null;
  const serverVerifiedAt =
    input.provenance === "SERVER_VERIFIED"
      ? (checkedAt ?? new Date())
      : null;

  const investigation = await prisma.investigation.create({
    data: {
      postId: input.postId,
      contentHash: input.contentHash,
      contentText: input.contentText,
      contentProvenance: input.provenance,
      fetchFailureReason:
        input.provenance === "CLIENT_FALLBACK" ? "fetch unavailable" : null,
      serverVerifiedAt,
      status: input.status,
      promptId: prompt.id,
      provider: "OPENAI",
      model: "OPENAI_GPT_5",
      checkedAt,
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

function buildXViewInput(input: {
  externalId: string;
  observedContentText: string;
}) {
  const externalId = withIntegrationPrefix(input.externalId);
  const observedContentText = input.observedContentText;

  return {
    platform: "X" as const,
    externalId,
    url: `https://x.com/openerrata/status/${externalId}`,
    observedContentText,
    metadata: {
      authorHandle: withIntegrationPrefix("author"),
      authorDisplayName: "Integration Author",
      text: observedContentText,
      mediaUrls: [],
    },
  };
}

async function seedPostForXViewInput(input: XViewInput): Promise<SeededPost> {
  return seedPost({
    platform: input.platform,
    externalId: input.externalId,
    url: input.url,
    contentText: input.observedContentText,
  });
}

async function seedInvestigationForXViewInput(input: {
  viewInput: XViewInput;
  status: "COMPLETE" | "FAILED" | "PENDING" | "PROCESSING";
  provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
  checkedAt?: Date;
  claimCount?: number;
}): Promise<{ post: SeededPost; investigationId: string; checkedAt?: Date }> {
  const post = await seedPostForXViewInput(input.viewInput);

  if (input.status === "COMPLETE") {
    const investigation = await seedCompleteInvestigation({
      postId: post.id,
      contentHash: post.contentHash,
      contentText: post.contentText,
      provenance: input.provenance,
      ...(input.checkedAt !== undefined && { checkedAt: input.checkedAt }),
    });
    const claimCount = input.claimCount ?? 0;
    for (let index = 1; index <= claimCount; index += 1) {
      await seedClaimWithSource(investigation.id, index);
    }
    return { post, investigationId: investigation.id, checkedAt: investigation.checkedAt };
  }

  const investigation =
    input.status === "FAILED"
      ? await seedFailedInvestigation({
          postId: post.id,
          contentHash: post.contentHash,
          contentText: post.contentText,
          provenance: input.provenance,
        })
      : input.status === "PENDING"
        ? await seedPendingInvestigation({
            postId: post.id,
            contentHash: post.contentHash,
            contentText: post.contentText,
            provenance: input.provenance,
          })
        : await seedProcessingInvestigation({
            postId: post.id,
            contentHash: post.contentHash,
            contentText: post.contentText,
            provenance: input.provenance,
          });

  return { post, investigationId: investigation.id };
}

async function runConcurrentInvestigateNowScenario(input: {
  viewInput: XViewInput;
  callers: AppCaller[];
}): Promise<{
  results: InvestigateNowResult[];
  investigationId: string;
}> {
  const results = await Promise.all(
    input.callers.map((caller) => caller.post.investigateNow(input.viewInput)),
  );
  const investigationIds = new Set(results.map((result) => result.investigationId));
  assert.equal(investigationIds.size, 1);
  assert.equal(results.every((result) => result.status === "PENDING"), true);
  const firstResult = results[0];
  assert.ok(firstResult);

  return {
    results,
    investigationId: firstResult.investigationId,
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
  const input = buildXViewInput({
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
  const initialInput = buildXViewInput({
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

  const updatedInput = buildXViewInput({
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
  const input = buildXViewInput({
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
    where: { postId: post.id },
    select: {
      id: true,
      status: true,
      contentHash: true,
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
  assert.ok(result.claims);
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
    where: { postId: post.id },
  });
  assert.equal(investigationCount, 0);
});

void test("post.batchStatus returns investigated flag and incorrect claim counts", async () => {
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
  assert.equal(result.investigation.status, "COMPLETE");
  assert.equal(result.investigation.provenance, "SERVER_VERIFIED");
  assert.equal(result.investigation.corroborationCount, 0);
  assert.equal(typeof result.investigation.serverVerifiedAt, "string");
  assert.equal(result.post.platform, post.platform);
  assert.equal(result.post.externalId, post.externalId);
  assert.equal(result.claims.length, 1);

  const graphqlResult = await queryPublicGraphql<{
    publicInvestigation: {
      investigation: {
        id: string;
        provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
        corroborationCount: number;
        serverVerifiedAt: string | null;
        fetchFailureReason: string | null;
      };
      post: {
        platform: Platform;
        externalId: string;
      };
      claims: Array<{ id: string }>;
    } | null;
  }>(
    `
      query PublicInvestigation($investigationId: ID!) {
        publicInvestigation(investigationId: $investigationId) {
          investigation {
            id
            provenance
            corroborationCount
            serverVerifiedAt
            fetchFailureReason
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
  assert.equal(graphqlInvestigation.provenance, "SERVER_VERIFIED");
  assert.equal(graphqlInvestigation.corroborationCount, 0);
  assert.notEqual(graphqlInvestigation.serverVerifiedAt, null);
  assert.equal(graphqlInvestigation.fetchFailureReason, null);
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
  assert.equal(result.investigation.provenance, "CLIENT_FALLBACK");
  assert.equal(result.investigation.corroborationCount, 0);
  assert.equal(result.investigation.serverVerifiedAt, undefined);
  assert.equal(result.investigation.fetchFailureReason, "fetch unavailable");

  const graphqlResult = await queryPublicGraphql<{
    publicInvestigation: {
      investigation: {
        provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
        corroborationCount: number;
        serverVerifiedAt: string | null;
        fetchFailureReason: string | null;
      };
    } | null;
  }>(
    `
      query PublicInvestigation($investigationId: ID!) {
        publicInvestigation(investigationId: $investigationId) {
          investigation {
            provenance
            corroborationCount
            serverVerifiedAt
            fetchFailureReason
          }
        }
      }
    `,
    { investigationId: investigation.id },
  );

  assert.ok(graphqlResult.publicInvestigation);
  assert.equal(
    graphqlResult.publicInvestigation.investigation.provenance,
    "CLIENT_FALLBACK",
  );
  assert.equal(graphqlResult.publicInvestigation.investigation.corroborationCount, 0);
  assert.equal(graphqlResult.publicInvestigation.investigation.serverVerifiedAt, null);
  assert.equal(
    graphqlResult.publicInvestigation.investigation.fetchFailureReason,
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
  assert.equal(result.investigation.provenance, "CLIENT_FALLBACK");
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

  const serverVerifiedText = normalizeContent(
    "Server-verified content revision for same post.",
  );
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

  const byId = new Map(result.investigations.map((item) => [item.id, item]));
  const fallback = byId.get(fallbackInvestigation.id);
  assert.ok(fallback);
  assert.equal(fallback.provenance, "CLIENT_FALLBACK");
  assert.equal(fallback.corroborationCount, 2);

  const serverVerified = byId.get(serverVerifiedInvestigation.id);
  assert.ok(serverVerified);
  assert.equal(serverVerified.provenance, "SERVER_VERIFIED");
  assert.equal(serverVerified.claimCount, 1);

  const graphqlResult = await queryPublicGraphql<{
    postInvestigations: {
      investigations: Array<{
        id: string;
        provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
        corroborationCount: number;
      }>;
    };
  }>(
    `
      query PostInvestigations($platform: Platform!, $externalId: String!) {
        postInvestigations(platform: $platform, externalId: $externalId) {
          investigations {
            id
            provenance
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

  const queryIds = new Set(queryResult.investigations.map((item) => item.id));
  assert.equal(queryIds.has(moonInvestigation.id), true);
  assert.equal(queryIds.has(fallbackMoonInvestigation.id), true);
  assert.equal(queryResult.investigations.every((item) => item.platform === "LESSWRONG"), true);

  const platformResult = await caller.public.searchInvestigations({
    platform: "X",
    limit: 20,
    offset: 0,
  });

  const platformIds = new Set(platformResult.investigations.map((item) => item.id));
  assert.equal(platformIds.has(xInvestigation.id), true);
  assert.equal(platformIds.has(moonInvestigation.id), false);

  const graphqlResult = await queryPublicGraphql<{
    searchInvestigations: {
      investigations: Array<{ id: string; provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK" }>;
    };
  }>(
    `
      query SearchInvestigations($query: String!, $limit: Int!, $offset: Int!) {
        searchInvestigations(query: $query, limit: $limit, offset: $offset) {
          investigations {
            id
            provenance
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
