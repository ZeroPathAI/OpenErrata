import { JSDOM } from "jsdom";

const DOM_GLOBALS = [
  "window",
  "document",
  "Node",
  "Text",
  "Element",
  "HTMLElement",
  "NodeFilter",
  "MutationObserver",
  "Range",
] as const;

function isRenderedInJsdom(domWindow: JSDOM["window"], element: Element): boolean {
  for (let current: Element | null = element; current !== null; current = current.parentElement) {
    if (current.hasAttribute("hidden")) return false;
    const style = domWindow.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

/**
 * jsdom has no layout and no `Element.checkVisibility`; approximate it from
 * computed styles so adapter code runs unchanged under test.
 */
export function installCheckVisibility(domWindow: JSDOM["window"]): void {
  Object.defineProperty(domWindow.Element.prototype, "checkVisibility", {
    configurable: true,
    value(this: Element): boolean {
      return isRenderedInJsdom(domWindow, this);
    },
  });
}

/** Install a JSDOM document as the DOM globals until `restore` is called. */
export function installDom(
  html: string,
  url = "https://example.com/",
): { document: Document; restore: () => void } {
  const dom = new JSDOM(html, { url });
  installCheckVisibility(dom.window);
  const scope = globalThis as Record<string, unknown>;
  const windowScope = dom.window as unknown as Record<string, unknown>;
  const previous = new Map<string, { had: boolean; value: unknown }>();
  for (const name of DOM_GLOBALS) {
    previous.set(name, { had: Object.hasOwn(scope, name), value: scope[name] });
    scope[name] =
      name === "window"
        ? dom.window
        : name === "document"
          ? dom.window.document
          : windowScope[name];
  }
  return {
    document: dom.window.document,
    restore: () => {
      for (const [name, saved] of previous) {
        if (saved.had) scope[name] = saved.value;
        else Reflect.deleteProperty(scope, name);
      }
      dom.window.close();
    },
  };
}

/** Run `run` with a JSDOM document installed as the DOM globals, then restore them. */
export function withDom<T>(
  html: string,
  run: (document: Document) => T,
  url = "https://example.com/",
): T {
  const installed = installDom(html, url);
  try {
    return run(installed.document);
  } finally {
    installed.restore();
  }
}

export function requireElement(document: Document, selector: string): Element {
  const element = document.querySelector(selector);
  if (element === null) throw new Error(`Missing ${selector} in test fixture`);
  return element;
}
