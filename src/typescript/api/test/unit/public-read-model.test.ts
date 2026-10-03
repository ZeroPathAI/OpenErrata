import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrismaClient } from "../../src/lib/db/prisma-client.js";
import {
  getPublicInvestigationById,
  getPublicMetrics,
  PublicReadModelInvariantError,
} from "../../src/lib/services/public-read-model.js";

interface InvestigationFindFirstResult {
  id: string;
  checkedAt: Date | null;
  provider: string;
  model: string | null;
  input: {
    provenance: string;
  } | null;
  postVersion: {
    serverVerifiedAt: Date | null;
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
  input: {
    provenance: string;
  } | null;
  postVersion: {
    contentBlob: {
      contentHash: string;
    };
    serverVerifiedAt: Date | null;
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
        model: "gpt-6.1-sol",
        input: {
          provenance: "SERVER_VERIFIED",
        },
        postVersion: {
          serverVerifiedAt,
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
  assert.equal(result.investigation.model, "gpt-6.1-sol");
  assert.equal(result.post.platform, "X");
  assert.equal(result.post.externalId, "tweet_1");
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0]?.sources.length, 1);
});

test("getPublicInvestigationById throws when a COMPLETE investigation has no recorded model", async () => {
  const prisma = createMockPrisma({
    investigation: {
      findFirst: async () => ({
        id: "inv_no_model",
        checkedAt: new Date("2026-02-27T09:30:00.000Z"),
        provider: "OPENAI",
        model: null,
        input: {
          provenance: "SERVER_VERIFIED",
        },
        postVersion: {
          serverVerifiedAt: new Date("2026-02-27T09:00:00.000Z"),
          contentBlob: {
            contentHash: "hash-no-model",
          },
          post: {
            platform: "X",
            externalId: "tweet_no_model",
            url: "https://x.com/openerrata/status/tweet_no_model",
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
    getPublicInvestigationById(prisma, "inv_no_model"),
    (error: unknown) =>
      error instanceof PublicReadModelInvariantError && error.message.includes("null model"),
  );
});

test("getPublicMetrics computes incidence, and reports none when nothing was investigated", async () => {
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
    $queryRaw: async () => [{ total_investigated: 0, with_flags: 0 }],
  });
  const empty = await getPublicMetrics(emptyPrisma, {});
  assert.deepEqual(empty, {
    totalInvestigatedPosts: 0,
    investigatedPostsWithFlags: 0,
    factCheckIncidence: null,
  });
});

test("getPublicMetrics fails loudly if the aggregate query returns no row", async () => {
  const brokenPrisma = createMockPrisma({
    $queryRaw: async () => [],
  });
  await assert.rejects(getPublicMetrics(brokenPrisma, {}), PublicReadModelInvariantError);
});
