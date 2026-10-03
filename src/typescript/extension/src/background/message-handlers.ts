import type {
  ExtensionPostStatus,
  InvestigateNowInput,
  InvestigateNowOutput,
  PlatformContent,
  RecordViewAndGetStatusInput,
  RegisterObservedVersionInput,
  RegisterObservedVersionOutput,
  TabSessionId,
  ViewPostOutput,
} from "@openerrata/shared";
import type { BackgroundRequestHandlers } from "../lib/messaging.js";
import { toViewPostInput } from "../lib/view-post-input.js";
import type { InvestigationPolling } from "./investigation-polling.js";
import {
  apiErrorPostStatus,
  postStatusFromInvestigateNow,
  postStatusFromView,
  priorResultOf,
  type PostPage,
} from "./post-status.js";
import type { TabStates } from "./tab-state.js";
import type { UpgradeRequiredState } from "./upgrade-required.js";

/** The parts of a `runtime.onMessage` sender the handlers use. */
export interface MessageSender {
  tab?: { id?: number };
}

interface BackgroundHandlerDeps {
  tabStates: TabStates;
  polling: InvestigationPolling;
  api: {
    registerObservedVersion: (
      input: RegisterObservedVersionInput,
    ) => Promise<RegisterObservedVersionOutput>;
    recordViewAndGetStatus: (input: RecordViewAndGetStatusInput) => Promise<ViewPostOutput>;
    investigateNow: (input: InvestigateNowInput) => Promise<InvestigateNowOutput>;
    shouldAutoInvestigate: () => Promise<boolean>;
  };
  getUpgradeRequiredState: () => Promise<UpgradeRequiredState>;
}

/** Content-script messages always come from a tab; anything else is a protocol violation. */
function requireSenderTabId(sender: MessageSender): number {
  const tabId = sender.tab?.id;
  if (tabId === undefined) {
    throw new Error("Page-session messages must come from a tab's content script");
  }
  return tabId;
}

function pageOf(tabSessionId: TabSessionId, content: PlatformContent): PostPage {
  return {
    tabSessionId,
    platform: content.platform,
    externalId: content.externalId,
    pageUrl: content.url,
  };
}

function staleSessionError(tabSessionId: TabSessionId): Error {
  return new Error(`Tab session ${tabSessionId} is no longer the tab's current page session`);
}

export function createBackgroundHandlers(
  deps: BackgroundHandlerDeps,
): BackgroundRequestHandlers<MessageSender> {
  const { tabStates, polling, api } = deps;

  /**
   * Cache a post status and follow it if it is still in progress. False when
   * its page session was superseded meanwhile (nothing is cached then).
   */
  async function publishPostStatus(tabId: number, status: ExtensionPostStatus): Promise<boolean> {
    if (!(await tabStates.putStatus(tabId, status))) return false;
    if (status.investigationState === "INVESTIGATING") {
      polling.follow(tabId, status);
    } else {
      polling.stop(tabId);
    }
    return true;
  }

  async function autoInvestigate(
    tabId: number,
    page: PostPage,
    postVersionId: RegisterObservedVersionOutput["postVersionId"],
  ): Promise<void> {
    let result: InvestigateNowOutput;
    try {
      result = await api.investigateNow({ postVersionId });
    } catch (error) {
      await publishPostStatus(tabId, apiErrorPostStatus(page));
      throw error;
    }
    const current = await tabStates.getStatus(tabId);
    const prior =
      current?.kind === "POST" && current.tabSessionId === page.tabSessionId
        ? priorResultOf(current)
        : null;
    await publishPostStatus(tabId, postStatusFromInvestigateNow(page, result, prior));
  }

  return {
    async PAGE_CONTENT({ tabSessionId, content }, sender) {
      const tabId = requireSenderTabId(sender);
      if (!tabStates.claimSession(tabId, tabSessionId)) {
        throw staleSessionError(tabSessionId);
      }
      const page = pageOf(tabSessionId, content);

      let registered: RegisterObservedVersionOutput;
      let view: ViewPostOutput;
      try {
        registered = await api.registerObservedVersion(toViewPostInput(content));
        view = await api.recordViewAndGetStatus({ postVersionId: registered.postVersionId });
      } catch (error) {
        await publishPostStatus(tabId, apiErrorPostStatus(page));
        throw error;
      }

      // An investigation someone else (or the selector) started is followed
      // like one this tab started (spec §2.6).
      const status = postStatusFromView(page, view);
      const published = await publishPostStatus(tabId, status);

      if (
        published &&
        view.investigationState === "NOT_INVESTIGATED" &&
        (await api.shouldAutoInvestigate())
      ) {
        void autoInvestigate(tabId, page, registered.postVersionId).catch((error: unknown) => {
          console.error("Auto-investigate failed:", error);
        });
      }
      return status;
    },

    async PAGE_SKIPPED(skipped, sender) {
      const tabId = requireSenderTabId(sender);
      if (!tabStates.claimSession(tabId, skipped.tabSessionId)) {
        // A superseded session's skip is moot.
        return null;
      }
      polling.stop(tabId);
      await tabStates.putStatus(tabId, { kind: "SKIPPED", ...skipped });
      return null;
    },

    async PAGE_RESET({ tabSessionId }, sender) {
      const tabId = requireSenderTabId(sender);
      polling.stop(tabId);
      await tabStates.retireSession(tabId, tabSessionId);
      return null;
    },

    async INVESTIGATE_NOW({ tabSessionId, content }, sender) {
      const tabId = requireSenderTabId(sender);
      if (!tabStates.claimSession(tabId, tabSessionId)) {
        throw staleSessionError(tabSessionId);
      }
      const page = pageOf(tabSessionId, content);

      let result: InvestigateNowOutput;
      try {
        const registered = await api.registerObservedVersion(toViewPostInput(content));
        result = await api.investigateNow({ postVersionId: registered.postVersionId });
      } catch (error) {
        await publishPostStatus(tabId, apiErrorPostStatus(page));
        throw error;
      }

      const current = await tabStates.getStatus(tabId);
      const prior =
        current?.kind === "POST" && current.tabSessionId === tabSessionId
          ? priorResultOf(current)
          : null;
      const status = postStatusFromInvestigateNow(page, result, prior);
      await publishPostStatus(tabId, status);
      return status;
    },

    async GET_TAB_STATUS({ tabId }) {
      const upgrade = await deps.getUpgradeRequiredState();
      if (upgrade.kind === "REQUIRED") {
        return { kind: "UPGRADE_REQUIRED", message: upgrade.message };
      }
      // A popup read is a natural moment to pick polling back up after the
      // service worker was stopped.
      await polling.resume(tabId);
      return { kind: "STATUS", status: await tabStates.getStatus(tabId) };
    },
  };
}
