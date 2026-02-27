import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

type PageBootstrapModule = typeof import("../../src/lib/page-bootstrap");

function installChromeRuntime(): void {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      id: "test-extension",
      getURL: (asset: string) => `chrome-extension://test-extension/${asset}`,
    },
  };
}

function installDocument(html: string): () => void {
  const dom = new JSDOM(html, { url: "https://example.com" });
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
  });

  return () => {
    dom.window.close();
    Object.assign(globalThis, {
      window: originalWindow,
      document: originalDocument,
    });
  };
}

async function importPageBootstrapModule(): Promise<PageBootstrapModule> {
  installChromeRuntime();
  return (await import(
    `../../src/lib/page-bootstrap.ts?test=${Date.now().toString()}-${Math.random().toString()}`
  )) as PageBootstrapModule;
}

test("ensurePageStylesheet injects a fallback stylesheet when missing", async () => {
  const restoreDocument = installDocument("<!doctype html><html><head></head><body></body></html>");
  const originalWarn = console.warn;
  const warnCalls: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };

  try {
    const { ensurePageStylesheet } = await importPageBootstrapModule();
    ensurePageStylesheet({
      pageLabel: "options",
      stylesheetAsset: "index.css",
    });

    const stylesheets = Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
    );
    assert.equal(stylesheets.length, 1);
    assert.equal(stylesheets[0]?.href, "chrome-extension://test-extension/index.css");
    assert.equal(warnCalls.length, 1);
  } finally {
    console.warn = originalWarn;
    restoreDocument();
  }
});

test("ensurePageStylesheet is a no-op when expected stylesheet already exists", async () => {
  const restoreDocument = installDocument(
    '<!doctype html><html><head><link rel="stylesheet" href="chrome-extension://test-extension/index.css"></head><body></body></html>',
  );
  const originalWarn = console.warn;
  const warnCalls: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };

  try {
    const { ensurePageStylesheet } = await importPageBootstrapModule();
    ensurePageStylesheet({
      pageLabel: "options",
      stylesheetAsset: "index.css",
    });

    const stylesheets = Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
    );
    assert.equal(stylesheets.length, 1);
    assert.equal(warnCalls.length, 0);
  } finally {
    console.warn = originalWarn;
    restoreDocument();
  }
});

test("requireMountTarget returns configured mount element and throws when missing", async () => {
  const restoreDocument = installDocument(
    '<!doctype html><html><head></head><body><div id="app"></div><div id="custom-root"></div></body></html>',
  );

  try {
    const { requireMountTarget } = await importPageBootstrapModule();
    assert.equal(requireMountTarget({ pageLabel: "popup" }).id, "app");
    assert.equal(
      requireMountTarget({ pageLabel: "options", mountId: "custom-root" }).id,
      "custom-root",
    );
    assert.throws(
      () => requireMountTarget({ pageLabel: "options", mountId: "missing" }),
      /Missing #missing mount point for options page/,
    );
  } finally {
    restoreDocument();
  }
});
