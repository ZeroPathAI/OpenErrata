import {
  EXTENSION_MESSAGE_PROTOCOL_VERSION,
  extensionMessageSchema,
  extensionRuntimeErrorResponseSchema,
  getInvestigationInputSchema,
  investigationStatusOutputSchema,
  POLL_INTERVAL_MS,
} from "@openerrata/shared";
import type {
  ContentProvenance,
  ExtensionPageStatus,
  ExtensionPostStatus,
  GetInvestigationOutput,
  InvestigateNowOutput,
  InvestigationStatusOutput,
  RegisterObservedVersionOutput,
  ViewPostInput,
  ViewPostOutput,
} from "@openerrata/shared";
import browser, { type Runtime } from "webextension-polyfill";
import {
  ApiClientError,
  init,
  registerObservedVersion,
  recordViewAndGetStatus,
  getInvestigation,
  investigateNow,
  hasUserOpenAiKey,
  isAutoInvestigateEnabled,
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
import { createPostStatusFromInvestigation, apiErrorToPostStatus } from "./post-status.js";
import { BackgroundInvestigationState, type InvestigationPoller } from "./investigation-state.js";
import {
  snapshotFromInvestigateNowResult,
  toInvestigationStatusForCaching,
} from "./investigation-snapshot.js";
import { decidePageContentSnapshot } from "./page-content-decision.js";
import { decidePageContentPostCacheAction } from "./page-content-action.js";
import { unsupportedProtocolVersionResponse } from "../lib/protocol-version.js";
import {
  addDomContentLoadedListener,
  addHistoryStateUpdatedListener,
  executeTabFunction,
  injectTabAssets,
} from "./browser-compat.js";

// Initialize API client on worker start.
void init();

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
    type:
      | "PAGE_CONTENT"
      | "PAGE_SKIPPED"
      | "PAGE_RESET"
      | "GET_STATUS"
      | "INVESTIGATE_NOW"
      | "GET_CACHED";
  }
>;
type ExtensionRuntimeErrorResponse = ReturnType<typeof extensionRuntimeErrorResponseSchema.parse>;

const SUBSTACK_POST_PATH_REGEX = /^\/p\/[^/?#]+/i;
const KNOWN_DECLARATIVE_DOMAINS = [
  "substack.com",
  "lesswrong.com",
  "x.com",
  "twitter.com",
  "wikipedia.org",
];

const injectedCustomSubstackTabs = new Map<number, string>();

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

function isContentMismatchError(error: unknown): boolean {
  return error instanceof ApiClientError && error.errorCode === "CONTENT_MISMATCH";
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
  return (
    message.type === "PAGE_CONTENT" ||
    message.type === "PAGE_SKIPPED" ||
    message.type === "PAGE_RESET" ||
    message.type === "GET_STATUS" ||
    message.type === "INVESTIGATE_NOW" ||
    message.type === "GET_CACHED"
  );
}

function isKnownDeclarativeDomain(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return KNOWN_DECLARATIVE_DOMAINS.some(
    (domain) => normalizedHostname === domain || normalizedHostname.endsWith(`.${domain}`),
  );
}

function hasCandidateSubstackPath(url: URL): boolean {
  return SUBSTACK_POST_PATH_REGEX.test(url.pathname);
}

async function detectSubstackDomFingerprint(tabId: number): Promise<boolean> {
  const probeResult = await executeTabFunction(tabId, () => {
    const hasPostPath = /^\/p\/[^/?#]+/i.test(window.location.pathname);
    const hasSubstackFingerprint =
      document.querySelector(
        [
          'link[href*="substackcdn.com"]',
          'script[src*="substackcdn.com"]',
          'img[src*="substackcdn.com"]',
          'meta[property="og:url"][content*=".substack.com"]',
          'meta[name="twitter:image"][content*="post_preview/"]',
        ].join(","),
      ) !== null;
    return hasPostPath && hasSubstackFingerprint;
  });

  return probeResult === true;
}

async function injectContentScriptIntoTab(tabId: number): Promise<void> {
  await injectTabAssets({
    tabId,
    scriptFile: "content/main.js",
    cssFile: "content/annotations.css",
  });
}

async function hasContentScriptListener(tabId: number): Promise<boolean> {
  try {
    await browser.tabs.sendMessage(tabId, {
      v: EXTENSION_MESSAGE_PROTOCOL_VERSION,
      type: "GET_ANNOTATION_VISIBILITY",
    });
    return true;
  } catch {
    return false;
  }
}

async function maybeInjectKnownDomainContentScript(tabId: number, tabUrl: string): Promise<void> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(tabUrl);
  } catch {
    return;
  }

  if (!isKnownDeclarativeDomain(parsedUrl.hostname)) {
    return;
  }

  if (await hasContentScriptListener(tabId)) {
    return;
  }

  try {
    await injectContentScriptIntoTab(tabId);
  } catch (error) {
    console.error("known-domain content script injection failed:", error);
  }
}

