import {
  extensionMessageSchema,
  extensionRuntimeErrorResponseSchema,
  investigationStatusOutputSchema,
  type ExtensionPageStatus,
  type ExtensionPostStatus,
  type InvestigateNowOutput,
  type InvestigationStatusOutput,
  type RegisterObservedVersionOutput,
  type ViewPostInput,
  type ViewPostOutput,
} from "@openerrata/shared";
import browser, { type Runtime } from "webextension-polyfill";
import {
  ApiClientError,
  getCurrentApiBaseUrl,
  getInvestigation,
  hasUserOpenAiKey,
  init,
  investigateNow,
  isAutoInvestigateEnabled,
  recordViewAndGetStatus,
  registerObservedVersion,
} from "./api-client.js";
import {
  cachePostStatus,
  cacheSkippedStatus,
  clearActiveStatus,
  clearCache,
  getActivePostStatus,
  getActiveStatus,
  syncToolbarBadgesForOpenTabs,
} from "./cache.js";
import { toViewPostInput } from "../lib/view-post-input.js";
import { createPostStatusFromInvestigation } from "./post-status.js";
import {
  snapshotFromInvestigateNowResult,
  toInvestigationStatusForCaching,
} from "./investigation-snapshot.js";
import { decidePageContentSnapshot } from "./page-content-decision.js";
import { decidePageContentPostCacheAction } from "./page-content-action.js";
import { unsupportedProtocolVersionResponse } from "../lib/protocol-version.js";
import { addDomContentLoadedListener, addHistoryStateUpdatedListener } from "./browser-compat.js";
import { describeError } from "../lib/describe-error.js";
import { wikipediaExternalIdFromPageId } from "../lib/wikipedia-url.js";
import {
  clearUpgradeRequiredState,
  clearUpgradeRequiredStateBestEffort,
  isUpgradeRequiredError,
  markUpgradeRequiredFromError,
  restoreUpgradeRequiredState,
} from "./upgrade-required-runtime.js";
import { normalizeConfiguredApiBaseUrl } from "../lib/settings-core.js";
import { getUpgradeRequiredState } from "./upgrade-required-state.js";
import {
  clearInjectedCustomSubstackTab,
  ensureSubstackInjectionForOpenTabs,
  maybeInjectCustomDomainSubstack,
  maybeInjectKnownDomainContentScript,
} from "./content-script-injection.js";
import {
  cacheApiErrorStatus,
  clearTabSession,
  isInvestigatingCheckStatus,
  isStaleTabSession,
  maybeResumePollingFromCachedStatus,
  noteTabSession,
  parsePollRecoveryAlarmTabId,
  restoreInvestigationPollingState,
  retireTabSession,
  startInvestigationPolling,
  stopInvestigationPolling,
} from "./investigation-polling.js";
import {
  isBackgroundMessageType,
  toInvestigationStatusSnapshot,
  type BackgroundMessageType,
} from "./message-dispatch.js";

// Initialize API client on worker start, then restore persisted upgrade state.
void init()
  .then(() => restoreUpgradeRequiredState())
  .catch((error: unknown) => {
    console.error("Failed to initialize extension background state:", error);
  });

type ParsedExtensionMessage = Extract<
  ReturnType<typeof extensionMessageSchema.safeParse>,
  { success: true }
>["data"];
type ParsedPageContentPayload = Extract<
  ParsedExtensionMessage,
  { type: "PAGE_CONTENT" }
>["payload"];
type ParsedPageSkippedPayload = Extract<
  ParsedExtensionMessage,
  { type: "PAGE_SKIPPED" }
>["payload"];
type ParsedGetStatusPayload = Extract<ParsedExtensionMessage, { type: "GET_STATUS" }>["payload"];
type ParsedPageResetPayload = Extract<ParsedExtensionMessage, { type: "PAGE_RESET" }>["payload"];
type ParsedInvestigateNowPayload = Extract<
  ParsedExtensionMessage,
  { type: "INVESTIGATE_NOW" }
>["payload"];
type ParsedBackgroundMessage = Extract<
  ParsedExtensionMessage,
  {
    type: BackgroundMessageType;
  }
>;
type ExtensionRuntimeErrorResponse = ReturnType<typeof extensionRuntimeErrorResponseSchema.parse>;

function describeSchemaError(error: { message: string }): string {
  return `Invalid extension message payload: ${error.message}`;
}

function parseInvestigationStatusSnapshot(value: unknown): InvestigationStatusOutput {
  const parsed = investigationStatusOutputSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  throw new ApiClientError(`Malformed GET_STATUS response from API: ${parsed.error.message}`, {
    errorCode: "INVALID_EXTENSION_MESSAGE",
  });
}

