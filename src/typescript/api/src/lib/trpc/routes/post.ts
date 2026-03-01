/**
 * Extension-facing tRPC router.
 *
 * Each procedure is a thin handler that delegates to focused modules:
 * - `post/content-storage.ts` — content canonicalization and version management
 * - `post/investigation-queries.ts` — investigation loading, formatting, lifecycle
 * - `post/wikipedia.ts` — Wikipedia URL parsing and metadata normalization
 */

import { router, publicProcedure } from "../init.js";
import {
  registerObservedVersionInputSchema,
  registerObservedVersionOutputSchema,
  recordViewAndGetStatusInputSchema,
  viewPostOutputSchema,
  getInvestigationInputSchema,
  getInvestigationOutputSchema,
  investigateNowInputSchema,
  investigateNowOutputSchema,
  batchStatusInputSchema,
  batchStatusOutputSchema,
  settingsValidationOutputSchema,
  isExtensionVersionAtLeast,
  type ExtensionRuntimeErrorCode,
  type Platform,
} from "@openerrata/shared";
import { getOrCreateCurrentPrompt } from "$lib/services/prompt.js";
import { InvestigationWordLimitError } from "$lib/services/investigation-lifecycle.js";
import { maybeIncrementUniqueViewScore } from "$lib/services/view-credit.js";
import { attachOpenAiKeySourceIfPendingRun } from "$lib/services/user-key-source.js";
import { validateOpenAiApiKeyForSettings } from "$lib/services/openai-key-validation.js";
import { TRPCError } from "@trpc/server";
import { registerObservedVersion, findPostVersionById } from "./post/content-storage.js";
import {
  loadInvestigationWithClaims,
  findCompletedInvestigationByPostVersionId,
  findLatestServerVerifiedCompleteInvestigationForPost,
  selectSourceInvestigationForUpdate,
  toPriorInvestigationResult,
  formatClaims,
  ensureInvestigationsWithUpdateMetadata,
  maybeRecordCorroboration,
  unreachableInvestigationStatus,
  requireCompleteCheckedAtIso,
} from "./post/investigation-queries.js";

// ---------------------------------------------------------------------------
// Extension version gate
// ---------------------------------------------------------------------------

const UPGRADE_REQUIRED_ERROR_CODE: ExtensionRuntimeErrorCode = "UPGRADE_REQUIRED";
const MALFORMED_EXTENSION_VERSION_ERROR_CODE: ExtensionRuntimeErrorCode =
  "MALFORMED_EXTENSION_VERSION";

function upgradeRequiredError(input: {
  minimumVersion: string;
  currentVersion: string | null;
}): TRPCError {
  return new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `Extension upgrade required: minimum supported version is ${input.minimumVersion}; received ${input.currentVersion ?? "missing"}.`,
    cause: {
      openerrataCode: UPGRADE_REQUIRED_ERROR_CODE,
      minimumSupportedExtensionVersion: input.minimumVersion,
      receivedExtensionVersion: input.currentVersion,
    },
  });
}

/**
 * Validates that the client extension version meets the minimum required
 * version. Returns the validated version string on success so callers can
 * narrow the context type from `string | null` to `string`.
 */
