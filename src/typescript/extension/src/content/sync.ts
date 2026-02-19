import {
  extensionPageStatusSchema,
  extensionRuntimeErrorResponseSchema,
  investigateNowOutputSchema,
  viewPostOutputSchema,
  type ExtensionSkippedReason,
  type Platform,
  type PlatformContent,
  type InvestigateNowOutput,
  type ViewPostInput,
  type ViewPostOutput,
} from "@truesight/shared";
import browser from "webextension-polyfill";

export type ParsedExtensionPageStatus = ReturnType<
  typeof extensionPageStatusSchema.parse
>;

type CachedStatusListener = () => void;

function throwIfRuntimeError(response: unknown): void {
  const parsedError = extensionRuntimeErrorResponseSchema.safeParse(response);
  if (!parsedError.success) return;
  throw new Error(parsedError.data.error);
}

export class ContentSyncClient {
  sendPageReset(tabSessionId: number): void {
    void browser.runtime.sendMessage({
      type: "PAGE_RESET",
      payload: { tabSessionId },
    });
  }

  sendPageSkipped(input: {
    tabSessionId: number;
    platform: Platform;
    externalId: string;
    pageUrl: string;
    reason: ExtensionSkippedReason;
  }): void {
    void browser.runtime.sendMessage({
      type: "PAGE_SKIPPED",
      payload: input,
    });
  }

  async sendPageContent(
    tabSessionId: number,
    content: PlatformContent,
  ): Promise<ViewPostOutput> {
    const response = await browser.runtime.sendMessage({
      type: "PAGE_CONTENT",
      payload: {
        tabSessionId,
        content,
      },
    });

    throwIfRuntimeError(response);
    return viewPostOutputSchema.parse(response);
  }

  async requestInvestigation(
    tabSessionId: number,
    request: ViewPostInput,
  ): Promise<InvestigateNowOutput> {
    const response = await browser.runtime.sendMessage({
      type: "INVESTIGATE_NOW",
      payload: {
        tabSessionId,
        request,
      },
    });

    throwIfRuntimeError(response);
    return investigateNowOutputSchema.parse(response);
  }

  async getCachedStatus(): Promise<ParsedExtensionPageStatus | null> {
    const response = await browser.runtime.sendMessage({ type: "GET_CACHED" });
    throwIfRuntimeError(response);
    if (response === null) return null;
    return extensionPageStatusSchema.parse(response);
  }

  installCachedStatusListener(listener: CachedStatusListener): void {
    const onStorageChanged: Parameters<
      typeof browser.storage.onChanged.addListener
    >[0] = (changes, areaName) => {
      if (areaName !== "local") return;
      if (!Object.keys(changes).some((key) => key.startsWith("tab:"))) return;
      listener();
    };

    browser.storage.onChanged.addListener(onStorageChanged);
  }
}
