import browser from "webextension-polyfill";
import { PageSessionController } from "./page-session-controller";
import { handleContentControlMessage } from "./control-message-handler";

declare global {
  interface Window {
    __openerrata_loaded?: boolean;
  }
}

const controller = new PageSessionController();

browser.runtime.onMessage.addListener((message: unknown) => {
  const response = handleContentControlMessage(controller, message);
  if (response === false) return false;

  return response.catch((error: unknown) => {
    console.error("Content script message handler error:", error);
    throw error;
  });
});

function boot(): void {
  if (window.__openerrata_loaded) {
    return;
  }
  window.__openerrata_loaded = true;
  controller.boot();
}

boot();
