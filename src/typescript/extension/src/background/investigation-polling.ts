import {
  POLL_INTERVAL_MS,
  getInvestigationInputSchema,
  type ExtensionPageStatus,
  type ExtensionPostStatus,
  type InvestigateNowOutput,
  type InvestigationStatusOutput,
  type ViewPostInput,
} from "@openerrata/shared";
import browser from "webextension-polyfill";
import { getInvestigation } from "./api-client.js";
import { cachePostStatus, getActivePostStatus, getActiveStatus } from "./cache.js";
import { apiErrorToPostStatus, createPostStatusFromInvestigation } from "./post-status.js";
import { BackgroundInvestigationState, type InvestigationPoller } from "./investigation-state.js";
import {
  clearUpgradeRequiredStateBestEffort,
  isTerminalCompatibilityError,
  isUpgradeRequiredError,
  markUpgradeRequiredFromError,
} from "./upgrade-required-runtime.js";
import { toInvestigationStatusSnapshot } from "./message-dispatch.js";

const backgroundInvestigationState = new BackgroundInvestigationState();
const INVESTIGATION_POLL_ALARM_PREFIX = "investigation-poll:";
// Chrome enforces a minimum repeating alarm interval; keep this as a wake-up
// recovery signal and retain in-memory 5s polling while the worker is alive.
const INVESTIGATION_POLL_RECOVERY_ALARM_PERIOD_MINUTES = 0.5;

export function noteTabSession(tabId: number, tabSessionId: number): void {
  backgroundInvestigationState.noteTabSession(tabId, tabSessionId);
}

export function retireTabSession(tabId: number, tabSessionId: number): void {
  backgroundInvestigationState.retireTabSession(tabId, tabSessionId);
}

export function clearTabSession(tabId: number): void {
  backgroundInvestigationState.clearTabSession(tabId);
}

export function isStaleTabSession(tabId: number, tabSessionId: number): boolean {
  return backgroundInvestigationState.isStaleTabSession(tabId, tabSessionId);
}

export async function cacheApiErrorStatus(input: {
  error: unknown;
  tabId: number;
  tabSessionId: number;
  platform: ViewPostInput["platform"];
  externalId: string;
  pageUrl: string;
  investigationId?: string;
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

  await cachePostStatus(input.tabId, apiErrorToPostStatus(statusInput));
}

function pollRecoveryAlarmName(tabId: number): string {
  return `${INVESTIGATION_POLL_ALARM_PREFIX}${tabId.toString()}`;
}

export function parsePollRecoveryAlarmTabId(alarmName: string): number | null {
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

export function stopInvestigationPolling(tabId: number): void {
  clearPollRecoveryAlarm(tabId);

  const existing = backgroundInvestigationState.getPoller(tabId);
  if (!existing) return;

  if (existing.timer !== null) {
    clearInterval(existing.timer);
  }
  backgroundInvestigationState.clearPoller(tabId);
}

export function isInvestigatingCheckStatus(status: InvestigateNowOutput["status"]): boolean {
  return status === "PENDING" || status === "PROCESSING";
}

function isInvestigatingSnapshot(
  snapshot: Pick<InvestigationStatusOutput, "investigationState">,
): boolean {
  return snapshot.investigationState === "INVESTIGATING";
}

export async function startInvestigationPolling(input: {
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
    let existingStatus: ExtensionPostStatus | null = null;
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
      existingStatus = existing;

      const latest = await getInvestigation(
        getInvestigationInputSchema.parse({
          investigationId: input.investigationId,
        }),
      );
      await clearUpgradeRequiredStateBestEffort("investigation polling");
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
    } catch (error: unknown) {
      if (isTerminalCompatibilityError(error)) {
        if (isUpgradeRequiredError(error)) {
          await markUpgradeRequiredFromError(error);
        }

        if (existingStatus !== null) {
          await cacheApiErrorStatus({
            error,
            tabId: input.tabId,
            tabSessionId: input.tabSessionId,
            platform: input.platform,
            externalId: input.externalId,
            pageUrl: existingStatus.pageUrl,
            investigationId: input.investigationId,
            stopPolling: true,
          });
        } else {
          stopInvestigationPolling(input.tabId);
        }
        return;
      }
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

export async function maybeResumePollingFromCachedStatus(
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

export async function restoreInvestigationPollingState(): Promise<void> {
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
