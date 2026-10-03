import assert from "node:assert/strict";
import { test } from "node:test";
import { validateOpenAiApiKeyForSettingsWithClient } from "../../src/lib/services/openai-key-validation-core.js";
import {
  createFakeOpenAiClient,
  makeResponse,
  type FakeOpenAiReply,
} from "../helpers/fake-openai.js";

const WELL_FORMED_KEY = "sk-test-key-abcdefghijklmnopqrstuvwxyz";

async function validateWithReply(reply: FakeOpenAiReply, timeoutMs?: number) {
  const fake = createFakeOpenAiClient(() => reply, timeoutMs === undefined ? {} : { timeoutMs });
  const result = await validateOpenAiApiKeyForSettingsWithClient(
    WELL_FORMED_KEY,
    () => fake.client,
  );
  return { result, requests: fake.requests };
}

test("missing and malformed keys are reported without calling OpenAI", async () => {
  const neverCalled = () => assert.fail("OpenAI must not be called");
  assert.deepEqual(await validateOpenAiApiKeyForSettingsWithClient("   ", neverCalled), {
    openaiApiKeyStatus: "missing",
  });
  assert.deepEqual(await validateOpenAiApiKeyForSettingsWithClient("invalid-key", neverCalled), {
    openaiApiKeyStatus: "format_invalid",
    openaiApiKeyMessage: "OpenAI API keys must begin with sk- and include the full token value.",
  });
});

test("a key is valid when OpenAI accepts the investigation request probe", async () => {
  const { result, requests } = await validateWithReply({
    kind: "response",
    // The probe's tiny output cap usually leaves the response incomplete.
    response: makeResponse({ id: "resp_probe", status: "incomplete", output: [] }),
  });

  assert.deepEqual(result, { openaiApiKeyStatus: "valid" });
  const [probe] = requests;
  assert.ok(probe);
  assert.equal(probe.body.model, "gpt-6.1-sol");
  assert.equal(probe.body.tool_choice, "none");
  assert.equal(probe.body.max_output_tokens, 16);
  assert.deepEqual(probe.body.include, ["web_search_call.action.sources"]);
  assert.deepEqual(probe.body.reasoning, { effort: "medium", summary: "detailed" });
  assert.deepEqual(
    probe.body.tools?.map((tool) => (tool.type === "function" ? tool.name : tool.type)),
    ["web_search", "fetch_url", "submit_correction"],
  );
});

test("OpenAI authentication and permission failures map to key statuses", async () => {
  assert.deepEqual(
    (await validateWithReply({ kind: "http_error", status: 401, message: "Incorrect API key" }))
      .result,
    { openaiApiKeyStatus: "invalid", openaiApiKeyMessage: "OpenAI rejected this API key." },
  );
  assert.deepEqual(
    (await validateWithReply({ kind: "http_error", status: 403, message: "Forbidden" })).result,
    {
      openaiApiKeyStatus: "authenticated_restricted",
      openaiApiKeyMessage:
        "OpenAI authenticated this key, but access is restricted for validation checks.",
    },
  );
});

test("other OpenAI rejections are reported with OpenAI's explanation", async () => {
  const { result } = await validateWithReply({
    kind: "http_error",
    status: 404,
    message: "The model `gpt-6.1-sol` does not exist or you do not have access to it.",
  });
  assert.deepEqual(result, {
    openaiApiKeyStatus: "error",
    openaiApiKeyMessage:
      "404 The model `gpt-6.1-sol` does not exist or you do not have access to it.",
  });
});

test("a probe that times out reports the timeout", async () => {
  const { result } = await validateWithReply({ kind: "hang" }, 20);
  assert.deepEqual(result, {
    openaiApiKeyStatus: "error",
    openaiApiKeyMessage:
      "OpenAI key validation timed out. Confirm outbound network access and retry.",
  });
});

test("a probe response that failed server-side is not a valid key", async () => {
  const { result } = await validateWithReply({
    kind: "response",
    response: makeResponse({ id: "resp_probe", status: "failed", output: [] }),
  });
  assert.deepEqual(result, {
    openaiApiKeyStatus: "error",
    openaiApiKeyMessage: "OpenAI probe response resp_probe ended with status failed",
  });
});
