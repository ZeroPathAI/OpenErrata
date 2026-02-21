<script lang="ts">
  import {
    annotationVisibilityResponseSchema,
    extensionPageStatusSchema,
    extensionRuntimeErrorResponseSchema,
    requestInvestigateResponseSchema,
  } from "@openerrata/shared";
  import type { ExtensionPageStatus, ExtensionSkippedReason } from "@openerrata/shared";
  import browser from "webextension-polyfill";
  import { isSupportedPostUrl, parseSupportedPageIdentity } from "../lib/post-identity";
  import { isSubstackPostPathUrl, statusMatchesIdentity } from "./status-identity";
  import { loadExtensionSettings } from "../lib/settings";

  // ── View model ────────────────────────────────────────────────────────────
  //
  // The popup's display state is a single discriminated union. Each variant
  // maps 1:1 to one branch of the template's {#if} chain. loadStatus()
  // computes the entire view atomically after all async work completes, so
  // the template never sees an inconsistent intermediate state.

  type PostStatus = Extract<ExtensionPageStatus, { kind: "POST" }>;
  type PopupClaim = NonNullable<PostStatus["claims"]>[number];

  type PopupView =
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "unsupported" }
    | { kind: "awaiting_status" }
    | { kind: "skipped"; message: string }
    | { kind: "found_claims"; claims: PopupClaim[] }
    | { kind: "clean" }
    | { kind: "failed" }
    | { kind: "investigating" }
    | { kind: "not_investigated"; canRequest: boolean };

  // ── Utilities ─────────────────────────────────────────────────────────────

  function extractPageTitle(tabTitle: string | undefined, url: string): string | null {
    if (!tabTitle) return null;
    if (/lesswrong\.com/.test(url)) {
      const cleaned = tabTitle.replace(/\s*[-\u2013\u2014]\s*LessWrong\s*$/, "").trim();
      return cleaned.length > 0 ? cleaned : null;
    }
    const cleaned = tabTitle.trim();
    return cleaned.length > 0 ? cleaned : null;
  }

  function skippedReasonMessage(reason: ExtensionSkippedReason): string {
    if (reason === "video_only") {
      return "This post is video-only. Video analysis is not supported yet.";
    }
    if (reason === "word_count") {
      return "This post is too long and is not eligible for investigation.";
    }
    if (reason === "unsupported_content") {
      return "OpenErrata could not extract this post. Try reloading the page or opening the canonical post URL.";
    }
    return "This post is not eligible for investigation.";
  }

  function describeError(error: unknown): string {
    if (error instanceof Error && error.message.length > 0) {
      return error.message;
    }
    return String(error);
  }

  function computePostView(matched: PostStatus, canRequest: boolean): PopupView {
    if (matched.investigationState === "INVESTIGATED" && matched.claims.length > 0) {
      return { kind: "found_claims", claims: matched.claims };
    }
    if (matched.investigationState === "INVESTIGATED") {
      return { kind: "clean" };
    }
    if (matched.investigationState === "FAILED") {
      return { kind: "failed" };
    }
    if (matched.investigationState === "INVESTIGATING") {
      return { kind: "investigating" };
    }
    return { kind: "not_investigated", canRequest };
  }

  // ── Reactive state ────────────────────────────────────────────────────────

  let view: PopupView = $state({ kind: "loading" });
  let pageTitle = $state<string | null>(null);
  let showHighlights = $state(true);

  const showFooter = $derived(
    view.kind === "found_claims" ||
    view.kind === "clean" ||
    view.kind === "failed" ||
    view.kind === "investigating" ||
    view.kind === "not_investigated",
  );

  // ── Async operations ──────────────────────────────────────────────────────

  async function loadStatus() {
    try {
      const settings = await loadExtensionSettings();
      const canRequest =
        settings.apiKey.trim().length > 0 ||
        settings.openaiApiKey.trim().length > 0;

      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const tabUrl = tab?.url ?? "";
      const title = extractPageTitle(tab?.title, tabUrl);

      const supportedIdentity = parseSupportedPageIdentity(tabUrl);
      const onSupportedPage = isSupportedPostUrl(tabUrl) || isSubstackPostPathUrl(tabUrl);

      const response = await browser.runtime.sendMessage({ type: "GET_CACHED" });
      const runtimeError = extensionRuntimeErrorResponseSchema.safeParse(response);
      if (runtimeError.success) {
        throw new Error(runtimeError.data.error);
      }
      const parsed = extensionPageStatusSchema.safeParse(response);
      const status = parsed.success ? parsed.data : null;
      const matched = statusMatchesIdentity(status, supportedIdentity, tabUrl)
        ? status
        : null;

      let newView: PopupView;
      if (matched === null) {
        newView = onSupportedPage
          ? { kind: "awaiting_status" }
          : { kind: "unsupported" };
      } else if (matched.kind === "SKIPPED") {
        newView = { kind: "skipped", message: skippedReasonMessage(matched.reason) };
      } else {
        newView = computePostView(matched, canRequest);
      }

      // Set all display state in one synchronous block so the template never
      // sees a half-updated combination of page title and view.
      pageTitle = title;
      view = newView;

      await syncHighlightVisibility();
    } catch (loadError) {
      console.error("Failed to load popup status:", loadError);
      view = { kind: "error", message: "Could not load status" };
    }
  }

  async function syncHighlightVisibility() {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      const response = await browser.tabs.sendMessage(tab.id, {
        type: "GET_ANNOTATION_VISIBILITY",
      });
      const parsed = annotationVisibilityResponseSchema.safeParse(response);
      if (parsed.success) {
        showHighlights = parsed.data.visible;
      }
    } catch {
      // Tab may not have an active content script. Keep current local value.
    }
  }

  async function requestInvestigation() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      view = { kind: "error", message: "No active tab available" };
      return;
    }

    // Give immediate feedback before the content script round-trip.
    view = { kind: "investigating" };

    try {
      const response = await browser.tabs.sendMessage(tab.id, {
        type: "REQUEST_INVESTIGATE",
      });
      const parsedResponse = requestInvestigateResponseSchema.safeParse(response);
      if (!parsedResponse.success) {
        view = { kind: "error", message: "Could not start investigation" };
        console.error("REQUEST_INVESTIGATE returned an invalid payload.");
        return;
      }
      if (!parsedResponse.data.ok) {
        view = { kind: "error", message: "This post is not ready yet. Wait a moment and try again." };
        return;
      }
      await loadStatus();
    } catch (requestError) {
      console.error(
        `Could not reach content script: ${describeError(requestError)}`,
      );
      view = { kind: "error", message: "Could not reach content script" };
    }
  }

  async function toggleHighlights() {
    const nextVisibility = !showHighlights;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    try {
      await browser.tabs.sendMessage(tab.id, {
        type: nextVisibility ? "SHOW_ANNOTATIONS" : "HIDE_ANNOTATIONS",
      });
      showHighlights = nextVisibility;
    } catch (toggleError) {
      console.error(
        `Could not update highlights: ${describeError(toggleError)}`,
      );
      view = { kind: "error", message: "Could not update highlights" };
    }
  }

  function openSettings() {
    void browser.runtime.openOptionsPage();
  }

  // ── Side effects ──────────────────────────────────────────────────────────

  $effect(() => {
    void loadStatus();

    const onStorageChanged: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
      changes,
      areaName,
    ) => {
      if (areaName !== "local") return;
      if (
        !Object.keys(changes).some((key) =>
          key.startsWith("tab:") ||
          key === "apiKey" ||
          key === "openaiApiKey" ||
          key === "autoInvestigate",
        )
      ) {
        return;
      }
      void loadStatus();
    };

    browser.storage.onChanged.addListener(onStorageChanged);
    return () => {
      browser.storage.onChanged.removeListener(onStorageChanged);
    };
  });
