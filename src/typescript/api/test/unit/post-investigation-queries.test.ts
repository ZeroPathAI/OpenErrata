import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "../../src/lib/generated/prisma/client.js";
import type { ResolvedPostVersion } from "../../src/lib/trpc/routes/post/content-storage.js";
import {
  ensureInvestigationsWithUpdateMetadata,
  findCompletedInvestigationByPostVersionId,
  findLatestServerVerifiedCompleteInvestigationForPost,
  investigationQueriesInternals,
  loadInvestigationWithClaims,
  maybeRecordCorroboration,
  requireCompleteCheckedAtIso,
  selectSourceInvestigationForUpdate,
  toPriorInvestigationResult,
  unreachableInvestigationStatus,
} from "../../src/lib/trpc/routes/post/investigation-queries.js";

function createKnownRequestError(code: "P2002" | "P2025") {
  return new Prisma.PrismaClientKnownRequestError("mock error", {
    code,
    clientVersion: "unit-test",
  });
}

function buildResolvedPostVersion(contentText = "new line"): ResolvedPostVersion {
  return {
    id: "post-version-id",
    postId: "post-id",
    versionHash: "version-hash",
    contentProvenance: "SERVER_VERIFIED",
    contentBlob: {
      contentHash: "content-hash",
      contentText,
      wordCount: 2,
    },
    post: {
      id: "post-id",
      platform: "X",
      externalId: "external-id",
      url: "https://x.com/openerrata/status/1",
    },
  };
}

test("requireCompleteCheckedAtIso returns ISO and throws when checkedAt is missing", () => {
  const checkedAt = new Date("2026-02-28T12:34:56.789Z");
  assert.equal(requireCompleteCheckedAtIso("inv-1", checkedAt), checkedAt.toISOString());

  assert.throws(() => requireCompleteCheckedAtIso("inv-2", null), /COMPLETE with null checkedAt/);
});

test("selectSourceInvestigationForUpdate drops same-version source and keeps prior version", () => {
  const source = {
    id: "source-investigation-id",
    postVersion: {
      id: "source-post-version-id",
      contentBlob: {
        contentText: "old line",
      },
    },
    claims: [],
  };

  assert.equal(selectSourceInvestigationForUpdate(null, "current-post-version-id"), null);
  assert.equal(selectSourceInvestigationForUpdate(source, "source-post-version-id"), null);
  assert.equal(selectSourceInvestigationForUpdate(source, "current-post-version-id"), source);
});

test("toPriorInvestigationResult maps source claims and handles null source", () => {
  assert.equal(toPriorInvestigationResult(null), null);

  const source = {
    id: "source-investigation-id",
    postVersion: {
      id: "source-post-version-id",
      contentBlob: { contentText: "old line" },
    },
    claims: [
      {
        id: "claim_1",
        text: "Claim text",
        context: "Claim context",
        summary: "Claim summary",
        reasoning: "Claim reasoning",
        sources: [
          {
            url: "https://example.com/1",
            title: "Source 1",
            snippet: "Snippet 1",
          },
        ],
      },
    ],
  };

  assert.deepEqual(toPriorInvestigationResult(source), {
    sourceInvestigationId: "source-investigation-id",
    oldClaims: [
      {
        id: "claim_1",
        text: "Claim text",
        context: "Claim context",
        summary: "Claim summary",
        reasoning: "Claim reasoning",
        sources: [
          {
            url: "https://example.com/1",
            title: "Source 1",
            snippet: "Snippet 1",
          },
        ],
      },
    ],
  });
});

test("buildLineDiff reports no changes and changed line blocks", () => {
  assert.equal(
    investigationQueriesInternals.buildLineDiff("same\ncontent", "same\ncontent"),
    "No changes detected.",
  );

  const diff = investigationQueriesInternals.buildLineDiff(
    "keep one\nremove me\nkeep tail",
    "keep one\nadd me\nkeep tail",
  );
  assert.match(diff, /Diff summary \(line context\):/);
  assert.match(diff, /- Removed lines:\nremove me/);
  assert.match(diff, /\+ Added lines:\nadd me/);
});

test("unreachableInvestigationStatus throws explicit internal error", () => {
  assert.throws(
    () => unreachableInvestigationStatus("UNKNOWN" as never),
    /Unexpected investigation status: UNKNOWN/,
  );
});

test("loadInvestigationWithClaims queries by id and includes required relations", async () => {
  let capturedArgs: unknown = null;
  const prisma = {
    investigation: {
      findUnique: async (args: unknown) => {
        capturedArgs = args;
        return null;
      },
    },
  };

  const result = await loadInvestigationWithClaims(prisma, "investigation-id");
  assert.equal(result, null);

  if (typeof capturedArgs !== "object" || capturedArgs === null) return;
  const query = capturedArgs as { where: unknown; include: unknown };
  assert.deepEqual(query.where, { id: "investigation-id" });
  if (typeof query.include !== "object" || query.include === null) return;
  assert.ok(Object.hasOwn(query.include, "postVersion"));
  assert.ok(Object.hasOwn(query.include, "claims"));
});

