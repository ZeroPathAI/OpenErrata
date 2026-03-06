import { Prisma, type PrismaClient } from "$lib/db/prisma-client";
import { platformSchema, type Platform } from "@openerrata/shared";

interface PublicInvestigationOrigin {
  provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
  serverVerifiedAt: Date | null;
}

interface PublicTrustSignals {
  origin: PublicInvestigationOrigin;
  corroborationCount: number;
}

interface PublicClaimSource {
  url: string;
  title: string;
  snippet: string;
}

interface PublicClaim {
  id: string;
  text: string;
  context: string;
  summary: string;
  reasoning: string;
  sources: PublicClaimSource[];
}

type PublicInvestigation = PublicTrustSignals & {
  id: string;
  checkedAt: Date;
  promptVersion: string;
  provider: string;
  model: string;
};

interface PublicPost {
  platform: Platform;
  externalId: string;
  url: string;
}

interface PublicInvestigationResult {
  investigation: PublicInvestigation;
  post: PublicPost;
  claims: PublicClaim[];
}

type PublicPostInvestigationSummary = PublicTrustSignals & {
  id: string;
  contentHash: string;
  checkedAt: Date;
  claimCount: number;
  claimSummaries: PublicClaimSummary[];
};

interface PublicPostInvestigationsResult {
  post: PublicPost | null;
  investigations: PublicPostInvestigationSummary[];
}

interface PublicClaimSummary {
  id: string;
  summary: string;
}

type PublicSearchInvestigationSummary = PublicTrustSignals & {
  id: string;
  contentHash: string;
  checkedAt: Date;
  platform: Platform;
  externalId: string;
  url: string;
  claimCount: number;
  claimSummaries: PublicClaimSummary[];
};

interface PublicSearchInvestigationsResult {
  investigations: PublicSearchInvestigationSummary[];
  hasMore: boolean;
}

interface SearchInvestigationPageRow {
  id: string;
}

interface PublicMetricsResult {
  totalInvestigatedPosts: number;
  investigatedPostsWithFlags: number;
  factCheckIncidence: number;
}

interface PublicMetricsInput {
  platform?: Platform | undefined;
  authorId?: string | undefined;
  windowStart?: string | undefined;
  windowEnd?: string | undefined;
}

interface PublicSearchInvestigationsInput {
  query?: string | undefined;
  platform?: Platform | undefined;
  minClaimCount?: number | undefined;
  limit: number;
  offset: number;
}

function parsePlatform(value: string): Platform {
  return platformSchema.parse(value);
}

function escapeLikePattern(query: string): string {
  return query.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export class PublicReadModelInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicReadModelInvariantError";
  }
}

function invariantViolation(message: string): never {
  throw new PublicReadModelInvariantError(`Public read-model invariant violation: ${message}`);
}

function parsePublicOrigin(input: {
  investigationId: string;
  provenance: string | undefined;
  serverVerifiedAt: Date | null;
}): PublicInvestigationOrigin {
  // provenance lives on InvestigationInput (1:1); older investigations may lack it.
  if (input.provenance === undefined) {
    invariantViolation(
      `Investigation ${input.investigationId} has no InvestigationInput (missing provenance)`,
    );
  }
  if (input.provenance !== "SERVER_VERIFIED" && input.provenance !== "CLIENT_FALLBACK") {
    invariantViolation(
      `Investigation ${input.investigationId} has invalid provenance "${input.provenance}"`,
    );
  }
  return {
    provenance: input.provenance,
    serverVerifiedAt: input.serverVerifiedAt,
  };
}

function requireCompleteCheckedAt(input: {
  investigationId: string;
  checkedAt: Date | null;
}): Date {
  if (input.checkedAt === null) {
    invariantViolation(`Investigation ${input.investigationId} is COMPLETE with null checkedAt`);
  }
  return input.checkedAt;
}

function parsePublicLifecycle(input: {
  investigationId: string;
  provenance: string | undefined;
  serverVerifiedAt: Date | null;
  checkedAt: Date | null;
}): { origin: PublicInvestigationOrigin; checkedAt: Date } {
  const origin = parsePublicOrigin({
    investigationId: input.investigationId,
    provenance: input.provenance,
    serverVerifiedAt: input.serverVerifiedAt,
  });

  const checkedAt = requireCompleteCheckedAt({
    investigationId: input.investigationId,
    checkedAt: input.checkedAt,
  });

  return {
    origin,
    checkedAt,
  };
}

