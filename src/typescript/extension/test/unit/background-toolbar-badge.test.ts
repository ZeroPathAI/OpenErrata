import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionPostStatus,
  InvestigationClaim,
  InvestigationClaimPayload,
} from "@openerrata/shared";

type ToolbarBadgeModule = typeof import("../../src/background/toolbar-badge");

interface ActionCallLog {
  setIcon: unknown[];
  setBadgeText: unknown[];
  setBadgeBackgroundColor: unknown[];
  setTitle: unknown[];
}

const toolbarActionState: ActionCallLog = {
  setIcon: [],
  setBadgeText: [],
  setBadgeBackgroundColor: [],
  setTitle: [],
};

function makeClaimPayload(index: number): InvestigationClaimPayload {
  return {
    text: `Claim ${index.toString()}`,
    context: "Context",
    summary: "Summary",
    reasoning: "Reasoning",
    sources: [
      {
        url: "https://example.com",
        title: "Example Source",
        snippet: "Snippet",
      },
    ],
  };
}

function createPostStatus(
  state: "NOT_INVESTIGATED" | "INVESTIGATING" | "FAILED" | "INVESTIGATED" | "API_ERROR",
  options: {
    claimCount?: number;
    pendingClaimCount?: number;
    confirmedClaimCount?: number;
  } = {},
): ExtensionPostStatus {
  const sessionId = 1 as ExtensionPostStatus["tabSessionId"];

  const externalId = "123" as ExtensionPostStatus["externalId"];

  const claimId = (value: string): InvestigationClaim["id"] => value as InvestigationClaim["id"];

  const base = {
    kind: "POST",
    tabSessionId: sessionId,
    platform: "X",
    externalId,
    pageUrl: "https://x.com/example/status/123",
  } as const;

  if (state === "NOT_INVESTIGATED") {
    const status: ExtensionPostStatus = {
      ...base,
      investigationState: "NOT_INVESTIGATED",
      priorInvestigationResult: null,
    };
    return status;
  }

  if (state === "INVESTIGATING") {
    const pendingClaims = Array.from({ length: options.pendingClaimCount ?? 0 }, (_value, index) =>
      makeClaimPayload(index),
    );
    const confirmedClaims = Array.from(
      { length: options.confirmedClaimCount ?? 0 },
      (_value, index) => makeClaimPayload(index + (options.pendingClaimCount ?? 0)),
    );
    const status: ExtensionPostStatus = {
      ...base,
      investigationState: "INVESTIGATING",
      status: "PENDING",
      provenance: "SERVER_VERIFIED",
      pendingClaims,
      confirmedClaims,
      priorInvestigationResult: null,
    };
    return status;
  }

  if (state === "FAILED") {
    const status: ExtensionPostStatus = {
      ...base,
      investigationState: "FAILED",
      provenance: "SERVER_VERIFIED",
    };
    return status;
  }

  if (state === "API_ERROR") {
    const status: ExtensionPostStatus = {
      ...base,
      investigationState: "API_ERROR",
    };
    return status;
  }

  const claims = Array.from({ length: options.claimCount ?? 0 }, (_value, index) => {
    const claim: InvestigationClaim = {
      id: claimId(`claim-${index.toString()}`),
      ...makeClaimPayload(index),
    };
    return claim;
  });

  const status: ExtensionPostStatus = {
    ...base,
    investigationState: "INVESTIGATED",
    provenance: "SERVER_VERIFIED",
    claims,
  };
  return status;
}

