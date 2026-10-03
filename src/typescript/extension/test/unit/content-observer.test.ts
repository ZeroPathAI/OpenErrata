import assert from "node:assert/strict";
import { test } from "node:test";
import { PageObserver } from "../../src/content/observer";
import { installDom, withDom } from "../helpers/dom";

async function waitMs(durationMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(() => resolve(), durationMs);
  });
}

test("PageObserver reports back/forward navigation until stopped", () => {
  withDom("<div id='root'></div>", () => {
    let popStates = 0;
    const observer = new PageObserver({
      mutationDebounceMs: 5,
      onPopState: () => {
        popStates += 1;
      },
      onMutationSettled: () => undefined,
    });

    observer.start();
    observer.start();
    window.dispatchEvent(new window.PopStateEvent("popstate"));
    assert.equal(popStates, 1);

    observer.stop();
    window.dispatchEvent(new window.PopStateEvent("popstate"));
    assert.equal(popStates, 1);
  });
});

test("PageObserver debounces mutation events and stops observing when stopped", async () => {
  const { document, restore } = installDom("<div id='root'></div>");
  try {
    const settled: string[] = [];
    const observer = new PageObserver({
      mutationDebounceMs: 10,
      onPopState: () => undefined,
      onMutationSettled: () => {
        settled.push("settled");
      },
    });
    observer.start();

    document.body.appendChild(document.createElement("div"));
    document.body.appendChild(document.createElement("span"));
    await waitMs(25);
    assert.equal(settled.length, 1);

    document.body.appendChild(document.createElement("p"));
    await waitMs(25);
    assert.equal(settled.length, 2);

    observer.stop();
    document.body.appendChild(document.createElement("section"));
    await waitMs(25);
    assert.equal(settled.length, 2);
  } finally {
    restore();
  }
});
