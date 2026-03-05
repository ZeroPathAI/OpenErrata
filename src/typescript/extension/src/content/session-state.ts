import type {
  ExtensionSkippedReason,
  Platform,
  PlatformContent,
  ViewPostInput,
} from "@openerrata/shared";
import type { PlatformAdapter } from "./adapters/index.js";
import type { ParsedExtensionPageStatus } from "./sync.js";

export type PageSessionState =
  | {
      kind: "IDLE";
      tabSessionId: number;
      sessionKey: null;
    }
  | {
      kind: "SKIPPED";
      tabSessionId: number;
      sessionKey: string;
      platform: Platform;
      externalId: string;
      pageUrl: string;
      reason: ExtensionSkippedReason;
    }
  | {
      kind: "TRACKED_POST";
      tabSessionId: number;
      sessionKey: string;
      platform: Platform;
      externalId: string;
      /**
       * Normalized text of the live content root observed for this session.
       * `null` means the root was unavailable when the session started.
       */
      observedRootText: string | null;
      adapter: PlatformAdapter;
      request: ViewPostInput;
    };

export type TrackedPostSessionState = Extract<PageSessionState, { kind: "TRACKED_POST" }>;

export type PageSnapshot =
  | {
      kind: "NONE";
      sessionKey: null;
    }
  | {
      kind: "SKIPPED";
      sessionKey: string;
      platform: Platform;
      externalId: string;
      pageUrl: string;
      reason: ExtensionSkippedReason;
    }
  | {
      kind: "TRACKED_POST";
      sessionKey: string;
      platform: Platform;
      externalId: string;
      adapter: PlatformAdapter;
      content: PlatformContent;
      request: ViewPostInput;
    };

export type TrackedPostSnapshot = Extract<PageSnapshot, { kind: "TRACKED_POST" }>;

export function createInitialPageSessionState(): PageSessionState {
  return {
    kind: "IDLE",
    tabSessionId: 0,
    sessionKey: null,
  };
}

export function createIdleSessionState(tabSessionId: number): PageSessionState {
  return {
    kind: "IDLE",
    tabSessionId,
    sessionKey: null,
  };
}

export function createSkippedSessionState(
  tabSessionId: number,
  snapshot: Extract<PageSnapshot, { kind: "SKIPPED" }>,
): PageSessionState {
  return {
    kind: "SKIPPED",
    tabSessionId,
    sessionKey: snapshot.sessionKey,
    platform: snapshot.platform,
    externalId: snapshot.externalId,
    pageUrl: snapshot.pageUrl,
    reason: snapshot.reason,
  };
}

export function createTrackedPostSessionState(
  tabSessionId: number,
  snapshot: TrackedPostSnapshot,
  observedRootText: string | null,
): TrackedPostSessionState {
  return {
    kind: "TRACKED_POST",
    tabSessionId,
    sessionKey: snapshot.sessionKey,
    platform: snapshot.platform,
    externalId: snapshot.externalId,
    observedRootText,
    adapter: snapshot.adapter,
    request: snapshot.request,
  };
}

export function isActiveTrackedSession(
  currentState: PageSessionState,
  targetState: TrackedPostSessionState,
): boolean {
  return (
    currentState.kind === "TRACKED_POST" &&
    currentState.tabSessionId === targetState.tabSessionId &&
    currentState.platform === targetState.platform &&
    currentState.externalId === targetState.externalId
  );
}

export function isCurrentSessionPostStatus(
  currentState: PageSessionState,
  status: ParsedExtensionPageStatus | null,
): status is Extract<ParsedExtensionPageStatus, { kind: "POST" }> {
  if (status?.kind !== "POST" || currentState.kind !== "TRACKED_POST") {
    return false;
  }

  return (
    status.tabSessionId === currentState.tabSessionId &&
    status.platform === currentState.platform &&
    status.externalId === currentState.externalId
  );
}

export function shouldRefreshSkippedSessionOnMutation(
  reason: ExtensionSkippedReason,
  adapterPresent: boolean,
): boolean {
  if (!adapterPresent) {
    return false;
  }

  return reason === "unsupported_content" || reason === "no_text" || reason === "private_or_gated";
}