async function maybeInjectCustomDomainSubstack(tabId: number, tabUrl: string): Promise<void> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(tabUrl);
  } catch {
    return;
  }

  if (isKnownDeclarativeDomain(parsedUrl.hostname)) {
    return;
  }
  if (!hasCandidateSubstackPath(parsedUrl)) {
    return;
  }
  if (injectedCustomSubstackTabs.get(tabId) === tabUrl) {
    return;
  }

  try {
    const isSubstackPage = await detectSubstackDomFingerprint(tabId);
    if (!isSubstackPage) {
      return;
    }

    await injectContentScriptIntoTab(tabId);
    injectedCustomSubstackTabs.set(tabId, tabUrl);
  } catch (error) {
    console.error("custom-domain substack injection failed:", error);
  }
}

async function ensureSubstackInjectionForOpenTabs(): Promise<void> {
  const tabs = await browser.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined || tab.url === undefined || tab.url.length === 0) return;
      await maybeInjectKnownDomainContentScript(tab.id, tab.url);
      await maybeInjectCustomDomainSubstack(tab.id, tab.url);
    }),
  );
}

const backgroundInvestigationState = new BackgroundInvestigationState();
const INVESTIGATION_POLL_ALARM_PREFIX = "investigation-poll:";
// Chrome enforces a minimum repeating alarm interval; keep this as a wake-up
// recovery signal and retain in-memory 5s polling while the worker is alive.
const INVESTIGATION_POLL_RECOVERY_ALARM_PERIOD_MINUTES = 0.5;

function noteTabSession(tabId: number, tabSessionId: number): void {
  backgroundInvestigationState.noteTabSession(tabId, tabSessionId);
}

function retireTabSession(tabId: number, tabSessionId: number): void {
  backgroundInvestigationState.retireTabSession(tabId, tabSessionId);
}

function isStaleTabSession(tabId: number, tabSessionId: number): boolean {
  return backgroundInvestigationState.isStaleTabSession(tabId, tabSessionId);
}

async function cacheApiErrorStatus(input: {
  error: unknown;
  tabId: number;
  tabSessionId: number;
  platform: ViewPostInput["platform"];
  externalId: string;
  pageUrl: string;
  investigationId?: string;
  provenance?: ContentProvenance;
  skipIfStale?: boolean;
  noteSession?: boolean;
  stopPolling?: boolean;
}): Promise<void> {
  if (input.skipIfStale === true && isStaleTabSession(input.tabId, input.tabSessionId)) {
    return;
  }
  if (input.noteSession === true) {
    noteTabSession(input.tabId, input.tabSessionId);
  }
  if (input.stopPolling === true) {
    stopInvestigationPolling(input.tabId);
  }

  const statusInput: Parameters<typeof apiErrorToPostStatus>[0] = {
    error: input.error,
    tabSessionId: input.tabSessionId,
    platform: input.platform,
    externalId: input.externalId,
    pageUrl: input.pageUrl,
  };
  if (input.investigationId !== undefined) {
    statusInput.investigationId = input.investigationId;
  }
  if (input.provenance !== undefined) {
    statusInput.provenance = input.provenance;
  }

  await cachePostStatus(input.tabId, apiErrorToPostStatus(statusInput));
}

function pollRecoveryAlarmName(tabId: number): string {
  return `${INVESTIGATION_POLL_ALARM_PREFIX}${tabId.toString()}`;
}

function parsePollRecoveryAlarmTabId(alarmName: string): number | null {
  if (!alarmName.startsWith(INVESTIGATION_POLL_ALARM_PREFIX)) {
    return null;
  }
  const rawTabId = alarmName.slice(INVESTIGATION_POLL_ALARM_PREFIX.length);
  if (!/^\d+$/.test(rawTabId)) {
    return null;
  }
  const tabId = Number.parseInt(rawTabId, 10);
  if (!Number.isSafeInteger(tabId) || tabId < 0) {
    return null;
  }
  return tabId;
}

function schedulePollRecoveryAlarm(tabId: number): void {
  void browser.alarms
    .create(pollRecoveryAlarmName(tabId), {
      periodInMinutes: INVESTIGATION_POLL_RECOVERY_ALARM_PERIOD_MINUTES,
    })
    .catch((error: unknown) => {
      console.error("Failed to schedule investigation poll recovery alarm:", error);
    });
}

function clearPollRecoveryAlarm(tabId: number): void {
  void browser.alarms.clear(pollRecoveryAlarmName(tabId)).catch((error: unknown) => {
    console.error("Failed to clear investigation poll recovery alarm:", error);
  });
}

