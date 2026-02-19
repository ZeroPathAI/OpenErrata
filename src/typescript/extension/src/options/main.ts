import browser from "webextension-polyfill";
import { mount } from "svelte";
import App from "./App.svelte";

function ensureOptionsStylesheet(): void {
  const expectedHref = browser.runtime.getURL("index2.css");
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
    `[options] missing stylesheet link; injected fallback href=${expectedHref}`,
  );
}

ensureOptionsStylesheet();
const optionsRoot = document.getElementById("app");
if (!optionsRoot) {
  throw new Error("Missing #app mount point for options page");
}

const app = mount(App, { target: optionsRoot });

export default app;
