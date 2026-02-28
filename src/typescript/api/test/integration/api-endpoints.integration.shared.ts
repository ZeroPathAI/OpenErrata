/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, afterEach, test } from "node:test";
import type { RequestEvent } from "@sveltejs/kit";
import {
  hashContent,
  isNonNullObject,
  normalizeContent,
  WORD_COUNT_LIMIT,
  type Platform,
} from "@openerrata/shared";
import { MINIMUM_SUPPORTED_EXTENSION_VERSION } from "../../src/lib/config/env.js";
import {
  createDeterministicRandom,
  randomChance,
  randomInt,
  sleep,
} from "../helpers/fuzz-utils.js";
import { INTEGRATION_LESSWRONG_FIXTURE_KEYS, readLesswrongFixture } from "./lesswrong-fixtures.js";

process.env["NODE_ENV"] = "test";
process.env["DATABASE_URL"] ??= "postgresql://openerrata:openerrata_dev@localhost:5433/openerrata";
process.env["HMAC_SECRET"] = "test-hmac-secret";
process.env["BLOB_STORAGE_PROVIDER"] = "aws";
process.env["BLOB_STORAGE_REGION"] = "us-east-1";
process.env["BLOB_STORAGE_ENDPOINT"] = "";
process.env["BLOB_STORAGE_BUCKET"] = "test-openerrata-images";
process.env["BLOB_STORAGE_ACCESS_KEY_ID"] = "test-blob-access-key";
process.env["BLOB_STORAGE_SECRET_ACCESS_KEY"] = "test-blob-secret";
process.env["BLOB_STORAGE_PUBLIC_URL_PREFIX"] = "https://example.test/images";
process.env["DATABASE_ENCRYPTION_KEY"] = "integration-test-database-encryption-key";
process.env["OPENAI_API_KEY"] = "sk-test-openai-key";

const INTEGRATION_TEST_RUN_ID = [
  Date.now().toString(36),
  process.pid.toString(36),
  Math.random().toString(36).slice(2, 8),
].join("-");
const INTEGRATION_DATA_PREFIX = `integration-test-${INTEGRATION_TEST_RUN_ID}-`;

function withIntegrationPrefix(value: string): string {
  return value.startsWith(INTEGRATION_DATA_PREFIX) ? value : `${INTEGRATION_DATA_PREFIX}${value}`;
}

const [
  { appRouter },
  { getPrisma },
  { createContext },
  { hashInstanceApiKey },
  { GET: healthGet },
  { POST: graphqlPost },
  { closeQueueUtils },
  { ensureInvestigationQueued },
  { runSelector },
  { lesswrongHtmlToNormalizedText },
  { orchestrateInvestigation },
  { OpenAIInvestigator, InvestigatorExecutionError },
] = await Promise.all([
  import("../../src/lib/trpc/router.js"),
  import("../../src/lib/db/client.js"),
  import("../../src/lib/trpc/context.js"),
  import("../../src/lib/services/instance-api-key.js"),
  import("../../src/routes/health/+server.js"),
  import("../../src/routes/graphql/+server.js"),
  import("../../src/lib/services/queue.js"),
  import("../../src/lib/services/investigation-lifecycle.js"),
  import("../../src/lib/services/selector.js"),
  import("../../src/lib/services/content-fetcher.js"),
  import("../../src/lib/services/orchestrator.js"),
  import("../../src/lib/investigators/openai.js"),
]);

const prisma = getPrisma();

interface CallerOptions {
  isAuthenticated?: boolean;
  userOpenAiApiKey?: string | null;
  viewerKey?: string;
  ipRangeKey?: string;
  extensionVersion?: string | null;
}

interface SeededPost {
  id: string;
  platform: Platform;
  externalId: string;
  url: string;
  contentText: string;
  contentHash: string;
  versionHash: string;
  postVersionId: string;
}

