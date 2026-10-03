import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  publicInvestigationQuery,
  searchInvestigationsQuery,
} from "../../src/lib/public-queries.js";
import { PublicApiError, runPublicQuery } from "../../src/lib/server/public-api-client.js";
import {
  goodPublicInvestigation,
  javascriptPostUrlInvestigation,
  searchInvestigationsResult,
} from "../e2e/public-api-fixtures.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function transportReturning(response: Response | Error) {
  const fetch = mock.fn<typeof globalThis.fetch>(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  return { fetch, transport: { baseUrl: "https://api.example.com", fetch } };
}

describe("runPublicQuery", () => {
  it("posts the document and validated variables to /graphql and returns parsed data", async () => {
    const { fetch, transport } = transportReturning(
      jsonResponse({ data: { searchInvestigations: searchInvestigationsResult } }),
    );

    const data = await runPublicQuery(transport, searchInvestigationsQuery, {
      platform: "LESSWRONG",
      minClaimCount: 1,
    });

    assert.deepEqual(data.searchInvestigations, searchInvestigationsResult);
    const [url, init] = fetch.mock.calls[0]!.arguments;
    assert.equal(String(url), "https://api.example.com/graphql");
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    assert.equal(body["query"], searchInvestigationsQuery.document);
    // Shared input-schema defaults are applied before sending.
    assert.deepEqual(body["variables"], {
      platform: "LESSWRONG",
      minClaimCount: 1,
      limit: 20,
      offset: 0,
    });
  });

  it("keeps a path prefix on the API base URL", async () => {
    const fetch = mock.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ data: { publicInvestigation: null } })),
    );
    await runPublicQuery({ baseUrl: "https://example.com/api/", fetch }, publicInvestigationQuery, {
      investigationId: "inv-1",
    });
    assert.equal(String(fetch.mock.calls[0]!.arguments[0]), "https://example.com/api/graphql");
  });

  it("returns null for an investigation the API does not have", async () => {
    const { transport } = transportReturning(jsonResponse({ data: { publicInvestigation: null } }));
    const data = await runPublicQuery(transport, publicInvestigationQuery, {
      investigationId: "missing",
    });
    assert.equal(data.publicInvestigation, null);
  });

  it("parses a complete investigation, including the model id", async () => {
    const { transport } = transportReturning(
      jsonResponse({ data: { publicInvestigation: goodPublicInvestigation } }),
    );
    const data = await runPublicQuery(transport, publicInvestigationQuery, {
      investigationId: "inv-good",
    });
    assert.equal(data.publicInvestigation?.investigation.model, "gpt-6.1-sol");
  });

  it("rejects a post URL that is not http(s) as a contract violation", async () => {
    const { transport } = transportReturning(
      jsonResponse({ data: { publicInvestigation: javascriptPostUrlInvestigation } }),
    );
    await assert.rejects(
      () => runPublicQuery(transport, publicInvestigationQuery, { investigationId: "x" }),
      (error: unknown) =>
        error instanceof PublicApiError && error.message.includes("violates the public contract"),
    );
  });

  it("rejects a SERVER_VERIFIED origin without a verification timestamp", async () => {
    const result = {
      ...searchInvestigationsResult,
      investigations: searchInvestigationsResult.investigations.map((investigation) => ({
        ...investigation,
        origin: { provenance: "SERVER_VERIFIED", serverVerifiedAt: null },
      })),
    };
    const { transport } = transportReturning(
      jsonResponse({ data: { searchInvestigations: result } }),
    );
    await assert.rejects(
      () => runPublicQuery(transport, searchInvestigationsQuery, {}),
      PublicApiError,
    );
  });

  it("throws on GraphQL errors", async () => {
    const { transport } = transportReturning(
      jsonResponse({ data: null, errors: [{ message: "Unknown argument" }, { message: "Bad" }] }),
    );
    await assert.rejects(() => runPublicQuery(transport, searchInvestigationsQuery, {}), {
      name: "PublicApiError",
      message: "GraphQL errors: Unknown argument; Bad",
    });
  });

  it("throws on non-2xx responses", async () => {
    const { transport } = transportReturning(
      new Response("upstream down", { status: 503, statusText: "Service Unavailable" }),
    );
    await assert.rejects(() => runPublicQuery(transport, searchInvestigationsQuery, {}), {
      name: "PublicApiError",
      message: "Public API responded 503 Service Unavailable: upstream down",
    });
  });

  it("wraps network failures", async () => {
    const { transport } = transportReturning(new TypeError("fetch failed"));
    await assert.rejects(
      () => runPublicQuery(transport, searchInvestigationsQuery, {}),
      (error: unknown) => error instanceof PublicApiError && error.cause instanceof TypeError,
    );
  });

  it("refuses invalid variables before sending anything", async () => {
    const { fetch, transport } = transportReturning(jsonResponse({ data: {} }));
    await assert.rejects(() =>
      runPublicQuery(transport, searchInvestigationsQuery, { offset: -20 }),
    );
    assert.equal(fetch.mock.callCount(), 0);
  });
});
