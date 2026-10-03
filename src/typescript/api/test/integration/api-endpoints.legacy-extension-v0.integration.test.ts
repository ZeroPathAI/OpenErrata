import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import {
  isNonNullObject,
  observedImageUrlsFromOccurrences,
  type ExtensionApiProcedurePath,
} from "@openerrata/shared";
import {
  legacyBatchStatusOutputSchema,
  legacyGetInvestigationOutputSchema,
  legacyInvestigateNowOutputSchema,
  legacyRecordViewAndGetStatusOutputSchema,
  legacyRegisterObservedVersionOutputSchema,
  legacyValidateSettingsOutputSchema,
} from "../../src/lib/trpc/legacy-extension-v0/wire-schemas.js";
import {
  appRouter,
  assert,
  buildXViewInput,
  createCaller,
  createContext,
  hashContent,
  normalizeContent,
  prisma,
  seedClaimWithSource,
  seedCompleteInvestigation,
  seedInstanceApiKey,
  seedInvestigation,
  seedInvestigationForXViewInput,
  seedPostForXViewInput,
  test,
} from "./api-endpoints.integration.shared.js";

// Extensions 0.2.0–0.3.x speak the legacy v0 protocol (the API at 9ee2cae) and
// are served through the legacy-extension-v0 adapter. These tests speak that
// protocol over HTTP the way the 0.3.3 client does (tRPC httpLink: GET for
// queries, JSON POST for mutations) and hold every response to the legacy
// client's strict schemas.

const LEGACY_EXTENSION_VERSION = "0.3.3";
const CURRENT_EXTENSION_VERSION = "0.4.0";

type ApiResult = { ok: true; data: unknown } | { ok: false; status: number; code: unknown };

async function callApi(input: {
  path: ExtensionApiProcedurePath;
  kind: "query" | "mutation";
  input: unknown;
  extensionVersion: string;
  headers?: Record<string, string>;
}): Promise<ApiResult> {
  const url = new URL(`http://localhost/trpc/${input.path}`);
  const headers = new Headers({
    "x-openerrata-extension-version": input.extensionVersion,
    ...input.headers,
  });
  let request: Request;
  if (input.kind === "query") {
    if (input.input !== undefined) {
      url.searchParams.set("input", JSON.stringify(input.input));
    }
    request = new Request(url, { method: "GET", headers });
  } else {
    headers.set("content-type", "application/json");
    request = new Request(url, { method: "POST", headers, body: JSON.stringify(input.input) });
  }

  const response = await fetchRequestHandler({
    endpoint: "/trpc",
    req: request,
    router: appRouter,
    createContext: () => createContext({ request, getClientAddress: () => "203.0.113.7" }),
  });
  const body: unknown = await response.json();
  assert.ok(isNonNullObject(body));
  const result = body["result"];
  if (response.ok && isNonNullObject(result)) {
    return { ok: true, data: result["data"] };
  }
  const error = body["error"];
  assert.ok(isNonNullObject(error) && isNonNullObject(error["data"]));
  return { ok: false, status: response.status, code: error["data"]["code"] };
}

async function legacyCall(input: {
  path: ExtensionApiProcedurePath;
  kind: "query" | "mutation";
  input: unknown;
  headers?: Record<string, string>;
}): Promise<unknown> {
  const result = await callApi({ ...input, extensionVersion: LEGACY_EXTENSION_VERSION });
  assert.ok(result.ok, `legacy ${input.path} failed: ${JSON.stringify(result)}`);
  return result.data;
}

/** A 0.3.x X post as the legacy client sends it: image URLs listed beside the occurrences. */
function buildLegacyXViewInput(externalId: string) {
  const current = buildXViewInput({
    externalId,
    observedContentText: "Legacy client content with one image.",
    observedImageOccurrences: [
      { originalIndex: 0, normalizedTextOffset: 0, sourceUrl: "https://pbs.twimg.com/media/a.jpg" },
      {
        originalIndex: 1,
        normalizedTextOffset: 6,
        sourceUrl: "https://pbs.twimg.com/media/a.jpg",
      },
    ],
  });
  return {
    ...current,
    observedImageUrls: observedImageUrlsFromOccurrences(current.observedImageOccurrences),
  };
}

