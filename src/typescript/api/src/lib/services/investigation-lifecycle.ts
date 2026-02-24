import { isUniqueConstraintError } from "$lib/db/errors.js";
import type {
  Investigation,
  InvestigationRun,
  PrismaClient,
} from "$lib/generated/prisma/client";
import {
  DEFAULT_INVESTIGATION_MODEL,
  DEFAULT_INVESTIGATION_PROVIDER,
  WORD_COUNT_LIMIT,
  type ContentProvenance,
} from "@openerrata/shared";
import { enqueueInvestigationRun } from "./queue.js";

type CanonicalInvestigationContent =
  | {
      contentHash: string;
      contentText: string;
      provenance: "SERVER_VERIFIED";
    }
  | {
      contentHash: string;
      contentText: string;
      provenance: "CLIENT_FALLBACK";
      fetchFailureReason: string;
    };

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

export function exceedsInvestigationWordLimit(text: string): boolean {
  return wordCount(text) > WORD_COUNT_LIMIT;
}

function serverVerifiedAtFor(provenance: ContentProvenance): Date | null {
  return provenance === "SERVER_VERIFIED" ? new Date() : null;
}

async function findInvestigation(
  prisma: PrismaClient,
  postId: string,
  contentHash: string,
): Promise<Investigation | null> {
  return prisma.investigation.findUnique({
    where: {
      postId_contentHash: {
        postId,
        contentHash,
      },
    },
  });
}

async function createInvestigation(
  prisma: PrismaClient,
  input: {
    postId: string;
    promptId: string;
    canonical: CanonicalInvestigationContent;
  },
): Promise<Investigation> {
  return prisma.investigation.create({
    data: {
      postId: input.postId,
      contentHash: input.canonical.contentHash,
      contentText: input.canonical.contentText,
      contentProvenance: input.canonical.provenance,
      fetchFailureReason:
        input.canonical.provenance === "CLIENT_FALLBACK"
          ? input.canonical.fetchFailureReason
          : null,
      serverVerifiedAt: serverVerifiedAtFor(input.canonical.provenance),
      status: "PENDING",
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
  return prisma.investigationRun.create({
    data: {
      investigationId: input.investigationId,
      queuedAt: input.investigationStatus === "PENDING" ? now : null,
      startedAt: input.investigationStatus === "PROCESSING" ? now : null,
      heartbeatAt: input.investigationStatus === "PROCESSING" ? now : null,
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
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      data: {
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        queuedAt: now,
      },
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

export async function maybeUpgradeInvestigationProvenance(
  prisma: PrismaClient,
  postId: string,
  serverHash: string,
): Promise<number> {
  const updated = await prisma.investigation.updateMany({
    where: {
      postId,
      contentHash: serverHash,
      contentProvenance: "CLIENT_FALLBACK",
      serverVerifiedAt: null,
    },
    data: {
      contentProvenance: "SERVER_VERIFIED",
      serverVerifiedAt: new Date(),
      fetchFailureReason: null,
    },
  });

  return updated.count;
}

type EnsureInvestigationInput = {
  prisma: PrismaClient;
  postId: string;
  promptId: string;
  canonical: CanonicalInvestigationContent;
  rejectOverWordLimitOnCreate?: boolean;
  allowRequeueFailed?: boolean;
  enqueue?: boolean;
  onPendingRun?: (input: {
    prisma: PrismaClient;
    investigation: Investigation;
    run: InvestigationRun;
  }) => Promise<void>;
};

async function ensureInvestigationRecord(
  input: EnsureInvestigationInput,
): Promise<{
  investigation: Investigation;
  created: boolean;
}> {
  const rejectOverWordLimitOnCreate = input.rejectOverWordLimitOnCreate ?? true;
  const allowRequeueFailed = input.allowRequeueFailed ?? false;

  if (input.canonical.provenance === "SERVER_VERIFIED") {
    await maybeUpgradeInvestigationProvenance(
      input.prisma,
      input.postId,
      input.canonical.contentHash,
    );
  }

  let investigation = await findInvestigation(
    input.prisma,
    input.postId,
    input.canonical.contentHash,
  );
  let created = false;

  if (!investigation) {
    if (
      rejectOverWordLimitOnCreate &&
      exceedsInvestigationWordLimit(input.canonical.contentText)
    ) {
      throw new InvestigationWordLimitError(
        wordCount(input.canonical.contentText),
        WORD_COUNT_LIMIT,
      );
    }

    try {
      investigation = await createInvestigation(input.prisma, {
        postId: input.postId,
        promptId: input.promptId,
        canonical: input.canonical,
      });
      created = true;
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      investigation = await findInvestigation(
        input.prisma,
        input.postId,
        input.canonical.contentHash,
      );
      if (!investigation) throw error;
    }
  }

  if (
    input.canonical.provenance === "SERVER_VERIFIED" &&
    investigation.contentProvenance === "CLIENT_FALLBACK"
  ) {
    await maybeUpgradeInvestigationProvenance(
      input.prisma,
      input.postId,
      input.canonical.contentHash,
    );
    const upgraded = await findInvestigation(
      input.prisma,
      input.postId,
      input.canonical.contentHash,
    );
    if (!upgraded) {
      throw new Error(
        `Investigation missing after provenance upgrade for post ${input.postId}`,
      );
    }
    investigation = upgraded;
  }

  if (allowRequeueFailed && investigation.status === "FAILED") {
    investigation = await input.prisma.investigation.update({
      where: { id: investigation.id },
      data: {
        status: "PENDING",
        checkedAt: null,
      },
    });
  }

  return { investigation, created };
}

export async function ensureInvestigationQueued(
  input: EnsureInvestigationInput,
): Promise<{
  investigation: Investigation;
  run: InvestigationRun;
  created: boolean;
  runCreated: boolean;
  enqueued: boolean;
}> {
  const { investigation: initialInvestigation, created } =
    await ensureInvestigationRecord(input);
  const { run: initialRun, created: runCreated } = await ensureInvestigationRunRecord(
    input.prisma,
    initialInvestigation,
  );
  let investigation = initialInvestigation;
  let run = initialRun;

  if (
    investigation.status === "PROCESSING" &&
    (run.leaseExpiresAt === null || run.leaseExpiresAt.getTime() <= Date.now())
  ) {
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
