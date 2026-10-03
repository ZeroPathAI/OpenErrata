/**
 * Canned public-API responses (GraphQL `data` payloads) shared by the unit
 * tests and the e2e mock API. They follow the shared public output schemas;
 * the "hostile" variants carry values the site must never render as-is.
 */

export const GOOD_INVESTIGATION_ID = "inv-good";
export const JAVASCRIPT_POST_URL_INVESTIGATION_ID = "inv-javascript-post-url";

/** Search query the mock API answers with an HTTP 500. */
export const API_FAILURE_SEARCH_QUERY = "__api_failure__";

export const HOSTILE_REASONING =
  "### Evidence\n\n" +
  "See [the report](https://example.org/report) and [click me](javascript:alert(document.domain)).\n\n" +
  "![tracker](https://tracker.example/pixel.png)";

const checkedAt = "2026-09-30T12:00:00.000Z";

export const goodPublicInvestigation = {
  investigation: {
    id: GOOD_INVESTIGATION_ID,
    corroborationCount: 2,
    checkedAt,
    promptVersion: "v1.0.0",
    provider: "OPENAI",
    model: "gpt-6.1-sol",
    origin: { provenance: "SERVER_VERIFIED", serverVerifiedAt: checkedAt },
  },
  post: {
    platform: "LESSWRONG",
    externalId: "abc123",
    url: "https://www.lesswrong.com/posts/abc123/example-post",
  },
  claims: [
    {
      id: "claim-1",
      text: "The Eiffel Tower was completed in 1899.",
      context: "Paris landmarks: The Eiffel Tower was completed in 1899. It remains popular.",
      summary: "The Eiffel Tower was completed in 1889, not 1899.",
      reasoning: HOSTILE_REASONING,
      sources: [
        {
          url: "https://example.org/report",
          title: "Eiffel Tower history",
          snippet: "Construction finished in March 1889.",
        },
        {
          url: "https://example.org/report",
          title: "Same source cited twice",
          snippet: "Opened for the 1889 World's Fair.",
        },
      ],
    },
  ],
};

export const javascriptPostUrlInvestigation = {
  ...goodPublicInvestigation,
  investigation: {
    ...goodPublicInvestigation.investigation,
    id: JAVASCRIPT_POST_URL_INVESTIGATION_ID,
  },
  post: {
    ...goodPublicInvestigation.post,
    // eslint-disable-next-line no-script-url -- hostile value the site must refuse to link
    url: "javascript:alert(document.domain)",
  },
};

export const searchInvestigationsResult = {
  investigations: [
    {
      id: GOOD_INVESTIGATION_ID,
      contentHash: "a".repeat(64),
      checkedAt,
      platform: "LESSWRONG",
      externalId: "abc123",
      url: "https://www.lesswrong.com/posts/abc123/example-post",
      corroborationCount: 2,
      claimCount: 1,
      claimSummaries: [
        { id: "claim-1", summary: "The Eiffel Tower was completed in 1889, not 1899." },
      ],
      origin: { provenance: "CLIENT_FALLBACK", serverVerifiedAt: null },
    },
  ],
  hasMore: false,
};
