import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { PageObserver } from "../../src/content/observer";

function installDom(): () => void {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://example.com",
  });
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalHistory = globalThis.history;
  const originalMutationObserver = globalThis.MutationObserver;

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    history: dom.window.history,
    MutationObserver: dom.window.MutationObserver,
  });

  return () => {
    dom.window.close();
    Object.assign(globalThis, {
      window: originalWindow,
      document: originalDocument,
      history: originalHistory,
      MutationObserver: originalMutationObserver,
    });
  };
}

async function waitMs(durationMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), durationMs);
  });
}

test("PageObserver wires navigation listeners once and restores them on stop", async () => {
  const restoreDom = installDom();
  const navigationCalls: string[] = [];

  try {
    const observer = new PageObserver({
      mutationDebounceMs: 5,
      onNavigation: () => {
        navigationCalls.push("navigation");
      },
      onMutationSettled: () => {},
    });

    observer.start();
    observer.start();

    history.pushState({}, "", "/push");
    history.replaceState({}, "", "/replace");
    window.dispatchEvent(new window.PopStateEvent("popstate"));

    assert.equal(navigationCalls.length, 3);

    observer.stop();
    history.pushState({}, "", "/after-stop");
    history.replaceState({}, "", "/after-stop-replace");
    window.dispatchEvent(new window.PopStateEvent("popstate"));
    assert.equal(navigationCalls.length, 3);

    observer.stop();
  } finally {
    restoreDom();
  }
});

test("PageObserver debounces mutation events and stops observing when stopped", async () => {
  const restoreDom = installDom();
  const mutationSettledCalls: string[] = [];

  try {
    const observer = new PageObserver({
      mutationDebounceMs: 10,
      onNavigation: () => {},
      onMutationSettled: () => {
        mutationSettledCalls.push("settled");
      },
    });
    observer.start();

    document.body.appendChild(document.createElement("div"));
    document.body.appendChild(document.createElement("span"));
    await waitMs(25);
    assert.equal(mutationSettledCalls.length, 1);

    document.body.appendChild(document.createElement("p"));
    await waitMs(25);
    assert.equal(mutationSettledCalls.length, 2);

    observer.stop();
    document.body.appendChild(document.createElement("section"));
    await waitMs(25);
    assert.equal(mutationSettledCalls.length, 2);
  } finally {
    restoreDom();
  }
});
