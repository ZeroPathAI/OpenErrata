import assert from "node:assert/strict";
import { test } from "node:test";
import type { FunctionTool } from "openai/resources/responses/responses";
import { fetchUrlToolDefinition } from "../../src/lib/investigators/fetch-url-tool.js";
import {
  buildRetainCorrectionToolDefinition,
  parseRetainCorrectionArguments,
  parseSubmitCorrectionArguments,
  submitCorrectionToolDefinition,
} from "../../src/lib/investigators/openai-claim-tools.js";
import { buildFactCheckTools } from "../../src/lib/investigators/openai-request-config.js";
import { makeClaim } from "../helpers/fake-openai.js";

// Keywords OpenAI strict mode accepts, per JSON Schema node type
// (https://platform.openai.com/docs/guides/structured-outputs#supported-schemas).
const STRICT_MODE_KEYWORDS: Record<string, ReadonlySet<string>> = {
  object: new Set(["type", "description", "properties", "required", "additionalProperties"]),
  array: new Set(["type", "description", "items", "minItems", "maxItems"]),
  string: new Set(["type", "description", "enum", "pattern", "format"]),
};
const STRICT_MODE_STRING_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
]);

/** Throws describing the first strict-mode violation under `path`. */
function assertStrictModeSchema(schema: Record<string, unknown>, path: string): void {
  const type = schema["type"];
  assert.equal(typeof type, "string", `${path}: every node needs a single type`);
  const allowed = STRICT_MODE_KEYWORDS[String(type)];
  assert.ok(allowed, `${path}: unsupported type ${String(type)}`);
  for (const keyword of Object.keys(schema)) {
    if (keyword === "$schema" && path === "parameters") continue;
    assert.ok(allowed.has(keyword), `${path}: keyword "${keyword}" is not allowed in strict mode`);
  }
  if (type === "string" && schema["format"] !== undefined) {
    assert.ok(STRICT_MODE_STRING_FORMATS.has(schema["format"] as string), `${path}: format`);
  }
  if (type === "object") {
    const properties = schema["properties"] as Record<string, Record<string, unknown>>;
    assert.equal(schema["additionalProperties"], false, `${path}: additionalProperties`);
    assert.deepEqual(schema["required"], Object.keys(properties), `${path}: all fields required`);
    for (const [name, property] of Object.entries(properties)) {
      assertStrictModeSchema(property, `${path}.${name}`);
    }
  }
  if (type === "array") {
    assertStrictModeSchema(schema["items"] as Record<string, unknown>, `${path}[]`);
  }
}

test("every function tool offered to the fact-check is valid under OpenAI strict mode", () => {
  const functionTools = buildFactCheckTools(["claim-1", "claim-2"]).filter(
    (tool): tool is FunctionTool => tool.type === "function",
  );
  assert.deepEqual(
    functionTools.map((tool) => tool.name),
    [fetchUrlToolDefinition.name, "submit_correction", "retain_correction"],
  );
  for (const tool of functionTools) {
    assert.equal(tool.strict, true, tool.name);
    assert.ok(tool.parameters);
    assertStrictModeSchema(tool.parameters, "parameters");
  }
});

test("submit_correction advertises the shared claim payload's shape", () => {
  const parameters = submitCorrectionToolDefinition.parameters;
  assert.ok(parameters);
  assert.deepEqual(Object.keys(parameters["properties"] as object), [
    "text",
    "context",
    "summary",
    "reasoning",
    "sources",
  ]);
  const sources = (parameters["properties"] as Record<string, Record<string, unknown>>)["sources"];
  assert.ok(sources);
  assert.equal(sources["minItems"], 1);
  assert.deepEqual(
    Object.keys((sources["items"] as Record<string, unknown>)["properties"] as object),
    ["url", "title", "snippet"],
  );
});

test("parseSubmitCorrectionArguments accepts a valid claim", () => {
  const claim = makeClaim("Alpha");
  assert.deepEqual(parseSubmitCorrectionArguments(JSON.stringify(claim)), {
    kind: "valid",
    value: claim,
  });
});

test("parseSubmitCorrectionArguments rejects non-http(s) source URLs", () => {
  for (const url of ["data:text/plain,hi", "ftp://example.com/file", "example.com/page"]) {
    const claim = { ...makeClaim("Alpha"), sources: [{ url, title: "T", snippet: "S" }] };
    assert.equal(parseSubmitCorrectionArguments(JSON.stringify(claim)).kind, "invalid", url);
  }
});

test("parseSubmitCorrectionArguments rejects claims the shared schema rejects", () => {
  const cases = [
    { ...makeClaim("Alpha"), sources: [] },
    { ...makeClaim("Alpha"), text: "" },
    { ...makeClaim("Alpha"), extra: "field" },
  ];
  for (const claim of cases) {
    assert.equal(parseSubmitCorrectionArguments(JSON.stringify(claim)).kind, "invalid");
  }
  assert.deepEqual(parseSubmitCorrectionArguments("{not json"), {
    kind: "invalid",
    error: "Arguments are not valid JSON",
  });
});

test("retain_correction accepts exactly the retainable claim ids", () => {
  const ids = ["claim-1", "claim-2"] as const;
  const definition = buildRetainCorrectionToolDefinition(ids);
  assert.deepEqual(
    (definition.parameters?.["properties"] as Record<string, Record<string, unknown>>)["id"]?.[
      "enum"
    ],
    ["claim-1", "claim-2"],
  );
  assert.deepEqual(parseRetainCorrectionArguments(JSON.stringify({ id: "claim-2" }), ids), {
    kind: "valid",
    value: "claim-2",
  });
  assert.equal(
    parseRetainCorrectionArguments(JSON.stringify({ id: "claim-3" }), ids).kind,
    "invalid",
  );
});
