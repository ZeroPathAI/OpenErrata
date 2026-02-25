import { contentControlMessageSchema } from "@openerrata/shared";
import { unsupportedProtocolVersionResponse } from "../lib/protocol-version.js";

type ContentControlController = {
  requestInvestigation: () => unknown;
  showAnnotations: () => unknown;
  hideAnnotations: () => unknown;
  getAnnotationVisibility: () => unknown;
  focusClaim: (claimIndex: number) => unknown;
};

export function handleContentControlMessage(
  controller: ContentControlController,
  message: unknown,
): Promise<unknown> | false {
  const protocolError = unsupportedProtocolVersionResponse(message);
  if (protocolError) {
    return Promise.resolve(protocolError);
  }

  const parsedMessage = contentControlMessageSchema.safeParse(message);
  if (!parsedMessage.success) return false;
  const controlMessage = parsedMessage.data;
  const result = (() => {
    switch (controlMessage.type) {
      case "REQUEST_INVESTIGATE":
        return controller.requestInvestigation();
      case "SHOW_ANNOTATIONS":
        return controller.showAnnotations();
      case "HIDE_ANNOTATIONS":
        return controller.hideAnnotations();
      case "GET_ANNOTATION_VISIBILITY":
        return controller.getAnnotationVisibility();
      case "FOCUS_CLAIM":
        return controller.focusClaim(controlMessage.payload.claimIndex);
      default: {
        const unreachable: never = controlMessage;
        return unreachable;
      }
    }
  })();

  return Promise.resolve(result);
}
