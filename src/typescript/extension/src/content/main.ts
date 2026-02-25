import browser from "webextension-polyfill";
import { PageSessionController } from "./page-session-controller";
import { bootOpenErrataController } from "./bootstrap";
import { handleContentControlMessage } from "./control-message-handler";
import { isExtensionContextInvalidatedError } from "../lib/runtime-error";

type RuntimeMessageListener = Parameters<typeof browser.runtime.onMessage.addListener>[0];

declare global {
  interface Window {
    __openerrata_loaded?: boolean;
    __openerrata_controller?: PageSessionController;
    __openerrata_messageListener?: RuntimeMessageListener;
  }
}

const controller: PageSessionController = bootOpenErrataController(
  window,
  () => new PageSessionController(),
);

if (window.__openerrata_messageListener) {
  browser.runtime.onMessage.removeListener(window.__openerrata_messageListener);
}

const messageListener: RuntimeMessageListener = (message: unknown) => {
  const response = handleContentControlMessage(controller, message);
  if (response === false) return false;

  return response.catch((error: unknown) => {
    if (isExtensionContextInvalidatedError(error)) {
      return undefined;
    }
    console.error("Content script message handler error:", error);
    throw error;
  });
};

window.__openerrata_messageListener = messageListener;
browser.runtime.onMessage.addListener(messageListener);
