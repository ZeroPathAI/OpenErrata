export const DEFAULT_INTEGRATION_DATABASE_URL =
  "postgresql://openerrata:openerrata_dev@localhost:5433/openerrata";

const INTEGRATION_ENV_OVERRIDES = {
  BLOB_STORAGE_PROVIDER: "aws",
  BLOB_STORAGE_REGION: "us-east-1",
  BLOB_STORAGE_ENDPOINT: "",
  BLOB_STORAGE_BUCKET: "test-openerrata-images",
  BLOB_STORAGE_ACCESS_KEY_ID: "test-blob-access-key",
  BLOB_STORAGE_SECRET_ACCESS_KEY: "test-blob-secret",
  DATABASE_ENCRYPTION_KEY: "integration-test-database-encryption-key",
  OPENAI_API_KEY: "sk-test-openai-key",
  OPENAI_MAX_RESPONSE_TOOL_ROUNDS: "150",
  WORKER_CONCURRENCY: "250",
  SELECTOR_DAILY_BUDGET: "100",
  IP_RANGE_CREDIT_CAP: "10",
} as const;

interface ApplyIntegrationEnvironmentOptions {
  databaseUrl?: string;
}

/**
 * Apply deterministic integration-test environment defaults.
 *
 * We write the fixed service/config values directly to avoid hidden dependence
 * on caller shell state. DATABASE_URL can be injected per test run and falls
 * back to local docker-compose defaults when omitted.
 */
export function applyIntegrationEnvironmentDefaults(
  env: NodeJS.ProcessEnv,
  options: ApplyIntegrationEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  env["NODE_ENV"] = "test";
  for (const [key, value] of Object.entries(INTEGRATION_ENV_OVERRIDES)) {
    env[key] = value;
  }

  env["DATABASE_URL"] =
    options.databaseUrl ?? env["DATABASE_URL"] ?? DEFAULT_INTEGRATION_DATABASE_URL;
  return env;
}
