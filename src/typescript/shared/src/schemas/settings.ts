import { z } from "zod";
import { MAX_BATCH_STATUS_POSTS } from "../constants.js";
import { platformSchema, postIdSchema, versionHashSchema } from "./common.js";

export const openaiApiKeyFormatSchema = z
  .string()
  .regex(/^sk-[A-Za-z0-9_-]{20,}$/, "Expected an OpenAI API key beginning with sk-");

const settingsValidationMissingSchema = z
  .object({
    instanceApiKeyAccepted: z.boolean(),
    openaiApiKeyStatus: z.literal("missing"),
  })
  .strict();

const settingsValidationValidSchema = z
  .object({
    instanceApiKeyAccepted: z.boolean(),
    openaiApiKeyStatus: z.literal("valid"),
  })
  .strict();

const settingsValidationFormatInvalidSchema = z
  .object({
    instanceApiKeyAccepted: z.boolean(),
    openaiApiKeyStatus: z.literal("format_invalid"),
    openaiApiKeyMessage: z.string().min(1),
  })
  .strict();

const settingsValidationAuthenticatedRestrictedSchema = z
  .object({
    instanceApiKeyAccepted: z.boolean(),
    openaiApiKeyStatus: z.literal("authenticated_restricted"),
    openaiApiKeyMessage: z.string().min(1),
  })
  .strict();

const settingsValidationInvalidSchema = z
  .object({
    instanceApiKeyAccepted: z.boolean(),
    openaiApiKeyStatus: z.literal("invalid"),
    openaiApiKeyMessage: z.string().min(1),
  })
  .strict();

const settingsValidationErrorSchema = z
  .object({
    instanceApiKeyAccepted: z.boolean(),
    openaiApiKeyStatus: z.literal("error"),
    openaiApiKeyMessage: z.string().min(1),
  })
  .strict();

export const settingsValidationOutputSchema = z.discriminatedUnion("openaiApiKeyStatus", [
  settingsValidationMissingSchema,
  settingsValidationValidSchema,
  settingsValidationFormatInvalidSchema,
  settingsValidationAuthenticatedRestrictedSchema,
  settingsValidationInvalidSchema,
  settingsValidationErrorSchema,
]);

export const batchStatusInputSchema = z
  .object({
    posts: z
      .array(
        z
          .object({
            platform: platformSchema,
            externalId: postIdSchema,
            versionHash: versionHashSchema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_BATCH_STATUS_POSTS),
  })
  .strict();

export const batchStatusOutputSchema = z
  .object({
    statuses: z.array(
      z.discriminatedUnion("investigationState", [
        z
          .object({
            platform: platformSchema,
            externalId: postIdSchema,
            investigationState: z.literal("NOT_INVESTIGATED"),
            incorrectClaimCount: z.literal(0),
          })
          .strict(),
        z
          .object({
            platform: platformSchema,
            externalId: postIdSchema,
            investigationState: z.literal("INVESTIGATED"),
            incorrectClaimCount: z.number().int().nonnegative(),
          })
          .strict(),
      ]),
    ),
  })
  .strict();
