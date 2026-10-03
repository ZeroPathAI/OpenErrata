import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse as parseDotenv } from "dotenv";
import { parseEnvironmentValues } from "../../src/lib/config/env.js";

// README tells developers to copy api/.env.example to api/.env, so the example
// must always be a complete, valid configuration.
test("api/.env.example satisfies the API environment schema", () => {
  const example = parseDotenv(readFileSync(new URL("../../.env.example", import.meta.url)));
  assert.doesNotThrow(() => parseEnvironmentValues(example));
});