const toolbarChromeMock = {
  runtime: {
    id: "test-extension",
    getURL: (asset: string) => `chrome-extension://test-extension/${asset}`,
  },
  action: {
    setIcon: (details: unknown, callback?: () => void) => {
      toolbarActionState.setIcon.push(details);
      if (typeof callback === "function") {
        callback();
        return;
      }
      return Promise.resolve();
    },
    setBadgeText: (details: unknown, callback?: () => void) => {
      toolbarActionState.setBadgeText.push(details);
      if (typeof callback === "function") {
        callback();
        return;
      }
      return Promise.resolve();
    },
    setBadgeBackgroundColor: (details: unknown, callback?: () => void) => {
      toolbarActionState.setBadgeBackgroundColor.push(details);
      if (typeof callback === "function") {
        callback();
        return;
      }
      return Promise.resolve();
    },
    setTitle: (details: unknown, callback?: () => void) => {
      toolbarActionState.setTitle.push(details);
      if (typeof callback === "function") {
        callback();
        return;
      }
      return Promise.resolve();
    },
  },
};

(globalThis as { chrome?: unknown }).chrome = toolbarChromeMock;

function installChromeActionMock(): ActionCallLog {
  toolbarActionState.setIcon.length = 0;
  toolbarActionState.setBadgeText.length = 0;
  toolbarActionState.setBadgeBackgroundColor.length = 0;
  toolbarActionState.setTitle.length = 0;
  return toolbarActionState;
}

function installIntervalMocks() {
  const intervalCallbacks = new Map<number, () => void>();
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let nextTimerId = 1;

  globalThis.setInterval = ((handler: TimerHandler) => {
    const callback = handler as () => void;
    const timerId = nextTimerId;
    nextTimerId += 1;
    intervalCallbacks.set(timerId, callback);

    return timerId as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;

  globalThis.clearInterval = ((timerId: ReturnType<typeof setInterval>) => {
    if (typeof timerId === "number") {
      intervalCallbacks.delete(timerId);
    }
  }) as unknown as typeof clearInterval;

  return {
    intervalCallbacks,
    restore: () => {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    },
  };
}

async function flushAsyncQueue(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(() => resolve());
  });
  await Promise.resolve();
}

async function importToolbarBadgeModule(): Promise<ToolbarBadgeModule> {
  return (await import(
    `../../src/background/toolbar-badge.ts?test=${Date.now().toString()}-${Math.random().toString()}`
  )) as ToolbarBadgeModule;
}

function requireSetIconCall(call: unknown): { tabId: number; path: Record<string, string> } {
  assert.equal(typeof call, "object");
  assert.notEqual(call, null);

  const maybeCall = call as { tabId?: unknown; path?: unknown };
  const tabId = maybeCall.tabId;
  assert.equal(typeof tabId, "number");
  if (typeof tabId !== "number") {
    throw new Error(`Expected tabId to be a number, received ${typeof tabId}`);
  }
  assert.equal(typeof maybeCall.path, "object");
  assert.notEqual(maybeCall.path, null);
  const path = maybeCall.path;
  if (typeof path !== "object" || path === null) {
    throw new Error("Expected path to be a non-null object");
  }

  return {
    tabId,

    path: path as Record<string, string>,
  };
}

function assertIconPathMatches(path: string | undefined, pattern: RegExp): void {
  assert.equal(typeof path, "string");
  if (typeof path !== "string") {
    throw new Error("Expected icon path string");
  }
  assert.match(path, pattern);
}

function requireSetBadgeColorCall(call: unknown): { tabId: number; color: string } {
  assert.equal(typeof call, "object");
  assert.notEqual(call, null);

  const maybeCall = call as { tabId?: unknown; color?: unknown };
  const tabId = maybeCall.tabId;
  const color = maybeCall.color;
  assert.equal(typeof tabId, "number");
  assert.equal(typeof color, "string");
  if (typeof tabId !== "number") {
    throw new Error(`Expected tabId to be a number, received ${typeof tabId}`);
  }
  if (typeof color !== "string") {
    throw new Error(`Expected color to be a string, received ${typeof color}`);
  }

  return {
    tabId,
    color,
  };
}

