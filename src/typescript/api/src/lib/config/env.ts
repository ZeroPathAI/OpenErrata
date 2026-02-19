import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Explicitly load .env into process.env. Vite/SvelteKit only exposes .env
// vars through $env virtual modules, not process.env, and the worker/selector
// entrypoints (tsx) don't load .env at all. In production the .env file
// typically doesn't exist and env vars come from the system, making this a
// no-op.
loadDotenv();

const positiveIntegerFromEnv = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
  }
  return value;
}, z.number().int().positive());

const optionalNonEmptyStringFromEnv = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().min(1).optional());

const requiredNonEmptyStringFromEnv = z.preprocess((value) => {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") return value;
  return value.trim();
}, z.string().min(1));

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (value) =>
        value.startsWith("postgres://") || value.startsWith("postgresql://"),
      "DATABASE_URL must use postgres:// or postgresql://",
    ),
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  OPENAI_MODEL_ID: z.string().trim().min(1).default("gpt-5.2"),
  OPENAI_MAX_RESPONSE_TOOL_ROUNDS: positiveIntegerFromEnv.optional(),
  VALID_API_KEYS: z.string().default(""),
  HMAC_SECRET: z.string().trim().min(1, "HMAC_SECRET is required"),
  SELECTOR_BUDGET: positiveIntegerFromEnv.default(100),
  IP_RANGE_CREDIT_CAP: positiveIntegerFromEnv.default(10),
  BLOB_STORAGE_ENDPOINT: optionalNonEmptyStringFromEnv,
  BLOB_STORAGE_BUCKET: requiredNonEmptyStringFromEnv,
  BLOB_STORAGE_ACCESS_KEY_ID: requiredNonEmptyStringFromEnv,
  BLOB_STORAGE_SECRET_ACCESS_KEY: requiredNonEmptyStringFromEnv,
  BLOB_STORAGE_PUBLIC_URL_PREFIX: requiredNonEmptyStringFromEnv,
  DATABASE_ENCRYPTION_KEY: requiredNonEmptyStringFromEnv,
  DATABASE_ENCRYPTION_KEY_ID:
    optionalNonEmptyStringFromEnv.default("primary"),
});

type Environment = z.infer<typeof environmentSchema>;

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "environment";
      return `- ${path}: ${issue.message}`;
    })
    .join("\n");
}

function parseEnvironment(): Environment {
  const result = environmentSchema.safeParse(process.env);
  if (result.success) return result.data;

  const details = formatZodIssues(result.error);
  console.error(
    `\nInvalid API environment configuration:\n${details}\n\n` +
      "Ensure the api/.env file exists with the required variables. " +
      "See .env.example for reference.\n",
  );
  process.exit(1);
}

// Validated eagerly on first import. If invalid, the process exits immediately
// with a descriptive message instead of throwing through Vite's module runner
// and producing a stack trace on every request.
const environment: Environment = parseEnvironment();

export function getEnv(): Environment {
  return environment;
}

export function getConfiguredApiKeys(): string[] {
  return getEnv()
    .VALID_API_KEYS.split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

export function requireOpenAiApiKey(): string {
  const apiKey = getEnv().OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }
  return apiKey;
}

export function getDatabaseEncryptionConfig(): {
  keyMaterial: string;
  keyId: string;
} {
  const env = getEnv();
  return {
    keyMaterial: env.DATABASE_ENCRYPTION_KEY,
    keyId: env.DATABASE_ENCRYPTION_KEY_ID,
  };
}
