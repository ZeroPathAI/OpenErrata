import { isUniqueConstraintError } from "$lib/db/errors.js";
import type { Investigation, Prisma, PrismaClient } from "$lib/db/prisma-client";
import {
  DEFAULT_INVESTIGATION_MODEL,
  DEFAULT_INVESTIGATION_PROVIDER,
  WORD_COUNT_LIMIT,
} from "@openerrata/shared";
import { resolveMarkdownForInvestigation } from "./markdown-resolution.js";
import type { HtmlSnapshots } from "./prompt-context.js";
import { enqueueInvestigation } from "./queue.js";
import { randomUUID } from "node:crypto";

export class InvestigationWordLimitError extends Error {
  readonly limit: number;
  readonly observedWordCount: number;

  constructor(observedWordCount: number, limit: number) {
    super(`Post exceeds word count limit (${limit.toString()} words)`);
    this.name = "InvestigationWordLimitError";
    this.observedWordCount = observedWordCount;
    this.limit = limit;
  }
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

async function findInvestigation(
  prisma: PrismaClient,
  postVersionId: string,
): Promise<Investigation | null> {
  return prisma.investigation.findUnique({
    where: {
      postVersionId,
    },
  });
}

async function loadPostVersionWordCount(
  prisma: PrismaClient,
  postVersionId: string,
): Promise<number> {
  const postVersion = await prisma.postVersion.findUnique({
    where: { id: postVersionId },
    select: {
      contentBlob: {
        select: {
          wordCount: true,
        },
      },
    },
  });

  if (postVersion === null) {
    throw new Error(`PostVersion ${postVersionId} not found`);
  }

  return postVersion.contentBlob.wordCount;
}

const postVersionForInputSnapshotSelect = {
  post: {
    select: {
      platform: true,
    },
  },
  serverVerifiedAt: true,
  contentBlob: {
    select: {
      contentHash: true,
    },
  },
  lesswrongVersionMeta: {
    select: {
      serverHtmlBlob: { select: { htmlContent: true } },
      clientHtmlBlob: { select: { htmlContent: true } },
    },
  },
  substackVersionMeta: {
    select: {
      serverHtmlBlob: { select: { htmlContent: true } },
      clientHtmlBlob: { select: { htmlContent: true } },
    },
  },
  wikipediaVersionMeta: {
    select: {
      serverHtmlBlob: { select: { htmlContent: true } },
      clientHtmlBlob: { select: { htmlContent: true } },
    },
  },
} satisfies Prisma.PostVersionSelect;

type PostVersionForInputSnapshot = Prisma.PostVersionGetPayload<{
  select: typeof postVersionForInputSnapshotSelect;
}>;

type InvestigationInputSnapshot =
  | {
      provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
      contentHash: string;
      markdownSource: "NONE";
    }
  | {
      provenance: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
      contentHash: string;
      markdownSource: "SERVER_HTML" | "CLIENT_HTML";
      markdown: string;
      markdownRendererVersion: string;
    };

function unreachablePlatform(platform: never): never {
  throw new Error(`Unsupported post platform: ${String(platform)}`);
}

function resolveHtmlSnapshotsFromPostVersion(
  postVersion: PostVersionForInputSnapshot,
): HtmlSnapshots {
  const platform = postVersion.post.platform;
  let serverHtml: string | null;
  let clientHtml: string | null;
  switch (platform) {
    case "LESSWRONG":
      serverHtml = postVersion.lesswrongVersionMeta?.serverHtmlBlob?.htmlContent ?? null;
      clientHtml = postVersion.lesswrongVersionMeta?.clientHtmlBlob?.htmlContent ?? null;
      break;
    case "SUBSTACK":
      serverHtml = postVersion.substackVersionMeta?.serverHtmlBlob?.htmlContent ?? null;
      clientHtml = postVersion.substackVersionMeta?.clientHtmlBlob?.htmlContent ?? null;
      break;
    case "WIKIPEDIA":
      serverHtml = postVersion.wikipediaVersionMeta?.serverHtmlBlob?.htmlContent ?? null;
      clientHtml = postVersion.wikipediaVersionMeta?.clientHtmlBlob?.htmlContent ?? null;
      break;
    case "X":
      serverHtml = null;
      clientHtml = null;
      break;
    default:
      return unreachablePlatform(platform);
  }

  if (postVersion.serverVerifiedAt !== null) {
    if (serverHtml === null) {
      throw new Error(
        `serverVerifiedAt is set but serverHtml is missing for platform ${platform} — violates DB invariant (serverVerifiedAt IS NOT NULL → serverHtmlBlobId IS NOT NULL)`,
      );
    }
    return { serverVerifiedAt: postVersion.serverVerifiedAt, serverHtml, clientHtml };
  }
  return { serverVerifiedAt: null, serverHtml, clientHtml };
}

async function loadInvestigationInputSnapshot(
  prisma: PrismaClient,
  postVersionId: string,
): Promise<InvestigationInputSnapshot> {
  const postVersion = await prisma.postVersion.findUnique({
    where: { id: postVersionId },
    select: postVersionForInputSnapshotSelect,
  });
  if (postVersion === null) {
    throw new Error(`PostVersion ${postVersionId} not found`);
  }

  const htmlSnapshots = resolveHtmlSnapshotsFromPostVersion(postVersion);
  const markdownResolution = resolveMarkdownForInvestigation({
    platform: postVersion.post.platform,
    snapshots: htmlSnapshots,
  });
  const provenance =
    htmlSnapshots.serverVerifiedAt !== null
      ? ("SERVER_VERIFIED" as const)
      : ("CLIENT_FALLBACK" as const);

  if (markdownResolution.source === "NONE") {
    return {
      provenance,
      contentHash: postVersion.contentBlob.contentHash,
      markdownSource: "NONE",
    };
  }

  return {
    provenance,
    contentHash: postVersion.contentBlob.contentHash,
    markdownSource: markdownResolution.source,
    markdown: markdownResolution.markdown,
    markdownRendererVersion: markdownResolution.rendererVersion,
  };
}

async function createInvestigation(
  prisma: PrismaClient,
  input: {
    postVersionId: string;
    promptId: string;
    snapshot: InvestigationInputSnapshot;
    parentInvestigationId?: string;
    contentDiff?: string;
  },
): Promise<Investigation> {
  const investigationId = randomUUID();
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    await tx.investigationInput.create({
      data: {
        investigationId,
        provenance: input.snapshot.provenance,
        contentHash: input.snapshot.contentHash,
        markdownSource: input.snapshot.markdownSource,
        ...(input.snapshot.markdownSource === "NONE"
          ? {}
          : {
              markdown: input.snapshot.markdown,
              markdownRendererVersion: input.snapshot.markdownRendererVersion,
            }),
      },
    });

    return tx.investigation.create({
      data: {
        id: investigationId,
        inputId: investigationId,
        postVersionId: input.postVersionId,
        status: "PENDING",
        parentInvestigationId: input.parentInvestigationId ?? null,
        contentDiff: input.contentDiff ?? null,
        promptId: input.promptId,
        provider: DEFAULT_INVESTIGATION_PROVIDER,
        model: DEFAULT_INVESTIGATION_MODEL,
        queuedAt: now,
      },
    });
  });
}