function stopInvestigationPolling(tabId: number): void {
  clearPollRecoveryAlarm(tabId);

  const existing = backgroundInvestigationState.getPoller(tabId);
  if (!existing) return;

  if (existing.timer) {
    clearInterval(existing.timer);
  }
  backgroundInvestigationState.clearPoller(tabId);
}

function isInvestigatingCheckStatus(status: InvestigateNowOutput["status"]): boolean {
  return status === "PENDING" || status === "PROCESSING";
}

function isInvestigatingSnapshot(
  snapshot: Pick<InvestigationStatusOutput, "investigationState">,
): boolean {
  return snapshot.investigationState === "INVESTIGATING";
}

function toInvestigationStatusSnapshot(output: GetInvestigationOutput): InvestigationStatusOutput {
  const { checkedAt: _checkedAt, ...snapshot } = output;
  return snapshot;
}

async function startInvestigationPolling(input: {
  tabId: number;
  tabSessionId: number;
  platform: ViewPostInput["platform"];
  externalId: string;
  investigationId: string;
}): Promise<void> {
  stopInvestigationPolling(input.tabId);

  const poller: InvestigationPoller = {
    tabSessionId: input.tabSessionId,
    investigationId: input.investigationId,
    inFlight: false,
    timer: null,
  };
  backgroundInvestigationState.setPoller(input.tabId, poller);
  schedulePollRecoveryAlarm(input.tabId);

  const tick = async () => {
    const activePoller = backgroundInvestigationState.getPoller(input.tabId);
    if (
      activePoller?.tabSessionId !== input.tabSessionId ||
      activePoller.investigationId !== input.investigationId
    ) {
      return;
    }
    if (activePoller.inFlight) return;

    activePoller.inFlight = true;
    try {
      const existing = await getActivePostStatus(input.tabId);
      if (
        existing?.tabSessionId !== input.tabSessionId ||
        existing.platform !== input.platform ||
        existing.externalId !== input.externalId
      ) {
        stopInvestigationPolling(input.tabId);
        return;
      }

      const latest = await getInvestigation(
        getInvestigationInputSchema.parse({
          investigationId: input.investigationId,
        }),
      );
      const latestSnapshot = toInvestigationStatusSnapshot(latest);
      await cachePostStatus(
        input.tabId,
        createPostStatusFromInvestigation({
          tabSessionId: input.tabSessionId,
          platform: input.platform,
          externalId: input.externalId,
          pageUrl: existing.pageUrl,
          investigationId: input.investigationId,
          ...latestSnapshot,
        }),
        { setActive: false },
      );

      if (!isInvestigatingSnapshot(latestSnapshot)) {
        stopInvestigationPolling(input.tabId);
      }
    } catch (error) {
      console.error("investigation polling failed:", error);
    } finally {
      const current = backgroundInvestigationState.getPoller(input.tabId);
      if (current) {
        current.inFlight = false;
      }
    }
  };

  await tick();
  const current = backgroundInvestigationState.getPoller(input.tabId);
  if (!current || current !== poller) {
    return;
  }
  const timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  poller.timer = timer;
}

async function maybeResumePollingFromCachedStatus(
  tabId: number,
  status: ExtensionPageStatus | null,
): Promise<void> {
  if (status?.kind !== "POST") {
    stopInvestigationPolling(tabId);
    return;
  }
  if (status.investigationState !== "INVESTIGATING" || status.investigationId === undefined) {
    stopInvestigationPolling(tabId);
    return;
  }

  const activePoller = backgroundInvestigationState.getPoller(tabId);
  if (
    activePoller?.tabSessionId === status.tabSessionId &&
    activePoller.investigationId === status.investigationId
  ) {
    return;
  }

  await startInvestigationPolling({
    tabId,
    tabSessionId: status.tabSessionId,
    platform: status.platform,
    externalId: status.externalId,
    investigationId: status.investigationId,
  });
}

async function resumeInvestigationPollingForOpenTabs(): Promise<void> {
  const tabs = await browser.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        const status = await getActiveStatus(tab.id);
        await maybeResumePollingFromCachedStatus(tab.id, status);
      } catch (error) {
        console.error("Failed to resume investigation polling for tab:", error);
      }
    }),
  );
}

async function clearAllPollRecoveryAlarms(): Promise<void> {
  const alarms = await browser.alarms.getAll();
  const clearTasks = alarms.flatMap((alarm) => {
    if (parsePollRecoveryAlarmTabId(alarm.name) === null) {
      return [];
    }
    return [browser.alarms.clear(alarm.name)];
  });
  await Promise.all(clearTasks);
}

let restoreInvestigationPollingPromise: Promise<void> | null = null;