type RawAppCaller = ReturnType<typeof appRouter.createCaller>;
type ViewPostInput = Parameters<RawAppCaller["post"]["registerObservedVersion"]>[0];
type VersionedPostInput = Parameters<RawAppCaller["post"]["recordViewAndGetStatus"]>[0];
type WrappedPostRouter = Omit<RawAppCaller["post"], "recordViewAndGetStatus" | "investigateNow"> & {
  recordViewAndGetStatus: (
    input: ViewPostInput | VersionedPostInput,
  ) => ReturnType<RawAppCaller["post"]["recordViewAndGetStatus"]>;
  investigateNow: (
    input: ViewPostInput | VersionedPostInput,
  ) => ReturnType<RawAppCaller["post"]["investigateNow"]>;
};
type AppCaller = Omit<RawAppCaller, "post"> & {
  post: WrappedPostRouter;
};
type InvestigateNowResult = Awaited<ReturnType<AppCaller["post"]["investigateNow"]>>;
type XViewInput = Awaited<ReturnType<typeof buildXViewInput>>;

let promptCounter = 0;

function isVersionedPostInput(
  input: ViewPostInput | VersionedPostInput,
): input is VersionedPostInput {
  return "postVersionId" in input;
}

async function toVersionedPostInput(
  postRouter: RawAppCaller["post"],
  input: ViewPostInput | VersionedPostInput,
): Promise<VersionedPostInput> {
  if (isVersionedPostInput(input)) {
    return input;
  }
  const registered = await postRouter.registerObservedVersion(input);
  return {
    postVersionId: registered.postVersionId,
  };
}

function createCaller(options: CallerOptions = {}): AppCaller {
  const isAuthenticated = options.isAuthenticated ?? false;
  const userOpenAiApiKey = options.userOpenAiApiKey ?? null;

  const caller = appRouter.createCaller({
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- tRPC caller test harness bypasses SvelteKit event
    event: null as unknown as RequestEvent,
    prisma,
    viewerKey: options.viewerKey ?? "integration-viewer",
    ipRangeKey: options.ipRangeKey ?? "integration-ip-range",
    isAuthenticated,
    canInvestigate: isAuthenticated || userOpenAiApiKey !== null,
    userOpenAiApiKey,
    hasValidAttestation: false,
    extensionVersion: options.extensionVersion ?? MINIMUM_SUPPORTED_EXTENSION_VERSION,
    minimumSupportedExtensionVersion: MINIMUM_SUPPORTED_EXTENSION_VERSION,
  });

  return {
    public: caller.public,
    post: {
      registerObservedVersion: caller.post.registerObservedVersion,
      getInvestigation: caller.post.getInvestigation,
      validateSettings: caller.post.validateSettings,
      batchStatus: caller.post.batchStatus,
      recordViewAndGetStatus: async (input: ViewPostInput | VersionedPostInput) => {
        const versioned = await toVersionedPostInput(caller.post, input);
        return caller.post.recordViewAndGetStatus(versioned);
      },
      investigateNow: async (input: ViewPostInput | VersionedPostInput) => {
        const versioned = await toVersionedPostInput(caller.post, input);
        return caller.post.investigateNow(versioned);
      },
    },
  };
}

function errorHasOpenErrataCode(error: unknown, expectedCode: string): boolean {
  if (!(error instanceof Error) || !isNonNullObject(error.cause)) {
    return false;
  }
  return error.cause["openerrataCode"] === expectedCode;
}

interface GraphqlError {
  message: string;
}

interface GraphqlEnvelope<TData> {
  data?: TData;
  errors?: GraphqlError[];
}

type GraphqlRequestEvent = Parameters<typeof graphqlPost>[0];

async function queryPublicGraphql<TData>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<TData> {
  const requestBody = JSON.stringify(variables === undefined ? { query } : { query, variables });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal SvelteKit request event stub for GraphQL route
  const response = await graphqlPost({
    request: new Request("http://localhost/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: requestBody,
    }),
  } as unknown as GraphqlRequestEvent);

  assert.equal(response instanceof Response, true);
  assert.equal(response.status, 200);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- integration test deserializing GraphQL JSON response
  const payload = (await response.json()) as GraphqlEnvelope<TData>;
  if (payload.errors !== undefined && payload.errors.length > 0) {
    assert.fail(`GraphQL errors: ${payload.errors.map((error) => error.message).join("; ")}`);
  }
  const data = payload.data;
  if (data === undefined) {
    assert.fail("GraphQL response missing data");
  }
  return data;
}

