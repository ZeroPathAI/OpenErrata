/**
 * Stand-in for the API's public GraphQL endpoint during frontend e2e tests.
 * It answers the site's two queries with canned fixtures; that the queries
 * match the real schema is checked separately by the API's
 * frontend-graphql-contract test.
 */
import { createServer } from "node:http";
import {
  API_FAILURE_SEARCH_QUERY,
  GOOD_INVESTIGATION_ID,
  JAVASCRIPT_POST_URL_INVESTIGATION_ID,
  goodPublicInvestigation,
  javascriptPostUrlInvestigation,
  searchInvestigationsResult,
} from "./public-api-fixtures.js";

const port = Number(process.env["MOCK_PUBLIC_API_PORT"]);
if (!Number.isInteger(port)) {
  throw new Error("MOCK_PUBLIC_API_PORT must be set");
}

interface GraphqlRequest {
  query: string;
  variables: Record<string, unknown>;
}

type MockResponse = { status: 200; data: Record<string, unknown> } | { status: 500 };

function publicInvestigationFor(investigationId: unknown): unknown {
  switch (investigationId) {
    case GOOD_INVESTIGATION_ID:
      return goodPublicInvestigation;
    case JAVASCRIPT_POST_URL_INVESTIGATION_ID:
      return javascriptPostUrlInvestigation;
    default:
      return null;
  }
}

function respond(request: GraphqlRequest): MockResponse {
  if (request.query.includes("searchInvestigations(")) {
    if (request.variables["query"] === API_FAILURE_SEARCH_QUERY) {
      return { status: 500 };
    }
    return { status: 200, data: { searchInvestigations: searchInvestigationsResult } };
  }
  if (request.query.includes("publicInvestigation(")) {
    return {
      status: 200,
      data: { publicInvestigation: publicInvestigationFor(request.variables["investigationId"]) },
    };
  }
  throw new Error(`Mock public API received an unknown query:\n${request.query}`);
}

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200).end("ok");
      return;
    }
    if (req.method !== "POST" || req.url !== "/graphql") {
      res.writeHead(404).end();
      return;
    }
    const response = respond(JSON.parse(Buffer.concat(chunks).toString("utf8")) as GraphqlRequest);
    if (response.status === 500) {
      res.writeHead(500, { "Content-Type": "text/plain" }).end("mock upstream failure");
      return;
    }
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ data: response.data }));
  });
}).listen(port, "127.0.0.1");