test("updateToolbarBadge animates investigating state and clears badge when investigation stops", async () => {
  const calls = installChromeActionMock();
  const intervals = installIntervalMocks();

  try {
    const { updateToolbarBadge } = await importToolbarBadgeModule();
    updateToolbarBadge(10, createPostStatus("INVESTIGATING"));
    await flushAsyncQueue();

    const firstIconCall = requireSetIconCall(calls.setIcon[0]);
    assert.equal(firstIconCall.tabId, 10);
    assertIconPathMatches(firstIconCall.path["16"], /icons\/frame-\d+-16\.png$/);
    assertIconPathMatches(firstIconCall.path["48"], /icons\/frame-\d+-48\.png$/);

    const firstBadgeColorCall = requireSetBadgeColorCall(calls.setBadgeBackgroundColor[0]);
    assert.equal(firstBadgeColorCall.tabId, 10);
    assert.equal(firstBadgeColorCall.color.length > 0, true);

    assert.deepEqual(calls.setBadgeText[0], {
      tabId: 10,
      text: "…",
    });

    assert.equal(intervals.intervalCallbacks.size, 1);
    const [animationCallback] = intervals.intervalCallbacks.values();
    animationCallback?.();
    await flushAsyncQueue();
    const animatedIconCall = requireSetIconCall(calls.setIcon[1]);
    assert.equal(animatedIconCall.tabId, 10);
    assertIconPathMatches(animatedIconCall.path["16"], /icons\/frame-\d+-16\.png$/);
    assertIconPathMatches(animatedIconCall.path["48"], /icons\/frame-\d+-48\.png$/);
    assert.notEqual(animatedIconCall.path["16"], firstIconCall.path["16"]);

    updateToolbarBadge(10, createPostStatus("NOT_INVESTIGATED"));
    await flushAsyncQueue();
    const staticIconCall = requireSetIconCall(calls.setIcon[2]);
    assert.equal(staticIconCall.tabId, 10);
    assertIconPathMatches(staticIconCall.path["16"], /icons\/icon-\d+\.png$/);
    assertIconPathMatches(staticIconCall.path["48"], /icons\/icon-\d+\.png$/);
    assertIconPathMatches(staticIconCall.path["128"], /icons\/icon-\d+\.png$/);
    assert.deepEqual(calls.setBadgeText[1], {
      tabId: 10,
      text: "",
    });
    assert.equal(intervals.intervalCallbacks.size, 0);
  } finally {
    intervals.restore();
  }
});

test("updateToolbarBadge renders count/success/failure badge states", async () => {
  const calls = installChromeActionMock();
  const intervals = installIntervalMocks();

  try {
    const { updateToolbarBadge } = await importToolbarBadgeModule();

    updateToolbarBadge(20, createPostStatus("INVESTIGATED", { claimCount: 3 }));
    await flushAsyncQueue();
    updateToolbarBadge(21, createPostStatus("INVESTIGATED", { claimCount: 0 }));
    await flushAsyncQueue();
    updateToolbarBadge(22, createPostStatus("FAILED"));
    await flushAsyncQueue();
    const colors = calls.setBadgeBackgroundColor.map((call) => requireSetBadgeColorCall(call));
    assert.deepEqual(
      colors.map((entry) => entry.tabId),
      [20, 21, 22],
    );
    assert.equal(
      colors.every((entry) => entry.color.length > 0),
      true,
    );
    const firstColor = colors[0];
    const secondColor = colors[1];
    const thirdColor = colors[2];
    assert.ok(firstColor);
    assert.ok(secondColor);
    assert.ok(thirdColor);
    assert.equal(firstColor.color, thirdColor.color);
    assert.notEqual(firstColor.color, secondColor.color);

    assert.deepEqual(calls.setBadgeText, [
      { tabId: 20, text: "3" },
      { tabId: 21, text: "✓" },
      { tabId: 22, text: "!" },
    ]);
  } finally {
    intervals.restore();
  }
});

