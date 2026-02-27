import { router, publicProcedure } from "../init.js";
import {
  getPublicInvestigationInputSchema,
  getPostInvestigationsInputSchema,
  searchInvestigationsInputSchema,
  getMetricsInputSchema,
  publicGetInvestigationOutputSchema,
  publicGetPostInvestigationsOutputSchema,
  publicSearchInvestigationsOutputSchema,
  publicGetMetricsOutputSchema,
} from "@openerrata/shared";
import {
  getPublicInvestigationById,
  getPublicPostInvestigations,
  searchPublicInvestigations,
  getPublicMetrics,
} from "$lib/services/public-read-model.js";

type PublicOrigin =
  | {
      provenance: "SERVER_VERIFIED";
      serverVerifiedAt: Date;
    }
  | {
      provenance: "CLIENT_FALLBACK";
      fetchFailureReason: string;
    };

function toOriginOutput(origin: PublicOrigin) {
  if (origin.provenance === "SERVER_VERIFIED") {
    return {
      provenance: "SERVER_VERIFIED" as const,
      serverVerifiedAt: origin.serverVerifiedAt.toISOString(),
    };
  }
  return {
    provenance: "CLIENT_FALLBACK" as const,
    fetchFailureReason: origin.fetchFailureReason,
  };
}

export const publicRouter = router({
  getInvestigation: publicProcedure
    .input(getPublicInvestigationInputSchema)
    .output(publicGetInvestigationOutputSchema)
    .query(async ({ input, ctx }) => {
      const result = await getPublicInvestigationById(ctx.prisma, input.investigationId);
      if (!result) {
        return null;
      }

      return {
        investigation: {
          id: result.investigation.id,
          corroborationCount: result.investigation.corroborationCount,
          checkedAt: result.investigation.checkedAt.toISOString(),
          origin: toOriginOutput(result.investigation.origin),
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
    .output(publicGetPostInvestigationsOutputSchema)
    .query(async ({ input, ctx }) => {
      const result = await getPublicPostInvestigations(ctx.prisma, input);
      return {
        post: result.post,
        investigations: result.investigations.map((investigation) => ({
          id: investigation.id,
          contentHash: investigation.contentHash,
          corroborationCount: investigation.corroborationCount,
          checkedAt: investigation.checkedAt.toISOString(),
          claimCount: investigation.claimCount,
          origin: toOriginOutput(investigation.origin),
        })),
      };
    }),

  searchInvestigations: publicProcedure
    .input(searchInvestigationsInputSchema)
    .output(publicSearchInvestigationsOutputSchema)
    .query(async ({ input, ctx }) => {
      const result = await searchPublicInvestigations(ctx.prisma, input);

      return {
        investigations: result.investigations.map((investigation) => ({
          id: investigation.id,
          contentHash: investigation.contentHash,
          checkedAt: investigation.checkedAt.toISOString(),
          platform: investigation.platform,
          externalId: investigation.externalId,
          url: investigation.url,
          corroborationCount: investigation.corroborationCount,
          claimCount: investigation.claimCount,
          origin: toOriginOutput(investigation.origin),
        })),
      };
    }),

  getMetrics: publicProcedure
    .input(getMetricsInputSchema)
    .output(publicGetMetricsOutputSchema)
    .query(async ({ input, ctx }) => getPublicMetrics(ctx.prisma, input)),
});
