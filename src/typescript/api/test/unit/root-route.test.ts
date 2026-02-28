import assert from "node:assert/strict";
import { test } from "node:test";
import { GET } from "../../src/routes/+server.js";

test("root route returns a JSON welcome payload", async () => {
  const routeGet = GET as (event: { request: Request }) => Promise<Response>;
  const response = await routeGet({
    request: new Request("http://localhost/"),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");

  const payload = (await response.json()) as { message?: unknown };
  const message = payload.message;
  assert.equal(typeof message, "string");
  if (typeof message !== "string") {
    assert.fail("Expected root payload message to be a string");
  }
  assert.equal(message.trim().length > 0, true);
  assert.match(message, /openerrata api/i);
});
