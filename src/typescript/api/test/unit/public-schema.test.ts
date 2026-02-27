import assert from "node:assert/strict";
import { test } from "node:test";
import { graphql } from "graphql";
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
          model: "OPENAI_GPT_5",
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
      return { investigations: [] };
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