function toRuntimeErrorResponse(error: unknown): ExtensionRuntimeErrorResponse {
  const errorCode = error instanceof ApiClientError ? error.errorCode : undefined;
  return extensionRuntimeErrorResponseSchema.parse({
    ok: false,
    error: describeError(error),
    ...(errorCode === undefined ? {} : { errorCode }),
  });
}

function isBackgroundMessage(message: ParsedExtensionMessage): message is ParsedBackgroundMessage {
  return isBackgroundMessageType(message.type);
}

function viewPostExternalId(request: ViewPostInput): string {
  if (request.platform === "WIKIPEDIA") {
    return wikipediaExternalIdFromPageId(
      request.metadata.language.toLowerCase(),
      request.metadata.pageId,
    );
  }
  return request.externalId;
}

async function cacheInvestigateNowResult(input: {
  tabId: number;
  tabSessionId: number;
  request: ViewPostInput;
  result: InvestigateNowOutput;
  existingStatus?: InvestigationStatusOutput | null;
}): Promise<void> {
  const { tabId, tabSessionId, request, result } = input;
  const externalId = viewPostExternalId(request);

  const initialSnapshot = snapshotFromInvestigateNowResult(result, input.existingStatus);

  await cachePostStatus(
    tabId,
    createPostStatusFromInvestigation({
      tabSessionId,
      platform: request.platform,
      externalId,
      pageUrl: request.url,
      investigationId: result.investigationId,
      ...initialSnapshot,
    }),
  );

  if (result.status !== "COMPLETE") {
    return;
  }
}

async function maybeAutoInvestigate(input: {
  tabId: number;
  tabSessionId: number;
  request: ViewPostInput;
  registeredVersion: RegisterObservedVersionOutput;
  existingStatus: ExtensionPostStatus | null;
}): Promise<void> {
  const requestExternalId = viewPostExternalId(input.request);

  // The caller already wrote NOT_INVESTIGATED to cache, so bail-out paths
  // here do not need to write anything — the cache already has a valid status.
  if (!hasUserOpenAiKey() || !isAutoInvestigateEnabled()) {
    return;
  }
  if (input.existingStatus?.investigationState === "INVESTIGATING") {
    return;
  }
  if (isStaleTabSession(input.tabId, input.tabSessionId)) {
    return;
  }

  try {
    const result = await investigateNow({
      postVersionId: input.registeredVersion.postVersionId,
    });
    if (isStaleTabSession(input.tabId, input.tabSessionId)) {
      return;
    }
    await cacheInvestigateNowResult({
      tabId: input.tabId,
      tabSessionId: input.tabSessionId,
      request: input.request,
      result,
      existingStatus: toInvestigationStatusForCaching(input.existingStatus),
    });

    if (isInvestigatingCheckStatus(result.status)) {
      if (isStaleTabSession(input.tabId, input.tabSessionId)) {
        return;
      }
      await startInvestigationPolling({
        tabId: input.tabId,
        tabSessionId: input.tabSessionId,
        platform: input.request.platform,
        externalId: requestExternalId,
        investigationId: result.investigationId,
      });
    }
  } catch (error) {
    await cacheApiErrorStatus({
      error,
      tabId: input.tabId,
      tabSessionId: input.tabSessionId,
      platform: input.request.platform,
      externalId: requestExternalId,
      pageUrl: input.request.url,
      skipIfStale: true,
      ...(input.existingStatus?.tabSessionId === input.tabSessionId &&
      input.existingStatus.investigationId !== undefined
        ? { investigationId: input.existingStatus.investigationId }
        : {}),
    });
    if (isUpgradeRequiredError(error)) {
      await markUpgradeRequiredFromError(error);
    }
    throw error;
  }
}

