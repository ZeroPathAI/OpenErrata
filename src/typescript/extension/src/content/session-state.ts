import type {
  ExtensionPostStatus,
  ExtensionSkippedReason,
  Platform,
  PlatformContent,
  TabSessionId,
} from "@openerrata/shared";
import type { PageLocator } from "../lib/page-locator.js";
import type { PlatformAdapter } from "./adapters/index.js";

/**
 * What the content script currently sees on the page. Every snapshot that
 * describes a supported post page starts a page session (see `sessionKeyFor`).
 */
export type PageSnapshot =
  /** No supported post on this page. */
  | { kind: "NONE" }
  /** A supported post page whose post cannot be extracted yet (still rendering). */
  | { kind: "PENDING" }
  | SkippedSnapshot
  | TrackedPostSnapshot;

export interface SkippedSnapshot {
  kind: "SKIPPED";
  platform: Platform;
  pageUrl: string;
  reason: ExtensionSkippedReason;
  /**
   * What the skip was decided from: the extracted content (video, length,
   * empty text) or only the page itself (gated or unextractable pages).
   */
  basis: { kind: "CONTENT"; content: PlatformContent } | { kind: "PAGE"; locator: PageLocator };
}

export interface TrackedPostSnapshot {
  kind: "TRACKED_POST";
  adapter: PlatformAdapter;
  content: PlatformContent;
}

export type PageSessionState =
  | { kind: "IDLE" }
  | {
      kind: "SKIPPED";
      tabSessionId: TabSessionId;
      sessionKey: string;
      reason: ExtensionSkippedReason;
    }
  | TrackedPostSessionState;

export interface TrackedPostSessionState {
  kind: "TRACKED_POST";
  tabSessionId: TabSessionId;
  sessionKey: string;
  adapter: PlatformAdapter;
  /** The content sent to the background; its text is the baseline for mutation checks. */
  content: PlatformContent;
}

export function sessionKeyOfState(state: PageSessionState): string | null {
  return state.kind === "IDLE" ? null : state.sessionKey;
}

/** Whether `status` was cached for the page session `state`. */
export function isStatusOfSession(
  state: PageSessionState,
  status: ExtensionPostStatus,
): state is TrackedPostSessionState {
  return state.kind === "TRACKED_POST" && status.tabSessionId === state.tabSessionId;
}

/**
 * Skips decided from the page rather than final content can be lifted by
 * later DOM changes (a paywall removed after login, a post finishing
 * rendering), so they are re-evaluated on mutation.
 */
export function shouldRefreshSkippedSessionOnMutation(reason: ExtensionSkippedReason): boolean {
  return reason === "unsupported_content" || reason === "no_text" || reason === "private_or_gated";
}
