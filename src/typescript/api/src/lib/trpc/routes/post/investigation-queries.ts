/**
 * Investigation query helpers for the post router.
 *
 * Provides loading, formatting, and lifecycle helpers for investigations:
 * claim formatting, diff computation for update investigations,
 * corroboration recording, and investigation queueing with update metadata.
 */

import { claimIdSchema, type InvestigationClaim } from "@openerrata/shared";
import { ensureInvestigationQueued } from "$lib/services/investigation-lifecycle.js";
import { isUniqueConstraintError } from "$lib/db/errors.js";
import type { Prisma, PrismaClient } from "$lib/generated/prisma/client";
import { TRPCError } from "@trpc/server";
import type { ResolvedPostVersion } from "./content-storage.js";

// ---------------------------------------------------------------------------
// Prisma include shapes and derived payload types
// ---------------------------------------------------------------------------

const investigationWithClaimsInclude = {
  postVersion: {
    select: {
      contentProvenance: true,
      contentBlob: {
        select: {
          contentText: true,
          contentHash: true,
        },
      },
    },
  },
  claims: {
    include: {
      sources: true,
    },
  },
  parentInvestigation: {
    include: {
      claims: {
        include: {
          sources: true,
        },
      },
      postVersion: {
        select: {
          contentBlob: {
            select: {
              contentText: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.InvestigationInclude;

type InvestigationWithClaims = Prisma.InvestigationGetPayload<{
  include: typeof investigationWithClaimsInclude;
}>;

const completedInvestigationInclude = {
  postVersion: {
    select: {
      id: true,
      contentProvenance: true,
      contentBlob: {
        select: {
          contentText: true,
          contentHash: true,
        },
      },
    },
  },
  claims: {
    include: {
      sources: true,
    },
  },
} satisfies Prisma.InvestigationInclude;

type CompletedInvestigation = Prisma.InvestigationGetPayload<{
  include: typeof completedInvestigationInclude;
}>;

const serverVerifiedSourceInclude = {
  postVersion: {
    select: {
      id: true,
      contentBlob: {
        select: {
          contentText: true,
        },
      },
    },
  },
  claims: {
    include: {
      sources: true,
    },
  },
} satisfies Prisma.InvestigationInclude;

interface ClaimSourceSummary {
  url: string;
  title: string;
  snippet: string;
}

interface ClaimSummary {
  id: string;
  text: string;
  context: string;
  summary: string;
  reasoning: string;
  sources: ClaimSourceSummary[];
}

interface SourceInvestigationForUpdate {
  id: string;
  postVersion: {
    id: string;
    contentBlob: {
      contentText: string;
    };
  };
  claims: ClaimSummary[];
}

type LatestServerVerifiedCompleteInvestigation = SourceInvestigationForUpdate | null;

type EnsuredInvestigationStatus = Awaited<
  ReturnType<typeof ensureInvestigationQueued>
>["investigation"]["status"];

interface EnsureInvestigationResult {
  investigation: {
    id: string;
    status: EnsuredInvestigationStatus;
  };
}

interface EnsureQueuedInput<TPrisma> {
  prisma: TPrisma;
  postVersionId: string;
  promptId: string;
  parentInvestigationId?: string;
  contentDiff?: string;
  rejectOverWordLimitOnCreate: true;
  allowRequeueFailed: true;
  onPendingRun?: (input: {
    prisma: TPrisma;
    investigation: {
      id: string;
      status: EnsuredInvestigationStatus;
    };
    run: {
      id: string;
    };
  }) => Promise<void>;
}

type EnsureQueued<TPrisma> = (
  input: EnsureQueuedInput<TPrisma>,
) => Promise<EnsureInvestigationResult>;

interface EnsureWithDefaultInput {
  prisma: PrismaClient;
  promptId: string;
  postVersion: ResolvedPostVersion;
  sourceInvestigation: LatestServerVerifiedCompleteInvestigation;
  onPendingRun?: Parameters<typeof ensureInvestigationQueued>[0]["onPendingRun"];
  ensureQueued?: undefined;
}

interface EnsureWithCustomInput<TPrisma> {
  prisma: TPrisma;
  promptId: string;
  postVersion: ResolvedPostVersion;
  sourceInvestigation: LatestServerVerifiedCompleteInvestigation;
  onPendingRun?: EnsureQueuedInput<TPrisma>["onPendingRun"];
  ensureQueued: EnsureQueued<TPrisma>;
}

interface InvestigationWithClaimsLookup {
  investigation: {
    findUnique(args: {
      where: { id: string };
      include: typeof investigationWithClaimsInclude;
    }): Promise<InvestigationWithClaims | null>;
  };
}

interface CompletedInvestigationLookup {
  investigation: {
    findFirst(args: {
      where: {
        postVersionId: string;
        status: "COMPLETE";
      };
      include: typeof completedInvestigationInclude;
    }): Promise<CompletedInvestigation | null>;
  };
}

interface LatestServerVerifiedInvestigationLookup {
  investigation: {
    findFirst(args: {
      where: {
        status: "COMPLETE";
        postVersion: {
          postId: string;
          contentProvenance: "SERVER_VERIFIED";
        };
      };
      orderBy: {
        checkedAt: "desc";
      };
      include: typeof serverVerifiedSourceInclude;
    }): Promise<SourceInvestigationForUpdate | null>;
  };
}

interface CorroborationLookup {
  investigation: {
    findFirst(args: {
      where: {
        postVersionId: string;
        postVersion: {
          contentProvenance: "CLIENT_FALLBACK";
        };
      };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
  corroborationCredit: {
    create(args: {
      data: {
        investigationId: string;
        reporterKey: string;
      };
    }): Promise<unknown>;
  };
}

// ---------------------------------------------------------------------------
// Invariant helpers
// ---------------------------------------------------------------------------

export function unreachableInvestigationStatus(status: never): never {
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: `Unexpected investigation status: ${String(status)}`,
  });
}

export function requireCompleteCheckedAtIso(
  investigationId: string,
  checkedAt: Date | null,
): string {
  if (checkedAt === null) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Investigation ${investigationId} is COMPLETE with null checkedAt`,
    });
  }
  return checkedAt.toISOString();
}

// ---------------------------------------------------------------------------
// Claim formatting
// ---------------------------------------------------------------------------

export function formatClaims(claims: ClaimSummary[]): InvestigationClaim[] {
  return claims.map((c) => ({
    id: claimIdSchema.parse(c.id),
    text: c.text,
    context: c.context,
    summary: c.summary,
    reasoning: c.reasoning,
    sources: c.sources.map((s) => ({
      url: s.url,
      title: s.title,
      snippet: s.snippet,
    })),
  }));
}

// ---------------------------------------------------------------------------
// Investigation loading
// ---------------------------------------------------------------------------

export async function loadInvestigationWithClaims(
  prisma: InvestigationWithClaimsLookup,
  investigationId: string,
): Promise<InvestigationWithClaims | null> {
  return prisma.investigation.findUnique({
    where: { id: investigationId },
    include: investigationWithClaimsInclude,
  });
}

export async function findCompletedInvestigationByPostVersionId(
  prisma: CompletedInvestigationLookup,
  postVersionId: string,
): Promise<CompletedInvestigation | null> {
  return prisma.investigation.findFirst({
    where: {
      postVersionId,
      status: "COMPLETE",
    },
    include: completedInvestigationInclude,
  });
}

export async function findLatestServerVerifiedCompleteInvestigationForPost(
  prisma: LatestServerVerifiedInvestigationLookup,
  postId: string,
): Promise<LatestServerVerifiedCompleteInvestigation> {
  const source = await prisma.investigation.findFirst({
    where: {
      status: "COMPLETE",
      postVersion: {
        postId,
        contentProvenance: "SERVER_VERIFIED",
      },
    },
    orderBy: {
      checkedAt: "desc",
    },
    include: serverVerifiedSourceInclude,
  });
  if (source === null) {
    return null;
  }

  return source;
}

// ---------------------------------------------------------------------------
// Update investigation helpers
// ---------------------------------------------------------------------------

export function selectSourceInvestigationForUpdate(
  latestServerVerifiedSource: LatestServerVerifiedCompleteInvestigation,
  currentPostVersionId: string,
): LatestServerVerifiedCompleteInvestigation {
  if (latestServerVerifiedSource === null) {
    return null;
  }

  return latestServerVerifiedSource.postVersion.id === currentPostVersionId
    ? null
    : latestServerVerifiedSource;
}

export function toPriorInvestigationResult(
  sourceInvestigation: LatestServerVerifiedCompleteInvestigation,
): {
  oldClaims: InvestigationClaim[];
  sourceInvestigationId: string;
} | null {
  if (sourceInvestigation === null) {
    return null;
  }

  return {
    oldClaims: formatClaims(sourceInvestigation.claims),
    sourceInvestigationId: sourceInvestigation.id,
  };
}

function buildLineDiff(previous: string, current: string): string {
  if (previous === current) {
    return "No changes detected.";
  }

  const previousLines = previous.split("\n");
  const currentLines = current.split("\n");
  const maxStart = Math.min(previousLines.length, currentLines.length);
  let start = 0;
  while (start < maxStart && previousLines[start] === currentLines[start]) {
    start += 1;
  }

  let previousEnd = previousLines.length;
  let currentEnd = currentLines.length;
  while (
    previousEnd > start &&
    currentEnd > start &&
    previousLines[previousEnd - 1] === currentLines[currentEnd - 1]
  ) {
    previousEnd -= 1;
    currentEnd -= 1;
  }

  const removed = previousLines.slice(start, previousEnd);
  const added = currentLines.slice(start, currentEnd);

  return [
    "Diff summary (line context):",
    "- Removed lines:",
    removed.length > 0 ? removed.join("\n") : "(none)",
    "+ Added lines:",
    added.length > 0 ? added.join("\n") : "(none)",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Corroboration recording
// ---------------------------------------------------------------------------

export async function maybeRecordCorroboration(
  prisma: CorroborationLookup,
  postVersionId: string,
  viewerKey: string,
  isAuthenticated: boolean,
): Promise<void> {
  if (!isAuthenticated) return;

  const investigation = await prisma.investigation.findFirst({
    where: {
      postVersionId,
      postVersion: {
        contentProvenance: "CLIENT_FALLBACK",
      },
    },
    select: { id: true },
  });

  if (!investigation) return;

  try {
    await prisma.corroborationCredit.create({
      data: {
        investigationId: investigation.id,
        reporterKey: viewerKey,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) return;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Investigation queueing with update metadata
// ---------------------------------------------------------------------------

export async function ensureInvestigationsWithUpdateMetadata(
  input: EnsureWithDefaultInput,
): Promise<EnsureInvestigationResult>;

export async function ensureInvestigationsWithUpdateMetadata<TPrisma>(input: {
  prisma: TPrisma;
  promptId: string;
  postVersion: ResolvedPostVersion;
  sourceInvestigation: LatestServerVerifiedCompleteInvestigation;
  onPendingRun?: EnsureQueuedInput<TPrisma>["onPendingRun"];
  ensureQueued: EnsureQueued<TPrisma>;
}): Promise<EnsureInvestigationResult>;

export async function ensureInvestigationsWithUpdateMetadata<TPrisma>(
  input:
    | {
        prisma: PrismaClient;
        promptId: string;
        postVersion: ResolvedPostVersion;
        sourceInvestigation: LatestServerVerifiedCompleteInvestigation;
        onPendingRun?: Parameters<typeof ensureInvestigationQueued>[0]["onPendingRun"];
        ensureQueued?: undefined;
      }
    | EnsureWithCustomInput<TPrisma>,
): Promise<EnsureInvestigationResult> {
  if (input.ensureQueued !== undefined) {
    const baseInput = {
      prisma: input.prisma,
      postVersionId: input.postVersion.id,
      promptId: input.promptId,
      rejectOverWordLimitOnCreate: true as const,
      allowRequeueFailed: true as const,
      ...(input.onPendingRun === undefined ? {} : { onPendingRun: input.onPendingRun }),
    };

    const queuedInput =
      input.sourceInvestigation === null
        ? baseInput
        : {
            ...baseInput,
            parentInvestigationId: input.sourceInvestigation.id,
            contentDiff: buildLineDiff(
              input.sourceInvestigation.postVersion.contentBlob.contentText,
              input.postVersion.contentBlob.contentText,
            ),
          };

    return input.ensureQueued(queuedInput);
  }

  const baseInput = {
    prisma: input.prisma,
    postVersionId: input.postVersion.id,
    promptId: input.promptId,
    rejectOverWordLimitOnCreate: true as const,
    allowRequeueFailed: true as const,
    ...(input.onPendingRun === undefined ? {} : { onPendingRun: input.onPendingRun }),
  };

  const queuedInput =
    input.sourceInvestigation === null
      ? baseInput
      : {
          ...baseInput,
          parentInvestigationId: input.sourceInvestigation.id,
          contentDiff: buildLineDiff(
            input.sourceInvestigation.postVersion.contentBlob.contentText,
            input.postVersion.contentBlob.contentText,
          ),
        };

  const ensured = await ensureInvestigationQueued(queuedInput);
  return {
    investigation: {
      id: ensured.investigation.id,
      status: ensured.investigation.status,
    },
  };
}

export const investigationQueriesInternals = {
  buildLineDiff,
};