browser.runtime.onMessage.addListener((message: unknown, sender: Runtime.MessageSender) => {
  const protocolError = unsupportedProtocolVersionResponse(message);
  if (protocolError) {
    return protocolError;
  }

  const parsedMessage = extensionMessageSchema.safeParse(message);
  if (!parsedMessage.success) {
    return extensionRuntimeErrorResponseSchema.parse({
      ok: false,
      error: describeSchemaError(parsedMessage.error),
      errorCode: "INVALID_EXTENSION_MESSAGE",
    });
  }
  const typedMessage = parsedMessage.data;
  if (!isBackgroundMessage(typedMessage)) return false;

  const handle = async () => {
    switch (typedMessage.type) {
      case "PAGE_CONTENT":
        return handlePageContent(typedMessage.payload, sender);
      case "PAGE_SKIPPED":
        return handlePageSkipped(typedMessage.payload, sender);
      case "PAGE_RESET":
        return handlePageReset(typedMessage.payload, sender);
      case "GET_STATUS":
        return handleGetStatus(typedMessage.payload, sender);
      case "INVESTIGATE_NOW":
        return handleInvestigateNow(typedMessage.payload, sender);
      case "GET_CACHED":
        return handleGetCached(sender);
    }
  };

  return handle().catch(async (err: unknown) => {
    if (isUpgradeRequiredError(err)) {
      // Upgrade requirement is expected while the extension is outdated.
    } else {
      console.error("Background handler error:", err);
    }
    try {
      await markUpgradeRequiredFromError(err);
    } catch (upgradeStateError) {
      console.error("Failed to update upgrade-required state:", upgradeStateError);
    }
    return toRuntimeErrorResponse(err);
  });
});

async function handlePageContent(
  payload: ParsedPageContentPayload,
  sender: Runtime.MessageSender,
): Promise<ViewPostOutput> {
  const request = toViewPostInput(payload.content);
  const requestExternalId = viewPostExternalId(request);

  let registeredVersion: RegisterObservedVersionOutput;
  let result: ViewPostOutput;
  try {
    registeredVersion = await registerObservedVersion(request);
    await clearUpgradeRequiredStateBestEffort("PAGE_CONTENT");
    result = await recordViewAndGetStatus({
      postVersionId: registeredVersion.postVersionId,
    });
  } catch (error) {
    if (sender.tab?.id !== undefined) {
      await cacheApiErrorStatus({
        error,
        tabId: sender.tab.id,
        tabSessionId: payload.tabSessionId,
        platform: request.platform,
        externalId: requestExternalId,
        pageUrl: request.url,
        skipIfStale: true,
        noteSession: true,
        stopPolling: true,
      });
    }
    throw error;
  }

  if (sender.tab?.id !== undefined) {
    const tabId = sender.tab.id;
    if (isStaleTabSession(tabId, payload.tabSessionId)) {
      return result;
    }
    noteTabSession(tabId, payload.tabSessionId);

    const existing = await getActivePostStatus(tabId);
    const existingForSession =
      existing !== null &&
      existing.tabSessionId === payload.tabSessionId &&
      existing.platform === request.platform &&
      existing.externalId === requestExternalId
        ? existing
        : null;
    if (!existingForSession) {
      stopInvestigationPolling(tabId);
    }

    const resultUpdateInterim = toInvestigationStatusForCaching(result);
    const existingForSessionUpdateInterim =
      existingForSession === null ? null : toInvestigationStatusForCaching(existingForSession);

    const { snapshot, shouldAutoInvestigate } = decidePageContentSnapshot({
      result,
      resultUpdateInterim,
      existingForSession,
      existingForSessionUpdateInterim,
    });

    const nextStatus = createPostStatusFromInvestigation({
      tabSessionId: payload.tabSessionId,
      platform: request.platform,
      externalId: requestExternalId,
      pageUrl: request.url,
      ...(existingForSession?.investigationId === undefined
        ? {}
        : { investigationId: existingForSession.investigationId }),
      ...snapshot,
    });

    const postCacheAction = decidePageContentPostCacheAction({
      status: nextStatus,
      shouldAutoInvestigate,
    });

    if (postCacheAction === "RESUME_POLLING") {
      await cachePostStatus(tabId, nextStatus);
      await maybeResumePollingFromCachedStatus(tabId, nextStatus);
    } else if (postCacheAction === "AUTO_INVESTIGATE") {
      // Write the NOT_INVESTIGATED status immediately so the popup never shows
      // "Checking This Page" while waiting for the auto-investigate round-trip.
      // maybeAutoInvestigate will overwrite with INVESTIGATING once the API
      // call succeeds.
      await cachePostStatus(tabId, nextStatus);
      void maybeAutoInvestigate({
        tabId,
        tabSessionId: payload.tabSessionId,
        request,
        registeredVersion,
        existingStatus: existingForSession,
      }).catch((error: unknown) => {
        console.error("auto investigate failed:", error);
      });
    } else {
      await cachePostStatus(tabId, nextStatus);
      stopInvestigationPolling(tabId);
    }
  }

  return result;
}