async function restoreInvestigationPollingState(): Promise<void> {
  restoreInvestigationPollingPromise ??= (async () => {
    for (const tabId of backgroundInvestigationState.pollerTabIds()) {
      stopInvestigationPolling(tabId);
    }
    await clearAllPollRecoveryAlarms();
    await resumeInvestigationPollingForOpenTabs();
  })().finally(() => {
    restoreInvestigationPollingPromise = null;
  });

  await restoreInvestigationPollingPromise;
}

async function cacheInvestigateNowResult(input: {
  tabId: number;
  tabSessionId: number;
  request: ViewPostInput;
  result: InvestigateNowOutput;
  existingStatus?: InvestigationStatusOutput | null;
}): Promise<void> {
  const { tabId, tabSessionId, request, result } = input;

  const initialSnapshot = snapshotFromInvestigateNowResult(result, input.existingStatus);

  await cachePostStatus(
    tabId,
    createPostStatusFromInvestigation({
      tabSessionId,
      platform: request.platform,
      externalId: request.externalId,
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
        externalId: input.request.externalId,
        investigationId: result.investigationId,
      });
    }
  } catch (error) {
    await cacheApiErrorStatus({
      error,
      tabId: input.tabId,
      tabSessionId: input.tabSessionId,
      platform: input.request.platform,
      externalId: input.request.externalId,
      pageUrl: input.request.url,
      skipIfStale: true,
      ...(input.existingStatus?.tabSessionId === input.tabSessionId &&
      input.existingStatus.investigationId !== undefined
        ? { investigationId: input.existingStatus.investigationId }
        : {}),
    });
    throw error;
  }
}

browser.runtime.onMessage.addListener((message: unknown, sender: Runtime.MessageSender) => {
  const protocolError = unsupportedProtocolVersionResponse(message);
  if (protocolError) {
    return protocolError;
  }

  const parsedMessage = extensionMessageSchema.safeParse(message);
  if (!parsedMessage.success) return false;
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

  return handle().catch((err: unknown) => {
    if (isContentMismatchError(err)) {
      console.warn("Background handler rejected mismatched page content:", err);
    } else {
      console.error("Background handler error:", err);
    }
    return toRuntimeErrorResponse(err);
  });
});

async function handlePageContent(
  payload: ParsedPageContentPayload,
  sender: Runtime.MessageSender,
): Promise<ViewPostOutput> {
  const request = toViewPostInput(payload.content);

  let registeredVersion: RegisterObservedVersionOutput;
  let result: ViewPostOutput;
  try {
    registeredVersion = await registerObservedVersion(request);
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
        externalId: request.externalId,
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
      existing.externalId === request.externalId
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
      externalId: request.externalId,
      pageUrl: request.url,
      ...(existingForSession?.investigationId === undefined
        ? {}
        : { investigationId: existingForSession.investigationId }),
      ...snapshot,
    });
    await cachePostStatus(tabId, nextStatus);

    const postCacheAction = decidePageContentPostCacheAction({
      status: nextStatus,
      shouldAutoInvestigate,
    });

    if (postCacheAction === "RESUME_POLLING") {
      await maybeResumePollingFromCachedStatus(tabId, nextStatus);
    } else if (postCacheAction === "AUTO_INVESTIGATE") {
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

  const { checkedAt: _checkedAt, ...response } = result;
  investigationStatusOutputSchema.parse(response);

  if (sender.tab?.id !== undefined) {
    const existing = await getActivePostStatus(sender.tab.id);
    if (existing) {
      if (tabSessionId !== undefined && tabSessionId !== existing.tabSessionId) {
        return response;
      }

      await cachePostStatus(
        sender.tab.id,
        createPostStatusFromInvestigation({
          tabSessionId: existing.tabSessionId,
          platform: existing.platform,
          externalId: existing.externalId,
          pageUrl: existing.pageUrl,
          investigationId: payload.investigationId,
          ...response,
        }),
        { setActive: false },
      );
    }
  }

  return response;
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

  let registeredVersion: RegisterObservedVersionOutput;
  let result: InvestigateNowOutput;
  try {
    registeredVersion = await registerObservedVersion(request);
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
        externalId: request.externalId,
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
      existingStatus.externalId === request.externalId
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
        externalId: request.externalId,
        investigationId: result.investigationId,
      });
    } else {
      stopInvestigationPolling(sender.tab.id);
    }
  }

  return result;
}

async function handleGetCached(sender: Runtime.MessageSender): Promise<ExtensionPageStatus | null> {
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

browser.tabs.onRemoved.addListener((tabId) => {
  injectedCustomSubstackTabs.delete(tabId);
  backgroundInvestigationState.clearTabSession(tabId);
  stopInvestigationPolling(tabId);
  clearCache(tabId);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  injectedCustomSubstackTabs.delete(tabId);
  backgroundInvestigationState.clearTabSession(tabId);
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