async function countedPageViews(version: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ pageViewCount: number }[]>`
    SELECT "pageViewCount" FROM "ExtensionVersionDailyCount"
    WHERE "version" = ${version} AND "day" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
  `;
  return rows[0]?.pageViewCount ?? 0;
}

void test("legacy registerObservedVersion accepts observedImageUrls and answers in the legacy shape", async () => {
  const input = buildLegacyXViewInput("legacy-register-1");

  const output = legacyRegisterObservedVersionOutputSchema.parse(
    await legacyCall({ path: "post.registerObservedVersion", kind: "mutation", input }),
  );

  assert.equal(output.externalId, input.externalId);
  assert.equal(output.provenance, "CLIENT_FALLBACK");
  // The image list is carried by the occurrences, so dropping it loses nothing.
  const version = await prisma.postVersion.findUniqueOrThrow({
    where: { id: output.postVersionId },
    select: {
      imageOccurrenceSet: {
        select: { occurrences: { select: { originalIndex: true, sourceUrl: true } } },
      },
    },
  });
  assert.deepEqual(
    observedImageUrlsFromOccurrences(version.imageOccurrenceSet.occurrences),
    input.observedImageUrls,
  );
});

void test("legacy registerObservedVersion rejects observedImageUrls that the occurrences do not list", async () => {
  const input = {
    ...buildLegacyXViewInput("legacy-register-unrepresentable-1"),
    observedImageUrls: ["https://pbs.twimg.com/media/not-on-the-page.jpg"],
  };

  const result = await callApi({
    path: "post.registerObservedVersion",
    kind: "mutation",
    input,
    extensionVersion: LEGACY_EXTENSION_VERSION,
  });

  assert.deepEqual(result, { ok: false, status: 400, code: "BAD_REQUEST" });
});

void test("legacy recordViewAndGetStatus reports an uninvestigated version as NOT_INVESTIGATED", async () => {
  const registered = legacyRegisterObservedVersionOutputSchema.parse(
    await legacyCall({
      path: "post.registerObservedVersion",
      kind: "mutation",
      input: buildLegacyXViewInput("legacy-record-view-none-1"),
    }),
  );

  const status = legacyRecordViewAndGetStatusOutputSchema.parse(
    await legacyCall({
      path: "post.recordViewAndGetStatus",
      kind: "mutation",
      input: { postVersionId: registered.postVersionId },
    }),
  );

  assert.deepEqual(status, {
    investigationState: "NOT_INVESTIGATED",
    priorInvestigationResult: null,
  });
});

void test("legacy recordViewAndGetStatus reports a COMPLETE investigation without its id", async () => {
  const input = buildXViewInput({
    externalId: "legacy-record-view-complete-1",
    observedContentText: "Completed content seen by a legacy client.",
  });
  const seeded = await seedInvestigationForXViewInput({
    viewInput: input,
    status: "COMPLETE",
    provenance: "CLIENT_FALLBACK",
    claimCount: 1,
  });

  const status = legacyRecordViewAndGetStatusOutputSchema.parse(
    await legacyCall({
      path: "post.recordViewAndGetStatus",
      kind: "mutation",
      input: { postVersionId: seeded.post.postVersionId },
    }),
  );

  assert.equal(status.investigationState, "INVESTIGATED");
  assert.equal(status.claims.length, 1);
});