async function handlePageSkipped(
  payload: ParsedPageSkippedPayload,
  sender: Runtime.MessageSender,
): Promise<void> {
  if (sender.tab?.id === undefined) {
    return;
  }

  if (isStaleTabSession(sender.tab.id, payload.tabSessionId)) {
    return;
  }
  noteTabSession(sender.tab.id, payload.tabSessionId);

  stopInvestigationPolling(sender.tab.id);
  await cacheSkippedStatus(sender.tab.id, {
    kind: "SKIPPED",
    tabSessionId: payload.tabSessionId,
    platform: payload.platform,
    externalId: payload.externalId,
    pageUrl: payload.pageUrl,
    reason: payload.reason,
  });
}

async function handlePageReset(
  payload: ParsedPageResetPayload,
  sender: Runtime.MessageSender,
): Promise<void> {
  if (sender.tab?.id === undefined) {
    return;
  }
  const tabId = sender.tab.id;
  retireTabSession(tabId, payload.tabSessionId);

  const active = await getActiveStatus(tabId);
  if (active !== null && active.tabSessionId > payload.tabSessionId) {
    return;
  }

  stopInvestigationPolling(tabId);
  await clearActiveStatus(tabId);
}

async function handleGetStatus(
  payload: ParsedGetStatusPayload,
  sender: Runtime.MessageSender,
): Promise<InvestigationStatusOutput> {
  const { tabSessionId, ...request } = payload;
  const result = await getInvestigation(request);
  await clearUpgradeRequiredStateBestEffort("GET_STATUS");

  const parsedResponse = parseInvestigationStatusSnapshot(toInvestigationStatusSnapshot(result));

  if (sender.tab?.id !== undefined) {
    const existing = await getActivePostStatus(sender.tab.id);
    if (existing) {
      if (tabSessionId !== undefined && tabSessionId !== existing.tabSessionId) {
        return parsedResponse;
      }

      await cachePostStatus(
        sender.tab.id,
        createPostStatusFromInvestigation({
          tabSessionId: existing.tabSessionId,
          platform: existing.platform,
          externalId: existing.externalId,
          pageUrl: existing.pageUrl,
          investigationId: payload.investigationId,
          ...parsedResponse,
        }),
        { setActive: false },
      );
    }
  }

  return parsedResponse;
}

async function handleInvestigateNow(
  payload: ParsedInvestigateNowPayload,
  sender: Runtime.MessageSender,
): Promise<InvestigateNowOutput> {
  if (sender.tab?.id !== undefined) {
    if (isStaleTabSession(sender.tab.id, payload.tabSessionId)) {
      throw new Error(
        `Rejected investigateNow for stale tab session ${payload.tabSessionId.toString()}`,
      );
    }
    noteTabSession(sender.tab.id, payload.tabSessionId);
  }

  const request = payload.request;
  const requestExternalId = viewPostExternalId(request);

  let registeredVersion: RegisterObservedVersionOutput;
  let result: InvestigateNowOutput;
  try {
    registeredVersion = await registerObservedVersion(request);
    await clearUpgradeRequiredStateBestEffort("INVESTIGATE_NOW");
    result = await investigateNow({
      postVersionId: registeredVersion.postVersionId,
    });
  } catch (error) {
    if (sender.tab?.id !== undefined) {
      await cacheApiErrorStatus({
        error,
        tabId: sender.tab.id,
        tabSessionId: payload.tabSessionId,
        platform: request.platform,
        externalId: requestExternalId,
        pageUrl: request.url,
        skipIfStale: true,
        stopPolling: true,
      });
    }
    throw error;
  }

  if (sender.tab?.id !== undefined) {
    if (isStaleTabSession(sender.tab.id, payload.tabSessionId)) {
      return result;
    }

    const existingStatus = await getActivePostStatus(sender.tab.id);
    const existingStatusForCaching = toInvestigationStatusForCaching(existingStatus);
    const preservedExistingStatus =
      existingStatusForCaching !== null &&
      existingStatus !== null &&
      existingStatus.tabSessionId === payload.tabSessionId &&
      existingStatus.platform === request.platform &&
      existingStatus.externalId === requestExternalId
        ? existingStatusForCaching
        : null;

    await cacheInvestigateNowResult({
      tabId: sender.tab.id,
      tabSessionId: payload.tabSessionId,
      request,
      result,
      ...(preservedExistingStatus !== null ? { existingStatus: preservedExistingStatus } : {}),
    });

    if (isInvestigatingCheckStatus(result.status)) {
      if (isStaleTabSession(sender.tab.id, payload.tabSessionId)) {
        return result;
      }
      await startInvestigationPolling({
        tabId: sender.tab.id,
        tabSessionId: payload.tabSessionId,
        platform: request.platform,
        externalId: requestExternalId,
        investigationId: result.investigationId,
      });
    } else {
      stopInvestigationPolling(sender.tab.id);
    }
  }

  return result;
}