function createMockRequestEvent(headers?: HeadersInit): RequestEvent {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal SvelteKit request event stub for tRPC route
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
            postVersion: {
              postId: { in: integrationPostIds },
            },
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

async function assertIntegrationDatabaseInvariants(): Promise<void> {
  const integrationExternalIdPrefix = `${INTEGRATION_DATA_PREFIX}%`;

  const claimsOnNonCompleteInvestigations = await prisma.$queryRaw<
    { investigationId: string; status: string }[]
  >`
    SELECT DISTINCT i."id" AS "investigationId", i."status"::text AS "status"
    FROM "Investigation" i
    JOIN "PostVersion" pv ON pv."id" = i."postVersionId"
    JOIN "Post" p ON p."id" = pv."postId"
    JOIN "Claim" c ON c."investigationId" = i."id"
    WHERE p."externalId" LIKE ${integrationExternalIdPrefix}
      AND i."status" <> 'COMPLETE'
    LIMIT 10
  `;
  assert.equal(
    claimsOnNonCompleteInvestigations.length,
    0,
    `invariant failed: only COMPLETE investigations may have claims: ${JSON.stringify(claimsOnNonCompleteInvestigations)}`,
  );

  const processingInvestigationsWithoutRun = await prisma.$queryRaw<{ investigationId: string }[]>`
    SELECT i."id" AS "investigationId"
    FROM "Investigation" i
    JOIN "PostVersion" pv ON pv."id" = i."postVersionId"
    JOIN "Post" p ON p."id" = pv."postId"
    LEFT JOIN "InvestigationRun" r ON r."investigationId" = i."id"
    WHERE p."externalId" LIKE ${integrationExternalIdPrefix}
      AND i."status" = 'PROCESSING'
      AND r."id" IS NULL
    LIMIT 10
  `;
  assert.equal(
    processingInvestigationsWithoutRun.length,
    0,
    `invariant failed: PROCESSING investigations must have runs: ${JSON.stringify(processingInvestigationsWithoutRun)}`,
  );

  const orphanSources = await prisma.$queryRaw<{ sourceId: string; claimId: string }[]>`
    SELECT s."id" AS "sourceId", s."claimId"
    FROM "Source" s
    LEFT JOIN "Claim" c ON c."id" = s."claimId"
    WHERE c."id" IS NULL
    LIMIT 10
  `;
  assert.equal(
    orphanSources.length,
    0,
    `invariant failed: Source rows must reference existing Claim rows: ${JSON.stringify(orphanSources)}`,
  );
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

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const EMPTY_IMAGE_OCCURRENCES_HASH = sha256(JSON.stringify([]));

function versionHashFromContentHash(contentHash: string): string {
  return sha256(`${contentHash}\n${EMPTY_IMAGE_OCCURRENCES_HASH}`);
}

async function ensurePostVersionForSeed(input: {
  postId: string;
  contentHash: string;
  contentText: string;
  provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
  fetchFailureReason?: string;
}): Promise<{ id: string; versionHash: string }> {
  const wordCount = input.contentText.split(/\s+/).filter(Boolean).length;
  const versionHash = versionHashFromContentHash(input.contentHash);

  const [contentBlob, imageOccurrenceSet] = await Promise.all([
    prisma.contentBlob.upsert({
      where: { contentHash: input.contentHash },
      create: {
        contentHash: input.contentHash,
        contentText: input.contentText,
        wordCount,
      },
      update: {
        contentText: input.contentText,
        wordCount,
      },
      select: { id: true },
    }),
    prisma.imageOccurrenceSet.upsert({
      where: { occurrencesHash: EMPTY_IMAGE_OCCURRENCES_HASH },
      create: { occurrencesHash: EMPTY_IMAGE_OCCURRENCES_HASH },
      update: {},
      select: { id: true },
    }),
  ]);

  const now = new Date();
  const fetchFailureReason =
    input.provenance === "CLIENT_FALLBACK"
      ? (input.fetchFailureReason ?? "fetch unavailable")
      : null;
  const serverVerifiedAt = input.provenance === "SERVER_VERIFIED" ? now : null;
  const existing = await prisma.postVersion.findUnique({
    where: {
      postId_versionHash: {
        postId: input.postId,
        versionHash,
      },
    },
    select: {
      id: true,
      contentProvenance: true,
    },
  });
  if (existing === null) {
    return prisma.postVersion.create({
      data: {
        postId: input.postId,
        versionHash,
        contentBlobId: contentBlob.id,
        imageOccurrenceSetId: imageOccurrenceSet.id,
        contentProvenance: input.provenance,
        fetchFailureReason,
        serverVerifiedAt,
        firstSeenAt: now,
        lastSeenAt: now,
        seenCount: 1,
      },
      select: {
        id: true,
        versionHash: true,
      },
    });
  }

  return prisma.postVersion.update({
    where: { id: existing.id },
    data: {
      contentBlobId: contentBlob.id,
      imageOccurrenceSetId: imageOccurrenceSet.id,
      lastSeenAt: now,
      seenCount: {
        increment: 1,
      },
      ...(input.provenance === "SERVER_VERIFIED" && existing.contentProvenance === "CLIENT_FALLBACK"
        ? {
            contentProvenance: "SERVER_VERIFIED",
            fetchFailureReason: null,
            serverVerifiedAt: now,
          }
        : {}),
    },
    select: {
      id: true,
      versionHash: true,
    },
  });
}

async function loadLatestPostVersionByIdentity(input: { platform: Platform; externalId: string }) {
  return prisma.postVersion.findFirst({
    where: {
      post: {
        platform: input.platform,
        externalId: input.externalId,
      },
    },
    orderBy: [{ lastSeenAt: "desc" }],
    include: {
      contentBlob: true,
    },
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

  const post = await prisma.post.create({
    data: {
      platform: input.platform,
      externalId,
      url: input.url,
    },
    select: {
      id: true,
      platform: true,
      externalId: true,
      url: true,
    },
  });
  const postVersion = await ensurePostVersionForSeed({
    postId: post.id,
    contentHash,
    contentText,
    provenance: "CLIENT_FALLBACK",
  });

  return {
    ...post,
    contentText,
    contentHash,
    versionHash: postVersion.versionHash,
    postVersionId: postVersion.id,
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
  parentInvestigationId?: string;
  contentDiff?: string;
}): Promise<{ id: string }> {
  const prompt = await seedPrompt(input.promptLabel);
  const checkedAt = input.status === "COMPLETE" ? (input.checkedAt ?? new Date()) : null;
  const postVersion = await ensurePostVersionForSeed({
    postId: input.postId,
    contentHash: input.contentHash,
    contentText: input.contentText,
    provenance: input.provenance,
  });

  const investigation = await prisma.investigation.create({
    data: {
      postVersionId: postVersion.id,
      status: input.status,
      promptId: prompt.id,
      provider: "OPENAI",
      model: "OPENAI_GPT_5",
      checkedAt,
      parentInvestigationId: input.parentInvestigationId ?? null,
      contentDiff: input.contentDiff ?? null,
    },
    select: { id: true },
  });

  return { id: investigation.id };
}

async function seedInvestigationRun(input: {
  investigationId: string;
  leaseOwner?: string | null;
  leaseExpiresAt?: Date | null;
  recoverAfterAt?: Date | null;
  queuedAt?: Date | null;
  startedAt?: Date | null;
  heartbeatAt?: Date | null;
}): Promise<{ id: string }> {
  const run = await prisma.investigationRun.create({
    data: {
      investigationId: input.investigationId,
      leaseOwner: input.leaseOwner ?? null,
      leaseExpiresAt: input.leaseExpiresAt ?? null,
      recoverAfterAt: input.recoverAfterAt ?? null,
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
): Promise<{ id: string }> {
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

  return { id: claim.id };
}

async function seedCorroborationCredits(investigationId: string, count: number): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await prisma.corroborationCredit.create({
      data: {
        investigationId,
        reporterKey: withIntegrationPrefix(`reporter-${index.toString()}-${investigationId}`),
      },
    });
  }
}

function buildXViewInput(input: { externalId: string; observedContentText: string }) {
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

function buildLesswrongViewInput(input: { externalId: string; htmlContent: string }) {
  const externalId = withIntegrationPrefix(input.externalId);

  return {
    platform: "LESSWRONG" as const,
    externalId,
    url: `https://www.lesswrong.com/posts/${externalId}/integration-post`,
    metadata: {
      slug: `${externalId}-integration-post`,
      title: "Integration LW Post",
      htmlContent: input.htmlContent,
      tags: [],
    },
  };
}

async function withMockLesswrongFetch<ResponseType>(
  fixtureKey: string,
  run: () => Promise<ResponseType>,
): Promise<ResponseType> {
  const fixture = await readLesswrongFixture(fixtureKey);
  return withMockLesswrongCanonicalHtml(fixture.html, run);
}

async function withMockLesswrongCanonicalHtml<ResponseType>(
  html: string,
  run: () => Promise<ResponseType>,
): Promise<ResponseType> {
  const lesswrongGraphqlUrl = "https://www.lesswrong.com/graphql";
  let sawLesswrongRequest = false;
  const originalFetch = globalThis.fetch;
  const mockedFetch: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url !== lesswrongGraphqlUrl) {
      return originalFetch(input, init);
    }
    sawLesswrongRequest = true;

    return new Response(
      JSON.stringify({
        data: {
          post: {
            result: {
              contents: {
                html,
              },
            },
          },
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  };

  globalThis.fetch = mockedFetch;
  try {
    const result = await run();
    assert.equal(sawLesswrongRequest, true);
    return result;
  } finally {
    globalThis.fetch = originalFetch;
  }
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
  assert.equal(
    results.every((result) => result.status === "PENDING"),
    true,
  );
  const firstResult = results[0];
  assert.ok(firstResult);

  return {
    results,
    investigationId: firstResult.investigationId,
  };
}

function buildSucceededAttemptAudit(label: string) {
  const now = new Date().toISOString();
  return {
    startedAt: now,
    completedAt: now,
    requestModel: `test-model-${label}`,
    requestInstructions: `instructions-${label}`,
    requestInput: `input-${label}`,
    requestReasoningEffort: null,
    requestReasoningSummary: null,
    requestedTools: [],
    response: {
      responseId: `response-${label}`,
      responseStatus: "completed",
      responseModelVersion: "test-model-version",
      responseOutputText: '{"claims":[]}',
      outputItems: [],
      outputTextParts: [],
      outputTextAnnotations: [],
      reasoningSummaries: [],
      toolCalls: [],
      usage: null,
    },
    error: null,
  };
}

function buildFailedAttemptAudit(label: string) {
  const now = new Date().toISOString();
  return {
    startedAt: now,
    completedAt: now,
    requestModel: `test-model-${label}`,
    requestInstructions: `instructions-${label}`,
    requestInput: `input-${label}`,
    requestReasoningEffort: null,
    requestReasoningSummary: null,
    requestedTools: [],
    response: null,
    error: {
      errorName: "TransientTestFailure",
      errorMessage: `transient-error-${label}`,
      statusCode: null,
    },
  };
}

after(async () => {
  await resetDatabase();
  await closeQueueUtils();
  await prisma.$disconnect();
});

afterEach(async () => {
  await assertIntegrationDatabaseInvariants();
});

export {
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
};
