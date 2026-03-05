import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { graphqlQuery } from "../../src/lib/api.js";

describe("graphqlQuery", () => {
  it("returns data on a successful response", async () => {
    const expected = { searchInvestigations: { investigations: [] } };
    const mockFetch = mock.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: expected }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    process.env["API_BASE_URL"] = "https://api.example.com";

    try {
      const result = await graphqlQuery<typeof expected>("query { test }", {});
      assert.deepEqual(result, expected);

      assert.equal(mockFetch.mock.callCount(), 1);
      const [url, init] = mockFetch.mock.calls[0]!.arguments;
      assert.equal(url, "https://api.example.com/graphql");
      assert.equal((init as RequestInit).method, "POST");
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env["API_BASE_URL"];
    }
  });

  it("throws on non-ok HTTP response", async () => {
    const mockFetch = mock.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" }),
      ),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    process.env["API_BASE_URL"] = "https://api.example.com";

    try {
      await assert.rejects(() => graphqlQuery("query { test }", {}), {
        message: "GraphQL request failed: 500 Internal Server Error",
      });
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env["API_BASE_URL"];
    }
  });

  it("throws when response body has no data field", async () => {
    const mockFetch = mock.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ errors: [{ message: "parse error" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    process.env["API_BASE_URL"] = "https://api.example.com";

    try {
      await assert.rejects(() => graphqlQuery("query { test }", {}), {
        message: "GraphQL response missing 'data' field",
      });
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env["API_BASE_URL"];
    }
  });

  it("throws on GraphQL errors even when data is present", async () => {
    const mockFetch = mock.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: null,
            errors: [{ message: "Unknown argument" }, { message: "Validation failed" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    process.env["API_BASE_URL"] = "https://api.example.com";

    try {
      await assert.rejects(() => graphqlQuery("query { test }", {}), {
        message: "GraphQL error: Unknown argument, Validation failed",
      });
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env["API_BASE_URL"];
    }
  });

  it("throws when API_BASE_URL is not set", async () => {
    const saved = process.env["API_BASE_URL"];
    delete process.env["API_BASE_URL"];

    try {
      await assert.rejects(() => graphqlQuery("query { test }", {}), {
        message: "API_BASE_URL environment variable is required",
      });
    } finally {
      if (saved !== undefined) {
        process.env["API_BASE_URL"] = saved;
      }
    }
  });

  it("sends variables in the request body", async () => {
    const mockFetch = mock.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    process.env["API_BASE_URL"] = "https://api.example.com";

    try {
      const vars = { query: "test", limit: 10 };
      await graphqlQuery("query($query: String) { search(query: $query) { id } }", vars);

      const body = JSON.parse(mockFetch.mock.calls[0]!.arguments[1]!.body as string) as Record<
        string,
        unknown
      >;
      assert.deepEqual(body["variables"], vars);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env["API_BASE_URL"];
    }
  });
});
