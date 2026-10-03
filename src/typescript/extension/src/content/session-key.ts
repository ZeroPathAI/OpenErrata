import { serializeObservedVersionIdentity, type PlatformContent } from "@openerrata/shared";
import { pageLocatorKey } from "../lib/page-locator.js";
import type { PageSnapshot } from "./session-state.js";

function contentIdentity(content: PlatformContent): unknown {
  return {
    platform: content.platform,
    externalId: content.externalId,
    hasVideo: content.hasVideo,
    observedVersionIdentity: serializeObservedVersionIdentity({
      contentText: content.contentText,
      imageOccurrences: content.imageOccurrences,
    }),
  };
}

/**
 * Identity of the page session a snapshot belongs to: a new key means a new
 * session (new tab session id, fresh sync with the background). Null for
 * snapshots that are not sessions (no supported post, or not extractable yet).
 *
 * Content-derived snapshots are keyed by post identity plus observed version,
 * so an edit re-syncs; page-derived skips by the page locator (URL identity)
 * and reason.
 */
export function sessionKeyFor(snapshot: PageSnapshot): string | null {
  switch (snapshot.kind) {
    case "NONE":
    case "PENDING":
      return null;
    case "TRACKED_POST":
      return JSON.stringify({ kind: "TRACKED_POST", content: contentIdentity(snapshot.content) });
    case "SKIPPED":
      return JSON.stringify({
        kind: "SKIPPED",
        reason: snapshot.reason,
        basis:
          snapshot.basis.kind === "CONTENT"
            ? contentIdentity(snapshot.basis.content)
            : pageLocatorKey(snapshot.basis.locator),
      });
  }
}