/**
 * Recover a stale PROCESSING investigation whose lease has expired.
 * Deletes the expired InvestigationLease row and transitions
 * PROCESSING → PENDING.
 */
async function tryRecoverExpiredProcessingInvestigation(
  prisma: PrismaClient,
  investigationId: string,
): Promise<Investigation | null> {
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    // Try to delete an expired lease row.
    const deleted = await tx.investigationLease.deleteMany({
      where: { investigationId, leaseExpiresAt: { lte: now } },
    });

    if (deleted.count === 0) {
      // No expired lease was deleted. Check whether a non-expired lease exists.
      const activeLease = await tx.investigationLease.findUnique({
        where: { investigationId },
        select: { investigationId: true },
      });
      if (activeLease) return null; // Active lease, can't recover

      const investigationStatus = await tx.investigation.findUnique({
        where: { id: investigationId },
        select: { status: true },
      });
      if (!investigationStatus) return null;
      if (investigationStatus.status !== "PROCESSING") {
        // Another concurrent caller likely recovered/transitioned this row
        // between our candidate selection and recovery attempt.
        return null;
      }

      // PROCESSING with no lease row at all is an invariant violation:
      // the InvestigationLease row's existence IS the PROCESSING state.
      // The migration cleans these up, so hitting this in production
      // indicates a bug in lease lifecycle management.
      throw new Error(
        `Invariant violation: PROCESSING investigation ${investigationId} has no InvestigationLease row. ` +
          `This state should not be reachable — lease row existence is required for PROCESSING status.`,
      );
    }

    // Expired lease deleted — transition PROCESSING → PENDING
    const recovered = await tx.investigation.updateMany({
      where: { id: investigationId, status: "PROCESSING" },
      data: { status: "PENDING", queuedAt: now },
    });

    if (recovered.count === 0) return null;

    const investigation = await tx.investigation.findUnique({
      where: { id: investigationId },
    });

    if (!investigation) {
      throw new Error(
        `Missing investigation during stale-run recovery (investigationId=${investigationId})`,
      );
    }

    return investigation;
  });
}