function assertSupportedExtensionVersion(input: {
  minimumSupportedExtensionVersion: string;
  extensionVersion: string | null;
}): string {
  const minimumVersion = input.minimumSupportedExtensionVersion;
  const currentVersion = input.extensionVersion;

  if (currentVersion === null) {
    throw upgradeRequiredError({
      minimumVersion,
      currentVersion: null,
    });
  }

  const atLeastMinimum = isExtensionVersionAtLeast(currentVersion, minimumVersion);
  if (atLeastMinimum === true) {
    return currentVersion;
  }

  if (atLeastMinimum === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Malformed extension version header: "${currentVersion}"`,
      cause: { openerrataCode: MALFORMED_EXTENSION_VERSION_ERROR_CODE },
    });
  }

  throw upgradeRequiredError({
    minimumVersion,
    currentVersion,
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const extensionProcedure = publicProcedure.use(async ({ ctx, next }) => {
  const extensionVersion = assertSupportedExtensionVersion(ctx);
  return next({ ctx: { extensionVersion } });
});

export const postRouter = router({
  registerObservedVersion: extensionProcedure
    .input(registerObservedVersionInputSchema)
    .output(registerObservedVersionOutputSchema)
    .mutation(async ({ input, ctx }) => {
      const postVersion = await registerObservedVersion(ctx.prisma, input);

      return {
        platform: postVersion.post.platform,
        externalId: postVersion.post.externalId,
        versionHash: postVersion.versionHash,
        postVersionId: postVersion.id,
        provenance: postVersion.contentProvenance,
      };
    }),

  recordViewAndGetStatus: extensionProcedure
    .input(recordViewAndGetStatusInputSchema)
    .output(viewPostOutputSchema)
    .mutation(async ({ input, ctx }) => {
      const postVersion = await findPostVersionById(ctx.prisma, input.postVersionId);
      if (postVersion === null) {
        return {
          investigationState: "NOT_INVESTIGATED" as const,
          claims: null,
          priorInvestigationResult: null,
        };
      }

      await ctx.prisma.post.update({
        where: { id: postVersion.post.id },
        data: {
          viewCount: { increment: 1 },
          lastViewedAt: new Date(),
        },
      });

      await maybeIncrementUniqueViewScore(
        ctx.prisma,
        postVersion.post.id,
        ctx.viewerKey,
        ctx.ipRangeKey,
      );

      await maybeRecordCorroboration(
        ctx.prisma,
        postVersion.id,
        ctx.viewerKey,
        ctx.isAuthenticated,
      );

      const complete = await findCompletedInvestigationByPostVersionId(ctx.prisma, postVersion.id);

      if (complete) {
        return {
          investigationState: "INVESTIGATED" as const,
          provenance: complete.postVersion.contentProvenance,
          claims: formatClaims(complete.claims),
        };
      }

      const latestServerVerifiedSource = await findLatestServerVerifiedCompleteInvestigationForPost(
        ctx.prisma,
        postVersion.post.id,
      );

      const sourceInvestigation = selectSourceInvestigationForUpdate(
        latestServerVerifiedSource,
        postVersion.id,
      );

      return {
        investigationState: "NOT_INVESTIGATED" as const,
        claims: null,
        priorInvestigationResult: toPriorInvestigationResult(sourceInvestigation),
      };
    }),

  getInvestigation: extensionProcedure
    .input(getInvestigationInputSchema)
    .output(getInvestigationOutputSchema)
    .query(async ({ input, ctx }) => {
      const investigation = await loadInvestigationWithClaims(ctx.prisma, input.investigationId);

      if (!investigation) {
        return {
          investigationState: "NOT_INVESTIGATED" as const,
          claims: null,
          priorInvestigationResult: null,
        };
      }

      const provenance = investigation.postVersion.contentProvenance;

      switch (investigation.status) {
        case "COMPLETE":
          return {
            investigationState: "INVESTIGATED" as const,
            provenance,
            claims: formatClaims(investigation.claims),
            checkedAt: requireCompleteCheckedAtIso(investigation.id, investigation.checkedAt),
          };
        case "PENDING":
        case "PROCESSING":
          return {
            investigationState: "INVESTIGATING" as const,
            status: investigation.status,
            provenance,
            claims: null,
            priorInvestigationResult:
              investigation.parentInvestigation !== null &&
              investigation.parentInvestigation.status === "COMPLETE"
                ? {
                    oldClaims: formatClaims(investigation.parentInvestigation.claims),
                    sourceInvestigationId: investigation.parentInvestigation.id,
                  }
                : null,
            checkedAt: investigation.checkedAt?.toISOString(),
          };
        case "FAILED":
          return {
            investigationState: "FAILED" as const,
            provenance,
            claims: null,
            checkedAt: investigation.checkedAt?.toISOString(),
          };
        default:
          return unreachableInvestigationStatus(investigation.status);
      }
    }),

  investigateNow: extensionProcedure
    .input(investigateNowInputSchema)
    .output(investigateNowOutputSchema)
    .mutation(async ({ input, ctx }) => {
      if (!ctx.canInvestigate) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Valid API key or x-openai-api-key required for investigateNow",
        });
      }

      const postVersion = await findPostVersionById(ctx.prisma, input.postVersionId);
      if (postVersion === null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Unknown post version",
        });
      }

      const complete = await findCompletedInvestigationByPostVersionId(ctx.prisma, postVersion.id);
      if (complete) {
        return {
          investigationId: complete.id,
          status: complete.status,
          provenance: complete.postVersion.contentProvenance,
          claims: formatClaims(complete.claims),
        };
      }

      const latestServerVerifiedSource = await findLatestServerVerifiedCompleteInvestigationForPost(
        ctx.prisma,
        postVersion.post.id,
      );

      const sourceInvestigation = selectSourceInvestigationForUpdate(
        latestServerVerifiedSource,
        postVersion.id,
      );

      const prompt = await getOrCreateCurrentPrompt();
      try {
        const { investigation } = await ensureInvestigationsWithUpdateMetadata({
          prisma: ctx.prisma,
          postVersion,
          promptId: prompt.id,
          sourceInvestigation,
          onPendingRun: async ({ prisma, run }) => {
            if (ctx.userOpenAiApiKey === null) return;
            await attachOpenAiKeySourceIfPendingRun(prisma, {
              runId: run.id,
              openAiApiKey: ctx.userOpenAiApiKey,
            });
          },
        });

        switch (investigation.status) {
          case "COMPLETE": {
            const completed = await loadInvestigationWithClaims(ctx.prisma, investigation.id);
            if (!completed) {
              throw new TRPCError({
                code: "INTERNAL_SERVER_ERROR",
                message: `Investigation ${investigation.id} disappeared after completion lookup`,
              });
            }

            return {
              investigationId: completed.id,
              status: completed.status,
              provenance: completed.postVersion.contentProvenance,
              claims: formatClaims(completed.claims),
            };
          }
          case "PENDING":
          case "PROCESSING":
          case "FAILED":
            return {
              investigationId: investigation.id,
              status: investigation.status,
              provenance: postVersion.contentProvenance,
            };
          default:
            return unreachableInvestigationStatus(investigation.status);
        }
      } catch (error) {
        if (error instanceof InvestigationWordLimitError) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: error.message,
          });
        }
        throw error;
      }
    }),

  validateSettings: extensionProcedure
    .output(settingsValidationOutputSchema)
    .query(async ({ ctx }) => {
      const openaiValidation = await validateOpenAiApiKeyForSettings(ctx.userOpenAiApiKey);

      return settingsValidationOutputSchema.parse({
        instanceApiKeyAccepted: ctx.isAuthenticated,
        ...openaiValidation,
      });
    }),

  batchStatus: extensionProcedure
    .input(batchStatusInputSchema)
    .output(batchStatusOutputSchema)
    .query(async ({ input, ctx }) => {
      const lookupKey = (platform: Platform, externalId: string, versionHash: string): string =>
        `${platform}:${externalId}:${versionHash}`;

      const versions =
        input.posts.length === 0
          ? []
          : await ctx.prisma.postVersion.findMany({
              where: {
                OR: input.posts.map((post) => ({
                  versionHash: post.versionHash,
                  post: {
                    platform: post.platform,
                    externalId: post.externalId,
                  },
                })),
              },
              select: {
                versionHash: true,
                post: {
                  select: {
                    platform: true,
                    externalId: true,
                  },
                },
                investigation: {
                  select: {
                    status: true,
                    _count: {
                      select: {
                        claims: true,
                      },
                    },
                  },
                },
              },
            });

      const byLookupKey = new Map<string, (typeof versions)[number]>();
      for (const version of versions) {
        byLookupKey.set(
          lookupKey(version.post.platform, version.post.externalId, version.versionHash),
          version,
        );
      }

      const statuses = input.posts.map((post) => {
        const matched = byLookupKey.get(
          lookupKey(post.platform, post.externalId, post.versionHash),
        );

        if (matched?.investigation?.status !== "COMPLETE") {
          return {
            platform: post.platform,
            externalId: post.externalId,
            investigationState: "NOT_INVESTIGATED" as const,
            incorrectClaimCount: 0 as const,
          };
        }

        return {
          platform: post.platform,
          externalId: post.externalId,
          investigationState: "INVESTIGATED" as const,
          incorrectClaimCount: matched.investigation._count.claims,
        };
      });

      return { statuses };
    }),
});
