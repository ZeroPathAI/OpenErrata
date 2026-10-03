/**
 * Update lineage for new investigations (SPEC §2.4.3).
 *
 * When a post is edited and an earlier version already has a complete
 * SERVER_VERIFIED investigation, the new investigation runs in update mode:
 * it records that investigation as its parent and carries a line diff from the
 * parent's text, so the prompt can keep unchanged claims stable. Every path
 * that creates investigations (investigateNow and the selector) goes through
 * here, so update-aware prompting does not depend on who queued the run.
 */

import type { DbClient } from "$lib/db/client";

export interface UpdateLineage {
  parentInvestigationId: string;
  contentDiff: string;
}

/**
 * Lineage for a new investigation of `postVersion`, or null when no other
 * version of the post has a complete SERVER_VERIFIED investigation.
 */
export async function resolveUpdateLineage(
  db: DbClient,
  postVersion: { id: string; postId: string; contentText: string },
): Promise<UpdateLineage | null> {
  const parent = await db.investigation.findFirst({
    where: {
      status: "COMPLETE",
      input: { provenance: "SERVER_VERIFIED" },
      postVersion: { postId: postVersion.postId, id: { not: postVersion.id } },
    },
    orderBy: [{ checkedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      postVersion: { select: { contentBlob: { select: { contentText: true } } } },
    },
  });
  if (parent === null) {
    return null;
  }

  return {
    parentInvestigationId: parent.id,
    contentDiff: buildLineDiff(parent.postVersion.contentBlob.contentText, postVersion.contentText),
  };
}

/**
 * Deterministic line-oriented diff: the common prefix and suffix are trimmed
 * and the differing middle is reported as removed and added lines.
 */
export function buildLineDiff(previous: string, current: string): string {
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
