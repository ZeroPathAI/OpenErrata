import type {
  BackgroundRequestPayload,
  BackgroundRequestType,
  BackgroundResponse,
  ExtensionPostStatus,
  PlatformContent,
  TabSessionId,
} from "@openerrata/shared";
import browser from "webextension-polyfill";
import { sendBackgroundRequest } from "../lib/messaging.js";

async function request<Type extends BackgroundRequestType>(
  type: Type,
  payload: BackgroundRequestPayload<Type>,
): Promise<BackgroundResponse<Type>> {
  return sendBackgroundRequest((message) => browser.runtime.sendMessage(message), type, payload);
}

/** The content script's side of the background protocol, for one tab. */
export const contentSyncClient = {
  async sendPageReset(tabSessionId: TabSessionId): Promise<void> {
    await request("PAGE_RESET", { tabSessionId });
  },

  async sendPageSkipped(payload: BackgroundRequestPayload<"PAGE_SKIPPED">): Promise<void> {
    await request("PAGE_SKIPPED", payload);
  },

  /** Register the observed content; resolves to the status cached for the session. */
  async sendPageContent(
    tabSessionId: TabSessionId,
    content: PlatformContent,
  ): Promise<ExtensionPostStatus> {
    return request("PAGE_CONTENT", { tabSessionId, content });
  },

  async requestInvestigation(
    tabSessionId: TabSessionId,
    content: PlatformContent,
  ): Promise<ExtensionPostStatus> {
    return request("INVESTIGATE_NOW", { tabSessionId, content });
  },
};
