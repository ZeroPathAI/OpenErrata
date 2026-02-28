import {
  EXTENSION_MESSAGE_PROTOCOL_VERSION,
  extensionPageStatusSchema,
  type ExtensionSkippedReason,
  type Platform,
  type PlatformContent,
  type InvestigateNowOutput,
  type ViewPostInput,
  type ViewPostOutput,
} from "@openerrata/shared";
import browser from "webextension-polyfill";
import { isExtensionContextInvalidatedError } from "../lib/runtime-error.js";
import {
  parseInvestigateNowResponse,
  parseViewPostResponse,
  throwIfRuntimeError,
} from "../lib/sync-response.js";

export type ParsedExtensionPageStatus = ReturnType<typeof extensionPageStatusSchema.parse>;

type CachedStatusListener = () => void;

export class ContentSyncClient {
  sendPageReset(tabSessionId: number): void {
    void browser.runtime
      .sendMessage({
        v: EXTENSION_MESSAGE_PROTOCOL_VERSION,
        type: "PAGE_RESET",
        payload: { tabSessionId },
      })
      .catch((error: unknown) => {
        if (isExtensionContextInvalidatedError(error)) {
          return;
        }
        console.error("Failed to send PAGE_RESET to background:", error);
      });
  }

  sendPageSkipped(input: {
    tabSessionId: number;
    platform: Platform;
    externalId: string;
    pageUrl: string;
    reason: ExtensionSkippedReason;
  }): void {
    void browser.runtime
      .sendMessage({
        v: EXTENSION_MESSAGE_PROTOCOL_VERSION,
        type: "PAGE_SKIPPED",
        payload: input,
      })
      .catch((error: unknown) => {
        if (isExtensionContextInvalidatedError(error)) {
          return;
        }
        console.error("Failed to send PAGE_SKIPPED to background:", error);
      });
  }

  async sendPageContent(tabSessionId: number, content: PlatformContent): Promise<ViewPostOutput> {
    const response = await browser.runtime.sendMessage({
      v: EXTENSION_MESSAGE_PROTOCOL_VERSION,
      type: "PAGE_CONTENT",
      payload: {
        tabSessionId,
        content,
      },
    });

    return parseViewPostResponse(response);
  }

  async requestInvestigation(
    tabSessionId: number,
    request: ViewPostInput,
  ): Promise<InvestigateNowOutput> {
    const response = await browser.runtime.sendMessage({
      v: EXTENSION_MESSAGE_PROTOCOL_VERSION,
      type: "INVESTIGATE_NOW",
      payload: {
        tabSessionId,
        request,
      },
    });

    return parseInvestigateNowResponse(response);
  }

  async getCachedStatus(): Promise<ParsedExtensionPageStatus | null> {
    const response = await browser.runtime.sendMessage({
      v: EXTENSION_MESSAGE_PROTOCOL_VERSION,
      type: "GET_CACHED",
    });
    throwIfRuntimeError(response);
    if (response === null) return null;
    return extensionPageStatusSchema.parse(response);
  }

  installCachedStatusListener(listener: CachedStatusListener): () => void {
    const onStorageChanged: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
      changes,
      areaName,
    ) => {
      if (areaName !== "local") return;
      if (!Object.keys(changes).some((key) => key.startsWith("tab:"))) return;
      listener();
    };

    browser.storage.onChanged.addListener(onStorageChanged);
    return () => {
      browser.storage.onChanged.removeListener(onStorageChanged);
    };
  }
}
