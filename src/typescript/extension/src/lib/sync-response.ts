import {
  extensionRuntimeErrorResponseSchema,
  investigateNowOutputSchema,
  viewPostOutputSchema,
  type InvestigateNowOutput,
  type ViewPostOutput,
} from "@openerrata/shared";
import { ExtensionRuntimeError } from "./runtime-error.js";

export function throwIfRuntimeError(response: unknown): void {
  const parsedError = extensionRuntimeErrorResponseSchema.safeParse(response);
  if (!parsedError.success) return;
  throw new ExtensionRuntimeError(parsedError.data.error, parsedError.data.errorCode);
}

function parseValidatedResponse<T>(input: {
  operation: string;
  response: unknown;
  parse: (
    value: unknown,
  ) => { success: true; data: T } | { success: false; error: { message: string } };
}): T {
  throwIfRuntimeError(input.response);
  const parsed = input.parse(input.response);
  if (parsed.success) {
    return parsed.data;
  }

  throw new ExtensionRuntimeError(
    `Malformed ${input.operation} response from background: ${parsed.error.message}`,
    "INVALID_EXTENSION_MESSAGE",
  );
}

export function parseViewPostResponse(response: unknown): ViewPostOutput {
  return parseValidatedResponse({
    operation: "PAGE_CONTENT",
    response,
    parse: (value) => viewPostOutputSchema.safeParse(value),
  });
}

export function parseInvestigateNowResponse(response: unknown): InvestigateNowOutput {
  return parseValidatedResponse({
    operation: "INVESTIGATE_NOW",
    response,
    parse: (value) => investigateNowOutputSchema.safeParse(value),
  });
}