function publicMetricsConditions(input: PublicMetricsInput): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [Prisma.sql`i."status" = 'COMPLETE'`];

  if (input.platform !== undefined) {
    conditions.push(Prisma.sql`p."platform" = ${input.platform}`);
  }
  if (input.authorId !== undefined && input.authorId.length > 0) {
    conditions.push(Prisma.sql`p."authorId" = ${input.authorId}`);
  }
  if (input.windowStart !== undefined && input.windowStart.length > 0) {
    conditions.push(Prisma.sql`i."checkedAt" >= ${input.windowStart}`);
  }
  if (input.windowEnd !== undefined && input.windowEnd.length > 0) {
    conditions.push(Prisma.sql`i."checkedAt" <= ${input.windowEnd}`);
  }

  return conditions;
}

async function loadSearchInvestigationPageRows(
  prisma: PrismaClient,
  input: PublicSearchInvestigationsInput,
): Promise<SearchInvestigationPageRow[]> {
  const platformFilter =
    input.platform === undefined ? Prisma.empty : Prisma.sql`AND p."platform" = ${input.platform}`;
  const textFilter =
    input.query === undefined
      ? Prisma.empty
      : Prisma.sql`AND cb."contentText" ILIKE ${`%${escapeLikePattern(input.query)}%`} ESCAPE '\\'`;

  const minimumClaimCount = input.minClaimCount ?? 0;

  return prisma.$queryRaw<SearchInvestigationPageRow[]>`
    SELECT i."id"
    FROM "Investigation" i
    JOIN "PostVersion" pv ON pv."id" = i."postVersionId"
    JOIN "Post" p ON p."id" = pv."postId"
    JOIN "ContentBlob" cb ON cb."id" = pv."contentBlobId"
    LEFT JOIN "Claim" c ON c."investigationId" = i."id"
    WHERE i."status" = 'COMPLETE'
      ${platformFilter}
      ${textFilter}
    GROUP BY i."id", i."checkedAt"
    HAVING COUNT(c."id") >= ${minimumClaimCount}
    ORDER BY i."checkedAt" DESC NULLS LAST, i."id" DESC
    LIMIT ${input.limit + 1} OFFSET ${input.offset}
  `;
}

export async function getPublicInvestigationById(
  prisma: PrismaClient,
  investigationId: string,
): Promise<PublicInvestigationResult | null> {
  const investigation = await prisma.investigation.findFirst({
    where: {
      id: investigationId,
      status: "COMPLETE",
    },
    include: {
      postVersion: {
        include: {
          post: true,
          contentBlob: {
            select: {
              contentHash: true,
            },
          },
        },
      },
      input: true,
      prompt: true,
      claims: { include: { sources: true } },
      _count: { select: { corroborationCredits: true } },
    },
  });

  if (!investigation) {
    return null;
  }

  const lifecycle = parsePublicLifecycle({
    investigationId: investigation.id,
    provenance: investigation.input.provenance,
    serverVerifiedAt: investigation.postVersion.serverVerifiedAt,
    checkedAt: investigation.checkedAt,
  });

  return {
    investigation: {
      id: investigation.id,
      origin: lifecycle.origin,
      corroborationCount: investigation._count.corroborationCredits,
      checkedAt: lifecycle.checkedAt,
      promptVersion: investigation.prompt.version,
      provider: investigation.provider,
      model: investigation.model,
    },
    post: {
      platform: parsePlatform(investigation.postVersion.post.platform),
      externalId: investigation.postVersion.post.externalId,
      url: investigation.postVersion.post.url,
    },
    claims: investigation.claims.map((claim) => ({
      id: claim.id,
      text: claim.text,
      context: claim.context,
      summary: claim.summary,
      reasoning: claim.reasoning,
      sources: claim.sources.map((source) => ({
        url: source.url,
        title: source.title,
        snippet: source.snippet,
      })),
    })),
  };
}

