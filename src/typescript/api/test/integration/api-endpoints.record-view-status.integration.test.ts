import { TRPCError } from "@trpc/server";
import {
  assert,
  buildXViewInput,
  createCaller,
  hashContent,
  normalizeContent,
  prisma,
  seedClaimWithSource,
  seedCompleteInvestigation,
  seedInvestigation,
  seedInvestigationForXViewInput,
  seedPostForXViewInput,
  test,
} from "./api-endpoints.integration.shared.js";

// recordViewAndGetStatus reports the investigation of the viewed post version in
// whatever state it is in (spec §2.6), with its id, so a viewer who did not
// start the investigation can still poll it to completion.

void test("post.recordViewAndGetStatus reports a PENDING investigation as INVESTIGATING with its id and interim claims", async () => {
  const caller = createCaller();
  const input = buildXViewInput({
    externalId: "record-view-status-pending-update-1",
    observedContentText: "Original content for the record view status coverage.",
  });
  const post = await seedPostForXViewInput(input);
  const parent = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "SERVER_VERIFIED",
  });
  const survivingClaim = await seedClaimWithSource(parent.id, 1, {
    text: "Original content for the record view status coverage.",
  });
  // The edit removed the passage this claim quoted, so it is not carried forward.
  await seedClaimWithSource(parent.id, 2, { text: "A sentence the edit removed." });

  const updatedText = normalizeContent(
    "Original content for the record view status coverage. Edited sentence.",
  );
  const pending = await seedInvestigation({
    postId: post.id,
    contentHash: await hashContent(updatedText),
    contentText: updatedText,
    provenance: "SERVER_VERIFIED",
    status: "PENDING",
    promptLabel: "record-view-status-pending-update",
    parentInvestigationId: parent.id,
    contentDiff: "Diff summary (line context):\n- Removed lines:\nOld\n+ Added lines:\nNew",
  });
  const pendingVersion = await prisma.investigation.findUniqueOrThrow({
    where: { id: pending.id },
    select: { postVersionId: true },
  });

  const result = await caller.post.recordViewAndGetStatus({
    postVersionId: pendingVersion.postVersionId,
  });

  assert.equal(result.investigationState, "INVESTIGATING");
  assert.equal(result.investigationId, pending.id);
  assert.equal(result.status, "PENDING");
  assert.equal(result.provenance, "SERVER_VERIFIED");
  assert.deepEqual(result.pendingClaims, []);
  assert.deepEqual(result.confirmedClaims, []);
  assert.ok(result.priorInvestigationResult);
  assert.equal(result.priorInvestigationResult.sourceInvestigationId, parent.id);
  assert.deepEqual(
    result.priorInvestigationResult.oldClaims.map((claim) => claim.id),
    [survivingClaim.id],
  );
});

void test("post.recordViewAndGetStatus reports no interim claims for an INVESTIGATING update when none of the parent's claims is still on the page", async () => {
  const caller = createCaller();
  const input = buildXViewInput({
    externalId: "record-view-status-pending-update-none-surviving-1",
    observedContentText: "A post whose every sentence the author later rewrote.",
  });
  const post = await seedPostForXViewInput(input);
  const parent = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "SERVER_VERIFIED",
  });
  await seedClaimWithSource(parent.id, 1, { text: "every sentence the author later rewrote" });

  const rewrittenText = normalizeContent("The rewritten post shares no sentence with the old one.");
  const pending = await seedInvestigation({
    postId: post.id,
    contentHash: await hashContent(rewrittenText),
    contentText: rewrittenText,
    provenance: "SERVER_VERIFIED",
    status: "PENDING",
    promptLabel: "record-view-status-pending-update-none-surviving",
    parentInvestigationId: parent.id,
    contentDiff: "Diff summary (line context):\n- Removed lines:\nOld\n+ Added lines:\nNew",
  });
  const pendingVersion = await prisma.investigation.findUniqueOrThrow({
    where: { id: pending.id },
    select: { postVersionId: true },
  });

  const result = await caller.post.recordViewAndGetStatus({
    postVersionId: pendingVersion.postVersionId,
  });

  assert.equal(result.investigationState, "INVESTIGATING");
  assert.equal(result.priorInvestigationResult, null);
});

void test("post.recordViewAndGetStatus reports PROCESSING progress claims from the active lease", async () => {
  const caller = createCaller();
  const input = buildXViewInput({
    externalId: "record-view-status-processing-1",
    observedContentText: "Processing content for the record view status coverage.",
  });
  const seeded = await seedInvestigationForXViewInput({
    viewInput: input,
    status: "PROCESSING",
    provenance: "CLIENT_FALLBACK",
  });
  const progressClaim = {
    text: "Processing content",
    context: "Processing content for the record view status coverage.",
    summary: "Summary of a claim found so far.",
    reasoning: "Reasoning for the claim found so far.",
    sources: [{ url: "https://example.com/source", title: "Source", snippet: "Snippet" }],
  };
  await prisma.investigationLease.update({
    where: { investigationId: seeded.investigationId },
    data: { progressClaims: { pending: [progressClaim], confirmed: [] } },
  });

  const result = await caller.post.recordViewAndGetStatus({
    postVersionId: seeded.post.postVersionId,
  });

  assert.equal(result.investigationState, "INVESTIGATING");
  assert.equal(result.investigationId, seeded.investigationId);
  assert.equal(result.status, "PROCESSING");
  assert.equal(result.provenance, "CLIENT_FALLBACK");
  assert.deepEqual(result.pendingClaims, [progressClaim]);
  assert.deepEqual(result.confirmedClaims, []);
  assert.equal(result.priorInvestigationResult, null);

  const viewedPost = await prisma.post.findUniqueOrThrow({
    where: { id: seeded.post.id },
    select: { viewCount: true },
  });
  assert.equal(viewedPost.viewCount, 1, "a view of an in-progress post is still recorded");
});

void test("post.recordViewAndGetStatus reports FAILED investigations as FAILED rather than not investigated", async () => {
  const caller = createCaller();
  const seeded = await seedInvestigationForXViewInput({
    viewInput: buildXViewInput({
      externalId: "record-view-status-failed-1",
      observedContentText: "Failed content for the record view status coverage.",
    }),
    status: "FAILED",
    provenance: "CLIENT_FALLBACK",
  });

  const result = await caller.post.recordViewAndGetStatus({
    postVersionId: seeded.post.postVersionId,
  });

  assert.deepEqual(result, {
    investigationState: "FAILED",
    investigationId: seeded.investigationId,
    provenance: "CLIENT_FALLBACK",
  });
});

void test("post.recordViewAndGetStatus reports COMPLETE investigations with their id", async () => {
  const caller = createCaller();
  const seeded = await seedInvestigationForXViewInput({
    viewInput: buildXViewInput({
      externalId: "record-view-status-complete-1",
      observedContentText: "Complete content for the record view status coverage.",
    }),
    status: "COMPLETE",
    provenance: "CLIENT_FALLBACK",
    claimCount: 2,
  });

  const result = await caller.post.recordViewAndGetStatus({
    postVersionId: seeded.post.postVersionId,
  });

  assert.equal(result.investigationState, "INVESTIGATED");
  assert.equal(result.investigationId, seeded.investigationId);
  assert.equal(result.claims.length, 2);
});

void test("post.recordViewAndGetStatus rejects unknown post versions", async () => {
  const caller = createCaller();

  await assert.rejects(
    () => caller.post.recordViewAndGetStatus({ postVersionId: "unknown-post-version-id" }),
    (error: unknown) => error instanceof TRPCError && error.code === "BAD_REQUEST",
  );
});
