import { isUniqueConstraintError } from "$lib/db/errors.js";
import type { Investigation, InvestigationRun, PrismaClient } from "$lib/generated/prisma/client";
import {
  DEFAULT_INVESTIGATION_MODEL,
  DEFAULT_INVESTIGATION_PROVIDER,
  WORD_COUNT_LIMIT,
} from "@openerrata/shared";
import { enqueueInvestigationRun } from "./queue.js";
import {
  isRecoverableProcessingRunState,
  recoveredProcessingRunData,
  runTimingForInvestigationStatus,
} from "./investigation-state.js";

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

async function createInvestigation(
  prisma: PrismaClient,
  input: {
    postVersionId: string;
    promptId: string;
    parentInvestigationId?: string;
    contentDiff?: string;
  },
): Promise<Investigation> {
  return prisma.investigation.create({
    data: {
      postVersionId: input.postVersionId,
      status: "PENDING",
      parentInvestigationId: input.parentInvestigationId ?? null,
      contentDiff: input.contentDiff ?? null,
      promptId: input.promptId,
      provider: DEFAULT_INVESTIGATION_PROVIDER,
      model: DEFAULT_INVESTIGATION_MODEL,
    },
  });
}

async function findInvestigationRun(
  prisma: PrismaClient,
  investigationId: string,
): Promise<InvestigationRun | null> {
  return prisma.investigationRun.findUnique({
    where: { investigationId },
  });
}

async function createInvestigationRun(
  prisma: PrismaClient,
  input: {
    investigationId: string;
    investigationStatus: Investigation["status"];
  },
): Promise<InvestigationRun> {
  const now = new Date();
  const timing = runTimingForInvestigationStatus(input.investigationStatus, now);
  return prisma.investigationRun.create({
    data: {
      investigationId: input.investigationId,
      queuedAt: timing.queuedAt,
      startedAt: timing.startedAt,
      heartbeatAt: timing.heartbeatAt,
    },
  });
}

async function tryRecoverExpiredProcessingRun(
  prisma: PrismaClient,
  input: {
    investigationId: string;
    runId: string;
  },
): Promise<{ investigation: Investigation; run: InvestigationRun } | null> {
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const recoveredRun = await tx.investigationRun.updateMany({
      where: {
        id: input.runId,
        investigation: { is: { status: "PROCESSING" } },
        OR: [
          {
            leaseOwner: { not: null },
            OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
          },
          {
            leaseOwner: null,
            OR: [{ recoverAfterAt: null }, { recoverAfterAt: { lte: now } }],
          },
        ],
      },
      data: recoveredProcessingRunData(now),
    });

    if (recoveredRun.count === 0) return null;

    await tx.investigation.updateMany({
      where: {
        id: input.investigationId,
        status: "PROCESSING",
      },
      data: { status: "PENDING" },
    });

    const run = await tx.investigationRun.findUnique({
      where: { id: input.runId },
    });
    const investigation = await tx.investigation.findUnique({
      where: { id: input.investigationId },
    });

    if (!run || !investigation) {
      throw new Error(
        `Missing investigation/run during stale-run recovery (investigationId=${input.investigationId}, runId=${input.runId})`,
      );
    }

    return { investigation, run };
  });
}

async function ensureInvestigationRunRecord(
  prisma: PrismaClient,
  investigation: Investigation,
): Promise<{
  run: InvestigationRun;
  created: boolean;
}> {
  let run = await findInvestigationRun(prisma, investigation.id);
  let created = false;

  if (!run) {
    try {
      run = await createInvestigationRun(prisma, {
        investigationId: investigation.id,
        investigationStatus: investigation.status,
      });
      created = true;
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      run = await findInvestigationRun(prisma, investigation.id);
      if (!run) throw error;
    }
  }

  return { run, created };
}

type EnsureInvestigationInput = {
  prisma: PrismaClient;
  postVersionId: string;
  promptId: string;
  parentInvestigationId?: string;
  contentDiff?: string;
  rejectOverWordLimitOnCreate?: boolean;
  allowRequeueFailed?: boolean;
  enqueue?: boolean;
  onPendingRun?: (input: {
    prisma: PrismaClient;
    investigation: Investigation;
    run: InvestigationRun;
  }) => Promise<void>;
};

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
      const createInput: Parameters<typeof createInvestigation>[1] = {
        postVersionId: input.postVersionId,
        promptId: input.promptId,
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
    investigation = await input.prisma.investigation.update({
      where: { id: investigation.id },
      data: {
        parentInvestigationId: input.parentInvestigationId ?? null,
        contentDiff: input.contentDiff ?? null,
        status: "PENDING",
        checkedAt: null,
      },
    });
  }

  return { investigation, created };
}

export async function ensureInvestigationQueued(input: EnsureInvestigationInput): Promise<{
  investigation: Investigation;
  run: InvestigationRun;
  created: boolean;
  runCreated: boolean;
  enqueued: boolean;
}> {
  const { investigation: initialInvestigation, created } = await ensureInvestigationRecord(input);
  const { run: initialRun, created: runCreated } = await ensureInvestigationRunRecord(
    input.prisma,
    initialInvestigation,
  );
  let investigation = initialInvestigation;
  let run = initialRun;

  if (investigation.status === "PROCESSING" && isRecoverableProcessingRunState(run)) {
    const recovered = await tryRecoverExpiredProcessingRun(input.prisma, {
      investigationId: investigation.id,
      runId: run.id,
    });
    if (recovered) {
      investigation = recovered.investigation;
      run = recovered.run;
    }
  }

  const shouldEnqueue = input.enqueue ?? true;
  let enqueued = false;
  if (shouldEnqueue && investigation.status === "PENDING") {
    if (input.onPendingRun) {
      await input.onPendingRun({
        prisma: input.prisma,
        investigation,
        run,
      });
    }
    await enqueueInvestigationRun(run.id);
    enqueued = true;
  }

  return { investigation, run, created, runCreated, enqueued };
}