void test("legacy recordViewAndGetStatus reports a running update as NOT_INVESTIGATED with its carried-forward claims", async () => {
  const input = buildXViewInput({
    externalId: "legacy-record-view-pending-update-1",
    observedContentText: "Original content a legacy client saw.",
  });
  const post = await seedPostForXViewInput(input);
  const parent = await seedCompleteInvestigation({
    postId: post.id,
    contentHash: post.contentHash,
    contentText: post.contentText,
    provenance: "SERVER_VERIFIED",
  });
  const survivingClaim = await seedClaimWithSource(parent.id, 1, {
    text: "Original content a legacy client saw.",
  });
  const updatedText = normalizeContent("Original content a legacy client saw. Edited sentence.");
  const pending = await seedInvestigation({
    postId: post.id,
    contentHash: await hashContent(updatedText),
    contentText: updatedText,
    provenance: "SERVER_VERIFIED",
    status: "PENDING",
    promptLabel: "legacy-record-view-pending-update",
    parentInvestigationId: parent.id,
    contentDiff: "Diff summary (line context):\n- Removed lines:\nOld\n+ Added lines:\nNew",
  });
  const pendingVersion = await prisma.investigation.findUniqueOrThrow({
    where: { id: pending.id },
    select: { postVersionId: true },
  });

  const status = legacyRecordViewAndGetStatusOutputSchema.parse(
    await legacyCall({
      path: "post.recordViewAndGetStatus",
      kind: "mutation",
      input: { postVersionId: pendingVersion.postVersionId },
    }),
  );

  assert.equal(status.investigationState, "NOT_INVESTIGATED");
  assert.ok(status.priorInvestigationResult);
  assert.equal(status.priorInvestigationResult.sourceInvestigationId, parent.id);
  assert.deepEqual(
    status.priorInvestigationResult.oldClaims.map((claim) => claim.id),
    [survivingClaim.id],
  );
});

void test("legacy recordViewAndGetStatus reports a FAILED investigation as NOT_INVESTIGATED", async () => {
  const input = buildXViewInput({
    externalId: "legacy-record-view-failed-1",
    observedContentText: "Content whose investigation failed.",
  });
  const seeded = await seedInvestigationForXViewInput({
    viewInput: input,
    status: "FAILED",
    provenance: "CLIENT_FALLBACK",
  });

  const status = legacyRecordViewAndGetStatusOutputSchema.parse(
    await legacyCall({
      path: "post.recordViewAndGetStatus",
      kind: "mutation",
      input: { postVersionId: seeded.post.postVersionId },
    }),
  );

  assert.deepEqual(status, {
    investigationState: "NOT_INVESTIGATED",
    priorInvestigationResult: null,
  });
});

void test("legacy getInvestigation answers every investigation state in the legacy shape", async () => {
  for (const [index, state] of (["COMPLETE", "PROCESSING", "FAILED"] as const).entries()) {
    const seeded = await seedInvestigationForXViewInput({
      viewInput: buildXViewInput({
        externalId: `legacy-get-investigation-${index.toString()}`,
        observedContentText: `Legacy polling content ${index.toString()}.`,
      }),
      status: state,
      provenance: "CLIENT_FALLBACK",
      claimCount: 1,
    });

    const output = legacyGetInvestigationOutputSchema.parse(
      await legacyCall({
        path: "post.getInvestigation",
        kind: "query",
        input: { investigationId: seeded.investigationId },
      }),
    );

    const expectedState = {
      COMPLETE: "INVESTIGATED",
      PROCESSING: "INVESTIGATING",
      FAILED: "FAILED",
    }[state];
    assert.equal(output.investigationState, expectedState);
  }

  const unknown = legacyGetInvestigationOutputSchema.parse(
    await legacyCall({
      path: "post.getInvestigation",
      kind: "query",
      input: { investigationId: "legacy-unknown-investigation" },
    }),
  );
  assert.equal(unknown.investigationState, "NOT_INVESTIGATED");
});

void test("legacy client flow: register, view, investigateNow, then poll the investigation", async () => {
  const rawKey = "legacy-v0-instance-key";
  await seedInstanceApiKey({ name: "legacy-v0", rawKey });
  const registered = legacyRegisterObservedVersionOutputSchema.parse(
    await legacyCall({
      path: "post.registerObservedVersion",
      kind: "mutation",
      input: buildLegacyXViewInput("legacy-investigate-now-1"),
    }),
  );

  const investigateNow = legacyInvestigateNowOutputSchema.parse(
    await legacyCall({
      path: "post.investigateNow",
      kind: "mutation",
      input: { postVersionId: registered.postVersionId },
      headers: { "x-api-key": rawKey },
    }),
  );
  assert.equal(investigateNow.status, "PENDING");

  const polled = legacyGetInvestigationOutputSchema.parse(
    await legacyCall({
      path: "post.getInvestigation",
      kind: "query",
      input: { investigationId: investigateNow.investigationId },
    }),
  );
  assert.equal(polled.investigationState, "INVESTIGATING");
});

