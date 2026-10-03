import {
  tabSessionIdSchema,
  WORD_COUNT_LIMIT,
  type ExtensionPageStatus,
  type ExtensionPostStatus,
  type ExtensionRuntimeErrorResponse,
  type Platform,
  type TabSessionId,
} from "@openerrata/shared";
import browser from "webextension-polyfill";
import { describeError } from "../lib/describe-error";
import { createContentRequestListener, type ContentRequestHandlers } from "../lib/messaging";
import { ExtensionRuntimeError, isExtensionContextInvalidatedError } from "../lib/runtime-error";
import { selectAdapter } from "./adapters/index";
import { displayClaimsForStatus } from "./annotation-lifecycle";
import { AnnotationController } from "./annotations";
import { contentTextIndexOf } from "./content-text";
import { PageObserver } from "./observer";
import { sessionKeyFor } from "./session-key";
import {
  isStatusOfSession,
  sessionKeyOfState,
  shouldRefreshSkippedSessionOnMutation,
  type PageSessionState,
  type PageSnapshot,
  type TrackedPostSessionState,
} from "./session-state";
import { contentSyncClient } from "./sync";
import {
  hasPendingRetryForSession,
  NO_SYNC_RETRY,
  scheduleSyncRetry,
  syncFailureAction,
  type SyncRetryState,
} from "./sync-retry-policy";

const REFRESH_DEBOUNCE_MS = 200;
const MUTATION_DEBOUNCE_MS = 300;
const SYNC_RETRY_DELAYS = { initialDelayMs: 1_000, maxDelayMs: 30_000 };
/**
 * How long a supported page may stay unextractable (still rendering, identity
 * not yet provable) before it is reported as `unsupported_content`. Pages
 * keep being re-checked on DOM changes after that.
 */
const NOT_READY_GRACE_MS = 5_000;
const CLAIM_FOCUS_CLASS = "openerrata-focus-target";
const CLAIM_FOCUS_DURATION_MS = 1_500;

function exceedsWordCountLimit(text: string): boolean {
  return text.split(/\s+/).filter(Boolean).length > WORD_COUNT_LIMIT;
}

function newTabSessionId(): TabSessionId {
  return tabSessionIdSchema.parse(crypto.randomUUID());
}

/**
 * False once this script's extension instance was reloaded, updated or
 * removed: Chrome then leaves the script running ("orphaned") but clears
 * `runtime.id`, which the type declarations cannot express.
 */
function isExtensionContextAlive(): boolean {
  try {
    const runtimeId: unknown = Reflect.get(browser.runtime, "id");
    return typeof runtimeId === "string";
  } catch {
    return false;
  }
}

function toContentErrorResponse(error: unknown): ExtensionRuntimeErrorResponse {
  return {
    ok: false,
    error: describeError(error),
    ...(error instanceof ExtensionRuntimeError && error.errorCode !== undefined
      ? { errorCode: error.errorCode }
      : {}),
  };
}

