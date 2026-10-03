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
import { TRPCError } from "@trpc/server";
import {
  InvestigationWordLimitError,
  requestInvestigation,
  UserOpenAiKeyRejectedError,
  type InvestigationRequester,
} from "$lib/services/investigate-now.js";
import { maybeIncrementUniqueViewScore } from "$lib/services/view-credit.js";
import { validateOpenAiApiKeyForSettings } from "$lib/services/openai-key-validation.js";
import { registerObservedVersion, findPostVersionById } from "./post/content-storage.js";
import {
  loadInvestigationWithClaims,
  findCarriedForwardClaims,
  formatClaims,
  maybeRecordCorroboration,
  unreachableInvestigationStatus,
  requireCompleteCheckedAtIso,
  prismaInvestigationRepository,
  parseProgressClaims,
  type InvestigationRepository,
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
// investigateNow funding
// ---------------------------------------------------------------------------

/**
 * Who would pay for a run this investigateNow admits: the request's own
 * OpenAI key when it sends one, otherwise the instance key it authenticated
 * with. Requests with neither cannot ask for investigations.
 */
function investigationRequester(ctx: {
  isAuthenticated: boolean;
  userOpenAiApiKey: string | null;
}): InvestigationRequester {
  if (ctx.userOpenAiApiKey !== null) {
    return { kind: "USER_OPENAI_KEY", apiKey: ctx.userOpenAiApiKey };
  }
  if (ctx.isAuthenticated) {
    return { kind: "INSTANCE_API_KEY" };
  }
  throw new TRPCError({
    code: "UNAUTHORIZED",
    message: "Valid API key or x-openai-api-key required for investigateNow",
  });
}

function userOpenAiKeyRejectedError(error: UserOpenAiKeyRejectedError): TRPCError {
  const { outcome } = error;
  switch (outcome.openaiApiKeyStatus) {
    case "missing":
      return new TRPCError({ code: "UNAUTHORIZED", message: "x-openai-api-key is empty" });
    case "format_invalid":
    case "invalid":
      return new TRPCError({
        code: "UNAUTHORIZED",
        message: `x-openai-api-key was rejected: ${outcome.openaiApiKeyMessage}`,
      });
    case "authenticated_restricted":
      return new TRPCError({
        code: "FORBIDDEN",
        message: `x-openai-api-key cannot run investigations: ${outcome.openaiApiKeyMessage}`,
      });
    case "error":
      return new TRPCError({
        code: "BAD_GATEWAY",
        message: `Could not verify x-openai-api-key with OpenAI: ${outcome.openaiApiKeyMessage}`,
      });
  }
}

// ---------------------------------------------------------------------------
// Investigation status projection
// ---------------------------------------------------------------------------

type LoadedInvestigation = NonNullable<Awaited<ReturnType<typeof loadInvestigationWithClaims>>>;

/**
 * Client-facing status of one investigation. Shared by `recordViewAndGetStatus`
 * (lookup by post version) and `getInvestigation` (lookup by id) so a viewer
 * sees the same projection — including live progress claims and the interim
 * claims carried forward to the version (spec §2.8) — however the
 * investigation was found.
 */
async function projectInvestigationStatus(
  repo: InvestigationRepository,
  investigation: LoadedInvestigation,
) {
  const provenance = investigation.input.provenance;

  switch (investigation.status) {
    case "COMPLETE":
      return {
        investigationState: "INVESTIGATED" as const,
        provenance,
        claims: formatClaims(investigation.claims),
      };
    case "PENDING":
    case "PROCESSING": {
      const progress = parseProgressClaims(investigation.lease?.progressClaims ?? null);
      return {
        investigationState: "INVESTIGATING" as const,
        status: investigation.status,
        provenance,
        pendingClaims: progress.pendingClaims,
        confirmedClaims: progress.confirmedClaims,
        priorInvestigationResult: await findCarriedForwardClaims(repo, {
          id: investigation.postVersion.id,
          postId: investigation.postVersion.postId,
          contentText: investigation.postVersion.contentBlob.contentText,
        }),
      };
    }
    case "FAILED":
      return {
        investigationState: "FAILED" as const,
        provenance,
      };
    default:
      return unreachableInvestigationStatus(investigation.status);
  }
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
        provenance: postVersion.serverVerifiedAt !== null ? "SERVER_VERIFIED" : "CLIENT_FALLBACK",
      };
    }),

  recordViewAndGetStatus: extensionProcedure
    .input(recordViewAndGetStatusInputSchema)
    .output(viewPostOutputSchema)
    .mutation(async ({ input, ctx }) => {
      const postVersion = await findPostVersionById(ctx.prisma, input.postVersionId);
      if (postVersion === null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Unknown post version",
        });
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

      const repo = prismaInvestigationRepository(ctx.prisma);
      await maybeRecordCorroboration(repo, postVersion.id, ctx.viewerKey, ctx.isAuthenticated);

      // At most one investigation exists per post version (spec §3.5). If it
      // exists in any state, report that state with its id: a viewer of a post
      // someone else (or the selector) queued must be able to poll it.
      const existing = await ctx.prisma.investigation.findUnique({
        where: { postVersionId: postVersion.id },
        select: { id: true },
      });
      const investigation =
        existing === null ? null : await loadInvestigationWithClaims(repo, existing.id);
      if (investigation !== null) {
        return {
          investigationId: investigation.id,
          ...(await projectInvestigationStatus(repo, investigation)),
        };
      }

      return {
        investigationState: "NOT_INVESTIGATED" as const,
        priorInvestigationResult: await findCarriedForwardClaims(repo, {
          id: postVersion.id,
          postId: postVersion.post.id,
          contentText: postVersion.contentBlob.contentText,
        }),
      };
    }),

  getInvestigation: extensionProcedure
    .input(getInvestigationInputSchema)
    .output(getInvestigationOutputSchema)
    .query(async ({ input, ctx }) => {
      const repo = prismaInvestigationRepository(ctx.prisma);
      const investigation = await loadInvestigationWithClaims(repo, input.investigationId);

      if (!investigation) {
        return {
          investigationState: "NOT_INVESTIGATED" as const,
          priorInvestigationResult: null,
        };
      }

      const status = await projectInvestigationStatus(repo, investigation);
      if (status.investigationState === "INVESTIGATED") {
        return {
          ...status,
          checkedAt: requireCompleteCheckedAtIso(investigation.id, investigation.checkedAt),
        };
      }
      return status;
    }),

  investigateNow: extensionProcedure
    .input(investigateNowInputSchema)
    .output(investigateNowOutputSchema)
    .mutation(async ({ input, ctx }) => {
      const requester = investigationRequester(ctx);

      const postVersion = await findPostVersionById(ctx.prisma, input.postVersionId);
      if (postVersion === null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Unknown post version",
        });
      }

      const prompt = await getOrCreateCurrentPrompt();
      let investigationId: string;
      try {
        ({ investigationId } = await requestInvestigation(ctx.prisma, {
          postVersion,
          promptId: prompt.id,
          requester,
        }));
      } catch (error) {
        if (error instanceof InvestigationWordLimitError) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: error.message,
          });
        }
        if (error instanceof UserOpenAiKeyRejectedError) {
          throw userOpenAiKeyRejectedError(error);
        }
        throw error;
      }

      const investigation = await loadInvestigationWithClaims(
        prismaInvestigationRepository(ctx.prisma),
        investigationId,
      );
      if (!investigation) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Investigation ${investigationId} disappeared after investigateNow`,
        });
      }

      const provenance = investigation.input.provenance;
      switch (investigation.status) {
        case "COMPLETE":
          return {
            investigationId: investigation.id,
            status: investigation.status,
            provenance,
            claims: formatClaims(investigation.claims),
          };
        case "PENDING":
        case "PROCESSING":
        case "FAILED":
          return {
            investigationId: investigation.id,
            status: investigation.status,
            provenance,
          };
        default:
          return unreachableInvestigationStatus(investigation.status);
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

      // batchStatusInputSchema requires at least one post.
      const versions = await ctx.prisma.postVersion.findMany({
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