void test("legacy validateSettings and batchStatus answer in the legacy shape", async () => {
  const settings = legacyValidateSettingsOutputSchema.parse(
    await legacyCall({ path: "post.validateSettings", kind: "query", input: undefined }),
  );
  assert.deepEqual(settings, { instanceApiKeyAccepted: false, openaiApiKeyStatus: "missing" });

  const input = buildXViewInput({
    externalId: "legacy-batch-status-1",
    observedContentText: "Batch status content for a legacy client.",
  });
  const seeded = await seedInvestigationForXViewInput({
    viewInput: input,
    status: "COMPLETE",
    provenance: "CLIENT_FALLBACK",
    claimCount: 2,
  });
  const batch = legacyBatchStatusOutputSchema.parse(
    await legacyCall({
      path: "post.batchStatus",
      kind: "query",
      input: {
        posts: [
          { platform: "X", externalId: input.externalId, versionHash: seeded.post.versionHash },
        ],
      },
    }),
  );
  assert.deepEqual(batch.statuses, [
    {
      platform: "X",
      externalId: input.externalId,
      investigationState: "INVESTIGATED",
      incorrectClaimCount: 2,
    },
  ]);
});

void test("0.4.0 clients get the current protocol, not the legacy one", async () => {
  const legacyShapedInput = buildLegacyXViewInput("current-protocol-unadapted-1");
  const rejected = await callApi({
    path: "post.registerObservedVersion",
    kind: "mutation",
    input: legacyShapedInput,
    extensionVersion: CURRENT_EXTENSION_VERSION,
  });
  assert.deepEqual(rejected, { ok: false, status: 400, code: "BAD_REQUEST" });

  const seeded = await seedInvestigationForXViewInput({
    viewInput: buildXViewInput({
      externalId: "current-protocol-unadapted-2",
      observedContentText: "Failed content seen by a current client.",
    }),
    status: "FAILED",
    provenance: "CLIENT_FALLBACK",
  });
  const status = await callApi({
    path: "post.recordViewAndGetStatus",
    kind: "mutation",
    input: { postVersionId: seeded.post.postVersionId },
    extensionVersion: CURRENT_EXTENSION_VERSION,
  });
  assert.deepEqual(status, {
    ok: true,
    data: {
      investigationState: "FAILED",
      investigationId: seeded.investigationId,
      provenance: "CLIENT_FALLBACK",
    },
  });
});

void test("extensions below 0.2.0 still get UPGRADE_REQUIRED", async () => {
  const result = await callApi({
    path: "post.registerObservedVersion",
    kind: "mutation",
    input: buildLegacyXViewInput("legacy-below-floor-1"),
    extensionVersion: "0.1.4",
  });
  assert.deepEqual(result, { ok: false, status: 412, code: "PRECONDITION_FAILED" });
});

void test("recordViewAndGetStatus counts one page view per call against its extension version and UTC day", async () => {
  const legacyBefore = await countedPageViews(LEGACY_EXTENSION_VERSION);
  const currentBefore = await countedPageViews(CURRENT_EXTENSION_VERSION);

  const registered = legacyRegisterObservedVersionOutputSchema.parse(
    await legacyCall({
      path: "post.registerObservedVersion",
      kind: "mutation",
      input: buildLegacyXViewInput("version-counts-1"),
    }),
  );
  // Registering a version is not a page view.
  assert.equal(await countedPageViews(LEGACY_EXTENSION_VERSION), legacyBefore);

  for (let view = 0; view < 2; view += 1) {
    await legacyCall({
      path: "post.recordViewAndGetStatus",
      kind: "mutation",
      input: { postVersionId: registered.postVersionId },
    });
  }
  await createCaller({ extensionVersion: CURRENT_EXTENSION_VERSION }).post.recordViewAndGetStatus({
    postVersionId: registered.postVersionId,
  });

  assert.equal(await countedPageViews(LEGACY_EXTENSION_VERSION), legacyBefore + 2);
  assert.equal(await countedPageViews(CURRENT_EXTENSION_VERSION), currentBefore + 1);
});
