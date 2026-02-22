import assert from "node:assert/strict";
import { test } from "node:test";
import { GET } from "../../src/routes/+server.js";

function createRequestEvent(): Parameters<typeof GET>[0] {
  return {
    request: new Request("http://localhost/"),
  } as Parameters<typeof GET>[0];
}

test("root route returns an OpenAI-style JSON welcome message", async () => {
  const response = await GET(createRequestEvent());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");

  const payload = (await response.json()) as { message: string };
  assert.equal(
    payload.message,
    "Welcome to the OpenErrata API! Documentation is available at https://github.com/ZeroPathAI/OpenErrata/blob/main/SPEC.md",
  );
});
