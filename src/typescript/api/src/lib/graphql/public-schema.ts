import { makeExecutableSchema } from "@graphql-tools/schema";
import { DateTimeResolver } from "graphql-scalars";
import {
  getMetricsInputSchema,
  getPostInvestigationsInputSchema,
  getPublicInvestigationInputSchema,
  searchInvestigationsInputSchema,
} from "@openerrata/shared";
import type { PrismaClient } from "$lib/generated/prisma/client";
import {
  getPublicInvestigationById,
  getPublicMetrics,
  getPublicPostInvestigations,
  searchPublicInvestigations,
} from "$lib/services/public-read-model.js";

export type PublicGraphqlContext = {
  prisma: PrismaClient;
};

const typeDefs = /* GraphQL */ `
  scalar DateTime

  enum Platform {
    LESSWRONG
    X
    SUBSTACK
  }

  enum ContentProvenance {
    SERVER_VERIFIED
    CLIENT_FALLBACK
  }

  type PublicInvestigation {
    id: ID!
    provenance: ContentProvenance!
    corroborationCount: Int!
    serverVerifiedAt: DateTime
    fetchFailureReason: String
    checkedAt: DateTime
    promptVersion: String!
    provider: String!
    model: String!
  }

  type PublicPost {
    platform: Platform!
    externalId: String!
    url: String!
  }

  type PublicSource {
    url: String!
    title: String!
    snippet: String!
  }

  type PublicClaim {
    id: ID!
    text: String!
    context: String!
    summary: String!
    reasoning: String!
    sources: [PublicSource!]!
  }

  type PublicInvestigationResult {
    investigation: PublicInvestigation!
    post: PublicPost!
    claims: [PublicClaim!]!
  }

  type PostInvestigationSummary {
    id: ID!
    contentHash: String!
    provenance: ContentProvenance!
    corroborationCount: Int!
    serverVerifiedAt: DateTime
    fetchFailureReason: String
    checkedAt: DateTime
    claimCount: Int!
  }

  type PostInvestigationsResult {
    post: PublicPost
    investigations: [PostInvestigationSummary!]!
  }

  type SearchInvestigationSummary {
    id: ID!
    contentHash: String!
    checkedAt: DateTime
    platform: Platform!
    externalId: String!
    url: String!
    provenance: ContentProvenance!
    corroborationCount: Int!
    serverVerifiedAt: DateTime
    fetchFailureReason: String
    claimCount: Int!
  }

  type SearchInvestigationsResult {
    investigations: [SearchInvestigationSummary!]!
  }

  type PublicMetrics {
    totalInvestigatedPosts: Int!
    investigatedPostsWithFlags: Int!
    factCheckIncidence: Float!
  }

  type Query {
    publicInvestigation(investigationId: ID!): PublicInvestigationResult
    postInvestigations(platform: Platform!, externalId: String!): PostInvestigationsResult!
    searchInvestigations(
      query: String
      platform: Platform
      limit: Int = 20
      offset: Int = 0
    ): SearchInvestigationsResult!
    publicMetrics(
      platform: Platform
      authorId: ID
      windowStart: DateTime
      windowEnd: DateTime
    ): PublicMetrics!
  }
`;

function toDateTimeInput(
  value: Date | string | null | undefined,
): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

type SearchInvestigationsArgs = {
  query?: string;
  platform?: "LESSWRONG" | "X" | "SUBSTACK";
  limit?: number;
  offset?: number;
};

type PublicMetricsArgs = {
  platform?: "LESSWRONG" | "X" | "SUBSTACK";
  authorId?: string;
  windowStart?: Date | string;
  windowEnd?: Date | string;
};

const resolvers = {
  DateTime: DateTimeResolver,
  Query: {
    publicInvestigation: async (
      _root: unknown,
      args: { investigationId: string },
      ctx: PublicGraphqlContext,
    ) => {
      const input = getPublicInvestigationInputSchema.parse({
        investigationId: args.investigationId,
      });
      return getPublicInvestigationById(ctx.prisma, input.investigationId);
    },

    postInvestigations: async (
      _root: unknown,
      args: { platform: "LESSWRONG" | "X" | "SUBSTACK"; externalId: string },
      ctx: PublicGraphqlContext,
    ) => {
      const input = getPostInvestigationsInputSchema.parse({
        platform: args.platform,
        externalId: args.externalId,
      });
      return getPublicPostInvestigations(ctx.prisma, input);
    },

    searchInvestigations: async (
      _root: unknown,
      args: SearchInvestigationsArgs,
      ctx: PublicGraphqlContext,
    ) => {
      const input = searchInvestigationsInputSchema.parse({
        query: args.query,
        platform: args.platform,
        limit: args.limit,
        offset: args.offset,
      });
      return searchPublicInvestigations(ctx.prisma, input);
    },

    publicMetrics: async (
      _root: unknown,
      args: PublicMetricsArgs,
      ctx: PublicGraphqlContext,
    ) => {
      const input = getMetricsInputSchema.parse({
        platform: args.platform,
        authorId: args.authorId,
        windowStart: toDateTimeInput(args.windowStart),
        windowEnd: toDateTimeInput(args.windowEnd),
      });
      return getPublicMetrics(ctx.prisma, input);
    },
  },
};

export const publicGraphqlSchema = makeExecutableSchema({
  typeDefs,
  resolvers,
});
