import assert from "node:assert/strict";
import { test } from "node:test";
import { GET } from "../../src/routes/+server.js";

test("root route returns an OpenAI-style JSON welcome message", async () => {
  const routeGet = GET as (event: { request: Request }) => Promise<Response>;
  const response = await routeGet({
    request: new Request("http://localhost/"),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");

  const payload = (await response.json()) as { message: string };
  assert.equal(
    payload.message,
    "Welcome to the OpenErrata API! Documentation is available at https://github.com/ZeroPathAI/OpenErrata/blob/main/SPEC.md",
  );
});
