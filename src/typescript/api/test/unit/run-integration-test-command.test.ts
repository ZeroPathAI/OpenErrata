import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIntegrationTestCommand } from "../integration/run-integration-test-command.js";

test("buildIntegrationTestCommand returns default integration runner command", () => {
  const result = buildIntegrationTestCommand([]);
  assert.deepEqual(result, {
    command: "pnpm",
    args: ["run", "test:integration:raw"],
  });
});

test("buildIntegrationTestCommand forwards args to test:integration:raw without exec prefix", () => {
  const result = buildIntegrationTestCommand(["--test-name-pattern", "orchestrator"]);
  assert.deepEqual(result, {
    command: "pnpm",
    args: ["run", "test:integration:raw", "--", "--test-name-pattern", "orchestrator"],
  });
});

test("buildIntegrationTestCommand composes exec prefix with integration test runner and forwarded args", () => {
  const result = buildIntegrationTestCommand([
    "--test-name-pattern",
    "orchestrator",
    "--exec-prefix",
    "c8",
    "--config",
    "../.c8rc.api.json",
    "--check-coverage",
    "false",
    "--",
    "--test-timeout",
    "5000",
  ]);
  assert.deepEqual(result, {
    command: "pnpm",
    args: [
      "exec",
      "c8",
      "--config",
      "../.c8rc.api.json",
      "--check-coverage",
      "false",
      "tsx",
      "--test",
      "--test-concurrency=1",
      "test/integration/*.integration.test.ts",
      "--test-name-pattern",
      "orchestrator",
      "--test-timeout",
      "5000",
    ],
  });
});

test("buildIntegrationTestCommand supports exec-prefix tokens without a delimiter", () => {
  const result = buildIntegrationTestCommand([
    "--exec-prefix",
    "c8",
    "--config",
    "../.c8rc.api.json",
    "--clean",
    "false",
  ]);
  assert.deepEqual(result, {
    command: "pnpm",
    args: [
      "exec",
      "c8",
      "--config",
      "../.c8rc.api.json",
      "--clean",
      "false",
      "tsx",
      "--test",
      "--test-concurrency=1",
      "test/integration/*.integration.test.ts",
    ],
  });
});

test("buildIntegrationTestCommand rejects missing exec-prefix tokens", () => {
  assert.throws(
    () => buildIntegrationTestCommand(["--exec-prefix"]),
    /requires at least one token/,
  );
  assert.throws(
    () => buildIntegrationTestCommand(["--exec-prefix", "--"]),
    /requires at least one token before --/,
  );
});

test("buildIntegrationTestCommand rejects legacy quoted exec-prefix command strings", () => {
  assert.throws(
    () => buildIntegrationTestCommand(["--exec-prefix", "c8 --config ../.c8rc.api.json"]),
    /must be tokenized/,
  );
});