test("updateToolbarBadge renders API_ERROR with same badge as FAILED", async () => {
  const calls = installChromeActionMock();
  const intervals = installIntervalMocks();

  try {
    const { updateToolbarBadge } = await importToolbarBadgeModule();

    updateToolbarBadge(30, createPostStatus("FAILED"));
    await flushAsyncQueue();
    updateToolbarBadge(31, createPostStatus("API_ERROR"));
    await flushAsyncQueue();

    const colors = calls.setBadgeBackgroundColor.map((call) => requireSetBadgeColorCall(call));
    assert.equal(colors.length, 2);
    const failedColor = colors[0];
    const apiErrorColor = colors[1];
    assert.ok(failedColor);
    assert.ok(apiErrorColor);
    assert.equal(failedColor.color, apiErrorColor.color);

    assert.deepEqual(calls.setBadgeText, [
      { tabId: 30, text: "!" },
      { tabId: 31, text: "!" },
    ]);
  } finally {
    intervals.restore();
  }
});

test("upgrade-required state overrides badge and title until cleared", async () => {
  const calls = installChromeActionMock();
  const intervals = installIntervalMocks();

  try {
    const { setUpgradeRequiredState } =
      await import("../../src/background/upgrade-required-state.js");
    const { updateToolbarBadge } = await importToolbarBadgeModule();
    setUpgradeRequiredState({
      active: true,
      message: "Extension upgrade required (minimum 0.2.0).",
      apiBaseUrl: "https://api.openerrata.com",
    });

    updateToolbarBadge(30, createPostStatus("INVESTIGATED", { claimCount: 2 }));
    await flushAsyncQueue();

    assert.deepEqual(calls.setBadgeText[0], { tabId: 30, text: "!" });
    const colorCall = requireSetBadgeColorCall(calls.setBadgeBackgroundColor[0]);
    assert.equal(colorCall.color, "#dc2626");
    assert.deepEqual(calls.setTitle[0], {
      tabId: 30,
      title: "Extension upgrade required (minimum 0.2.0).",
    });

    setUpgradeRequiredState({ active: false });
    updateToolbarBadge(30, createPostStatus("INVESTIGATED", { claimCount: 2 }));
    await flushAsyncQueue();

    assert.deepEqual(calls.setBadgeText[1], { tabId: 30, text: "2" });
    assert.deepEqual(calls.setTitle[1], {
      tabId: 30,
      title: "OpenErrata",
    });
  } finally {
    intervals.restore();
  }
});

test("updateToolbarBadge shows claim count in amber when INVESTIGATING has claims", async () => {
  const calls = installChromeActionMock();
  const intervals = installIntervalMocks();

  try {
    const { updateToolbarBadge } = await importToolbarBadgeModule();

    // INVESTIGATING with 2 pending + 1 confirmed = 3 total claims
    updateToolbarBadge(
      40,
      createPostStatus("INVESTIGATING", { pendingClaimCount: 2, confirmedClaimCount: 1 }),
    );
    await flushAsyncQueue();

    assert.deepEqual(calls.setBadgeText[0], { tabId: 40, text: "3" });
    const colorCall = requireSetBadgeColorCall(calls.setBadgeBackgroundColor[0]);
    assert.equal(colorCall.color, "#f59e0b", "in-progress claims should use amber badge color");
  } finally {
    intervals.restore();
  }
});

test("updateToolbarBadge shows ellipsis when INVESTIGATING has no claims", async () => {
  const calls = installChromeActionMock();
  const intervals = installIntervalMocks();

  try {
    const { updateToolbarBadge } = await importToolbarBadgeModule();

    // INVESTIGATING with 0 claims — should show "…" in blue (existing behavior)
    updateToolbarBadge(41, createPostStatus("INVESTIGATING"));
    await flushAsyncQueue();

    assert.deepEqual(calls.setBadgeText[0], { tabId: 41, text: "…" });
    const colorCall = requireSetBadgeColorCall(calls.setBadgeBackgroundColor[0]);
    assert.equal(colorCall.color, "#3b82f6", "no-claims investigating should use blue badge color");
  } finally {
    intervals.restore();
  }
});