</script>

<div class="popup">
  <div class="surface">
    <header class="topbar">
      <div class="brand">
        <h1 class="brand-title">OpenErrata</h1>
      </div>
      <button class="settings-btn" onclick={openSettings} title="Settings">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z"/>
          <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.902 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.421 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.421-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.116l.094-.318z"/>
        </svg>
      </button>
    </header>

    {#if pageTitle}
      <section class="post-card">
        <p class="post-label">Current post</p>
        <p class="post-title">{pageTitle}</p>
      </section>
    {/if}

    <main class="content">
      {#if view.kind === "loading"}
        <!-- Initial async load — intentionally empty to avoid flashing stale content. -->
      {:else if view.kind === "error"}
        <section class="state-panel error-panel">
          <p class="state-title">Couldn&apos;t load status</p>
          <p class="status-text error">{view.message}</p>
        </section>
      {:else if view.kind === "awaiting_status"}
        <section class="state-panel">
          <span class="spinner"></span>
          <p class="state-title">Checking This Page</p>
          <p class="state-subtitle">Checking this page&apos;s investigation status...</p>
        </section>
      {:else if view.kind === "unsupported"}
        <section class="state-panel">
          <p class="state-title">No Supported Post</p>
          <p class="state-subtitle">Open a LessWrong, X, or Substack post to get started.</p>
        </section>
      {:else if view.kind === "skipped"}
        <section class="state-panel">
          <p class="state-title">Not Eligible</p>
          <p class="state-subtitle">{view.message}</p>
        </section>
      {:else if view.kind === "found_claims"}
        <div class="result-badge found">
          <span class="badge-dot found-dot"></span>
          <span><strong>{view.claims.length}</strong> incorrect claim{view.claims.length !== 1 ? "s" : ""} found</span>
        </div>
        <ul class="claims">
          {#each view.claims as claim (claim.text)}
            <li>{claim.summary}</li>
          {/each}
        </ul>
      {:else if view.kind === "clean"}
        <div class="result-badge clean">
          <span class="badge-dot clean-dot"></span>
          <span>No issues found.</span>
        </div>
      {:else if view.kind === "failed"}
        <section class="state-panel error-panel">
          <p class="state-title">Investigation failed.</p>
          <button class="btn" onclick={requestInvestigation}>Investigate Again</button>
        </section>
      {:else if view.kind === "investigating"}
        <section class="state-panel">
          <p class="state-title">Not Yet Investigated</p>
          <div class="status-row">
            <span class="spinner"></span>
            <span class="status-text investigating">Investigating...</span>
          </div>
        </section>
      {:else if view.kind === "not_investigated"}
        <section class="state-panel">
          <p class="state-title">Not Yet Investigated</p>
          {#if view.canRequest}
            <button class="btn" onclick={requestInvestigation}>Investigate Now</button>
          {:else}
            <p class="state-subtitle">
              Free tier. Add your OpenAI API key in Settings to run on-demand investigations.
            </p>
          {/if}
        </section>
      {/if}
    </main>

    {#if showFooter}
      <footer class="footer">
        <label class="toggle-label">
          <input type="checkbox" checked={showHighlights} onchange={toggleHighlights} />
          Show highlights
        </label>
      </footer>
    {/if}
  </div>
</div>

<style>
  .popup {
    --ui-bg-a: #eef4ff;
    --ui-bg-b: #f9fafb;
    --ui-surface: #ffffff;
    --ui-border: #dbe3f5;
    --ui-text: #0f172a;
    --ui-subtle: #64748b;
    --ui-primary: #1d4ed8;
    --ui-primary-strong: #1e40af;
    --ui-danger: #dc2626;
    --ui-danger-soft: #fef2f2;
    --ui-success: #166534;
    --ui-success-soft: #f0fdf4;
    width: min(420px, calc(100vw - 12px));
    padding: 10px;
    background:
      radial-gradient(130% 100% at 0% 0%, var(--ui-bg-a) 0%, transparent 58%),
      linear-gradient(170deg, var(--ui-bg-b) 0%, #f4f7fc 100%);
    font-family: "Avenir Next", "Segoe UI", sans-serif;
    box-sizing: border-box;
  }

  .surface {
    max-width: 400px;
    margin: 0 auto;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 14px;
    box-shadow: 0 10px 28px rgba(15, 23, 42, 0.12);
    padding: 14px;
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }

  .brand-title {
    margin: 0;
    font-size: 20px;
    line-height: 1;
    letter-spacing: 0.01em;
    font-weight: 800;
    color: var(--ui-text);
  }

  .settings-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    background: #f8fafc;
    border: 1px solid #dbe3f5;
    border-radius: 8px;
    cursor: pointer;
    color: #475569;
    transition: color 0.15s, border-color 0.15s, background-color 0.15s;
  }
  .settings-btn:hover {
    color: #1e293b;
    border-color: #c0cde6;
    background: #eef3fb;
  }

  .post-card {
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    background: #f8fafc;
    padding: 10px 12px;
    margin-bottom: 12px;
  }

  .post-label {
    margin: 0 0 4px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 10px;
    color: #64748b;
    font-weight: 700;
  }

  .post-title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: #1e293b;
    line-height: 1.35;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .content {
    min-height: 94px;
  }

  .state-panel {
    min-height: 94px;
    border: 1px dashed #d5e1f5;
    border-radius: 10px;
    background: #f8fbff;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    text-align: center;
    padding: 12px;
  }

  .error-panel {
    border-color: #fecaca;
    background: #fff7f7;
  }

  .state-title {
    margin: 0;
    font-size: 14px;
    font-weight: 700;
    color: var(--ui-text);
    line-height: 1.25;
  }

  .state-subtitle {
    margin: 0;
    font-size: 12px;
    line-height: 1.45;
    color: var(--ui-subtle);
  }

  .status-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-top: 2px;
  }

  .status-text {
    font-size: 13px;
    line-height: 1.5;
    margin: 0;
  }
  .status-text.error { color: var(--ui-danger); }
  .status-text.investigating { color: var(--ui-primary); }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid #dbe3f5;
    border-top-color: #4b5d7d;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .result-badge {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
    padding: 9px 11px;
    border-radius: 10px;
  }
  .result-badge.found {
    color: #7f1d1d;
    background: var(--ui-danger-soft);
    border: 1px solid #fecaca;
  }
  .result-badge.clean {
    color: var(--ui-success);
    background: var(--ui-success-soft);
    border: 1px solid #bbf7d0;
  }

  .badge-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .found-dot { background: #ef4444; }
  .clean-dot { background: #22c55e; }

  .claims {
    list-style: none;
    padding: 0;
    margin: 8px 0 0;
    border: 1px solid #f1f5f9;
    border-radius: 10px;
    background: #fcfdff;
    overflow: hidden;
  }

  .claims li {
    position: relative;
    padding: 9px 10px 9px 18px;
    font-size: 13px;
    line-height: 1.45;
    color: #334155;
  }
  .claims li + li {
    border-top: 1px solid #f1f5f9;
  }
  .claims li::before {
    content: "";
    position: absolute;
    left: 8px;
    top: 16px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #ef4444;
  }

  .btn {
    margin-top: 8px;
    padding: 8px 14px;
    background: var(--ui-primary);
    color: white;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    transition: background 0.15s;
  }
  .btn:hover {
    background: var(--ui-primary-strong);
  }

  .footer {
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid #e5edf9;
  }

  .toggle-label {
    font-size: 13px;
    color: #334155;
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    user-select: none;
  }
  .toggle-label input[type="checkbox"] {
    accent-color: var(--ui-primary);
  }
</style>
