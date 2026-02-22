import { Prisma, type PrismaClient } from "$lib/generated/prisma/client";
import { contentProvenanceSchema, platformSchema, type Platform } from "@openerrata/shared";

function escapeLikePattern(query: string): string {
  return query.replace(/[\\%_]/g, (char) => `\\${char}`);
}

type PublicTrustSignals = {
  provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
  corroborationCount: number;
  serverVerifiedAt: Date | null;
  fetchFailureReason: string | null;
};

type PublicClaimSource = {
  url: string;
  title: string;
  snippet: string;
};

type PublicClaim = {
  id: string;
  text: string;
  context: string;
  summary: string;
  reasoning: string;
  sources: PublicClaimSource[];
};

type PublicInvestigation = PublicTrustSignals & {
  id: string;
  checkedAt: Date | null;
  promptVersion: string;
  provider: string;
  model: string;
};

type PublicPost = {
  platform: Platform;
  externalId: string;
  url: string;
};

type PublicInvestigationResult = {
  investigation: PublicInvestigation;
  post: PublicPost;
  claims: PublicClaim[];
};

type PublicPostInvestigationSummary = PublicTrustSignals & {
  id: string;
  contentHash: string;
  checkedAt: Date | null;
  claimCount: number;
};

type PublicPostInvestigationsResult = {
  post: PublicPost | null;
  investigations: PublicPostInvestigationSummary[];
};

type PublicSearchInvestigationSummary = PublicTrustSignals & {
  id: string;
  contentHash: string;
  checkedAt: Date | null;
  platform: Platform;
  externalId: string;
  url: string;
  claimCount: number;
};

type PublicSearchInvestigationsResult = {
  investigations: PublicSearchInvestigationSummary[];
};

type PublicMetricsResult = {
  totalInvestigatedPosts: number;
  investigatedPostsWithFlags: number;
  factCheckIncidence: number;
};

type PublicMetricsInput = {
  platform?: Platform;
  authorId?: string;
  windowStart?: string;
  windowEnd?: string;
};

type PublicSearchInvestigationsInput = {
  query?: string;
  platform?: Platform;
  limit: number;
  offset: number;
};

function parseProvenance(value: string): PublicTrustSignals["provenance"] {
  return contentProvenanceSchema.parse(value);
}

