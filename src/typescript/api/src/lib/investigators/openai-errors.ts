/**
 * Thrown when the LLM returns structured output that is syntactically valid
 * but semantically invalid for our investigation pipeline. This is a
 * non-retryable error — the model's output cannot be fixed by retrying.
 */
export class InvestigatorStructuredOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvestigatorStructuredOutputError";
  }
}
