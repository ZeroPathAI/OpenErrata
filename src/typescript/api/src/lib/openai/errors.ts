import { APIError } from "openai";

// A guard rather than a bare `instanceof`, which would type the generic
// error's fields as `any`.
function isOpenAiApiError(error: unknown): error is APIError {
  return error instanceof APIError;
}

/** HTTP status of an OpenAI API error response; null for any other error (incl. connection errors). */
export function readOpenAiStatusCode(error: unknown): number | null {
  return isOpenAiApiError(error) ? (error.status ?? null) : null;
}
