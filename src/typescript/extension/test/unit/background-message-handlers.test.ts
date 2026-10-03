import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lesswrongExternalIdSchema,
  postVersionIdSchema,
  type ExtensionPostStatus,
  type InvestigateNowOutput,
  type PlatformContent,
  type ViewPostOutput,
} from "@openerrata/shared";
import type { InvestigationPolling } from "../../src/background/investigation-polling";
import { createBackgroundHandlers } from "../../src/background/message-handlers";
import { TabStates } from "../../src/background/tab-state";
import { investigationId, sessionId } from "../helpers/statuses";

const CONTENT: PlatformContent = {
  platform: "LESSWRONG",
  externalId: lesswrongExternalIdSchema.parse("abc123"),
  url: "https://www.lesswrong.com/posts/abc123/post",
  contentText: "Post text.",
  hasVideo: false,
  imageOccurrences: [],
  metadata: { slug: "post", htmlContent: "<p>Post text.</p>", tags: [] },
};

const SENDER = { tab: { id: 9 } };

const notInvestigatedView: ViewPostOutput = {
  investigationState: "NOT_INVESTIGATED",
  priorInvestigationResult: null,
};

function setup(options: {
  view?: () => Promise<ViewPostOutput>;
  investigateNow?: () => Promise<InvestigateNowOutput>;
  autoInvestigate?: boolean;
}) {
  const tabStates = new TabStates({
    storage: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
    notifyTab: () => Promise.resolve(),
    updateBadge: () => undefined,
    listTabIds: () => Promise.resolve([9]),
  });
  const followed: ExtensionPostStatus[] = [];
  const apiCalls: string[] = [];
  const polling = {
    follow: (_tabId: number, status: ExtensionPostStatus) => {
      followed.push(status);
    },
    stop: () => undefined,
    resume: () => Promise.resolve(),
  } as unknown as InvestigationPolling;
  const handlers = createBackgroundHandlers({
    tabStates,
    polling,
    api: {
      registerObservedVersion: () => {
        apiCalls.push("registerObservedVersion");
        return Promise.resolve({
          platform: "LESSWRONG",
          externalId: CONTENT.externalId,
          versionHash: "a".repeat(64),
          postVersionId: postVersionIdSchema.parse("version-1"),
          provenance: "SERVER_VERIFIED",
        });
      },
      recordViewAndGetStatus: () => {
        apiCalls.push("recordViewAndGetStatus");
        return (options.view ?? (() => Promise.resolve(notInvestigatedView)))();
      },
      investigateNow: () => {
        apiCalls.push("investigateNow");
        return (options.investigateNow ?? (() => Promise.reject(new Error("unexpected"))))();
      },
      shouldAutoInvestigate: () => Promise.resolve(options.autoInvestigate ?? false),
    },
    getUpgradeRequiredState: () => Promise.resolve({ kind: "NOT_REQUIRED" }),
  });
  return { handlers, tabStates, followed, apiCalls };
}

test("PAGE_CONTENT follows an investigation the API reports as already running", async () => {
  const { handlers, tabStates, followed } = setup({
    view: () =>
      Promise.resolve({
        investigationState: "INVESTIGATING",
        investigationId: investigationId("queued-elsewhere"),
        status: "PENDING",
        provenance: "SERVER_VERIFIED",
        pendingClaims: [],
        confirmedClaims: [],
        priorInvestigationResult: null,
      }),
  });

  const status = await handlers.PAGE_CONTENT(
    { tabSessionId: sessionId(1), content: CONTENT },
    SENDER,
  );

  assert.equal(status.investigationState, "INVESTIGATING");
  assert.deepEqual(await tabStates.getStatus(9), status);
  assert.deepEqual(followed, [status]);
});

test("PAGE_CONTENT rejects a superseded session and does not cache a reply that arrives after it ended", async () => {
  let releaseView: (view: ViewPostOutput) => void = () => undefined;
  const { handlers, tabStates } = setup({
    view: () =>
      new Promise((resolve) => {
        releaseView = resolve;
      }),
  });

  const pending = handlers.PAGE_CONTENT({ tabSessionId: sessionId(1), content: CONTENT }, SENDER);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await handlers.PAGE_RESET({ tabSessionId: sessionId(1) }, SENDER);
  releaseView(notInvestigatedView);
  await pending;

  assert.equal(await tabStates.getStatus(9), null);
  await assert.rejects(
    handlers.PAGE_CONTENT({ tabSessionId: sessionId(1), content: CONTENT }, SENDER),
    /no longer the tab's current page session/,
  );
});

test("PAGE_CONTENT auto-investigates a not-yet-investigated post when enabled", async () => {
  const { handlers, tabStates, apiCalls } = setup({
    autoInvestigate: true,
    investigateNow: () =>
      Promise.resolve({
        investigationId: investigationId("new-investigation"),
        status: "PENDING",
        provenance: "SERVER_VERIFIED",
      }),
  });

  await handlers.PAGE_CONTENT({ tabSessionId: sessionId(1), content: CONTENT }, SENDER);
  for (let round = 0; round < 5; round += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }

  assert.deepEqual(apiCalls, [
    "registerObservedVersion",
    "recordViewAndGetStatus",
    "investigateNow",
  ]);
  const status = await tabStates.getStatus(9);
  assert.equal(status?.kind === "POST" && status.investigationState, "INVESTIGATING");
});

test("PAGE_CONTENT caches an API_ERROR status and reports the failure", async () => {
  const { handlers, tabStates } = setup({ view: () => Promise.reject(new Error("API down")) });

  await assert.rejects(
    handlers.PAGE_CONTENT({ tabSessionId: sessionId(1), content: CONTENT }, SENDER),
    /API down/,
  );
  const status = await tabStates.getStatus(9);
  assert.equal(status?.kind === "POST" && status.investigationState, "API_ERROR");
});

test("PAGE_SKIPPED from a superseded session is ignored", async () => {
  const { handlers, tabStates } = setup({});
  await handlers.PAGE_SKIPPED(
    {
      tabSessionId: sessionId(2),
      platform: "LESSWRONG",
      pageUrl: CONTENT.url,
      reason: "has_video",
    },
    SENDER,
  );
  await handlers.PAGE_RESET({ tabSessionId: sessionId(2) }, SENDER);
  await handlers.PAGE_SKIPPED(
    {
      tabSessionId: sessionId(2),
      platform: "LESSWRONG",
      pageUrl: CONTENT.url,
      reason: "has_video",
    },
    SENDER,
  );
  assert.equal(await tabStates.getStatus(9), null);
});

test("page-session messages must come from a tab", async () => {
  const { handlers } = setup({});
  await assert.rejects(
    handlers.PAGE_RESET({ tabSessionId: sessionId(1) }, {}),
    /must come from a tab/,
  );
});
