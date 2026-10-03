import type { InvestigatorInput } from "../../src/lib/investigators/interface.js";
import {
  InvestigatorExecutionError,
  assert,
  buildFailedAttemptAudit,
  buildLesswrongViewInput,
  buildSucceededInvestigatorOutput,
  buildXViewInput,
  createCaller,
  orchestrateInvestigation,
  prisma,
  test,
  withIntegrationPrefix,
  withMockLesswrongCanonicalHtml,
} from "./api-endpoints.integration.shared.js";

void test("investigateNow creates a new version and investigation when only image identity changes", async () => {
  const caller = createCaller({ isAuthenticated: true });
  const firstImageUrl = "https://example.com/version-a.png";
  const secondImageUrl = "https://example.com/version-b.png";

  const firstInput = buildXViewInput({
    externalId: "investigate-now-image-only-version-change-1",
    observedContentText: "The text body is unchanged between views.",
    observedImageOccurrences: [
      {
        originalIndex: 0,
        normalizedTextOffset: 0,
        sourceUrl: firstImageUrl,
      },
    ],
  });

  const firstResult = await caller.post.investigateNow(firstInput);
  const repeatedSameVersionResult = await caller.post.investigateNow(firstInput);
  assert.equal(repeatedSameVersionResult.investigationId, firstResult.investigationId);

  const secondInput = buildXViewInput({
    externalId: "investigate-now-image-only-version-change-1",
    observedContentText: "The text body is unchanged between views.",
    observedImageOccurrences: [
      {
        originalIndex: 0,
        normalizedTextOffset: 0,
        sourceUrl: secondImageUrl,
      },
    ],
  });

  const secondResult = await caller.post.investigateNow(secondInput);
  assert.notEqual(secondResult.investigationId, firstResult.investigationId);

  const post = await prisma.post.findUnique({
    where: {
      platform_externalId: {
        platform: secondInput.platform,
        externalId: secondInput.externalId,
      },
    },
    select: { id: true },
  });
  assert.ok(post);

  const versions = await prisma.postVersion.findMany({
    where: { postId: post.id },
    orderBy: { firstSeenAt: "asc" },
    select: {
      id: true,
      versionHash: true,
      contentBlob: {
        select: {
          contentHash: true,
        },
      },
      imageOccurrenceSet: {
        select: {
          occurrencesHash: true,
        },
      },
    },
  });

  assert.equal(versions.length, 2);
  const [firstVersion, secondVersion] = versions;
  assert.ok(firstVersion);
  assert.ok(secondVersion);
  assert.notEqual(firstVersion.id, secondVersion.id);
  assert.equal(firstVersion.contentBlob.contentHash, secondVersion.contentBlob.contentHash);
  assert.notEqual(
    firstVersion.imageOccurrenceSet.occurrencesHash,
    secondVersion.imageOccurrenceSet.occurrencesHash,
  );
  assert.notEqual(firstVersion.versionHash, secondVersion.versionHash);
});

void test("orchestrateInvestigation retries with identical multimodal snapshot input", async () => {
  const caller = createCaller({ isAuthenticated: true });
  const imageUrl = "https://example.com/retry-snapshot-image.png";
  const html = `<article><p>Alpha beta.</p><img src="${imageUrl}" alt="chart"/><p>Gamma delta.</p></article>`;
  const lesswrongInput = {
    ...buildLesswrongViewInput({
      externalId: "orchestrator-retry-multimodal-snapshot-1",
      htmlContent: html,
    }),
    observedImageOccurrences: [
      {
        originalIndex: 0,
        normalizedTextOffset: 0,
        sourceUrl: imageUrl,
      },
    ],
  };

  const queued = await withMockLesswrongCanonicalHtml(html, () =>
    caller.post.investigateNow(lesswrongInput),
  );
  assert.equal(queued.status, "PENDING");

  const capturedInputs: InvestigatorInput[] = [];
  let invocation = 0;

  const createInvestigator = () => ({
    investigate: async (input: InvestigatorInput) => {
      capturedInputs.push(structuredClone(input));
      invocation += 1;
      if (invocation === 1) {
        throw new InvestigatorExecutionError(
          "simulated transient retry path",
          buildFailedAttemptAudit("multimodal-retry-first"),
          new Error("simulated network timeout"),
        );
      }
      return buildSucceededInvestigatorOutput("multimodal-retry-second");
    },
  });

  await orchestrateInvestigation(
    queued.investigationId,
    { info() {}, warn() {}, error() {} },
    {
      workerIdentity: withIntegrationPrefix("worker-retry-snapshot-first"),
      createInvestigator,
    },
  );

  await orchestrateInvestigation(
    queued.investigationId,
    { info() {}, warn() {}, error() {} },
    {
      workerIdentity: withIntegrationPrefix("worker-retry-snapshot-second"),
      createInvestigator,
    },
  );

  assert.equal(capturedInputs.length, 2);
  const [firstAttemptInput, secondAttemptInput] = capturedInputs;
  assert.ok(firstAttemptInput);
  assert.ok(secondAttemptInput);
  assert.deepEqual(secondAttemptInput, firstAttemptInput);
  assert.match(firstAttemptInput.contentMarkdown ?? "", /\[IMAGE:0\]/);
  // Placeholders carry the image source URL captured at queue time, so the
  // investigator matches [IMAGE:N] to the downloaded image by URL, never by position.
  assert.deepEqual(firstAttemptInput.imagePlaceholders, [
    { index: 0, matchBy: "SOURCE_URL", sourceUrl: imageUrl },
  ]);
});
