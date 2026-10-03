import { isNonNullObject } from "@openerrata/shared";

/**
 * Stand in for the OpenAI API during integration tests so no test can reach
 * it. Keys containing "rejected" get 401 (OpenAI refused the key); every other
 * key is accepted. Installed once, underneath any per-test fetch mocks.
 */
export function installMockOpenAiApi(): void {
  const originalFetch = globalThis.fetch;
  const mockedFetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.hostname !== "api.openai.com") {
      return originalFetch(input, init);
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    const authorization = headers.get("authorization") ?? "";
    if (authorization.includes("rejected")) {
      return new Response(
        JSON.stringify({
          error: { message: "Incorrect API key provided", type: "invalid_request_error" },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }
    const body = url.pathname.includes("/models")
      ? { id: "mock-model", object: "model", created: 0, owned_by: "openai" }
      : {
          id: "resp_mock",
          object: "response",
          status: "completed",
          model: "mock-model",
          output: [],
          output_text: "pong",
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  globalThis.fetch = mockedFetch;
}

/** The post id a mocked LessWrong GraphQL request asks for. */
export function lesswrongPostIdFromGraphqlBody(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") {
    throw new Error("Expected LessWrong GraphQL request body to be a JSON string");
  }
  const parsed: unknown = JSON.parse(body);
  if (
    !isNonNullObject(parsed) ||
    !isNonNullObject(parsed["variables"]) ||
    typeof parsed["variables"]["id"] !== "string"
  ) {
    throw new Error("LessWrong GraphQL request is missing variables.id");
  }
  return parsed["variables"]["id"];
}
