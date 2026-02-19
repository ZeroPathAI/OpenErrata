import { router, publicProcedure } from "../init.js";
import { Prisma } from "$lib/generated/prisma/client";
import {
  getPublicInvestigationInputSchema,
  getPostInvestigationsInputSchema,
  searchInvestigationsInputSchema,
  getMetricsInputSchema,
} from "@truesight/shared";

function escapeLikePattern(query: string): string {
  return query.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export const publicRouter = router({
  getInvestigation: publicProcedure
    .input(getPublicInvestigationInputSchema)
    .query(async ({ input, ctx }) => {
      // Only return publicly eligible investigations (spec §2.10)
      const eligibility = await ctx.prisma.investigationPublicEligibility.findUnique({
        where: { investigationId: input.investigationId },
        select: { isPubliclyEligible: true },
      });

      if (!eligibility?.isPubliclyEligible) {
        return null;
      }

      const investigation = await ctx.prisma.investigation.findFirst({
        where: {
          id: input.investigationId,
          status: "COMPLETE",
        },
        include: {
          post: true,
          prompt: true,
          claims: { include: { sources: true } },
        },
      });

      if (!investigation) {
        return null;
      }

      return {
        investigation: {
          id: investigation.id,
          status: investigation.status,
          provenance: investigation.contentProvenance,
          checkedAt: investigation.checkedAt?.toISOString(),
          promptVersion: investigation.prompt.version,
          provider: investigation.provider,
          model: investigation.model,
        },
        post: {
          platform: investigation.post.platform,
          externalId: investigation.post.externalId,
          url: investigation.post.url,
        },
        claims: investigation.claims.map((c) => ({
          id: c.id,
          text: c.text,
          context: c.context,
          summary: c.summary,
          reasoning: c.reasoning,
          sources: c.sources.map((s) => ({
            url: s.url,
            title: s.title,
            snippet: s.snippet,
          })),
        })),
      };
    }),

  getPostInvestigations: publicProcedure
    .input(getPostInvestigationsInputSchema)
    .query(async ({ input, ctx }) => {
      const post = await ctx.prisma.post.findUnique({
        where: {
          platform_externalId: {
            platform: input.platform,
            externalId: input.externalId,
          },
        },
      });

      if (!post) return { post: null, investigations: [] };

      const investigations = await ctx.prisma.$queryRaw<
        Array<{
          id: string;
          contentHash: string;
          status: string;
          contentProvenance: string;
          checkedAt: Date | null;
          claimCount: number;
        }>
      >`
        SELECT i."id", i."contentHash", i."status", i."contentProvenance",
               i."checkedAt",
               (SELECT COUNT(*) FROM "Claim" c WHERE c."investigationId" = i."id")::int AS "claimCount"
        FROM "Investigation" i
        JOIN "investigation_public_eligibility" ipe ON ipe."investigationId" = i."id"
        WHERE i."postId" = ${post.id}
          AND i."status" = 'COMPLETE'
          AND ipe."isPubliclyEligible" = true
        ORDER BY i."checkedAt" DESC NULLS LAST, i."id" DESC
      `;

      return {
        post: {
          platform: post.platform,
          externalId: post.externalId,
          url: post.url,
        },
        investigations: investigations.map((i) => ({
          id: i.id,
          contentHash: i.contentHash,
          status: i.status,
          provenance: i.contentProvenance,
          checkedAt: i.checkedAt?.toISOString(),
          claimCount: i.claimCount,
        })),
      };
    }),

  searchInvestigations: publicProcedure
    .input(searchInvestigationsInputSchema)
    .query(async ({ input, ctx }) => {
      const { query, platform, limit, offset } = input;

      const platformFilter = platform
        ? Prisma.sql`AND p."platform" = ${platform}`
        : Prisma.empty;
      const textFilter = query
        ? Prisma.sql`AND i."contentText" ILIKE ${`%${escapeLikePattern(query)}%`} ESCAPE '\\'`
        : Prisma.empty;

      const investigations = await ctx.prisma.$queryRaw<
        Array<{
          id: string;
          contentHash: string;
          checkedAt: Date | null;
          platform: string;
          externalId: string;
          url: string;
          claimCount: number;
        }>
      >`
        SELECT i."id", i."contentHash", i."checkedAt",
               p."platform", p."externalId", p."url",
               (SELECT COUNT(*) FROM "Claim" c WHERE c."investigationId" = i."id")::int AS "claimCount"
        FROM "Investigation" i
        JOIN "Post" p ON p."id" = i."postId"
        JOIN "investigation_public_eligibility" ipe ON ipe."investigationId" = i."id"
        WHERE i."status" = 'COMPLETE'
          AND ipe."isPubliclyEligible" = true
          ${platformFilter}
          ${textFilter}
        ORDER BY i."checkedAt" DESC NULLS LAST, i."id" DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

      return {
        investigations: investigations.map((i) => ({
          id: i.id,
          contentHash: i.contentHash,
          checkedAt: i.checkedAt?.toISOString(),
          platform: i.platform,
          externalId: i.externalId,
          url: i.url,
          claimCount: i.claimCount,
        })),
      };
    }),

  getMetrics: publicProcedure
    .input(getMetricsInputSchema)
    .query(async ({ input, ctx }) => {
      const conditions: Prisma.Sql[] = [
        Prisma.sql`i."status" = 'COMPLETE'`,
        Prisma.sql`ipe."isPubliclyEligible" = true`,
      ];

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

      const result = await ctx.prisma.$queryRaw<
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
         JOIN "investigation_public_eligibility" ipe ON ipe."investigationId" = i."id"
         WHERE ${Prisma.join(conditions, " AND ")}
      `;

      const { total_investigated, with_flags } = result[0] ?? {
        total_investigated: 0,
        with_flags: 0,
      };

      return {
        totalInvestigatedPosts: total_investigated,
        investigatedPostsWithFlags: with_flags,
        factCheckIncidence:
          total_investigated > 0 ? with_flags / total_investigated : 0,
      };
    }),
});
