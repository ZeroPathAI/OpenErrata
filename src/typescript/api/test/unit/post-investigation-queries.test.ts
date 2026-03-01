import assert from "node:assert/strict";
import { test } from "node:test";
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
  type InvestigationRepository,
} from "../../src/lib/trpc/routes/post/investigation-queries.js";

function nullRepo(): InvestigationRepository {
  return {
    findInvestigationWithClaims: async () => null,
    findCompletedByPostVersionId: async () => null,
    findLatestServerVerifiedComplete: async () => null,
    findClientFallbackInvestigationId: async () => null,
    recordCorroborationCredit: async () => {},
  };
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

test("load and lookup helpers delegate to repository methods", async () => {
  const repo = nullRepo();
  assert.equal(await loadInvestigationWithClaims(repo, "inv-1"), null);
  assert.equal(await findCompletedInvestigationByPostVersionId(repo, "pv-1"), null);
  assert.equal(await findLatestServerVerifiedCompleteInvestigationForPost(repo, "post-1"), null);
});

test("maybeRecordCorroboration gates on auth and delegates to repository", async () => {
  let lookupCalls = 0;
  let creditCalls = 0;
  const errors: Error[] = [new Error("unexpected")];

  const repo: InvestigationRepository = {
    ...nullRepo(),
    findClientFallbackInvestigationId: async () => {
      lookupCalls += 1;
      return lookupCalls === 1 ? null : "investigation-id";
    },
    recordCorroborationCredit: async () => {
      creditCalls += 1;
      const maybeError = errors.shift();
      if (maybeError !== undefined) {
        throw maybeError;
      }
    },
  };

  // Not authenticated — skipped entirely.
  await maybeRecordCorroboration(repo, "pv-1", "viewer-key", false);
  assert.equal(lookupCalls, 0);
  assert.equal(creditCalls, 0);

  // Authenticated but no client-fallback investigation found.
  await maybeRecordCorroboration(repo, "pv-1", "viewer-key", true);
  assert.equal(lookupCalls, 1);
  assert.equal(creditCalls, 0);

  // Authenticated with matching investigation — error propagates.
  await assert.rejects(
    () => maybeRecordCorroboration(repo, "pv-1", "viewer-key", true),
    /unexpected/,
  );
  assert.equal(lookupCalls, 2);
  assert.equal(creditCalls, 1);

  // Success path.
  await maybeRecordCorroboration(repo, "pv-1", "viewer-key", true);
  assert.equal(lookupCalls, 3);
  assert.equal(creditCalls, 2);
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
