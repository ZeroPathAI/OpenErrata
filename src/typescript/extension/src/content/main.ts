import {
  contentControlMessageSchema,
} from "@truesight/shared";
import browser from "webextension-polyfill";
import { PageSessionController } from "./page-session-controller";

declare global {
  interface Window {
    __truesight_loaded?: boolean;
  }
}

const controller = new PageSessionController();

browser.runtime.onMessage.addListener((message: unknown) => {
  const parsedMessage = contentControlMessageSchema.safeParse(message);
  if (!parsedMessage.success) return false;
  const controlMessage = parsedMessage.data;

  const handle = async () => {
    switch (controlMessage.type) {
      case "REQUEST_INVESTIGATE":
        return controller.requestInvestigation();
      case "SHOW_ANNOTATIONS":
        return controller.showAnnotations();
      case "HIDE_ANNOTATIONS":
        return controller.hideAnnotations();
      case "GET_ANNOTATION_VISIBILITY":
        return controller.getAnnotationVisibility();
      default:
        return null;
    }
  };

  return handle().catch((error: unknown) => {
    console.error("Content script message handler error:", error);
    throw error;
  });
});

function boot(): void {
  if (window.__truesight_loaded) {
    return;
  }
  window.__truesight_loaded = true;
  controller.boot();
}

boot();
