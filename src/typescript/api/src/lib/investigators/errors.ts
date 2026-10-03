import type { InvestigatorFailedAttemptAudit } from "./interface.js";

/**
 * An investigation attempt failed after making provider requests. Carries the
 * attempt's audit so it can be persisted (SPEC §2.12); `cause` is the failure
 * the orchestrator classifies for retry (SPEC §3.7).
 */
export class InvestigatorExecutionError extends Error {
  readonly attemptAudit: InvestigatorFailedAttemptAudit;

  constructor(message: string, attemptAudit: InvestigatorFailedAttemptAudit, cause: unknown) {
    super(message, { cause });
    this.name = "InvestigatorExecutionError";
    this.attemptAudit = attemptAudit;
  }
}

/**
 * The provider returned output that is well-formed but unusable by the
 * pipeline (e.g. unparseable validation verdict, tool-round limit exceeded).
 * Deterministic for a given input, so non-retryable.
 */
export class InvestigatorStructuredOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvestigatorStructuredOutputError";
  }
}

/**
 * A provider response ended with a status other than "completed" (or with no
 * status at all). SPEC §3.7 classes truncated/incomplete output as PARTIAL:
 * the investigation is marked FAILED, not retried.
 */
export class InvestigatorIncompleteResponseError extends Error {
  readonly responseStatus: string | null;
  readonly responseId: string;
  readonly incompleteReason: string | null;

  constructor(input: {
    responseStatus: string | null;
    responseId: string;
    incompleteReason: string | null;
  }) {
    super(
      "OpenAI response did not complete " +
        `(status=${input.responseStatus ?? "missing"}, reason=${input.incompleteReason ?? "none"}, responseId=${input.responseId})`,
    );
    this.name = "InvestigatorIncompleteResponseError";
    this.responseStatus = input.responseStatus;
    this.responseId = input.responseId;
    this.incompleteReason = input.incompleteReason;
  }
}

/**
 * The investigator was called with input that violates its contract (a caller
 * bug, e.g. inconsistent image occurrences). Non-retryable: the same input
 * fails the same way.
 */
export class InvestigatorInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvestigatorInputError";
  }
}
