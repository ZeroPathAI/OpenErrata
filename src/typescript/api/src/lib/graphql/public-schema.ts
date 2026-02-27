import { makeExecutableSchema } from "@graphql-tools/schema";
import { DateTimeResolver } from "graphql-scalars";
import type { GraphQLSchema } from "graphql";
import {
  getMetricsInputSchema,
  getPostInvestigationsInputSchema,
  getPublicInvestigationInputSchema,
  searchInvestigationsInputSchema,
  type Platform,
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

  """
  Platforms supported by OpenErrata for fact-checking.
  """
  enum Platform {
    LESSWRONG
    X
    SUBSTACK
    WIKIPEDIA
  }

  """
  How the investigated content was obtained. Public responses include this
  signal so consumers can apply their own trust policy.
  """
  enum ContentProvenance {
    """
    The server independently fetched and verified the post content from the platform.
    """
    SERVER_VERIFIED
    """
    Server-side fetch failed (rate limit, outage, anti-bot block); the investigation used content submitted by the browser extension.
    """
    CLIENT_FALLBACK
  }

  type ServerVerifiedOrigin {
    provenance: ContentProvenance!
    serverVerifiedAt: DateTime!
  }

  type ClientFallbackOrigin {
    provenance: ContentProvenance!
    fetchFailureReason: String!
  }

  union InvestigationOrigin = ServerVerifiedOrigin | ClientFallbackOrigin

  """
  Metadata and trust signals for a single investigation. An investigation
  is the result of an LLM fact-checking a specific version of a post's content.
  """
  type PublicInvestigation {
    id: ID!
    """
    How the investigated content was obtained, with provenance-specific fields.
    """
    origin: InvestigationOrigin!
    """
    Number of distinct authenticated users who independently submitted matching content for this investigation, providing independent confirmation of what the post said.
    """
    corroborationCount: Int!
    """
    When this investigation was completed.
    """
    checkedAt: DateTime!
    """
    Version identifier of the LLM prompt used for this investigation.
    """
    promptVersion: String!
    """
    LLM provider used (e.g. "OPENAI").
    """
    provider: String!
    """
    LLM model used (e.g. "GPT4O").
    """
    model: String!
  }

  """
  The post that was investigated, identified by platform and external ID.
  """
  type PublicPost {
    platform: Platform!
    """
    Platform-specific identifier for the post (e.g. tweet ID, LessWrong slug).
    """
    externalId: String!
    """
    Original URL of the post on the platform.
    """
    url: String!
  }

  """
  A source cited by the LLM to support its reasoning about a claim.
  """
  type PublicSource {
    """
    URL of the source the LLM found via web search.
    """
    url: String!
    """
    Title of the source page or document.
    """
    title: String!
    """
    Relevant excerpt from the source that supports the reasoning.
    """
    snippet: String!
  }

  """
  A specific claim in a post that the LLM identified as empirically incorrect
  or unambiguously misleading, along with its reasoning and sources.
  """
  type PublicClaim {
    id: ID!
    """
    Exact verbatim quote of the incorrect claim from the post text. Used for DOM matching in the browser extension.
    """
    text: String!
    """
    Surrounding text (~10 words before and after) for disambiguating duplicate text in the post.
    """
    context: String!
    """
    One- or two-sentence factual correction summarizing why the claim is incorrect.
    """
    summary: String!
    """
    Detailed investigation reasoning explaining the evidence against the claim.
    """
    reasoning: String!
    """
    Sources found via web search that support the correction.
    """
    sources: [PublicSource!]!
  }

  """
  Full details of a single investigation, including the post it analyzed and
  all flagged claims. Only returned for completed investigations.
  """
  type PublicInvestigationResult {
    investigation: PublicInvestigation!
    post: PublicPost!
    """
    Claims flagged as incorrect. Empty if the post passed fact-checking with no issues.
    """
    claims: [PublicClaim!]!
  }

  """
  Summary of an investigation for a specific content version of a post.
  Used in the postInvestigations listing where full claim details are not needed.
  """
  type PostInvestigationSummary {
    id: ID!
    """
    SHA-256 hash of the normalized post content that was investigated. Different hashes indicate the post was edited between investigations.
    """
    contentHash: String!
    """
    How the investigated content was obtained, with provenance-specific fields.
    """
    origin: InvestigationOrigin!
    """
    Number of distinct authenticated users who independently submitted matching content.
    """
    corroborationCount: Int!
    """
    When this investigation was completed.
    """
    checkedAt: DateTime!
    """
    Number of incorrect claims flagged in this investigation.
    """
    claimCount: Int!
  }

  """
  All completed investigations for a specific post, grouped by content version.
  A post may have multiple investigations if its content was edited.
  """
  type PostInvestigationsResult {
    """
    The post, or null if no post exists for the given platform/externalId.
    """
    post: PublicPost
    """
    Completed investigations for this post, one per content version.
    """
    investigations: [PostInvestigationSummary!]!
  }

  """
  Summary of an investigation returned by search, including post identification
  fields so results can be displayed without a separate post lookup.
  """
  type SearchInvestigationSummary {
    id: ID!
    """
    SHA-256 hash of the normalized post content that was investigated.
    """
    contentHash: String!
    """
    When this investigation was completed.
    """
    checkedAt: DateTime!
    platform: Platform!
    """
    Platform-specific identifier for the post.
    """
    externalId: String!
    """
    Original URL of the post on the platform.
    """
    url: String!
    """
    How the investigated content was obtained, with provenance-specific fields.
    """
    origin: InvestigationOrigin!
    """
    Number of distinct authenticated users who independently submitted matching content.
    """
    corroborationCount: Int!
    """
    Number of incorrect claims flagged in this investigation.
    """
    claimCount: Int!
  }

  type SearchInvestigationsResult {
    investigations: [SearchInvestigationSummary!]!
  }

  """
  Aggregate fact-checking statistics, optionally filtered by platform, author, or time window.
  """
  type PublicMetrics {
    """
    Total number of posts with completed investigations matching the filter.
    """
    totalInvestigatedPosts: Int!
    """
    Number of investigated posts that had at least one incorrect claim flagged.
    """
    investigatedPostsWithFlags: Int!
    """
    Ratio of posts with flags to total investigated posts (investigatedPostsWithFlags / totalInvestigatedPosts).
    """
    factCheckIncidence: Float!
  }

  type Query {
    """
    Get the full details of a single investigation by ID, including all flagged
    claims with reasoning and sources. Returns null if the investigation does
    not exist or is not yet complete.
    """
    publicInvestigation(investigationId: ID!): PublicInvestigationResult

    """
    List all completed investigations for a specific post. Returns one
    investigation per content version (a post may have been edited and
    re-investigated). Returns an empty list with post: null if the post
    does not exist.
    """
    postInvestigations(
      """
      Platform the post belongs to.
      """
      platform: Platform!
      """
      Platform-specific post identifier (e.g. tweet ID, LessWrong slug).
      """
      externalId: String!
    ): PostInvestigationsResult!

    """
    Search and browse completed investigations. Returns summaries (without
    full claim details) for efficient listing. Use publicInvestigation to
    fetch full details for a specific result.
    """
    searchInvestigations(
      """
      Free-text search query. Omit to browse all investigations.
      """
      query: String
      """
      Filter to a specific platform.
      """
      platform: Platform
      """
      Maximum number of results to return (1-100).
      """
      limit: Int = 20
      """
      Number of results to skip for pagination.
      """
      offset: Int = 0
    ): SearchInvestigationsResult!

    """
    Aggregate fact-checking statistics. All filters are optional; omit all
    for global metrics.
    """
    publicMetrics(
      """
      Filter to a specific platform.
      """
      platform: Platform
      """
      Filter to a specific author by ID.
      """
      authorId: ID
      """
      Only count investigations completed on or after this timestamp (inclusive).
      """
      windowStart: DateTime
      """
      Only count investigations completed on or before this timestamp (inclusive).
      """
      windowEnd: DateTime
    ): PublicMetrics!
  }
`;

function toDateTimeInput(value: Date | string | null | undefined): string | undefined {
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
  platform?: Platform;
  limit?: number;
  offset?: number;
};

type PublicMetricsArgs = {
  platform?: Platform;
  authorId?: string;
  windowStart?: Date | string;
  windowEnd?: Date | string;
};

type PublicReadModel = {
  getPublicInvestigationById: typeof getPublicInvestigationById;
  getPublicPostInvestigations: typeof getPublicPostInvestigations;
  searchPublicInvestigations: typeof searchPublicInvestigations;
  getPublicMetrics: typeof getPublicMetrics;
};

const defaultPublicReadModel: PublicReadModel = {
  getPublicInvestigationById,
  getPublicPostInvestigations,
  searchPublicInvestigations,
  getPublicMetrics,
};

function createResolvers(publicReadModel: PublicReadModel) {
  return {
    DateTime: DateTimeResolver,
    InvestigationOrigin: {
      __resolveType: (value: unknown): "ServerVerifiedOrigin" | "ClientFallbackOrigin" | null => {
        if (value === null || typeof value !== "object") return null;
        const origin = value as { provenance?: string };
        if (origin.provenance === "SERVER_VERIFIED") return "ServerVerifiedOrigin";
        if (origin.provenance === "CLIENT_FALLBACK") return "ClientFallbackOrigin";
        return null;
      },
    },
    Query: {
      publicInvestigation: async (
        _root: unknown,
        args: { investigationId: string },
        ctx: PublicGraphqlContext,
      ) => {
        const input = getPublicInvestigationInputSchema.parse({
          investigationId: args.investigationId,
        });
        return publicReadModel.getPublicInvestigationById(ctx.prisma, input.investigationId);
      },

      postInvestigations: async (
        _root: unknown,
        args: {
          platform: Platform;
          externalId: string;
        },
        ctx: PublicGraphqlContext,
      ) => {
        const input = getPostInvestigationsInputSchema.parse({
          platform: args.platform,
          externalId: args.externalId,
        });
        return publicReadModel.getPublicPostInvestigations(ctx.prisma, input);
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
        return publicReadModel.searchPublicInvestigations(ctx.prisma, input);
      },

      publicMetrics: async (_root: unknown, args: PublicMetricsArgs, ctx: PublicGraphqlContext) => {
        const input = getMetricsInputSchema.parse({
          platform: args.platform,
          authorId: args.authorId,
          windowStart: toDateTimeInput(args.windowStart),
          windowEnd: toDateTimeInput(args.windowEnd),
        });
        return publicReadModel.getPublicMetrics(ctx.prisma, input);
      },
    },
  };
}

export function createPublicGraphqlSchema(
  publicReadModel: PublicReadModel = defaultPublicReadModel,
): GraphQLSchema {
  return makeExecutableSchema({
    typeDefs,
    resolvers: createResolvers(publicReadModel),
  });
}

export const publicGraphqlSchema = createPublicGraphqlSchema();
