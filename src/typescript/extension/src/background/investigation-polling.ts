import {
  POLL_INTERVAL_MS,
  type ExtensionPageStatus,
  type ExtensionPostStatus,
  type GetInvestigationInput,
  type GetInvestigationOutput,
  type InvestigationId,
  type TabSessionId,
} from "@openerrata/shared";
import { ApiClientError } from "./api-client-error.js";
import { apiErrorPostStatus, postStatusFromPoll, type PostPage } from "./post-status.js";
import type { TabStates } from "./tab-state.js";

const POLL_RECOVERY_ALARM_PREFIX = "investigation-poll:";
// Chrome enforces a minimum repeating alarm interval; the alarm only wakes a
// stopped service worker so polling can resume — ticks run on timers.
const POLL_RECOVERY_ALARM_PERIOD_MINUTES = 0.5;
/** Consecutive transient failures (network, 5xx) tolerated before giving up. */
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

type InvestigatingStatus = Extract<ExtensionPostStatus, { investigationState: "INVESTIGATING" }>;

interface Poller {
  tabSessionId: TabSessionId;
  investigationId: InvestigationId;
  consecutiveFailures: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface InvestigationPollingDeps {
  tabStates: TabStates;
  getInvestigation: (input: GetInvestigationInput) => Promise<GetInvestigationOutput>;
  alarms: {
    create: (name: string, info: { periodInMinutes: number }) => Promise<void>;
    clear: (name: string) => Promise<boolean>;
  };
}

function pageOf(status: ExtensionPostStatus): PostPage {
  return {
    tabSessionId: status.tabSessionId,
    platform: status.platform,
    externalId: status.externalId,
    pageUrl: status.pageUrl,
  };
}

function isInvestigating(status: ExtensionPageStatus | null): status is InvestigatingStatus {
  return status?.kind === "POST" && status.investigationState === "INVESTIGATING";
}

/**
 * A failure retrying cannot fix: every coded API client error is a
 * compatibility, configuration or contract problem, not a transient one.
 */
function isNonRetryablePollError(error: unknown): boolean {
  return error instanceof ApiClientError && error.errorCode !== undefined;
}

export function pollRecoveryAlarmTabId(alarmName: string): number | null {
  if (!alarmName.startsWith(POLL_RECOVERY_ALARM_PREFIX)) return null;
  const rawTabId = alarmName.slice(POLL_RECOVERY_ALARM_PREFIX.length);
  if (!/^\d+$/.test(rawTabId)) return null;
  const tabId = Number.parseInt(rawTabId, 10);
  return Number.isSafeInteger(tabId) ? tabId : null;
}

function pollRecoveryAlarmName(tabId: number): string {
  return `${POLL_RECOVERY_ALARM_PREFIX}${tabId.toString()}`;
}

/**
 * Follows INVESTIGATING statuses: polls `getInvestigation` every
 * `POLL_INTERVAL_MS` and caches each result, until the investigation settles
 * or the page session the status belongs to ends.
 */
export class InvestigationPolling {
  readonly #deps: InvestigationPollingDeps;
  readonly #pollers = new Map<number, Poller>();

  constructor(deps: InvestigationPollingDeps) {
    this.#deps = deps;
  }

  follow(tabId: number, status: InvestigatingStatus): void {
    const existing = this.#pollers.get(tabId);
    if (
      existing?.tabSessionId === status.tabSessionId &&
      existing.investigationId === status.investigationId
    ) {
      return;
    }
    this.stop(tabId);

    const poller: Poller = {
      tabSessionId: status.tabSessionId,
      investigationId: status.investigationId,
      consecutiveFailures: 0,
      timer: null,
    };
    this.#pollers.set(tabId, poller);
    void this.#deps.alarms
      .create(pollRecoveryAlarmName(tabId), {
        periodInMinutes: POLL_RECOVERY_ALARM_PERIOD_MINUTES,
      })
      .catch((error: unknown) => {
        console.error("Failed to schedule investigation poll recovery alarm:", error);
      });
    this.#runTick(tabId, poller);
  }

  stop(tabId: number): void {
    void this.#deps.alarms.clear(pollRecoveryAlarmName(tabId)).catch((error: unknown) => {
      console.error("Failed to clear investigation poll recovery alarm:", error);
    });
    const poller = this.#pollers.get(tabId);
    if (poller === undefined) return;
    if (poller.timer !== null) {
      clearTimeout(poller.timer);
    }
    this.#pollers.delete(tabId);
  }

  /** Follow (or stop following) whatever the tab's cached status now is. */
  async resume(tabId: number): Promise<void> {
    const status = await this.#deps.tabStates.getStatus(tabId);
    if (isInvestigating(status)) {
      this.follow(tabId, status);
    } else {
      this.stop(tabId);
    }
  }

  #isActive(tabId: number, poller: Poller): boolean {
    return this.#pollers.get(tabId) === poller;
  }

  #schedule(tabId: number, poller: Poller, delayMs: number): void {
    poller.timer = setTimeout(() => {
      poller.timer = null;
      this.#runTick(tabId, poller);
    }, delayMs);
  }

  #runTick(tabId: number, poller: Poller): void {
    void this.#tick(tabId, poller).catch((error: unknown) => {
      console.error("Investigation polling failed:", error);
      if (this.#isActive(tabId, poller)) this.stop(tabId);
    });
  }

  async #tick(tabId: number, poller: Poller): Promise<void> {
    if (!this.#isActive(tabId, poller)) return;
    const followed = await this.#deps.tabStates.getStatus(tabId);
    if (
      !isInvestigating(followed) ||
      followed.tabSessionId !== poller.tabSessionId ||
      followed.investigationId !== poller.investigationId
    ) {
      this.stop(tabId);
      return;
    }

    let output: GetInvestigationOutput;
    try {
      output = await this.#deps.getInvestigation({ investigationId: poller.investigationId });
    } catch (error) {
      if (!this.#isActive(tabId, poller)) return;
      poller.consecutiveFailures += 1;
      if (
        isNonRetryablePollError(error) ||
        poller.consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES
      ) {
        console.error("Investigation polling gave up:", error);
        this.stop(tabId);
        await this.#deps.tabStates.putStatus(tabId, apiErrorPostStatus(pageOf(followed)));
        return;
      }
      console.error("Investigation poll failed; retrying with backoff:", error);
      this.#schedule(tabId, poller, POLL_INTERVAL_MS * 2 ** poller.consecutiveFailures);
      return;
    }

    if (!this.#isActive(tabId, poller)) return;
    poller.consecutiveFailures = 0;
    const next = postStatusFromPoll(pageOf(followed), poller.investigationId, output);
    await this.#deps.tabStates.putStatus(tabId, next);
    if (next.investigationState === "INVESTIGATING" && this.#isActive(tabId, poller)) {
      this.#schedule(tabId, poller, POLL_INTERVAL_MS);
    } else {
      this.stop(tabId);
    }
  }
}
