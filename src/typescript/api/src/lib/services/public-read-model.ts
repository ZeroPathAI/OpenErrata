import { Prisma, type PrismaClient } from "$lib/generated/prisma/client";
import { contentProvenanceSchema, platformSchema, type Platform } from "@openerrata/shared";

function escapeLikePattern(query: string): string {
  return query.replace(/[\\%_]/g, (char) => `\\${char}`);
}

type PublicInvestigationOrigin =
  | {
      provenance: "SERVER_VERIFIED";
      serverVerifiedAt: Date;
    }
  | {
      provenance: "CLIENT_FALLBACK";
      fetchFailureReason: string;
    };

type PublicTrustSignals = {
  origin: PublicInvestigationOrigin;
  corroborationCount: number;
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
  checkedAt: Date;
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
  checkedAt: Date;
  claimCount: number;
};

type PublicPostInvestigationsResult = {
  post: PublicPost | null;
  investigations: PublicPostInvestigationSummary[];
};

type PublicSearchInvestigationSummary = PublicTrustSignals & {
  id: string;
  contentHash: string;
  checkedAt: Date;
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
  platform?: Platform | undefined;
  authorId?: string | undefined;
  windowStart?: string | undefined;
  windowEnd?: string | undefined;
};

type PublicSearchInvestigationsInput = {
  query?: string | undefined;
  platform?: Platform | undefined;
  limit: number;
  offset: number;
};

function parsePlatform(value: string): Platform {
  return platformSchema.parse(value);
}

function reportPublicLifecycleInvariantViolation(message: string): void {
  console.error(`Public read-model invariant violation: ${message}`);
}

function parsePublicOrigin(input: {
  investigationId: string;
  contentProvenance: string;
  serverVerifiedAt: Date | null;
  fetchFailureReason: string | null;
}): PublicInvestigationOrigin | null {
  let provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
  try {
    provenance = contentProvenanceSchema.parse(input.contentProvenance);
  } catch {
    reportPublicLifecycleInvariantViolation(
      `Investigation ${input.investigationId} has invalid contentProvenance ${input.contentProvenance}`,
    );
    return null;
  }

  if (provenance === "SERVER_VERIFIED") {
    if (input.serverVerifiedAt === null) {
      reportPublicLifecycleInvariantViolation(
        `Investigation ${input.investigationId} is SERVER_VERIFIED with null serverVerifiedAt`,
      );
      return null;
    }
    return {
      provenance: "SERVER_VERIFIED",
      serverVerifiedAt: input.serverVerifiedAt,
    };
  }

  if (input.fetchFailureReason === null) {
    reportPublicLifecycleInvariantViolation(
      `Investigation ${input.investigationId} is CLIENT_FALLBACK with null fetchFailureReason`,
    );
    return null;
  }
  if (input.fetchFailureReason.trim().length === 0) {
    reportPublicLifecycleInvariantViolation(
      `Investigation ${input.investigationId} is CLIENT_FALLBACK with empty fetchFailureReason`,
    );
    return null;
  }
  return {
    provenance: "CLIENT_FALLBACK",
    fetchFailureReason: input.fetchFailureReason,
  };
}

function requireCompleteCheckedAt(input: {
  investigationId: string;
  checkedAt: Date | null;
}): Date | null {
  if (input.checkedAt === null) {
    reportPublicLifecycleInvariantViolation(
      `Investigation ${input.investigationId} is COMPLETE with null checkedAt`,
    );
    return null;
  }
  return input.checkedAt;
}

function parsePublicLifecycle(input: {
  investigationId: string;
  contentProvenance: string;
  serverVerifiedAt: Date | null;
  fetchFailureReason: string | null;
  checkedAt: Date | null;
}): { origin: PublicInvestigationOrigin; checkedAt: Date } | null {
  const origin = parsePublicOrigin({
    investigationId: input.investigationId,
    contentProvenance: input.contentProvenance,
    serverVerifiedAt: input.serverVerifiedAt,
    fetchFailureReason: input.fetchFailureReason,
  });
  if (origin === null) {
    return null;
  }

  const checkedAt = requireCompleteCheckedAt({
    investigationId: input.investigationId,
    checkedAt: input.checkedAt,
  });
  if (checkedAt === null) {
    return null;
  }

  return {
    origin,
    checkedAt,
  };
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

  const lifecycle = parsePublicLifecycle({
    investigationId: investigation.id,
    contentProvenance: investigation.contentProvenance,
    serverVerifiedAt: investigation.serverVerifiedAt,
    fetchFailureReason: investigation.fetchFailureReason,
    checkedAt: investigation.checkedAt,
  });
  if (lifecycle === null) {
    return null;
  }

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
    investigations: investigations.flatMap((investigation) => {
      const lifecycle = parsePublicLifecycle({
        investigationId: investigation.id,
        contentProvenance: investigation.contentProvenance,
        serverVerifiedAt: investigation.serverVerifiedAt,
        fetchFailureReason: investigation.fetchFailureReason,
        checkedAt: investigation.checkedAt,
      });
      if (lifecycle === null) {
        return [];
      }

      return [
        {
          id: investigation.id,
          contentHash: investigation.contentHash,
          origin: lifecycle.origin,
          corroborationCount: investigation.corroborationCount,
          checkedAt: lifecycle.checkedAt,
          claimCount: investigation.claimCount,
        },
      ];
    }),
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
    investigations: investigations.flatMap((investigation) => {
      const lifecycle = parsePublicLifecycle({
        investigationId: investigation.id,
        contentProvenance: investigation.contentProvenance,
        serverVerifiedAt: investigation.serverVerifiedAt,
        fetchFailureReason: investigation.fetchFailureReason,
        checkedAt: investigation.checkedAt,
      });
      if (lifecycle === null) {
        return [];
      }

      return [
        {
          id: investigation.id,
          contentHash: investigation.contentHash,
          checkedAt: lifecycle.checkedAt,
          platform: parsePlatform(investigation.platform),
          externalId: investigation.externalId,
          url: investigation.url,
          origin: lifecycle.origin,
          corroborationCount: investigation.corroborationCount,
          claimCount: investigation.claimCount,
        },
      ];
    }),
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
