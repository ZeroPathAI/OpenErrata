import browser from "webextension-polyfill";

type PageIdentity = {
  pageLabel: string;
};

type StylesheetBootstrapOptions = PageIdentity & {
  stylesheetAsset: string;
};

type MountBootstrapOptions = PageIdentity & {
  mountId?: string;
};

export function ensurePageStylesheet(options: StylesheetBootstrapOptions): void {
  const expectedHref = browser.runtime.getURL(options.stylesheetAsset);
  const stylesheetLinks = Array.from(
    document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
  );
  const hasExpectedStylesheet = stylesheetLinks.some(
    (link) => link.href === expectedHref,
  );
  if (hasExpectedStylesheet) return;

  const fallbackLink = document.createElement("link");
  fallbackLink.rel = "stylesheet";
  fallbackLink.href = expectedHref;
  document.head.appendChild(fallbackLink);

  console.warn(
    `[${options.pageLabel}] missing stylesheet link; injected fallback href=${expectedHref}`,
  );
}

export function requireMountTarget(options: MountBootstrapOptions): HTMLElement {
  const mountId = options.mountId ?? "app";
  const target = document.getElementById(mountId);
  if (!target) {
    throw new Error(`Missing #${mountId} mount point for ${options.pageLabel} page`);
  }
  return target;
}