async function handleGetCached(sender: Runtime.MessageSender): Promise<ExtensionPageStatus | null> {
  const upgradeState = getUpgradeRequiredState();
  if (upgradeState.active) {
    if (upgradeState.apiBaseUrl !== getCurrentApiBaseUrl()) {
      await clearUpgradeRequiredStateBestEffort("background GET_CACHED");
    } else {
      throw new ApiClientError(upgradeState.message, {
        errorCode: "UPGRADE_REQUIRED",
      });
    }
  }

  if (sender.tab?.id !== undefined) {
    const status = await getActiveStatus(sender.tab.id);
    await maybeResumePollingFromCachedStatus(sender.tab.id, status);
    return status;
  }

  // Popup doesn't have a tab — resolve active tab from background context.
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return null;
  const status = await getActiveStatus(tab.id);
  await maybeResumePollingFromCachedStatus(tab.id, status);
  return status;
}

browser.alarms.onAlarm.addListener((alarm) => {
  const tabId = parsePollRecoveryAlarmTabId(alarm.name);
  if (tabId === null) return;
  void getActiveStatus(tabId)
    .then((status) => maybeResumePollingFromCachedStatus(tabId, status))
    .catch((error: unknown) => {
      console.error("Failed to resume polling from alarm:", error);
    });
});

browser.runtime.onStartup.addListener(() => {
  void restoreInvestigationPollingState().catch((error: unknown) => {
    console.error("Failed to restore investigation polling on startup:", error);
  });
});

browser.runtime.onInstalled.addListener(() => {
  void restoreInvestigationPollingState().catch((error: unknown) => {
    console.error("Failed to restore investigation polling on install/update:", error);
  });
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(changes, "apiBaseUrl")) {
    return;
  }
  const currentUpgradeState = getUpgradeRequiredState();
  if (!currentUpgradeState.active) {
    return;
  }

  const changedApiBaseUrl = normalizeConfiguredApiBaseUrl(changes["apiBaseUrl"]?.newValue);
  if (changedApiBaseUrl === currentUpgradeState.apiBaseUrl) {
    return;
  }

  void clearUpgradeRequiredState().catch((error: unknown) => {
    console.error("Failed to clear upgrade-required state after API base URL change:", error);
  });
});

browser.tabs.onRemoved.addListener((tabId) => {
  clearInjectedCustomSubstackTab(tabId);
  clearTabSession(tabId);
  stopInvestigationPolling(tabId);
  clearCache(tabId);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  clearInjectedCustomSubstackTab(tabId);
  clearTabSession(tabId);
  stopInvestigationPolling(tabId);
  void clearActiveStatus(tabId).catch((error: unknown) => {
    console.error("failed to clear active status on tab loading:", error);
  });
});

// Inject content scripts into custom-domain Substack pages as soon as the
// DOM is ready, rather than waiting for all subresources (`status: "complete"`).
// Substack pages are heavy and `complete` can fire 5-8 seconds after the
// article content is already visible and parseable.
addDomContentLoadedListener((details) => {
  if (details.frameId !== 0) return;
  void Promise.all([
    maybeInjectKnownDomainContentScript(details.tabId, details.url),
    maybeInjectCustomDomainSubstack(details.tabId, details.url),
  ]);
});

browser.tabs.onActivated.addListener(({ tabId }) => {
  void browser.tabs
    .get(tabId)
    .then((tab) => {
      if (tab.url === undefined || tab.url.length === 0) return;
      return Promise.all([
        maybeInjectKnownDomainContentScript(tabId, tab.url),
        maybeInjectCustomDomainSubstack(tabId, tab.url),
      ]);
    })
    .catch(() => {
      // Tab may have been closed between activation and the get() call.
    });
});

addHistoryStateUpdatedListener((details) => {
  if (details.frameId !== 0) return;
  void Promise.all([
    maybeInjectKnownDomainContentScript(details.tabId, details.url),
    maybeInjectCustomDomainSubstack(details.tabId, details.url),
  ]);
});

void ensureSubstackInjectionForOpenTabs().catch((error: unknown) => {
  console.error("substack startup probe failed:", error);
});

void syncToolbarBadgesForOpenTabs().catch((error: unknown) => {
  console.error("toolbar badge startup sync failed:", error);
});

void restoreInvestigationPollingState().catch((error: unknown) => {
  console.error("investigation polling startup restore failed:", error);
});
