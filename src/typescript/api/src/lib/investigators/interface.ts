import type { InvestigationClaim, InvestigationResult, Platform } from "@openerrata/shared";

export type InvestigatorJsonValue =
  | string
  | number
  | boolean
  | null
  | InvestigatorJsonValue[]
  | { [key: string]: InvestigatorJsonValue };

export type InvestigatorJsonRecord = Record<string, InvestigatorJsonValue>;

export type InvestigatorImageOccurrence =
  | {
      originalIndex: number;
      normalizedTextOffset: number;
      sourceUrl: string;
      captionText?: string;
      resolution: "resolved";
      imageDataUri: string;
      contentHash: string;
    }
  | {
      originalIndex: number;
      normalizedTextOffset: number;
      sourceUrl: string;
      captionText?: string;
      resolution: "missing" | "omitted";
    };

export type ImagePlaceholder =
  | {
      index: number;
      matchBy: "SOURCE_URL";
      sourceUrl: string;
    }
  | {
      index: number;
      matchBy: "ORIGINAL_INDEX";
    };

interface InvestigatorInputBase {
  contentText: string;
  /** Markdown content for the LLM prompt (sole content representation). */
  contentMarkdown?: string;
  /** Image placeholders embedded in the markdown ([IMAGE:N] patterns). */
  imagePlaceholders?: ImagePlaceholder[];
  platform: Platform;
  url: string;
  authorName?: string;
  postPublishedAt?: string;
  imageOccurrences?: InvestigatorImageOccurrence[];
  hasVideo?: boolean;
  contentDiff?: string;
}

export type InvestigatorInput =
  | (InvestigatorInputBase & {
      isUpdate?: false | undefined;
      oldClaims?: undefined;
    })
  | (InvestigatorInputBase & {
      isUpdate: true;
      oldClaims: InvestigationClaim[];
    });

// ── Attempt audit (SPEC §2.12) ──────────────────────────────────────────────
// Mirrors the persisted tree: InvestigationAttempt → InvestigationAttemptRequest
// (one per provider request) → InvestigationAttemptResponse → output items.
// Every positional index (request order of tools, output index, part index,
// annotation index, summary index) is the element's position in its array.

/** Which provider request of the attempt this was. */
export type InvestigatorRequestSubject =
  | { kind: "FACT_CHECK_ROUND"; round: number }
  | { kind: "CLAIM_VALIDATION"; claimIndex: number };

export interface InvestigatorRequestedToolAudit {
  toolType: string;
  rawDefinition: InvestigatorJsonRecord;
}

export interface InvestigatorOutputTextAnnotationAudit {
  annotationType: string;
  startIndex: number | null;
  endIndex: number | null;
  url: string | null;
  title: string | null;
  fileId: string | null;
}

export interface InvestigatorOutputTextPartAudit {
  partType: "output_text" | "refusal";
  text: string;
  annotations: InvestigatorOutputTextAnnotationAudit[];
}

export type InvestigatorOutputItemContentAudit =
  | { kind: "MESSAGE"; textParts: InvestigatorOutputTextPartAudit[] }
  | { kind: "REASONING"; summaries: string[] }
  | {
      kind: "TOOL_CALL";
      /** Full provider output item, as received. */
      rawPayload: InvestigatorJsonRecord;
    };

export interface InvestigatorOutputItemAudit {
  providerItemId: string | null;
  itemType: string;
  itemStatus: string | null;
  content: InvestigatorOutputItemContentAudit;
}

export interface InvestigatorUsageAudit {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
}

export interface InvestigatorResponseAudit {
  providerResponseId: string;
  /** Provider-reported status; null when the provider omitted it. */
  status: string | null;
  modelVersion: string;
  receivedAt: Date;
  outputItems: InvestigatorOutputItemAudit[];
  usage: InvestigatorUsageAudit | null;
}

export interface InvestigatorRequestAudit {
  subject: InvestigatorRequestSubject;
  model: string;
  instructions: string;
  /**
   * The request's `input` parameter as sent, except that image parts carry
   * `imageContentHash` (the stored ImageBlob's content hash) instead of the
   * inline data URI.
   */
  input: string | InvestigatorJsonRecord[];
  previousResponseId: string | null;
  reasoningEffort: string | null;
  reasoningSummary: string | null;
  include: string[];
  tools: InvestigatorRequestedToolAudit[];
  /** Null when the request failed before the provider returned a response. */
  response: InvestigatorResponseAudit | null;
}

export interface InvestigatorErrorAudit {
  errorName: string;
  errorMessage: string;
  statusCode: number | null;
}

interface InvestigatorAttemptAuditBase {
  startedAt: Date;
  completedAt: Date;
  requests: InvestigatorRequestAudit[];
}

export type InvestigatorSucceededAttemptAudit = InvestigatorAttemptAuditBase & {
  outcome: "SUCCEEDED";
};

export type InvestigatorFailedAttemptAudit = InvestigatorAttemptAuditBase & {
  outcome: "FAILED";
  error: InvestigatorErrorAudit;
};

export type InvestigatorAttemptAudit =
  | InvestigatorSucceededAttemptAudit
  | InvestigatorFailedAttemptAudit;

// ── Investigator contract ───────────────────────────────────────────────────

export interface InvestigationProgressCallbacks {
  onProgressUpdate: (
    pending: InvestigationResult["claims"],
    confirmed: InvestigationResult["claims"],
  ) => void;
}

export interface InvestigateOptions {
  /** Aborts every provider request and tool fetch when the run must stop. */
  signal: AbortSignal;
  callbacks?: InvestigationProgressCallbacks;
}

export interface InvestigatorOutput {
  result: InvestigationResult;
  attemptAudit: InvestigatorSucceededAttemptAudit;
  /** Provider model id the stage-1 fact-check requests were sent to. */
  model: string;
  /** Provider-reported model revision of the final stage-1 fact-check response. */
  modelVersion: string;
}

/**
 * Runs one investigation attempt. Failures reject with
 * `InvestigatorExecutionError` (carrying the failed attempt's audit) once a
 * provider request has been made, or with `InvestigatorInputError` when the
 * input itself violates this contract.
 */
export interface Investigator {
  investigate(input: InvestigatorInput, options: InvestigateOptions): Promise<InvestigatorOutput>;
}

/** Builds an investigator that authenticates to the provider with `apiKey`. */
export type InvestigatorFactory = (apiKey: string) => Investigator;
