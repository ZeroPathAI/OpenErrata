import assert from "node:assert/strict";
import { test } from "node:test";
import { graphql } from "graphql";
import type { PrismaClient } from "../../src/lib/db/prisma-client.js";
import { createPublicGraphqlSchema } from "../../src/lib/graphql/public-schema.js";

test("createPublicGraphqlSchema uses injected public read-model dependencies", async () => {
  const calls: {
    publicInvestigationId?: string;
    postInvestigationsInput?: { platform: string; externalId: string };
    searchInput?: {
      query?: string | undefined;
      platform?: string | undefined;
      limit: number;
      offset: number;
    };
    metricsInput?: {
      platform?: string | undefined;
      authorId?: string | undefined;
      windowStart?: string | undefined;
      windowEnd?: string | undefined;
    };
  } = {};

  const schema = createPublicGraphqlSchema({
    getPublicInvestigationById: async (_prisma, investigationId) => {
      calls.publicInvestigationId = investigationId;
      return {
        investigation: {
          id: investigationId,
          origin: {
            provenance: "SERVER_VERIFIED",
            serverVerifiedAt: new Date("2026-02-01T00:00:00.000Z"),
          },
          corroborationCount: 0,
          checkedAt: new Date("2026-02-01T00:00:00.000Z"),
          promptVersion: "integration-test-prompt",
          provider: "OPENAI",
          model: "gpt-6.1-sol",
        },
        post: { platform: "X", externalId: "x-1", url: "https://x.com/openerrata/status/x-1" },
        claims: [],
      };
    },
    getPublicPostInvestigations: async (_prisma, input) => {
      calls.postInvestigationsInput = input;
      return { post: null, investigations: [] };
    },
    searchPublicInvestigations: async (_prisma, input) => {
      calls.searchInput = input;
      return { investigations: [], hasMore: false };
    },
    getPublicMetrics: async (_prisma, input) => {
      calls.metricsInput = input;
      return {
        totalInvestigatedPosts: 3,
        investigatedPostsWithFlags: 1,
        factCheckIncidence: 1 / 3,
      };
    },
  });

  const contextValue = { prisma: {} };

  const publicInvestigationResult = await graphql({
    schema,
    source: `
      query($investigationId: ID!) {
        publicInvestigation(investigationId: $investigationId) {
          investigation { id }
        }
      }
    `,
    variableValues: { investigationId: "investigation-1" },
    contextValue,
  });
  assert.deepEqual(publicInvestigationResult.errors, undefined);
  assert.equal(calls.publicInvestigationId, "investigation-1");

  const postInvestigationsResult = await graphql({
    schema,
    source: `
      query($platform: Platform!, $externalId: String!) {
        postInvestigations(platform: $platform, externalId: $externalId) {
          investigations { id }
        }
      }
    `,
    variableValues: { platform: "LESSWRONG", externalId: "post-1" },
    contextValue,
  });
  assert.deepEqual(postInvestigationsResult.errors, undefined);
  assert.deepEqual(calls.postInvestigationsInput, {
    platform: "LESSWRONG",
    externalId: "post-1",
  });

  const searchResult = await graphql({
    schema,
    source: `
      query($query: String, $platform: Platform, $limit: Int!, $offset: Int!) {
        searchInvestigations(query: $query, platform: $platform, limit: $limit, offset: $offset) {
          investigations { id }
        }
      }
    `,
    variableValues: {
      query: "moon",
      platform: "X",
      limit: 3,
      offset: 2,
    },
    contextValue,
  });
  assert.deepEqual(searchResult.errors, undefined);
  assert.deepEqual(calls.searchInput, {
    query: "moon",
    platform: "X",
    minClaimCount: undefined,
    limit: 3,
    offset: 2,
  });

  const metricsResult = await graphql({
    schema,
    source: `
      query($platform: Platform, $authorId: ID, $windowStart: DateTime, $windowEnd: DateTime) {
        publicMetrics(
          platform: $platform
          authorId: $authorId
          windowStart: $windowStart
          windowEnd: $windowEnd
        ) {
          totalInvestigatedPosts
        }
      }
    `,
    variableValues: {
      platform: "SUBSTACK",
      authorId: "author-1",
      windowStart: "2026-02-01T00:00:00.000Z",
      windowEnd: "2026-02-02T00:00:00.000Z",
    },
    contextValue,
  });
  assert.deepEqual(metricsResult.errors, undefined);
  assert.deepEqual(calls.metricsInput, {
    platform: "SUBSTACK",
    authorId: "author-1",
    windowStart: "2026-02-01T00:00:00.000Z",
    windowEnd: "2026-02-02T00:00:00.000Z",
  });
});

