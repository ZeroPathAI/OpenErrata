import browser from "webextension-polyfill";
import { mount } from "svelte";
import App from "./App.svelte";

function ensurePopupStylesheet(): void {
  const expectedHref = browser.runtime.getURL("index.css");
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
    `[popup] missing stylesheet link; injected fallback href=${expectedHref}`,
  );
}

ensurePopupStylesheet();
const popupRoot = document.getElementById("app");
if (!popupRoot) {
  throw new Error("Missing #app mount point for popup page");
}

const app = mount(App, { target: popupRoot });

export default app;