test("findCompletedInvestigationByPostVersionId queries by postVersionId and COMPLETE status", async () => {
  let capturedArgs: unknown = null;
  const prisma = {
    investigation: {
      findFirst: async (args: unknown) => {
        capturedArgs = args;
        return null;
      },
    },
  };

  const result = await findCompletedInvestigationByPostVersionId(prisma, "post-version-id");
  assert.equal(result, null);

  if (typeof capturedArgs !== "object" || capturedArgs === null) return;
  const query = capturedArgs as { where: unknown; include: unknown };
  assert.deepEqual(query.where, {
    postVersionId: "post-version-id",
    status: "COMPLETE",
  });
  assert.notEqual(query.include, null);
});

test("findLatestServerVerifiedCompleteInvestigationForPost queries by post id and orders by checkedAt desc", async () => {
  let capturedArgs: unknown = null;
  const prisma = {
    investigation: {
      findFirst: async (args: unknown) => {
        capturedArgs = args;
        return null;
      },
    },
  };

  const result = await findLatestServerVerifiedCompleteInvestigationForPost(prisma, "post-id");
  assert.equal(result, null);

  if (typeof capturedArgs !== "object" || capturedArgs === null) return;
  const query = capturedArgs as { where: unknown; orderBy: unknown; include: unknown };
  assert.deepEqual(query.where, {
    status: "COMPLETE",
    postVersion: {
      postId: "post-id",
      contentProvenance: "SERVER_VERIFIED",
    },
  });
  assert.deepEqual(query.orderBy, { checkedAt: "desc" });
  assert.notEqual(query.include, null);
});

test("maybeRecordCorroboration gates on auth and handles duplicate credit races", async () => {
  let findFirstCalls = 0;
  let createCalls = 0;
  const createErrors: Error[] = [createKnownRequestError("P2002"), new Error("unexpected")];

  const prisma = {
    investigation: {
      findFirst: async () => {
        findFirstCalls += 1;
        if (findFirstCalls === 1) {
          return null;
        }
        return { id: "investigation-id" };
      },
    },
    corroborationCredit: {
      create: async () => {
        createCalls += 1;
        const maybeError = createErrors.shift();
        if (maybeError !== undefined) {
          throw maybeError;
        }
        return { id: "credit-id" };
      },
    },
  };

  await maybeRecordCorroboration(prisma, "post-version-id", "viewer-key", false);
  assert.equal(findFirstCalls, 0);
  assert.equal(createCalls, 0);

  await maybeRecordCorroboration(prisma, "post-version-id", "viewer-key", true);
  assert.equal(findFirstCalls, 1);
  assert.equal(createCalls, 0);

  await maybeRecordCorroboration(prisma, "post-version-id", "viewer-key", true);
  assert.equal(findFirstCalls, 2);
  assert.equal(createCalls, 1);

  await assert.rejects(
    () => maybeRecordCorroboration(prisma, "post-version-id", "viewer-key", true),
    /unexpected/,
  );
  assert.equal(findFirstCalls, 3);
  assert.equal(createCalls, 2);
});

test("ensureInvestigationsWithUpdateMetadata forwards create and update payloads", async () => {
  const ensureQueuedCalls: {
    prisma: { name: string };
    postVersionId: string;
    promptId: string;
    parentInvestigationId?: string;
    contentDiff?: string;
    rejectOverWordLimitOnCreate: true;
    allowRequeueFailed: true;
    onPendingRun?: unknown;
  }[] = [];
  const ensureQueued = async (input: (typeof ensureQueuedCalls)[number]) => {
    ensureQueuedCalls.push(input);
    return { investigation: { id: "inv-id", status: "PENDING" as const } };
  };
  const postVersion = buildResolvedPostVersion("new line\ntail");
  const prismaToken = { name: "prisma-token" };
  const onPendingRun = async () => {};

  await ensureInvestigationsWithUpdateMetadata({
    prisma: prismaToken,
    promptId: "prompt-id",
    postVersion,
    sourceInvestigation: null,
    onPendingRun,
    ensureQueued,
  });

  assert.deepEqual(ensureQueuedCalls[0], {
    prisma: prismaToken,
    postVersionId: "post-version-id",
    promptId: "prompt-id",
    rejectOverWordLimitOnCreate: true,
    allowRequeueFailed: true,
    onPendingRun,
  });

  await ensureInvestigationsWithUpdateMetadata({
    prisma: prismaToken,
    promptId: "prompt-id",
    postVersion,
    sourceInvestigation: {
      id: "source-investigation-id",
      postVersion: {
        id: "old-post-version-id",
        contentBlob: {
          contentText: "old line\ntail",
        },
      },
      claims: [],
    },
    ensureQueued,
  });

  assert.deepEqual(ensureQueuedCalls[1], {
    prisma: prismaToken,
    postVersionId: "post-version-id",
    promptId: "prompt-id",
    parentInvestigationId: "source-investigation-id",
    contentDiff:
      "Diff summary (line context):\n- Removed lines:\nold line\n+ Added lines:\nnew line",
    rejectOverWordLimitOnCreate: true,
    allowRequeueFailed: true,
  });
});
