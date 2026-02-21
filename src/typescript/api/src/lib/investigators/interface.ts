import { z } from "zod";
import type {
  InvestigationModel,
  InvestigationProvider,
  InvestigationResult,
  Platform,
} from "@openerrata/shared";

const isoDateTimeSchema = z.string().datetime();

export type InvestigatorJsonValue =
  | string
  | number
  | boolean
  | null
  | InvestigatorJsonValue[]
  | { [key: string]: InvestigatorJsonValue };

const investigatorJsonValueSchema: z.ZodType<InvestigatorJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(investigatorJsonValueSchema),
    z.record(z.string(), investigatorJsonValueSchema),
  ]),
);
const investigatorJsonRecordSchema: z.ZodType<
  Record<string, InvestigatorJsonValue>
> = z.record(z.string(), investigatorJsonValueSchema);

export interface InvestigatorInput {
  contentText: string;
  platform: Platform;
  url: string;
  authorName?: string;
  postPublishedAt?: string;
  imageUrls?: string[];
  hasVideo?: boolean;
}

export const investigatorRequestedToolAuditSchema = z.object({
  requestOrder: z.number().int().nonnegative(),
  toolType: z.string().min(1),
  rawDefinition: investigatorJsonRecordSchema,
});

export const investigatorOutputItemAuditSchema = z.object({
  outputIndex: z.number().int().nonnegative(),
  providerItemId: z.string().nullable(),
  itemType: z.string().min(1),
  itemStatus: z.string().nullable(),
});

export const investigatorOutputTextPartAuditSchema = z.object({
  outputIndex: z.number().int().nonnegative(),
  partIndex: z.number().int().nonnegative(),
  partType: z.string().min(1),
  text: z.string(),
});

export const investigatorOutputTextAnnotationAuditSchema = z.object({
  outputIndex: z.number().int().nonnegative(),
  partIndex: z.number().int().nonnegative(),
  annotationIndex: z.number().int().nonnegative(),
  annotationType: z.string().min(1),
  startIndex: z.number().int().nullable(),
  endIndex: z.number().int().nullable(),
  url: z.string().nullable(),
  title: z.string().nullable(),
  fileId: z.string().nullable(),
});

export const investigatorReasoningSummaryAuditSchema = z.object({
  outputIndex: z.number().int().nonnegative(),
  summaryIndex: z.number().int().nonnegative(),
  text: z.string(),
});

export const investigatorToolCallAuditSchema = z.object({
  outputIndex: z.number().int().nonnegative(),
  providerToolCallId: z.string().nullable(),
  toolType: z.string().min(1),
  status: z.string().nullable(),
  rawPayload: investigatorJsonRecordSchema,
  capturedAt: isoDateTimeSchema,
  providerStartedAt: isoDateTimeSchema.nullable(),
  providerCompletedAt: isoDateTimeSchema.nullable(),
});

export const investigatorUsageAuditSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  reasoningOutputTokens: z.number().int().nonnegative().nullable(),
});

export const investigatorResponseAuditSchema = z.object({
  responseId: z.string().nullable(),
  responseStatus: z.string().nullable(),
  responseModelVersion: z.string().nullable(),
  responseOutputText: z.string().nullable(),
  outputItems: z.array(investigatorOutputItemAuditSchema),
  outputTextParts: z.array(investigatorOutputTextPartAuditSchema),
  outputTextAnnotations: z.array(investigatorOutputTextAnnotationAuditSchema),
  reasoningSummaries: z.array(investigatorReasoningSummaryAuditSchema),
  toolCalls: z.array(investigatorToolCallAuditSchema),
  usage: investigatorUsageAuditSchema.nullable(),
});

export const investigatorErrorAuditSchema = z.object({
  errorName: z.string().min(1),
  errorMessage: z.string(),
  statusCode: z.number().int().nullable(),
});

export const investigatorAttemptAuditSchema = z.object({
  startedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
  requestModel: z.string().min(1),
  requestInstructions: z.string(),
  requestInput: z.string(),
  requestReasoningEffort: z.string().nullable(),
  requestReasoningSummary: z.string().nullable(),
  requestedTools: z.array(investigatorRequestedToolAuditSchema),
  response: investigatorResponseAuditSchema.nullable(),
  error: investigatorErrorAuditSchema.nullable(),
});

export type InvestigatorRequestedToolAudit = z.infer<
  typeof investigatorRequestedToolAuditSchema
>;
export type InvestigatorOutputItemAudit = z.infer<
  typeof investigatorOutputItemAuditSchema
>;
export type InvestigatorOutputTextPartAudit = z.infer<
  typeof investigatorOutputTextPartAuditSchema
>;
export type InvestigatorOutputTextAnnotationAudit = z.infer<
  typeof investigatorOutputTextAnnotationAuditSchema
>;
export type InvestigatorReasoningSummaryAudit = z.infer<
  typeof investigatorReasoningSummaryAuditSchema
>;
export type InvestigatorToolCallAudit = z.infer<
  typeof investigatorToolCallAuditSchema
>;
export type InvestigatorUsageAudit = z.infer<
  typeof investigatorUsageAuditSchema
>;
export type InvestigatorResponseAudit = z.infer<
  typeof investigatorResponseAuditSchema
>;
export type InvestigatorErrorAudit = z.infer<typeof investigatorErrorAuditSchema>;
export type InvestigatorAttemptAudit = z.infer<
  typeof investigatorAttemptAuditSchema
>;

export function parseInvestigatorAttemptAudit(
  value: unknown,
): InvestigatorAttemptAudit {
  return investigatorAttemptAuditSchema.parse(value);
}

export interface InvestigatorOutput {
  result: InvestigationResult;
  attemptAudit: InvestigatorAttemptAudit;
  modelVersion?: string;
}

export interface Investigator {
  investigate(input: InvestigatorInput): Promise<InvestigatorOutput>;
  readonly provider: InvestigationProvider;
  readonly model: InvestigationModel;
}
