import {
  annotationVisibilityResponseSchema,
  normalizeContent,
  requestInvestigateResponseSchema,
  WORD_COUNT_LIMIT,
  type ExtensionSkippedReason,
  type Platform,
  type PlatformContent,
  type ViewPostInput,
} from "@truesight/shared";
import type { PlatformAdapter } from "./adapters/index";
import { getAdapter } from "./adapters/index";
import { parseSupportedPageIdentity } from "../lib/post-identity";
import { AnnotationController } from "./annotations";
import { PageObserver } from "./observer";
import { ContentSyncClient, type ParsedExtensionPageStatus } from "./sync";

const REFRESH_DEBOUNCE_MS = 200;
const REAPPLY_DEBOUNCE_MS = 300;
const SYNC_RETRY_INITIAL_MS = 1_000;
const SYNC_RETRY_MAX_MS = 30_000;

type PageSessionState =
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
      adapter: PlatformAdapter;
      request: ViewPostInput;
    };

type TrackedPostSessionState = Extract<PageSessionState, { kind: "TRACKED_POST" }>;
type TrackedPostSnapshot = Extract<PageSnapshot, { kind: "TRACKED_POST" }>;

type PageSnapshot =
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

function pageKeyFor(content: PlatformContent): string {
  return [
    content.platform,
    content.externalId,
    content.mediaState,
    content.contentText,
  ].join(":");
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function exceedsWordCountLimit(text: string): boolean {
  return wordCount(text) > WORD_COUNT_LIMIT;
}

function toViewPostInput(content: PlatformContent): ViewPostInput {
  const common = {
    externalId: content.externalId,
    url: content.url,
    observedContentText: content.contentText,
    observedImageUrls: content.imageUrls,
  };

  switch (content.platform) {
    case "LESSWRONG":
      return {
        ...common,
        platform: "LESSWRONG",
        metadata: content.metadata,
      };
    case "X":
      return {
        ...common,
        platform: "X",
        metadata: content.metadata,
      };
    case "SUBSTACK":
      return {
        ...common,
        platform: "SUBSTACK",
        metadata: content.metadata,
      };
  }
}

export class PageSessionController {
  #state: PageSessionState = {
    kind: "IDLE",
    tabSessionId: 0,
    sessionKey: null,
  };
  #tabSessionCounter = 0;
  #lastObservedUrl = window.location.href;
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  #refreshInFlight = false;
  #refreshQueued = false;
  #booted = false;
  #pendingSyncRetrySessionKey: string | null = null;
  #nextSyncRetryDelayMs = SYNC_RETRY_INITIAL_MS;
  readonly #annotations = new AnnotationController();
  readonly #sync = new ContentSyncClient();
  readonly #observer = new PageObserver({
    mutationDebounceMs: REAPPLY_DEBOUNCE_MS,
    onNavigation: () => {
      this.scheduleRefresh();
    },
    onMutationSettled: () => {
      this.#onMutationSettled();
    },
  });

  boot(): void {
    if (this.#booted) return;
    this.#booted = true;

    this.#sync.installCachedStatusListener(() => {
      void this.#syncStatusFromBackgroundCache().catch((error) => {
        console.error("Failed to sync background status:", error);
      });
    });

    this.#observer.start();
    this.scheduleRefresh();
  }

  async requestInvestigation(): Promise<{ ok: boolean }> {
    const stateAtRequest = this.#state;
    if (stateAtRequest.kind !== "TRACKED_POST") {
      return requestInvestigateResponseSchema.parse({ ok: false });
    }

    const investigateResult = await this.#sync.requestInvestigation(
      stateAtRequest.tabSessionId,
      stateAtRequest.request,
    );

    if (investigateResult.status === "COMPLETE") {
      if (investigateResult.claims !== undefined) {
        if (!this.#isActiveTrackedSession(stateAtRequest)) {
          return requestInvestigateResponseSchema.parse({ ok: true });
        }
        this.#annotations.setClaims(investigateResult.claims);
        const applied = this.#annotations.render(stateAtRequest.adapter);
        if (!applied) {
          this.scheduleRefresh();
        }
      } else {
        void this.#syncStatusFromBackgroundCache().catch((error) => {
          console.error("Failed to sync completed investigation status:", error);
        });
      }
      return requestInvestigateResponseSchema.parse({ ok: true });
    }

    void this.#syncStatusFromBackgroundCache().catch((error) => {
      console.error("Failed to sync queued investigation status:", error);
    });
    return requestInvestigateResponseSchema.parse({ ok: true });
  }

  #isActiveTrackedSession(state: TrackedPostSessionState): boolean {
    return (
      this.#state.kind === "TRACKED_POST" &&
      this.#state.tabSessionId === state.tabSessionId &&
      this.#state.platform === state.platform &&
      this.#state.externalId === state.externalId
    );
  }

  showAnnotations(): { ok: boolean } {
    const adapter = this.#state.kind === "TRACKED_POST" ? this.#state.adapter : null;
    this.#annotations.show(adapter);
    return { ok: true };
  }

  hideAnnotations(): { ok: boolean } {
    this.#annotations.hide();
    return { ok: true };
  }

  getAnnotationVisibility(): { visible: boolean } {
    return annotationVisibilityResponseSchema.parse({
      visible: this.#annotations.isVisible(),
    });
  }

  scheduleRefresh(delayMs = REFRESH_DEBOUNCE_MS): void {
    if (this.#refreshTimer !== null) {
      clearTimeout(this.#refreshTimer);
    }

    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      void this.#runRefreshCycle();
    }, delayMs);
  }

  #resetSyncRetryState(): void {
    this.#pendingSyncRetrySessionKey = null;
    this.#nextSyncRetryDelayMs = SYNC_RETRY_INITIAL_MS;
  }

  #scheduleSyncRetry(sessionKey: string): void {
    this.#pendingSyncRetrySessionKey = sessionKey;
    const retryDelayMs = this.#nextSyncRetryDelayMs;
    this.#nextSyncRetryDelayMs = Math.min(
      this.#nextSyncRetryDelayMs * 2,
      SYNC_RETRY_MAX_MS,
    );
    this.scheduleRefresh(retryDelayMs);
  }

  async #runRefreshCycle(): Promise<void> {
    if (this.#refreshInFlight) {
      this.#refreshQueued = true;
      return;
    }

    this.#refreshInFlight = true;
    try {
      this.#refreshQueued = true;
      while (this.#refreshQueued) {
        this.#refreshQueued = false;
        await this.#refreshPageState();
      }
    } finally {
      this.#refreshInFlight = false;
    }
  }

  async #refreshPageState(): Promise<void> {
    this.#lastObservedUrl = window.location.href;
    const snapshot = this.#snapshotCurrentPage();
    const currentSessionKey = this.#state.sessionKey;

    if (snapshot.sessionKey === currentSessionKey) {
      if (
        snapshot.kind === "TRACKED_POST" &&
        this.#state.kind === "TRACKED_POST" &&
        this.#pendingSyncRetrySessionKey === snapshot.sessionKey
      ) {
        await this.#syncTrackedSnapshot(this.#state.tabSessionId, snapshot);
        return;
      }
      if (this.#state.kind === "TRACKED_POST") {
        this.#annotations.reapplyIfMissing(this.#state.adapter);
      }
      return;
    }

    await this.#transitionToSnapshot(snapshot);
  }

  #snapshotCurrentPage(): PageSnapshot {
    const url = window.location.href;
    const adapter = getAdapter(url, document);
    if (!adapter) {
      return {
        kind: "NONE",
        sessionKey: null,
      };
    }

    const content = adapter.extract(document);
    if (!content) {
      const supportedIdentity = parseSupportedPageIdentity(url);
      if (!supportedIdentity) {
        return {
          kind: "NONE",
          sessionKey: null,
        };
      }

      return {
        kind: "SKIPPED",
        sessionKey: [
          "unsupported_content",
          supportedIdentity.platform,
          supportedIdentity.externalId,
        ].join(":"),
        platform: supportedIdentity.platform,
        externalId: supportedIdentity.externalId,
        pageUrl: url,
        reason: "unsupported_content",
      };
    }

    if (content.mediaState === "video_only") {
      return {
        kind: "SKIPPED",
        sessionKey: pageKeyFor(content),
        platform: content.platform,
        externalId: content.externalId,
        pageUrl: content.url,
        reason: "video_only",
      };
    }

    if (exceedsWordCountLimit(content.contentText)) {
      return {
        kind: "SKIPPED",
        sessionKey: pageKeyFor(content),
        platform: content.platform,
        externalId: content.externalId,
        pageUrl: content.url,
        reason: "word_count",
      };
    }

    return {
      kind: "TRACKED_POST",
      sessionKey: pageKeyFor(content),
      platform: content.platform,
      externalId: content.externalId,
      adapter,
      request: toViewPostInput(content),
      content,
    };
  }

  async #syncTrackedSnapshot(
    tabSessionId: number,
    snapshot: TrackedPostSnapshot,
  ): Promise<void> {
    let viewPost: Awaited<ReturnType<ContentSyncClient["sendPageContent"]>>;
    try {
      viewPost = await this.#sync.sendPageContent(tabSessionId, snapshot.content);
    } catch (error) {
      console.error("Failed to sync page content with background:", error);
      this.#scheduleSyncRetry(snapshot.sessionKey);
      return;
    }

    this.#resetSyncRetryState();
    this.#annotations.setClaims(viewPost.claims ?? []);
    if (this.#annotations.getClaims().length > 0) {
      const applied = this.#annotations.render(snapshot.adapter);
      if (!applied) {
        this.scheduleRefresh();
      }
    }
  }

  async #transitionToSnapshot(snapshot: PageSnapshot): Promise<void> {
    if (this.#state.kind !== "IDLE") {
      this.#sync.sendPageReset(this.#state.tabSessionId);
    }

    this.#annotations.clearAll();

    if (snapshot.kind === "NONE") {
      this.#resetSyncRetryState();
      this.#state = {
        kind: "IDLE",
        tabSessionId: this.#tabSessionCounter,
        sessionKey: null,
      };
      return;
    }

    const tabSessionId = this.#nextTabSessionId();

    if (snapshot.kind === "SKIPPED") {
      this.#resetSyncRetryState();
      this.#state = {
        kind: "SKIPPED",
        tabSessionId,
        sessionKey: snapshot.sessionKey,
        platform: snapshot.platform,
        externalId: snapshot.externalId,
        pageUrl: snapshot.pageUrl,
        reason: snapshot.reason,
      };
      this.#sync.sendPageSkipped({
        tabSessionId,
        platform: snapshot.platform,
        externalId: snapshot.externalId,
        pageUrl: snapshot.pageUrl,
        reason: snapshot.reason,
      });
      return;
    }

    if (this.#pendingSyncRetrySessionKey !== snapshot.sessionKey) {
      this.#resetSyncRetryState();
    }

    this.#state = {
      kind: "TRACKED_POST",
      tabSessionId,
      sessionKey: snapshot.sessionKey,
      platform: snapshot.platform,
      externalId: snapshot.externalId,
      adapter: snapshot.adapter,
      request: snapshot.request,
    };
    await this.#syncTrackedSnapshot(tabSessionId, snapshot);
  }

  #nextTabSessionId(): number {
    this.#tabSessionCounter += 1;
    return this.#tabSessionCounter;
  }

  async #syncStatusFromBackgroundCache(): Promise<void> {
    const status = await this.#sync.getCachedStatus();
    if (!this.#isCurrentSessionPostStatus(status) || this.#state.kind !== "TRACKED_POST") {
      return;
    }
    const state = this.#state;

    if (status.investigationState === "INVESTIGATED") {
      this.#annotations.setClaims(status.claims);
      const applied = this.#annotations.render(state.adapter);
      if (!applied) {
        this.scheduleRefresh();
      }
      return;
    }

    if (status.investigationState === "FAILED") {
      this.#annotations.clearAll();
    }
  }

  #isCurrentSessionPostStatus(
    status: ParsedExtensionPageStatus | null,
  ): status is Extract<ParsedExtensionPageStatus, { kind: "POST" }> {
    if (
      status === null ||
      status.kind !== "POST" ||
      this.#state.kind !== "TRACKED_POST"
    ) {
      return false;
    }

    return (
      status.tabSessionId === this.#state.tabSessionId &&
      status.platform === this.#state.platform &&
      status.externalId === this.#state.externalId
    );
  }

  #onMutationSettled(): void {
    const currentUrl = window.location.href;
    if (currentUrl !== this.#lastObservedUrl) {
      this.scheduleRefresh();
      return;
    }

    if (this.#state.kind === "IDLE") {
      if (getAdapter(currentUrl, document)) {
        this.scheduleRefresh();
      }
      return;
    }

    if (this.#state.kind === "SKIPPED") {
      if (this.#state.reason === "unsupported_content" && getAdapter(currentUrl, document)) {
        this.scheduleRefresh();
      }
      return;
    }

    const root = this.#state.adapter.getContentRoot(document);
    if (!root) {
      this.scheduleRefresh();
      return;
    }

    const normalizedText = normalizeContent(root.textContent);
    if (
      normalizedText.length > 0 &&
      normalizedText !== this.#state.request.observedContentText
    ) {
      this.scheduleRefresh();
      return;
    }

    this.#annotations.reapplyIfMissing(this.#state.adapter);
  }
}
