import assert from "node:assert/strict";
import { test } from "node:test";
import {
  carryForwardClaims,
  findCarriedForwardClaims,
  loadInvestigationWithClaims,
  maybeRecordCorroboration,
  parseProgressClaims,
  requireCompleteCheckedAtIso,
  unreachableInvestigationStatus,
  type InvestigationRepository,
} from "../../src/lib/trpc/routes/post/investigation-queries.js";

function nullRepo(): InvestigationRepository {
  return {
    findInvestigationWithClaims: async () => null,
    findLatestCompleteOnOtherVersion: async () => null,
    findClientFallbackInvestigationId: async () => null,
    recordCorroborationCredit: async () => {},
  };
}

function claim(id: string, text: string) {
  return {
    id,
    text,
    context: `Context of ${text}`,
    summary: `Summary of ${text}`,
    reasoning: `Reasoning about ${text}`,
    sources: [{ url: `https://example.com/${id}`, title: `Source ${id}`, snippet: "Snippet" }],
  };
}

test("requireCompleteCheckedAtIso returns ISO and throws when checkedAt is missing", () => {
  const checkedAt = new Date("2026-02-28T12:34:56.789Z");
  assert.equal(requireCompleteCheckedAtIso("inv-1", checkedAt), checkedAt.toISOString());

  assert.throws(() => requireCompleteCheckedAtIso("inv-2", null), /COMPLETE with null checkedAt/);
});

test("carryForwardClaims keeps exactly the claims whose text still occurs in the content", () => {
  const source = {
    id: "source-investigation-id",
    claims: [
      claim("claim_kept", "The moon is made of cheese."),
      claim("claim_removed", "Mars has three moons."),
    ],
  };
  const contentText = "Intro. The moon is made of cheese. Mars has two moons.";

  assert.deepEqual(carryForwardClaims(source, contentText), {
    sourceInvestigationId: "source-investigation-id",
    oldClaims: [claim("claim_kept", "The moon is made of cheese.")],
  });
});

test("carryForwardClaims is null when no claim survives", () => {
  const source = { id: "source", claims: [claim("claim_1", "Removed sentence.")] };
  assert.equal(carryForwardClaims(source, "Entirely rewritten post."), null);
  assert.equal(carryForwardClaims({ id: "source", claims: [] }, "Any text."), null);
});

test("carryForwardClaims matches claim text after content normalization", () => {
  // Content text is normalized (§3.8): curly quotes and dashes become ASCII
  // and whitespace collapses. A claim quoting the page's original typography
  // still occurs in it.
  const source = {
    id: "source",
    claims: [claim("claim_1", "It\u2019s  a \u201Ctest\u201D \u2014 really.")],
  };
  const result = carryForwardClaims(source, `Prefix. It's a "test" - really. Suffix.`);
  assert.equal(result?.oldClaims.length, 1);
});

test("carryForwardClaims never carries a claim whose text normalizes to nothing", () => {
  const source = { id: "source", claims: [claim("claim_1", " \u200B ")] };
  assert.equal(carryForwardClaims(source, "Some content."), null);
});

test("findCarriedForwardClaims excludes the requested version and filters the latest complete source", async () => {
  const lookups: { postId: string; excludedPostVersionId: string }[] = [];
  const repo: InvestigationRepository = {
    ...nullRepo(),
    findLatestCompleteOnOtherVersion: async (postId, excludedPostVersionId) => {
      lookups.push({ postId, excludedPostVersionId });
      return {
        id: "source",
        claims: [claim("claim_1", "Kept sentence."), claim("claim_2", "Gone sentence.")],
      };
    },
  };

  const result = await findCarriedForwardClaims(repo, {
    id: "requested-version",
    postId: "post-1",
    contentText: "Kept sentence. New sentence.",
  });

  assert.deepEqual(lookups, [{ postId: "post-1", excludedPostVersionId: "requested-version" }]);
  assert.deepEqual(
    result?.oldClaims.map((c) => c.id),
    ["claim_1"],
  );
  assert.equal(
    await findCarriedForwardClaims(nullRepo(), {
      id: "requested-version",
      postId: "post-1",
      contentText: "Kept sentence.",
    }),
    null,
  );
});

test("unreachableInvestigationStatus throws explicit internal error", () => {
  assert.throws(
    () => unreachableInvestigationStatus("UNKNOWN" as never),
    /Unexpected investigation status: UNKNOWN/,
  );
});

test("parseProgressClaims fails fast on malformed progress payload", () => {
  assert.throws(
    () => parseProgressClaims({ pending: ["bad"], confirmed: [] }),
    /progressClaims failed schema validation/,
  );
});

test("load helper delegates to repository method", async () => {
  assert.equal(await loadInvestigationWithClaims(nullRepo(), "inv-1"), null);
});

test("maybeRecordCorroboration gates on auth and delegates to repository", async () => {
  let lookupCalls = 0;
  let creditCalls = 0;
  const errors: Error[] = [new Error("unexpected")];

  const repo: InvestigationRepository = {
    ...nullRepo(),
    findClientFallbackInvestigationId: async () => {
      lookupCalls += 1;
      return lookupCalls === 1 ? null : "investigation-id";
    },
    recordCorroborationCredit: async () => {
      creditCalls += 1;
      const maybeError = errors.shift();
      if (maybeError !== undefined) {
        throw maybeError;
      }
    },
  };

  // Not authenticated — skipped entirely.
  await maybeRecordCorroboration(repo, "pv-1", "viewer-key", false);
  assert.equal(lookupCalls, 0);
  assert.equal(creditCalls, 0);

  // Authenticated but no client-fallback investigation found.
  await maybeRecordCorroboration(repo, "pv-1", "viewer-key", true);
  assert.equal(lookupCalls, 1);
  assert.equal(creditCalls, 0);

  // Authenticated with matching investigation — error propagates.
  await assert.rejects(
    () => maybeRecordCorroboration(repo, "pv-1", "viewer-key", true),
    /unexpected/,
  );
  assert.equal(lookupCalls, 2);
  assert.equal(creditCalls, 1);

  // Success path.
  await maybeRecordCorroboration(repo, "pv-1", "viewer-key", true);
  assert.equal(lookupCalls, 3);
  assert.equal(creditCalls, 2);
});
