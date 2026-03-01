import { ZodError } from "zod";
import { isNonRetryableOpenAiStatusCode, readOpenAiStatusCode } from "$lib/openai/errors.js";
import {
  InvestigatorExecutionError,
  InvestigatorStructuredOutputError,
} from "$lib/investigators/openai.js";
import { ExpiredOpenAiKeySourceError, InvalidOpenAiKeySourceError } from "./user-key-source.js";

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
  const root = unwrapError(error);
  if (typeof root === "string") return null;
  return readOpenAiStatusCode(root);
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
  return status === null ? "unknown object error" : `status=${status}`;
}

export function isNonRetryableProviderError(error: unknown): boolean {
  const root = unwrapError(error);
  if (root instanceof ExpiredOpenAiKeySourceError) return true;
  if (root instanceof InvalidOpenAiKeySourceError) return true;
  if (root instanceof SyntaxError) return true;
  if (root instanceof ZodError) return true;
  if (root instanceof InvestigatorStructuredOutputError) return true;

  const status = getErrorStatus(root);
  return isNonRetryableOpenAiStatusCode(status);
}
