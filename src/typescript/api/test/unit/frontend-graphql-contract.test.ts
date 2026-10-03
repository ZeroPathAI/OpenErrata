/**
 * Consumer contract for the public frontend: every GraphQL document the site
 * sends must validate against this API's schema, and the API's responses to
 * it must parse with the shared output schemas the site parses them with.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { graphql, parse, validate } from "graphql";
import {
  publicInvestigationQuery,
  searchInvestigationsQuery,
} from "../../../frontend/src/lib/public-queries.js";
import { createPublicGraphqlSchema } from "../../src/lib/graphql/public-schema.js";

const checkedAt = new Date("2026-09-30T12:00:00.000Z");

/** In-process execution keeps scalars as JS values (e.g. Date); the HTTP handler sends JSON. */
function overTheWire(data: unknown): unknown {
  return JSON.parse(JSON.stringify(data));
}

const schema = createPublicGraphqlSchema({
  getPublicInvestigationById: async (_prisma, investigationId) =>
    investigationId === "missing"
      ? null
      : {
          investigation: {
            id: investigationId,
            origin: { provenance: "SERVER_VERIFIED", serverVerifiedAt: checkedAt },
            corroborationCount: 1,
            checkedAt,
            promptVersion: "v1.0.0",
            provider: "OPENAI",
            model: "gpt-6.1-sol",
          },
          post: {
            platform: "WIKIPEDIA",
            externalId: "en:42",
            url: "https://en.wikipedia.org/wiki/Example",
          },
          claims: [
            {
              id: "claim-1",
              text: "Claim text",
              context: "Context around the claim text",
              summary: "Correction summary",
              reasoning: "Reasoning",
              sources: [{ url: "https://example.org/a", title: "A", snippet: "Snippet" }],
            },
          ],
        },
  getPublicPostInvestigations: async () => ({ post: null, investigations: [] }),
  searchPublicInvestigations: async () => ({
    investigations: [
      {
        id: "inv-1",
        contentHash: "b".repeat(64),
        checkedAt,
        platform: "X",
        externalId: "1234",
        url: "https://x.com/someone/status/1234",
        origin: { provenance: "CLIENT_FALLBACK", serverVerifiedAt: null },
        corroborationCount: 0,
        claimCount: 1,
        claimSummaries: [{ id: "claim-1", summary: "Correction summary" }],
      },
      {
        id: "inv-2",
        contentHash: "c".repeat(64),
        checkedAt,
        platform: "SUBSTACK",
        externalId: "99",
        url: "https://example.substack.com/p/post",
        origin: { provenance: "CLIENT_FALLBACK", serverVerifiedAt: checkedAt },
        corroborationCount: 3,
        claimCount: 0,
        claimSummaries: [],
      },
    ],
    hasMore: true,
  }),
  getPublicMetrics: async () => ({
    totalInvestigatedPosts: 0,
    investigatedPostsWithFlags: 0,
    factCheckIncidence: 0,
  }),
});

for (const [name, query] of Object.entries({
  searchInvestigationsQuery,
  publicInvestigationQuery,
})) {
  test(`frontend ${name} validates against the public GraphQL schema`, () => {
    assert.deepEqual(validate(schema, parse(query.document)), []);
  });
}

test("searchInvestigations responses parse with the frontend's shared schema", async () => {
  const result = await graphql({
    schema,
    source: searchInvestigationsQuery.document,
    variableValues: searchInvestigationsQuery.variablesSchema.parse({
      platform: "X",
      minClaimCount: 1,
    }),
    contextValue: { prisma: {} },
  });
  assert.equal(result.errors, undefined);

  const data = searchInvestigationsQuery.dataSchema.parse(overTheWire(result.data));
  assert.equal(data.searchInvestigations.investigations.length, 2);
  assert.equal(data.searchInvestigations.hasMore, true);
});

async function runPublicInvestigationQuery(investigationId: string) {
  const result = await graphql({
    schema,
    source: publicInvestigationQuery.document,
    variableValues: publicInvestigationQuery.variablesSchema.parse({ investigationId }),
    contextValue: { prisma: {} },
  });
  assert.equal(result.errors, undefined);
  return publicInvestigationQuery.dataSchema.parse(overTheWire(result.data)).publicInvestigation;
}

test("publicInvestigation responses parse with the frontend's shared schema", async () => {
  const investigation = await runPublicInvestigationQuery("inv-1");
  assert.equal(investigation?.investigation.model, "gpt-6.1-sol");
  assert.equal(investigation.claims.length, 1);
});

test("publicInvestigation answers null for an unknown investigation", async () => {
  assert.equal(await runPublicInvestigationQuery("missing"), null);
});