interface MockPublicInvestigationRow {
  id: string;
  checkedAt: Date | null;
  provider: string;
  model: string;
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

function createPublicPrismaMock(
  rowsByInvestigationId: Record<string, MockPublicInvestigationRow>,
): PrismaClient {
  const prisma = {
    investigation: {
      findFirst: async (input: unknown) => {
        if (typeof input !== "object" || input === null) {
          return null;
        }
        const where = (input as { where?: unknown }).where;
        if (typeof where !== "object" || where === null) {
          return null;
        }
        const investigationId = (where as { id?: unknown }).id;
        if (typeof investigationId !== "string") {
          return null;
        }
        return rowsByInvestigationId[investigationId] ?? null;
      },
    },
  };
  return prisma as PrismaClient;
}

test("publicInvestigation maps trust signals and claims from the read model", async () => {
  const rowsByInvestigationId: Record<string, MockPublicInvestigationRow> = {
    "inv-server": {
      id: "inv-server",
      checkedAt: new Date("2026-02-28T09:30:00.000Z"),
      provider: "OPENAI",
      model: "gpt-6.1-sol",
      input: {
        provenance: "SERVER_VERIFIED",
      },
      postVersion: {
        serverVerifiedAt: new Date("2026-02-28T09:00:00.000Z"),
        contentBlob: {
          contentHash: "hash-server",
        },
        post: {
          platform: "X",
          externalId: "x-server",
          url: "https://x.com/openerrata/status/x-server",
        },
      },
      prompt: {
        version: "v1.11.0",
      },
      claims: [
        {
          id: "claim-server",
          text: "Claim text",
          context: "Claim context",
          summary: "Claim summary",
          reasoning: "Claim reasoning",
          sources: [
            {
              url: "https://example.com/source-server",
              title: "Server Source",
              snippet: "Server snippet",
            },
          ],
        },
      ],
      _count: {
        corroborationCredits: 3,
      },
    },
    "inv-fallback": {
      id: "inv-fallback",
      checkedAt: new Date("2026-02-28T10:30:00.000Z"),
      provider: "OPENAI",
      model: "gpt-6.1-sol",
      input: {
        provenance: "CLIENT_FALLBACK",
      },
      postVersion: {
        serverVerifiedAt: null,
        contentBlob: {
          contentHash: "hash-fallback",
        },
        post: {
          platform: "LESSWRONG",
          externalId: "lw-fallback",
          url: "https://www.lesswrong.com/posts/lw-fallback",
        },
      },
      prompt: {
        version: "v1.11.0",
      },
      claims: [],
      _count: {
        corroborationCredits: 1,
      },
    },
  };
  const prisma = createPublicPrismaMock(rowsByInvestigationId);
  const graphqlSchema = createPublicGraphqlSchema();
  const graphqlQuery = `
    query PublicInvestigation($investigationId: ID!) {
      publicInvestigation(investigationId: $investigationId) {
        investigation {
          id
          origin {
            provenance
            serverVerifiedAt
          }
          corroborationCount
          checkedAt
          promptVersion
          provider
          model
        }
        post {
          platform
          externalId
          url
        }
        claims {
          id
          text
          context
          summary
          reasoning
          sources {
            url
            title
            snippet
          }
        }
      }
    }
  `;

  const expected = {
    "inv-server": {
      investigation: {
        id: "inv-server",
        origin: { provenance: "SERVER_VERIFIED", serverVerifiedAt: "2026-02-28T09:00:00.000Z" },
        corroborationCount: 3,
        checkedAt: "2026-02-28T09:30:00.000Z",
        promptVersion: "v1.11.0",
        provider: "OPENAI",
        model: "gpt-6.1-sol",
      },
      post: {
        platform: "X",
        externalId: "x-server",
        url: "https://x.com/openerrata/status/x-server",
      },
      claims: [
        {
          id: "claim-server",
          text: "Claim text",
          context: "Claim context",
          summary: "Claim summary",
          reasoning: "Claim reasoning",
          sources: [
            {
              url: "https://example.com/source-server",
              title: "Server Source",
              snippet: "Server snippet",
            },
          ],
        },
      ],
    },
    "inv-fallback": {
      investigation: {
        id: "inv-fallback",
        origin: { provenance: "CLIENT_FALLBACK", serverVerifiedAt: null },
        corroborationCount: 1,
        checkedAt: "2026-02-28T10:30:00.000Z",
        promptVersion: "v1.11.0",
        provider: "OPENAI",
        model: "gpt-6.1-sol",
      },
      post: {
        platform: "LESSWRONG",
        externalId: "lw-fallback",
        url: "https://www.lesswrong.com/posts/lw-fallback",
      },
      claims: [],
    },
  };

  for (const investigationId of ["inv-server", "inv-fallback"] as const) {
    const graphqlResponse = await graphql({
      schema: graphqlSchema,
      source: graphqlQuery,
      variableValues: { investigationId },
      contextValue: { prisma },
    });
    assert.deepEqual(graphqlResponse.errors, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(graphqlResponse.data)), {
      publicInvestigation: expected[investigationId],
    });
  }
});
