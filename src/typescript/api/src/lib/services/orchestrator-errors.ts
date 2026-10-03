import { ZodError } from "zod";
import { readOpenAiStatusCode } from "$lib/openai/errors.js";
import {
  InvestigatorExecutionError,
  InvestigatorIncompleteResponseError,
  InvestigatorInputError,
  InvestigatorStructuredOutputError,
} from "$lib/investigators/errors.js";
import { ExpiredOpenAiKeySourceError, InvalidOpenAiKeySourceError } from "./user-key-source.js";

// Provider statuses that a retry of the same request cannot fix (SPEC §3.7):
// malformed request, auth, missing model/resource, unprocessable input.
const NON_RETRYABLE_OPENAI_STATUS_CODES = new Set([400, 401, 403, 404, 422]);

type UnwrappedError = Error | Record<string, unknown> | string;

export function unwrapError(error: unknown): UnwrappedError {
  const root = error instanceof InvestigatorExecutionError ? (error.cause ?? error) : error;
  if (root instanceof Error) return root;
  if (root !== null && typeof root === "object" && !Array.isArray(root)) {
    // After Error check, a non-null non-array object satisfies Record<string, unknown>.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by typeof+null guards above
    return root as Record<string, unknown>;
  }
  return String(root);
}

export function getErrorStatus(error: unknown): number | null {
  return readOpenAiStatusCode(unwrapError(error));
}

export function formatErrorForLog(error: unknown): string {
  const root = unwrapError(error);
  const status = getErrorStatus(root);
  if (root instanceof Error) {
    return status === null ? root.message : `status=${status}: ${root.message}`;
  }
  if (typeof root === "string") {
    return root;
  }
  return "unknown object error";
}

/**
 * NON_RETRYABLE and PARTIAL failures of SPEC §3.7: the investigation is marked
 * FAILED immediately. Everything else is TRANSIENT and retried with backoff.
 */
export function isNonRetryableProviderError(error: unknown): boolean {
  const root = unwrapError(error);
  if (root instanceof ExpiredOpenAiKeySourceError) return true;
  if (root instanceof InvalidOpenAiKeySourceError) return true;
  if (root instanceof SyntaxError) return true;
  if (root instanceof ZodError) return true;
  if (root instanceof InvestigatorStructuredOutputError) return true;
  if (root instanceof InvestigatorIncompleteResponseError) return true;
  if (root instanceof InvestigatorInputError) return true;

  const status = getErrorStatus(root);
  return status !== null && NON_RETRYABLE_OPENAI_STATUS_CODES.has(status);
}
