import assert from "node:assert/strict";
import { test } from "node:test";
import type { Platform } from "@openerrata/shared";
import type { PrismaClient } from "../../src/lib/generated/prisma/client.js";
import {
  getPublicInvestigationById,
  getPublicMetrics,
  getPublicPostInvestigations,
  PublicReadModelInvariantError,
  searchPublicInvestigations,
} from "../../src/lib/services/public-read-model.js";

interface InvestigationFindFirstResult {
  id: string;
  checkedAt: Date | null;
  provider: string;
  model: string;
  postVersion: {
    contentProvenance: string;
    serverVerifiedAt: Date | null;
    fetchFailureReason: string | null;
    contentBlob: {
      contentHash: string;
    };
    post: {
      platform: string;
      externalId: string;
      url: string;
    };
  };
  prompt: {
    version: string;
  };
  claims: {
    id: string;
    text: string;
    context: string;
    summary: string;
    reasoning: string;
    sources: {
      url: string;
      title: string;
      snippet: string;
    }[];
  }[];
  _count: {
    corroborationCredits: number;
  };
}

type InvestigationFindManyResult = {
  id: string;
  checkedAt: Date | null;
  postVersion: {
    contentBlob: {
      contentHash: string;
    };
    contentProvenance: string;
    serverVerifiedAt: Date | null;
    fetchFailureReason: string | null;
    post?: {
      platform: string;
      externalId: string;
      url: string;
    };
  };
  _count: {
    claims: number;
    corroborationCredits: number;
  };
}[];

interface PublicReadModelPrismaMock {
  investigation: {
    findFirst: (input: unknown) => Promise<InvestigationFindFirstResult | null>;
    findMany: (input: unknown) => Promise<InvestigationFindManyResult>;
  };
  post: {
    findUnique: (
      input: unknown,
    ) => Promise<{ platform: string; externalId: string; url: string } | null>;
  };
  $queryRaw: (
    templateStrings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<{ total_investigated: number; with_flags: number }[]>;
}

function asPrismaClient(mock: PublicReadModelPrismaMock): PrismaClient {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial PrismaClient mock for unit testing
  return mock as unknown as PrismaClient;
}

function createMockPrisma(overrides: Partial<PublicReadModelPrismaMock> = {}): PrismaClient {
  const base: PublicReadModelPrismaMock = {
    investigation: {
      findFirst: async () => null,
      findMany: async () => [],
    },
    post: {
      findUnique: async () => null,
    },
    $queryRaw: async () => [{ total_investigated: 0, with_flags: 0 }],
  };

  return asPrismaClient({
    ...base,
    ...overrides,
    investigation: {
      ...base.investigation,
      ...overrides.investigation,
    },
    post: {
      ...base.post,
      ...overrides.post,
    },
  });
}

test("getPublicInvestigationById maps a complete SERVER_VERIFIED investigation", async () => {
  const checkedAt = new Date("2026-02-27T09:30:00.000Z");
  const serverVerifiedAt = new Date("2026-02-27T09:00:00.000Z");
  const prisma = createMockPrisma({
    investigation: {
      findFirst: async () => ({
        id: "inv_1",
        checkedAt,
        provider: "OPENAI",
        model: "OPENAI_GPT_5",
        postVersion: {
          contentProvenance: "SERVER_VERIFIED",
          serverVerifiedAt,
          fetchFailureReason: null,
          contentBlob: {
            contentHash: "hash-1",
          },
          post: {
            platform: "X",
            externalId: "tweet_1",
            url: "https://x.com/openerrata/status/tweet_1",
          },
        },
        prompt: {
          version: "v1.11.0",
        },
        claims: [
          {
            id: "claim_1",
            text: "Claim text",
            context: "Claim context",
            summary: "Claim summary",
            reasoning: "Claim reasoning",
            sources: [
              {
                url: "https://example.com/source",
                title: "Source title",
                snippet: "Source snippet",
              },
            ],
          },
        ],
        _count: {
          corroborationCredits: 3,
        },
      }),
      findMany: async () => [],
    },
  });

  const result = await getPublicInvestigationById(prisma, "inv_1");

  assert.notEqual(result, null);
  if (result === null) throw new Error("Expected investigation result");
  assert.equal(result.investigation.id, "inv_1");
  assert.equal(result.investigation.checkedAt.toISOString(), checkedAt.toISOString());
  assert.deepEqual(result.investigation.origin, {
    provenance: "SERVER_VERIFIED",
    serverVerifiedAt,
  });
  assert.equal(result.post.platform, "X");
  assert.equal(result.post.externalId, "tweet_1");
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0]?.sources.length, 1);
});