interface EnsureInvestigationInput {
  prisma: PrismaClient;
  postVersionId: string;
  promptId: string;
  parentInvestigationId?: string;
  contentDiff?: string;
  rejectOverWordLimitOnCreate?: boolean;
  allowRequeueFailed?: boolean;
  enqueue?: boolean;
  onPendingInvestigation?: (input: {
    prisma: PrismaClient;
    investigation: Investigation;
  }) => Promise<void>;
}

async function ensureInvestigationRecord(input: EnsureInvestigationInput): Promise<{
  investigation: Investigation;
  created: boolean;
}> {
  const rejectOverWordLimitOnCreate = input.rejectOverWordLimitOnCreate ?? true;
  const allowRequeueFailed = input.allowRequeueFailed ?? false;

  let investigation = await findInvestigation(input.prisma, input.postVersionId);
  let created = false;

  if (!investigation) {
    if (rejectOverWordLimitOnCreate) {
      const observedWordCount = await loadPostVersionWordCount(input.prisma, input.postVersionId);
      if (observedWordCount > WORD_COUNT_LIMIT) {
        throw new InvestigationWordLimitError(observedWordCount, WORD_COUNT_LIMIT);
      }
    }

    try {
      const snapshot = await loadInvestigationInputSnapshot(input.prisma, input.postVersionId);
      const createInput: Parameters<typeof createInvestigation>[1] = {
        postVersionId: input.postVersionId,
        promptId: input.promptId,
        snapshot,
      };
      if (input.parentInvestigationId !== undefined) {
        createInput.parentInvestigationId = input.parentInvestigationId;
      }
      if (input.contentDiff !== undefined) {
        createInput.contentDiff = input.contentDiff;
      }
      investigation = await createInvestigation(input.prisma, createInput);
      created = true;
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      investigation = await findInvestigation(input.prisma, input.postVersionId);
      if (!investigation) throw error;
    }
  }

  if (allowRequeueFailed && investigation.status === "FAILED") {
    const failedInvestigation = investigation; // capture narrow type for async callback
    investigation = await input.prisma.$transaction(async (tx) => {
      // Defensive cleanup for any leftover lease row from prior failures.
      await tx.investigationLease.deleteMany({
        where: { investigationId: failedInvestigation.id },
      });

      return tx.investigation.update({
        where: { id: failedInvestigation.id },
        data: {
          parentInvestigationId: input.parentInvestigationId ?? null,
          contentDiff: input.contentDiff ?? null,
          status: "PENDING",
          checkedAt: null,
          queuedAt: new Date(),
          attemptCount: 0,
          retryAfter: null,
        },
      });
    });
  }

  return { investigation, created };
}

export async function ensureInvestigationQueued(input: EnsureInvestigationInput): Promise<{
  investigation: Investigation;
  created: boolean;
  enqueued: boolean;
}> {
  const { investigation: initialInvestigation, created } = await ensureInvestigationRecord(input);
  let investigation = initialInvestigation;

  // Recover stale PROCESSING investigations with expired leases
  if (investigation.status === "PROCESSING") {
    const recovered = await tryRecoverExpiredProcessingInvestigation(
      input.prisma,
      investigation.id,
    );
    if (recovered) {
      investigation = recovered;
    }
  }

  const shouldEnqueue = input.enqueue ?? true;
  let enqueued = false;
  if (shouldEnqueue && investigation.status === "PENDING") {
    if (input.onPendingInvestigation) {
      await input.onPendingInvestigation({
        prisma: input.prisma,
        investigation,
      });
    }
    await enqueueInvestigation(investigation.id);
    enqueued = true;
  }

  return { investigation, created, enqueued };
}
