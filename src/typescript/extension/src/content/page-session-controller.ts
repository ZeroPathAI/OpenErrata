import {
  annotationVisibilityResponseSchema,
  focusClaimResponseSchema,
  type InvestigationClaim,
  normalizeContent,
  requestInvestigateResponseSchema,
  WORD_COUNT_LIMIT,
  type ExtensionSkippedReason,
  type Platform,
  type PlatformContent,
  type ViewPostInput,
} from "@openerrata/shared";
import type { PlatformAdapter } from "./adapters/index";
import { getAdapter } from "./adapters/index";
import { parseSupportedPageIdentity } from "../lib/post-identity";
import {
  isContentMismatchRuntimeError,
  isExtensionContextInvalidatedError,
} from "../lib/runtime-error";
import { toViewPostInput } from "../lib/view-post-input";
import { AnnotationController } from "./annotations";
import { PageObserver } from "./observer";
import { ContentSyncClient, type ParsedExtensionPageStatus } from "./sync";
import { mapClaimsToDom } from "./dom-mapper";

const REFRESH_DEBOUNCE_MS = 200;
const REAPPLY_DEBOUNCE_MS = 300;
const SYNC_RETRY_INITIAL_MS = 1_000;
const SYNC_RETRY_MAX_MS = 30_000;
const SUBSTACK_POST_PATH_REGEX = /^\/p\/([^/?#]+)/i;
const CLAIM_FOCUS_CLASS = "openerrata-focus-target";
const CLAIM_FOCUS_DURATION_MS = 1_500;

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
      observedText: string;
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

function pageLocatorForSessionKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function inferIdentityForSkippedPage(
  url: string,
  adapter: PlatformAdapter,
): { platform: Platform; externalId: string } | null {
  const supportedIdentity = parseSupportedPageIdentity(url);
  if (supportedIdentity) {
    return supportedIdentity;
  }

  if (adapter.platformKey !== "SUBSTACK") {
    return null;
  }

  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(SUBSTACK_POST_PATH_REGEX);
    if (!match?.[1]) {
      return null;
    }
    return {
      platform: "SUBSTACK",
      externalId: match[1],
    };
  } catch {
    return null;
  }
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function exceedsWordCountLimit(text: string): boolean {
  return wordCount(text) > WORD_COUNT_LIMIT;
}

function resolveClaimAnchor(range: Range): HTMLElement | null {
  const startContainer = range.startContainer;
  const startElement =
    startContainer instanceof HTMLElement
      ? startContainer
      : startContainer instanceof Text
        ? startContainer.parentElement
        : startContainer instanceof Element
          ? startContainer.parentElement
          : null;
  if (!startElement) return null;
  return startElement.closest(".openerrata-annotation") ?? startElement;
}

function scrollToClaimRange(range: Range): boolean {
  const anchor = resolveClaimAnchor(range);
  if (!anchor) return false;

  anchor.scrollIntoView({
    behavior: "smooth",
    block: "center",
    inline: "nearest",
  });

  anchor.classList.add(CLAIM_FOCUS_CLASS);
  window.setTimeout(() => {
    if (anchor.isConnected) {
      anchor.classList.remove(CLAIM_FOCUS_CLASS);
    }
  }, CLAIM_FOCUS_DURATION_MS);

  return true;
}

function areClaimsEqual(
  left: InvestigationClaim[],
  right: InvestigationClaim[],
): boolean {
  if (left.length !== right.length) return false;

  for (const [index, leftClaim] of left.entries()) {
    const rightClaim = right[index];
    if (!rightClaim) return false;

    if (
      leftClaim.text !== rightClaim.text ||
      leftClaim.summary !== rightClaim.summary ||
      leftClaim.context !== rightClaim.context ||
      leftClaim.reasoning !== rightClaim.reasoning ||
      leftClaim.sources.length !== rightClaim.sources.length
    ) {
      return false;
    }

    for (const [sourceIndex, leftSource] of leftClaim.sources.entries()) {
      const rightSource = rightClaim.sources[sourceIndex];
      if (!rightSource) return false;
      if (
        leftSource.url !== rightSource.url ||
        leftSource.title !== rightSource.title ||
        leftSource.snippet !== rightSource.snippet
      ) {
        return false;
      }
    }
  }

  return true;
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
  #cachedStatusUnsubscribe: (() => void) | null = null;
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

    this.#cachedStatusUnsubscribe = this.#sync.installCachedStatusListener(
      () => {
        void this.#syncStatusFromBackgroundCache().catch((error: unknown) => {
          if (isExtensionContextInvalidatedError(error)) {
            return;
          }
          console.error("Failed to sync background status:", error);
        });
      },
    );

    this.#observer.start();
    this.scheduleRefresh();
  }

  dispose(): void {
    if (!this.#booted) return;
    this.#booted = false;

    if (this.#refreshTimer !== null) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    this.#refreshQueued = false;

    this.#observer.stop();
    this.#cachedStatusUnsubscribe?.();
    this.#cachedStatusUnsubscribe = null;
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
      if (!this.#isActiveTrackedSession(stateAtRequest)) {
        return requestInvestigateResponseSchema.parse({ ok: true });
      }
      this.#annotations.setClaims(investigateResult.claims);
      const applied = this.#annotations.render(stateAtRequest.adapter);
      if (!applied) {
        this.scheduleRefresh();
      }
      return requestInvestigateResponseSchema.parse({ ok: true });
    }

    void this.#syncStatusFromBackgroundCache().catch((error: unknown) => {
      if (isExtensionContextInvalidatedError(error)) {
        return;
      }
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
    // Popup opens are a reliable user-driven sync point. Nudge a refresh in case
    // a prior SPA route transition missed observer-driven refresh scheduling.
    this.scheduleRefresh(0);
    return annotationVisibilityResponseSchema.parse({
      visible: this.#annotations.isVisible(),
    });
  }

  focusClaim(claimIndex: number): { ok: boolean } {
    if (this.#state.kind !== "TRACKED_POST") {
      return focusClaimResponseSchema.parse({ ok: false });
    }

    const claim = this.#annotations.getClaims()[claimIndex];
    if (!claim) {
      return focusClaimResponseSchema.parse({ ok: false });
    }

    const root = this.#state.adapter.getContentRoot(document);
    if (!root) {
      return focusClaimResponseSchema.parse({ ok: false });
    }

    if (this.#annotations.isVisible()) {
      const applied = this.#annotations.render(this.#state.adapter);
      if (!applied) {
        this.scheduleRefresh();
      }
    }

    const [mappedClaim] = mapClaimsToDom([claim], root);
    if (!mappedClaim?.matched || !mappedClaim.range) {
      return focusClaimResponseSchema.parse({ ok: false });
    }

    return focusClaimResponseSchema.parse({
      ok: scrollToClaimRange(mappedClaim.range),
    });
  }

  scheduleRefresh(delayMs = REFRESH_DEBOUNCE_MS): void {
    if (!this.#booted) return;
    if (this.#refreshTimer !== null) {
      clearTimeout(this.#refreshTimer);
    }

    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      void this.#runRefreshCycle();
    }, delayMs);
  }

  #hasPendingRetryForActiveSession(): boolean {
    return (
      this.#state.kind === "TRACKED_POST" &&
      this.#pendingSyncRetrySessionKey === this.#state.sessionKey
    );
  }

  #scheduleRefreshFromMutation(): void {
    if (this.#hasPendingRetryForActiveSession()) {
      return;
    }
    this.scheduleRefresh();
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
    if (!this.#booted) return;
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

    if (adapter.detectPrivateOrGated?.(document) === true) {
      const identity = inferIdentityForSkippedPage(url, adapter);
      if (!identity) {
        return {
          kind: "NONE",
          sessionKey: null,
        };
      }

      return {
        kind: "SKIPPED",
        sessionKey: [
          "private_or_gated",
          identity.platform,
          identity.externalId,
          pageLocatorForSessionKey(url),
        ].join(":"),
        platform: identity.platform,
        externalId: identity.externalId,
        pageUrl: url,
        reason: "private_or_gated",
      };
    }

    const extraction = adapter.extract(document);
    if (extraction.kind === "not_ready") {
      if (extraction.reason === "missing_identity") {
        const supportedIdentity = inferIdentityForSkippedPage(url, adapter);
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

      if (extraction.reason !== "unsupported") {
        return {
          kind: "NONE",
          sessionKey: null,
        };
      }

      const supportedIdentity = inferIdentityForSkippedPage(url, adapter);
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
    const content = extraction.content;

    if (content.contentText.length === 0) {
      return {
        kind: "SKIPPED",
        sessionKey: pageKeyFor(content),
        platform: content.platform,
        externalId: content.externalId,
        pageUrl: content.url,
        reason: "no_text",
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
      if (isContentMismatchRuntimeError(error)) {
        this.#resetSyncRetryState();
        console.warn(
          "Page content mismatch with server-verified canonical content; skipping retries.",
          error,
        );
        return;
      }
      if (isExtensionContextInvalidatedError(error)) {
        this.#resetSyncRetryState();
        return;
      }
      console.error("Failed to sync page content with background:", error);
      this.#scheduleSyncRetry(snapshot.sessionKey);
      return;
    }

    this.#resetSyncRetryState();
    this.#annotations.setClaims(viewPost.claims ?? []);
    const applied = this.#annotations.render(snapshot.adapter);
    if (!applied) {
      this.scheduleRefresh();
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
      observedText: snapshot.content.contentText,
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
      const currentClaims = this.#annotations.getClaims();
      if (!areClaimsEqual(currentClaims, status.claims)) {
        this.#annotations.setClaims(status.claims);
        const applied = this.#annotations.render(state.adapter);
        if (!applied) {
          this.scheduleRefresh();
        }
      } else {
        this.#annotations.reapplyIfMissing(state.adapter);
      }
      return;
    }

    if (
      status.investigationState === "FAILED" ||
      status.investigationState === "CONTENT_MISMATCH"
    ) {
      this.#annotations.clearAll();
    }
  }

  #isCurrentSessionPostStatus(
    status: ParsedExtensionPageStatus | null,
  ): status is Extract<ParsedExtensionPageStatus, { kind: "POST" }> {
    if (
      status?.kind !== "POST" ||
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
        this.#scheduleRefreshFromMutation();
      }
      return;
    }

    if (this.#state.kind === "SKIPPED") {
      if (
        (this.#state.reason === "unsupported_content" ||
          this.#state.reason === "no_text" ||
          this.#state.reason === "private_or_gated") &&
        getAdapter(currentUrl, document)
      ) {
        this.#scheduleRefreshFromMutation();
      }
      return;
    }

    const root = this.#state.adapter.getContentRoot(document);
    if (!root) {
      this.#scheduleRefreshFromMutation();
      return;
    }

    const normalizedText = normalizeContent(root.textContent);
    if (normalizedText !== this.#state.observedText) {
      this.#scheduleRefreshFromMutation();
      return;
    }

    this.#annotations.reapplyIfMissing(this.#state.adapter);
  }
}