test("getPublicInvestigationById throws on invalid lifecycle provenance data", async () => {
  const prisma = createMockPrisma({
    investigation: {
      findFirst: async () => ({
        id: "inv_invalid",
        checkedAt: new Date("2026-02-27T09:30:00.000Z"),
        provider: "OPENAI",
        model: "OPENAI_GPT_5",
        postVersion: {
          contentProvenance: "UNKNOWN_PROVENANCE",
          serverVerifiedAt: null,
          fetchFailureReason: null,
          contentBlob: {
            contentHash: "hash-invalid",
          },
          post: {
            platform: "X",
            externalId: "tweet_invalid",
            url: "https://x.com/openerrata/status/tweet_invalid",
          },
        },
        prompt: {
          version: "v1.11.0",
        },
        claims: [],
        _count: {
          corroborationCredits: 0,
        },
      }),
      findMany: async () => [],
    },
  });

  await assert.rejects(
    getPublicInvestigationById(prisma, "inv_invalid"),
    (error: unknown) =>
      error instanceof PublicReadModelInvariantError &&
      error.message.includes("invalid contentProvenance"),
  );
});

test("getPublicPostInvestigations throws when lifecycle invariants are broken", async () => {
  const prisma = createMockPrisma({
    post: {
      findUnique: async () => ({
        platform: "LESSWRONG",
        externalId: "post_1",
        url: "https://www.lesswrong.com/posts/post_1",
      }),
    },
    investigation: {
      findFirst: async () => null,
      findMany: async () => [
        {
          id: "inv_good",
          checkedAt: new Date("2026-02-27T09:30:00.000Z"),
          postVersion: {
            contentBlob: {
              contentHash: "hash-good",
            },
            contentProvenance: "SERVER_VERIFIED",
            serverVerifiedAt: new Date("2026-02-27T09:00:00.000Z"),
            fetchFailureReason: null,
          },
          _count: {
            claims: 2,
            corroborationCredits: 5,
          },
        },
        {
          id: "inv_bad",
          checkedAt: new Date("2026-02-27T09:45:00.000Z"),
          postVersion: {
            contentBlob: {
              contentHash: "hash-bad",
            },
            contentProvenance: "CLIENT_FALLBACK",
            serverVerifiedAt: null,
            fetchFailureReason: "   ",
          },
          _count: {
            claims: 1,
            corroborationCredits: 1,
          },
        },
      ],
    },
  });

  await assert.rejects(
    getPublicPostInvestigations(prisma, {
      platform: "LESSWRONG",
      externalId: "post_1",
    }),
    (error: unknown) =>
      error instanceof PublicReadModelInvariantError &&
      error.message.includes("empty fetchFailureReason"),
  );
});

test("searchPublicInvestigations throws when lifecycle invariants are broken", async () => {
  const prisma = createMockPrisma({
    investigation: {
      findFirst: async () => null,
      findMany: async () => [
        {
          id: "inv_search_ok",
          checkedAt: new Date("2026-02-27T10:00:00.000Z"),
          postVersion: {
            contentBlob: {
              contentHash: "hash-search-ok",
            },
            contentProvenance: "CLIENT_FALLBACK",
            serverVerifiedAt: null,
            fetchFailureReason: "canonical fetch timed out",
            post: {
              platform: "SUBSTACK",
              externalId: "post_2",
              url: "https://example.substack.com/p/post_2",
            },
          },
          _count: {
            claims: 1,
            corroborationCredits: 2,
          },
        },
        {
          id: "inv_search_bad",
          checkedAt: new Date("2026-02-27T10:05:00.000Z"),
          postVersion: {
            contentBlob: {
              contentHash: "hash-search-bad",
            },
            contentProvenance: "SERVER_VERIFIED",
            serverVerifiedAt: null,
            fetchFailureReason: null,
            post: {
              platform: "SUBSTACK",
              externalId: "post_3",
              url: "https://example.substack.com/p/post_3",
            },
          },
          _count: {
            claims: 2,
            corroborationCredits: 4,
          },
        },
      ],
    },
  });

  await assert.rejects(
    searchPublicInvestigations(prisma, {
      query: "climate",
      platform: "SUBSTACK" as Platform,
      limit: 10,
      offset: 0,
    }),
    (error: unknown) =>
      error instanceof PublicReadModelInvariantError &&
      error.message.includes("null serverVerifiedAt"),
  );
});

test("getPublicMetrics computes incidence and handles empty query rows", async () => {
  const metricsPrisma = createMockPrisma({
    $queryRaw: async () => [{ total_investigated: 4, with_flags: 1 }],
  });
  const nonEmpty = await getPublicMetrics(metricsPrisma, {
    platform: "X",
    authorId: "author_1",
    windowStart: "2026-01-01T00:00:00.000Z",
    windowEnd: "2026-01-31T23:59:59.999Z",
  });

  assert.deepEqual(nonEmpty, {
    totalInvestigatedPosts: 4,
    investigatedPostsWithFlags: 1,
    factCheckIncidence: 0.25,
  });

  const emptyPrisma = createMockPrisma({
    $queryRaw: async () => [],
  });
  const empty = await getPublicMetrics(emptyPrisma, {});
  assert.deepEqual(empty, {
    totalInvestigatedPosts: 0,
    investigatedPostsWithFlags: 0,
    factCheckIncidence: 0,
  });
});