function parsePlatform(value: string): Platform {
  return platformSchema.parse(value);
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
      post: true,
      prompt: true,
      claims: { include: { sources: true } },
      _count: { select: { corroborationCredits: true } },
    },
  });

  if (!investigation) {
    return null;
  }

  return {
    investigation: {
      id: investigation.id,
      provenance: parseProvenance(investigation.contentProvenance),
      corroborationCount: investigation._count.corroborationCredits,
      serverVerifiedAt: investigation.serverVerifiedAt,
      fetchFailureReason: investigation.fetchFailureReason,
      checkedAt: investigation.checkedAt,
      promptVersion: investigation.prompt.version,
      provider: investigation.provider,
      model: investigation.model,
    },
    post: {
      platform: parsePlatform(investigation.post.platform),
      externalId: investigation.post.externalId,
      url: investigation.post.url,
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

  const investigations = await prisma.$queryRaw<
    Array<{
      id: string;
      contentHash: string;
      contentProvenance: string;
      serverVerifiedAt: Date | null;
      fetchFailureReason: string | null;
      checkedAt: Date | null;
      claimCount: number;
      corroborationCount: number;
    }>
  >`
    SELECT
      i."id",
      i."contentHash",
      i."contentProvenance",
      i."serverVerifiedAt",
      i."fetchFailureReason",
      i."checkedAt",
      (SELECT COUNT(*) FROM "Claim" c WHERE c."investigationId" = i."id")::int AS "claimCount",
      (SELECT COUNT(*) FROM "CorroborationCredit" cc WHERE cc."investigationId" = i."id")::int AS "corroborationCount"
    FROM "Investigation" i
    WHERE i."postId" = ${post.id}
      AND i."status" = 'COMPLETE'
    ORDER BY i."checkedAt" DESC NULLS LAST, i."id" DESC
  `;

  return {
    post: {
      platform: parsePlatform(post.platform),
      externalId: post.externalId,
      url: post.url,
    },
    investigations: investigations.map((investigation) => ({
      id: investigation.id,
      contentHash: investigation.contentHash,
      provenance: parseProvenance(investigation.contentProvenance),
      corroborationCount: investigation.corroborationCount,
      serverVerifiedAt: investigation.serverVerifiedAt,
      fetchFailureReason: investigation.fetchFailureReason,
      checkedAt: investigation.checkedAt,
      claimCount: investigation.claimCount,
    })),
  };
}

export async function searchPublicInvestigations(
  prisma: PrismaClient,
  input: PublicSearchInvestigationsInput,
): Promise<PublicSearchInvestigationsResult> {
  const platformFilter = input.platform
    ? Prisma.sql`AND p."platform" = ${input.platform}`
    : Prisma.empty;
  const textFilter = input.query
    ? Prisma.sql`AND i."contentText" ILIKE ${`%${escapeLikePattern(input.query)}%`} ESCAPE '\\'`
    : Prisma.empty;

  const investigations = await prisma.$queryRaw<
    Array<{
      id: string;
      contentHash: string;
      checkedAt: Date | null;
      platform: string;
      externalId: string;
      url: string;
      contentProvenance: string;
      serverVerifiedAt: Date | null;
      fetchFailureReason: string | null;
      claimCount: number;
      corroborationCount: number;
    }>
  >`
    SELECT
      i."id",
      i."contentHash",
      i."checkedAt",
      p."platform",
      p."externalId",
      p."url",
      i."contentProvenance",
      i."serverVerifiedAt",
      i."fetchFailureReason",
      (SELECT COUNT(*) FROM "Claim" c WHERE c."investigationId" = i."id")::int AS "claimCount",
      (SELECT COUNT(*) FROM "CorroborationCredit" cc WHERE cc."investigationId" = i."id")::int AS "corroborationCount"
    FROM "Investigation" i
    JOIN "Post" p ON p."id" = i."postId"
    WHERE i."status" = 'COMPLETE'
      ${platformFilter}
      ${textFilter}
    ORDER BY i."checkedAt" DESC NULLS LAST, i."id" DESC
    LIMIT ${input.limit} OFFSET ${input.offset}
  `;

  return {
    investigations: investigations.map((investigation) => ({
      id: investigation.id,
      contentHash: investigation.contentHash,
      checkedAt: investigation.checkedAt,
      platform: parsePlatform(investigation.platform),
      externalId: investigation.externalId,
      url: investigation.url,
      provenance: parseProvenance(investigation.contentProvenance),
      corroborationCount: investigation.corroborationCount,
      serverVerifiedAt: investigation.serverVerifiedAt,
      fetchFailureReason: investigation.fetchFailureReason,
      claimCount: investigation.claimCount,
    })),
  };
}

export async function getPublicMetrics(
  prisma: PrismaClient,
  input: PublicMetricsInput,
): Promise<PublicMetricsResult> {
  const conditions: Prisma.Sql[] = [Prisma.sql`i."status" = 'COMPLETE'`];

  if (input.platform) {
    conditions.push(Prisma.sql`p."platform" = ${input.platform}`);
  }
  if (input.authorId) {
    conditions.push(Prisma.sql`p."authorId" = ${input.authorId}`);
  }
  if (input.windowStart) {
    conditions.push(Prisma.sql`i."checkedAt" >= ${input.windowStart}`);
  }
  if (input.windowEnd) {
    conditions.push(Prisma.sql`i."checkedAt" <= ${input.windowEnd}`);
  }

  const result = await prisma.$queryRaw<
    Array<{
      total_investigated: number;
      with_flags: number;
    }>
  >`
    SELECT
      COUNT(DISTINCT i."postId")::int AS total_investigated,
      COUNT(DISTINCT CASE
        WHEN EXISTS (SELECT 1 FROM "Claim" c WHERE c."investigationId" = i."id")
        THEN i."postId"
      END)::int AS with_flags
    FROM "Investigation" i
    JOIN "Post" p ON p."id" = i."postId"
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
