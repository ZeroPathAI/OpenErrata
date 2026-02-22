import { router, publicProcedure } from "../init.js";
import {
  getPublicInvestigationInputSchema,
  getPostInvestigationsInputSchema,
  searchInvestigationsInputSchema,
  getMetricsInputSchema,
} from "@openerrata/shared";
import {
  getPublicInvestigationById,
  getPublicPostInvestigations,
  searchPublicInvestigations,
  getPublicMetrics,
} from "$lib/services/public-read-model.js";

export const publicRouter = router({
  getInvestigation: publicProcedure
    .input(getPublicInvestigationInputSchema)
    .query(async ({ input, ctx }) => {
      const result = await getPublicInvestigationById(
        ctx.prisma,
        input.investigationId,
      );
      if (!result) {
        return null;
      }

      return {
        investigation: {
          id: result.investigation.id,
          status: "COMPLETE" as const,
          provenance: result.investigation.provenance,
          corroborationCount: result.investigation.corroborationCount,
          checkedAt: result.investigation.checkedAt?.toISOString(),
          serverVerifiedAt: result.investigation.serverVerifiedAt?.toISOString(),
          fetchFailureReason:
            result.investigation.fetchFailureReason ?? undefined,
          promptVersion: result.investigation.promptVersion,
          provider: result.investigation.provider,
          model: result.investigation.model,
        },
        post: result.post,
        claims: result.claims,
      };
    }),

  getPostInvestigations: publicProcedure
    .input(getPostInvestigationsInputSchema)
    .query(async ({ input, ctx }) => {
      const result = await getPublicPostInvestigations(ctx.prisma, input);
      return {
        post: result.post,
        investigations: result.investigations.map((investigation) => ({
          id: investigation.id,
          contentHash: investigation.contentHash,
          status: "COMPLETE" as const,
          provenance: investigation.provenance,
          corroborationCount: investigation.corroborationCount,
          serverVerifiedAt: investigation.serverVerifiedAt?.toISOString(),
          fetchFailureReason: investigation.fetchFailureReason ?? undefined,
          checkedAt: investigation.checkedAt?.toISOString(),
          claimCount: investigation.claimCount,
        })),
      };
    }),

  searchInvestigations: publicProcedure
    .input(searchInvestigationsInputSchema)
    .query(async ({ input, ctx }) => {
      const result = await searchPublicInvestigations(ctx.prisma, input);

      return {
        investigations: result.investigations.map((investigation) => ({
          id: investigation.id,
          contentHash: investigation.contentHash,
          checkedAt: investigation.checkedAt?.toISOString(),
          platform: investigation.platform,
          externalId: investigation.externalId,
          url: investigation.url,
          provenance: investigation.provenance,
          corroborationCount: investigation.corroborationCount,
          serverVerifiedAt: investigation.serverVerifiedAt?.toISOString(),
          fetchFailureReason: investigation.fetchFailureReason ?? undefined,
          claimCount: investigation.claimCount,
        })),
      };
    }),

  getMetrics: publicProcedure
    .input(getMetricsInputSchema)
    .query(async ({ input, ctx }) => getPublicMetrics(ctx.prisma, input)),
});
