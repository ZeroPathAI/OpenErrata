import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type {
  AdapterExtractionResult,
  AdapterNotReadyReason,
} from "../../src/content/adapters/model.js";

type GlobalWindowScope = typeof globalThis & {
  window?: Window & typeof globalThis;
};

/**
 * Runs a callback with a JSDOM-backed `window` global, then restores the
 * previous `window` value. Use this for adapter extraction tests that read
 * `window.location`, `document`, or browser-specific globals like `window.mw`.
 *
 * @param options.globalSetup - Optional hook to attach extra globals (e.g.
 *   MediaWiki's `window.mw`) before `run` is called. Receives the JSDOM
 *   window object.
 */
export function withWindow<T>(
  url: string,
  html: string,
  run: (document: Document) => T,
  options?: {
    globalSetup?: (domWindow: JSDOM["window"]) => void;
  },
): T {
  const dom = new JSDOM(html, { url });

  if (options?.globalSetup) {
    options.globalSetup(dom.window);
  }

  const scope = globalThis as GlobalWindowScope;
  const hasWindowProperty = Object.prototype.hasOwnProperty.call(scope, "window");
  const previousWindow = scope.window;
  scope.window = dom.window as unknown as Window & typeof globalThis;
  try {
    return run(dom.window.document);
  } finally {
    if (!hasWindowProperty) {
      delete scope.window;
    } else {
      scope.window = previousWindow;
    }
  }
}

export function assertReady(
  result: AdapterExtractionResult,
): Extract<AdapterExtractionResult, { kind: "ready" }> {
  assert.equal(result.kind, "ready");
  return result;
}

export function assertNotReady(
  result: AdapterExtractionResult,
  reason: AdapterNotReadyReason,
): void {
  assert.equal(result.kind, "not_ready");
  assert.equal(result.reason, reason);
}
