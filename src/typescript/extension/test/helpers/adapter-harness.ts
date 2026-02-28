import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

type AdapterExtractionResult =
  import("../../src/content/adapters/model.js").AdapterExtractionResult;
type AdapterNotReadyReason = import("../../src/content/adapters/model.js").AdapterNotReadyReason;

type GlobalWindowScope = Omit<
  typeof globalThis,
  "window" | "document" | "Document" | "Element" | "Node" | "NodeFilter"
> & {
  window?: unknown;
  document?: unknown;
  Document?: unknown;
  Element?: unknown;
  Node?: unknown;
  NodeFilter?: unknown;
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

  const hadWindowProperty = Object.prototype.hasOwnProperty.call(scope, "window");
  const hadDocumentProperty = Object.prototype.hasOwnProperty.call(scope, "document");
  const hadDocumentCtorProperty = Object.prototype.hasOwnProperty.call(scope, "Document");
  const hadElementCtorProperty = Object.prototype.hasOwnProperty.call(scope, "Element");
  const hadNodeCtorProperty = Object.prototype.hasOwnProperty.call(scope, "Node");
  const hadNodeFilterCtorProperty = Object.prototype.hasOwnProperty.call(scope, "NodeFilter");

  const previousWindow = scope.window;
  const previousDocument = scope.document;
  const previousDocumentCtor = scope.Document;
  const previousElementCtor = scope.Element;
  const previousNodeCtor = scope.Node;
  const previousNodeFilterCtor = scope.NodeFilter;

  scope.window = dom.window;
  scope.document = dom.window.document;
  scope.Document = dom.window.Document;
  scope.Element = dom.window.Element;
  scope.Node = dom.window.Node;
  scope.NodeFilter = dom.window.NodeFilter;

  try {
    return run(dom.window.document);
  } finally {
    if (!hadWindowProperty) {
      delete scope.window;
    } else {
      scope.window = previousWindow;
    }

    if (!hadDocumentProperty) {
      delete scope.document;
    } else {
      scope.document = previousDocument;
    }

    if (!hadDocumentCtorProperty) {
      delete scope.Document;
    } else {
      scope.Document = previousDocumentCtor;
    }

    if (!hadElementCtorProperty) {
      delete scope.Element;
    } else {
      scope.Element = previousElementCtor;
    }

    if (!hadNodeCtorProperty) {
      delete scope.Node;
    } else {
      scope.Node = previousNodeCtor;
    }

    if (!hadNodeFilterCtorProperty) {
      delete scope.NodeFilter;
    } else {
      scope.NodeFilter = previousNodeFilterCtor;
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
