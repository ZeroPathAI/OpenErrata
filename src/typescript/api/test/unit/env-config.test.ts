import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEnvironmentValues } from "../../src/lib/config/env.js";

function createBaseEnvironment(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://openerrata:openerrata_dev@localhost:5433/openerrata",
    BLOB_STORAGE_PROVIDER: "aws",
    BLOB_STORAGE_REGION: "us-west-2",
    BLOB_STORAGE_BUCKET: "test-openerrata-images",
    BLOB_STORAGE_ACCESS_KEY_ID: "test-blob-access-key",
    BLOB_STORAGE_SECRET_ACCESS_KEY: "test-blob-secret",
    DATABASE_ENCRYPTION_KEY: "integration-test-database-encryption-key",
    OPENAI_MAX_RESPONSE_TOOL_ROUNDS: "150",
    WORKER_CONCURRENCY: "250",
    SELECTOR_DAILY_BUDGET: "100",
    IP_RANGE_CREDIT_CAP: "10",
    ...overrides,
  };
}

test("accepts aws blob storage configuration with an explicit region", () => {
  const environment = parseEnvironmentValues(createBaseEnvironment());
  assert.equal(environment.BLOB_STORAGE_PROVIDER, "aws");
  assert.equal(environment.BLOB_STORAGE_REGION, "us-west-2");
  assert.equal(environment.BLOB_STORAGE_ENDPOINT, undefined);
});

test("accepts a custom worker concurrency", () => {
  const environment = parseEnvironmentValues(
    createBaseEnvironment({
      WORKER_CONCURRENCY: "32",
    }),
  );
  assert.equal(environment.WORKER_CONCURRENCY, 32);
});

test("requires the numeric tuning variables the chart always sets", () => {
  for (const name of [
    "OPENAI_MAX_RESPONSE_TOOL_ROUNDS",
    "WORKER_CONCURRENCY",
    "SELECTOR_DAILY_BUDGET",
    "IP_RANGE_CREDIT_CAP",
  ]) {
    assert.throws(
      () => parseEnvironmentValues(createBaseEnvironment({ [name]: undefined })),
      new RegExp(name),
    );
  }
});

test("rejects aws blob storage configuration when endpoint is set", () => {
  assert.throws(
    () =>
      parseEnvironmentValues(
        createBaseEnvironment({
          BLOB_STORAGE_ENDPOINT: "https://s3.us-west-2.amazonaws.com",
        }),
      ),
    /BLOB_STORAGE_ENDPOINT must be unset/,
  );
});

test("rejects aws blob storage configuration with region 'auto'", () => {
  assert.throws(
    () =>
      parseEnvironmentValues(
        createBaseEnvironment({
          BLOB_STORAGE_REGION: "auto",
        }),
      ),
    /BLOB_STORAGE_REGION cannot be 'auto'/,
  );
});

test("requires endpoint for s3-compatible blob storage", () => {
  assert.throws(
    () =>
      parseEnvironmentValues(
        createBaseEnvironment({
          BLOB_STORAGE_PROVIDER: "s3_compatible",
          BLOB_STORAGE_REGION: "auto",
          BLOB_STORAGE_ENDPOINT: "",
        }),
      ),
    /BLOB_STORAGE_ENDPOINT/,
  );
});

test("accepts s3-compatible blob storage with endpoint and region", () => {
  const environment = parseEnvironmentValues(
    createBaseEnvironment({
      BLOB_STORAGE_PROVIDER: "s3_compatible",
      BLOB_STORAGE_REGION: "auto",
      BLOB_STORAGE_ENDPOINT: "https://example.r2.cloudflarestorage.com",
    }),
  );
  assert.equal(environment.BLOB_STORAGE_PROVIDER, "s3_compatible");
  assert.equal(environment.BLOB_STORAGE_REGION, "auto");
  assert.equal(environment.BLOB_STORAGE_ENDPOINT, "https://example.r2.cloudflarestorage.com");
});

test("SELECTOR_DAILY_BUDGET is read as a positive integer", () => {
  assert.equal(
    parseEnvironmentValues(createBaseEnvironment({ SELECTOR_DAILY_BUDGET: "25" }))
      .SELECTOR_DAILY_BUDGET,
    25,
  );
});