export async function getPublicPostInvestigations(
  prisma: PrismaClient,
  input: { platform: Platform; externalId: string },
): Promise<PublicPostInvestigationsResult> {
  const post = await prisma.post.findUnique({
    where: {
      platform_externalId: {
        platform: input.platform,
        externalId: input.externalId,
      },
    },
  });

  if (!post) {
    return { post: null, investigations: [] };
  }

  const investigations = await prisma.investigation.findMany({
    where: {
      status: "COMPLETE",
      postVersion: {
        postId: post.id,
      },
    },
    orderBy: [
      {
        checkedAt: {
          sort: "desc",
          nulls: "last",
        },
      },
      { id: "desc" },
    ],
    include: {
      postVersion: {
        select: {
          contentBlob: {
            select: {
              contentHash: true,
            },
          },
          serverVerifiedAt: true,
        },
      },
      input: true,
      claims: {
        orderBy: {
          id: "asc",
        },
        select: {
          id: true,
          summary: true,
        },
      },
      _count: {
        select: {
          claims: true,
          corroborationCredits: true,
        },
      },
    },
  });

  return {
    post: {
      platform: parsePlatform(post.platform),
      externalId: post.externalId,
      url: post.url,
    },
    investigations: investigations.map((investigation) => {
      const lifecycle = parsePublicLifecycle({
        investigationId: investigation.id,
        provenance: investigation.input.provenance,
        serverVerifiedAt: investigation.postVersion.serverVerifiedAt,
        checkedAt: investigation.checkedAt,
      });
      return {
        id: investigation.id,
        contentHash: investigation.postVersion.contentBlob.contentHash,
        origin: lifecycle.origin,
        corroborationCount: investigation._count.corroborationCredits,
        checkedAt: lifecycle.checkedAt,
        claimCount: investigation._count.claims,
        claimSummaries: investigation.claims.map((claim) => ({
          id: claim.id,
          summary: claim.summary,
        })),
      };
    }),
  };
}

export async function searchPublicInvestigations(
  prisma: PrismaClient,
  input: PublicSearchInvestigationsInput,
): Promise<PublicSearchInvestigationsResult> {
  const pageRows = await loadSearchInvestigationPageRows(prisma, input);
  const hasMore = pageRows.length > input.limit;
  const pageIds = pageRows.slice(0, input.limit).map((row) => row.id);

  if (pageIds.length === 0) {
    return {
      investigations: [],
      hasMore,
    };
  }

  const investigations = await prisma.investigation.findMany({
    where: {
      id: {
        in: pageIds,
      },
    },
    include: {
      postVersion: {
        select: {
          contentBlob: {
            select: {
              contentHash: true,
            },
          },
          serverVerifiedAt: true,
          post: {
            select: {
              platform: true,
              externalId: true,
              url: true,
            },
          },
        },
      },
      input: true,
      claims: {
        orderBy: {
          id: "asc",
        },
        select: {
          id: true,
          summary: true,
        },
      },
      _count: {
        select: {
          claims: true,
          corroborationCredits: true,
        },
      },
    },
  });

  const investigationsById = new Map(
    investigations.map((investigation) => [investigation.id, investigation]),
  );

  return {
    investigations: pageIds.map((investigationId) => {
      const investigation = investigationsById.get(investigationId);
      if (investigation === undefined) {
        invariantViolation(
          `searchPublicInvestigations loaded page id ${investigationId} but could not hydrate it`,
        );
      }

      const lifecycle = parsePublicLifecycle({
        investigationId: investigation.id,
        provenance: investigation.input.provenance,
        serverVerifiedAt: investigation.postVersion.serverVerifiedAt,
        checkedAt: investigation.checkedAt,
      });
      return {
        id: investigation.id,
        contentHash: investigation.postVersion.contentBlob.contentHash,
        checkedAt: lifecycle.checkedAt,
        platform: parsePlatform(investigation.postVersion.post.platform),
        externalId: investigation.postVersion.post.externalId,
        url: investigation.postVersion.post.url,
        origin: lifecycle.origin,
        corroborationCount: investigation._count.corroborationCredits,
        claimCount: investigation._count.claims,
        claimSummaries: investigation.claims.map((claim) => ({
          id: claim.id,
          summary: claim.summary,
        })),
      };
    }),
    hasMore,
  };
}

export async function getPublicMetrics(
  prisma: PrismaClient,
  input: PublicMetricsInput,
): Promise<PublicMetricsResult> {
  const conditions = publicMetricsConditions(input);

  const result = await prisma.$queryRaw<
    {
      total_investigated: number;
      with_flags: number;
    }[]
  >`
    SELECT
      COUNT(DISTINCT pv."postId")::int AS total_investigated,
      COUNT(DISTINCT CASE
        WHEN EXISTS (SELECT 1 FROM "Claim" c WHERE c."investigationId" = i."id")
        THEN pv."postId"
      END)::int AS with_flags
    FROM "Investigation" i
    JOIN "PostVersion" pv ON pv."id" = i."postVersionId"
    JOIN "Post" p ON p."id" = pv."postId"
    WHERE ${Prisma.join(conditions, " AND ")}
  `;

  const { total_investigated, with_flags } = result[0] ?? {
    total_investigated: 0,
    with_flags: 0,
  };

  return {
    totalInvestigatedPosts: total_investigated,
    investigatedPostsWithFlags: with_flags,
    factCheckIncidence: total_investigated > 0 ? with_flags / total_investigated : 0,
  };
}