function scrollToClaimAnchor(anchor: HTMLElement, platform: Platform): boolean {
  anchor.scrollIntoView({
    // Substack pages can have heavy scroll/layout handlers that cause long
    // main-thread stalls with smooth scrolling. Use instant scroll there.
    behavior: platform === "SUBSTACK" ? "auto" : "smooth",
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

/**
 * The content script's controller for one page: observes the page, keeps one
 * page session per observed post state in sync with the background, renders
 * highlights, and serves the content request protocol (spec §3.8.1).
 */
export class PageSessionController {
  #state: PageSessionState = { kind: "IDLE" };
  #lastObservedUrl = window.location.href;
  /** Since when the current URL's post has been unextractable. */
  #notReady: { url: string; since: number } | null = null;
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  #refreshInFlight = false;
  #refreshQueued = false;
  #booted = false;
  #syncRetry: SyncRetryState = NO_SYNC_RETRY;
  readonly #annotations = new AnnotationController();
  readonly #observer = new PageObserver({
    mutationDebounceMs: MUTATION_DEBOUNCE_MS,
    onPopState: () => {
      this.scheduleRefresh();
    },
    onMutationSettled: () => {
      this.#onMutationSettled();
    },
  });

  readonly #requestHandlers: ContentRequestHandlers = {
    PING: () => ({ alive: true }),
    GET_VISIBILITY: () => ({ visible: this.#annotations.isVisible() }),
    SHOW_ANNOTATIONS: () => {
      this.#annotations.show(this.#state.kind === "TRACKED_POST" ? this.#state.adapter : null);
      return { visible: true };
    },
    HIDE_ANNOTATIONS: () => {
      this.#annotations.hide();
      return { visible: false };
    },
    REQUEST_INVESTIGATE: () => this.requestInvestigation(),
    FOCUS_CLAIM: ({ claimId }) => this.focusClaim(claimId),
    LOCATION_CHANGED: () => {
      this.scheduleRefresh();
      return null;
    },
    STATUS_CHANGED: ({ status }) => {
      this.#onStatusChanged(status);
      return null;
    },
  };

  readonly #messageListener = createContentRequestListener(
    this.#requestHandlers,
    toContentErrorResponse,
  );

  readonly #onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) {
      this.#resyncAfterBackForwardCacheRestore();
    }
  };

  boot(): void {
    if (this.#booted) return;
    this.#booted = true;

    browser.runtime.onMessage.addListener(this.#messageListener);
    window.addEventListener("pageshow", this.#onPageShow);
    this.#observer.start();
    this.scheduleRefresh();
  }

  /**
   * Stop everything this controller does on the page and remove what it
   * added. Used when the extension instance that injected it is gone.
   */
  dispose(): void {
    if (!this.#booted) return;
    this.#booted = false;

    if (this.#refreshTimer !== null) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    this.#refreshQueued = false;
    this.#observer.stop();
    window.removeEventListener("pageshow", this.#onPageShow);
    this.#annotations.clearAll();
    this.#state = { kind: "IDLE" };
    this.#syncRetry = NO_SYNC_RETRY;
    // An orphaned context's listener can never be invoked again (and its
    // extension APIs throw), so only a live context unregisters.
    if (isExtensionContextAlive()) {
      browser.runtime.onMessage.removeListener(this.#messageListener);
    }
  }

  async requestInvestigation(): Promise<{ ok: boolean }> {
    const state = this.#state;
    if (state.kind !== "TRACKED_POST") {
      return { ok: false };
    }

    const status = await contentSyncClient.requestInvestigation(state.tabSessionId, state.content);
    if (this.#state === state) {
      this.#applyPostStatus(state, status);
    }
    return { ok: true };
  }

  focusClaim(claimId: string): { ok: boolean } {
    const state = this.#state;
    if (state.kind !== "TRACKED_POST") {
      return { ok: false };
    }
    const claim = this.#annotations.getClaims().find((candidate) => candidate.id === claimId);
    if (!claim) {
      return { ok: false };
    }

    if (this.#annotations.isVisible()) {
      if (this.#annotations.renderedAnchorFor(claimId) === null) {
        // The page dropped our highlight (e.g. a re-render); restore them.
        this.#annotations.render(state.adapter);
      }
      const anchor = this.#annotations.renderedAnchorFor(claimId);
      if (anchor === null) {
        this.scheduleRefresh(0);
        return { ok: false };
      }
      return { ok: scrollToClaimAnchor(anchor, state.content.platform) };
    }

    const pieces = this.#annotations.locateClaim(claim, state.adapter);
    const anchor = pieces?.[0]?.node.parentElement ?? null;
    if (anchor === null) {
      return { ok: false };
    }
    return { ok: scrollToClaimAnchor(anchor, state.content.platform) };
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

  #isBooted(): boolean {
    return this.#booted;
  }

  #scheduleRefreshFromMutation(): void {
    // A failed sync is retried on its own backoff schedule.
    if (hasPendingRetryForSession(this.#syncRetry, sessionKeyOfState(this.#state))) {
      return;
    }
    this.scheduleRefresh();
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
      // `dispose()` may run while a refresh awaits the background.
      while (this.#refreshQueued && this.#isBooted()) {
        this.#refreshQueued = false;
        await this.#refreshPageState();
      }
    } finally {
      this.#refreshInFlight = false;
    }
  }

  async #refreshPageState(): Promise<void> {
    if (!isExtensionContextAlive()) {
      this.dispose();
      return;
    }

    this.#lastObservedUrl = window.location.href;
    const snapshot = this.#snapshotCurrentPage(Date.now());
    const sessionKey = sessionKeyFor(snapshot);
    const state = this.#state;

    if (sessionKey !== sessionKeyOfState(state)) {
      await this.#transitionTo(snapshot, sessionKey);
      return;
    }
    if (state.kind === "TRACKED_POST") {
      if (hasPendingRetryForSession(this.#syncRetry, sessionKey)) {
        await this.#syncTrackedSession(state);
      } else {
        this.#annotations.reapplyIfMissing(state.adapter);
      }
    }
  }

  #snapshotCurrentPage(now: number): PageSnapshot {
    const url = window.location.href;
    const selected = selectAdapter(url, document);
    if (!selected) {
      this.#notReady = null;
      return { kind: "NONE" };
    }
    const { adapter, locator } = selected;
    const platform = adapter.platformKey;

    if (adapter.detectPrivateOrGated?.(document) === true) {
      this.#notReady = null;
      return {
        kind: "SKIPPED",
        platform,
        pageUrl: url,
        reason: "private_or_gated",
        basis: { kind: "PAGE", locator },
      };
    }

    const extraction = adapter.extract(document);
    if (extraction.kind === "not_ready") {
      const unextractable: PageSnapshot = {
        kind: "SKIPPED",
        platform,
        pageUrl: url,
        reason: "unsupported_content",
        basis: { kind: "PAGE", locator },
      };
      if (extraction.reason === "unsupported") {
        this.#notReady = null;
        return unextractable;
      }
      if (this.#notReady?.url !== url) {
        this.#notReady = { url, since: now };
      }
      const remainingGraceMs = this.#notReady.since + NOT_READY_GRACE_MS - now;
      if (remainingGraceMs > 0) {
        // Re-check at the deadline even if the page stops mutating.
        this.scheduleRefresh(remainingGraceMs);
        return { kind: "PENDING" };
      }
      return unextractable;
    }
    this.#notReady = null;

    const content = extraction.content;
    const skipFromContent = (reason: "no_text" | "has_video" | "word_count"): PageSnapshot => ({
      kind: "SKIPPED",
      platform,
      pageUrl: content.url,
      reason,
      basis: { kind: "CONTENT", content },
    });
    if (content.contentText.length === 0) return skipFromContent("no_text");
    if (content.hasVideo) return skipFromContent("has_video");
    if (exceedsWordCountLimit(content.contentText)) return skipFromContent("word_count");

    return { kind: "TRACKED_POST", adapter, content };
  }

  async #transitionTo(snapshot: PageSnapshot, sessionKey: string | null): Promise<void> {
    const previous = this.#state;
    if (previous.kind !== "IDLE") {
      this.#sendInBackground(contentSyncClient.sendPageReset(previous.tabSessionId), "PAGE_RESET");
    }
    this.#annotations.clearAll();

    if (sessionKey === null || snapshot.kind === "NONE" || snapshot.kind === "PENDING") {
      this.#syncRetry = NO_SYNC_RETRY;
      this.#state = { kind: "IDLE" };
      return;
    }

    const tabSessionId = newTabSessionId();
    if (snapshot.kind === "SKIPPED") {
      this.#syncRetry = NO_SYNC_RETRY;
      this.#state = { kind: "SKIPPED", tabSessionId, sessionKey, reason: snapshot.reason };
      this.#sendInBackground(
        contentSyncClient.sendPageSkipped({
          tabSessionId,
          platform: snapshot.platform,
          pageUrl: snapshot.pageUrl,
          reason: snapshot.reason,
        }),
        "PAGE_SKIPPED",
      );
      return;
    }

    if (!hasPendingRetryForSession(this.#syncRetry, sessionKey)) {
      this.#syncRetry = NO_SYNC_RETRY;
    }
    const state: TrackedPostSessionState = {
      kind: "TRACKED_POST",
      tabSessionId,
      sessionKey,
      adapter: snapshot.adapter,
      content: snapshot.content,
    };
    this.#state = state;
    await this.#syncTrackedSession(state);
  }

  async #syncTrackedSession(state: TrackedPostSessionState): Promise<void> {
    let status: ExtensionPostStatus;
    try {
      status = await contentSyncClient.sendPageContent(state.tabSessionId, state.content);
    } catch (error) {
      if (this.#state !== state) return;
      const action = syncFailureAction(error);
      switch (action.kind) {
        case "SHUT_DOWN":
          this.dispose();
          return;
        case "GIVE_UP":
          this.#syncRetry = NO_SYNC_RETRY;
          this.#annotations.clearAll();
          console.warn("Page content sync failed and will not be retried:", error);
          return;
        case "RETRY": {
          console.error("Failed to sync page content with background; retrying:", error);
          const scheduled = scheduleSyncRetry(this.#syncRetry, state.sessionKey, SYNC_RETRY_DELAYS);
          this.#syncRetry = scheduled.nextState;
          this.scheduleRefresh(scheduled.delayMs);
          return;
        }
      }
    }

    if (this.#state !== state) return;
    this.#syncRetry = NO_SYNC_RETRY;
    this.#applyPostStatus(state, status);
  }

  #applyPostStatus(state: TrackedPostSessionState, status: ExtensionPostStatus): void {
    const rendered = this.#annotations.showClaims(displayClaimsForStatus(status), state.adapter);
    if (!rendered) {
      this.scheduleRefresh();
    }
  }

  #onStatusChanged(status: ExtensionPageStatus): void {
    if (status.kind !== "POST") return;
    const state = this.#state;
    if (isStatusOfSession(state, status)) {
      this.#applyPostStatus(state, status);
    }
  }

  /** Fire-and-forget a background request; an orphaned context shuts the controller down. */
  #sendInBackground(request: Promise<void>, label: string): void {
    request.catch((error: unknown) => {
      if (isExtensionContextInvalidatedError(error)) {
        this.dispose();
        return;
      }
      console.error(`Failed to send ${label} to background:`, error);
    });
  }

  /**
   * A page restored from the back/forward cache keeps this controller's
   * memory, but the background forgot the tab's session when the tab
   * navigated away; start a fresh session.
   */
  #resyncAfterBackForwardCacheRestore(): void {
    this.#annotations.clearAll();
    this.#state = { kind: "IDLE" };
    this.#syncRetry = NO_SYNC_RETRY;
    this.scheduleRefresh(0);
  }

  #onMutationSettled(): void {
    const currentUrl = window.location.href;
    if (currentUrl !== this.#lastObservedUrl) {
      this.scheduleRefresh();
      return;
    }

    const state = this.#state;
    switch (state.kind) {
      case "IDLE":
        if (selectAdapter(currentUrl, document) !== null) {
          this.#scheduleRefreshFromMutation();
        }
        return;
      case "SKIPPED":
        if (shouldRefreshSkippedSessionOnMutation(state.reason)) {
          this.#scheduleRefreshFromMutation();
        }
        return;
      case "TRACKED_POST": {
        const textIndex = contentTextIndexOf(state.adapter, document);
        if (textIndex === null) {
          // Content root not in the DOM (yet or anymore) — nothing to compare.
          return;
        }
        if (textIndex.text !== state.content.contentText) {
          this.#scheduleRefreshFromMutation();
          return;
        }
        this.#annotations.reapplyIfMissing(state.adapter);
        return;
      }
    }
  }
}
