import { z } from "zod";
import type {
  InvestigationModel,
  InvestigationProvider,
  InvestigationResult,
  InvestigationClaim,
  Platform,
} from "@openerrata/shared";

const isoDateTimeSchema = z.iso.datetime();

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
  isUpdate?: boolean;
  oldClaims?: InvestigationClaim[];
  contentDiff?: string;
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
}).superRefine((audit, context) => {
  const providerItemIdMissing = audit.providerItemId === null;
  const itemStatusMissing = audit.itemStatus === null;
  if (providerItemIdMissing !== itemStatusMissing) {
    context.addIssue({
      code: "custom",
      path: ["providerItemId"],
      message: "providerItemId and itemStatus must be either both present or both null",
    });
  }
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
  characterPosition: z
    .object({
      start: z.number().int(),
      end: z.number().int(),
    })
    .optional(),
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
}).superRefine((toolCall, context) => {
  const providerToolCallIdMissing = toolCall.providerToolCallId === null;
  const statusMissing = toolCall.status === null;
  if (providerToolCallIdMissing !== statusMissing) {
    context.addIssue({
      code: "custom",
      path: ["providerToolCallId"],
      message:
        "providerToolCallId and status must be either both present or both null",
    });
  }
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

const investigatorAttemptAuditBaseSchema = z.object({
  startedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
  requestModel: z.string().min(1),
  requestInstructions: z.string(),
  requestInput: z.string(),
  requestReasoningEffort: z.string().nullable(),
  requestReasoningSummary: z.string().nullable(),
  requestedTools: z.array(investigatorRequestedToolAuditSchema),
});

const investigatorAttemptSucceededAuditSchema = investigatorAttemptAuditBaseSchema.extend({
  response: investigatorResponseAuditSchema,
  error: z.null(),
});

const investigatorAttemptFailedAuditSchema = investigatorAttemptAuditBaseSchema.extend({
  response: investigatorResponseAuditSchema.nullable(),
  error: investigatorErrorAuditSchema,
});

export const investigatorAttemptAuditSchema = z.union([
  investigatorAttemptSucceededAuditSchema,
  investigatorAttemptFailedAuditSchema,
]);

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
export type InvestigatorAttemptSucceededAudit = z.infer<
  typeof investigatorAttemptSucceededAuditSchema
>;
export type InvestigatorAttemptFailedAudit = z.infer<
  typeof investigatorAttemptFailedAuditSchema
>;
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
