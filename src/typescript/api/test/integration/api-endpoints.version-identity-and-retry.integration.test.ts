import type { InvestigatorInput } from "../../src/lib/investigators/interface.js";
import {
  InvestigatorExecutionError,
  OpenAIInvestigator,
  assert,
  buildFailedAttemptAudit,
  buildLesswrongViewInput,
  buildSucceededAttemptAudit,
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
    observedImageUrls: [firstImageUrl],
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
    observedImageUrls: [secondImageUrl],
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
    observedImageUrls: [imageUrl],
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

  const run = await prisma.investigationRun.findFirst({
    where: { investigationId: queued.investigationId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  assert.ok(run);

  const capturedInputs: InvestigatorInput[] = [];
  let invocation = 0;

  const originalInvestigateDescriptor = Object.getOwnPropertyDescriptor(
    OpenAIInvestigator.prototype,
    "investigate",
  );
  assert.ok(originalInvestigateDescriptor);
  assert.equal(typeof originalInvestigateDescriptor.value, "function");
  OpenAIInvestigator.prototype.investigate = async (input: InvestigatorInput) => {
    capturedInputs.push(structuredClone(input));
    invocation += 1;
    if (invocation === 1) {
      throw new InvestigatorExecutionError(
        "simulated transient retry path",
        buildFailedAttemptAudit("multimodal-retry-first"),
        new Error("simulated network timeout"),
      );
    }
    return {
      result: { claims: [] },
      attemptAudit: buildSucceededAttemptAudit("multimodal-retry-second"),
      modelVersion: "test-model-version",
    };
  };

  try {
    await assert.rejects(() =>
      orchestrateInvestigation(
        run.id,
        { info() {}, warn() {}, error() {} },
        {
          isLastAttempt: false,
          attemptNumber: 1,
          workerIdentity: withIntegrationPrefix("worker-retry-snapshot-first"),
        },
      ),
    );

    await orchestrateInvestigation(
      run.id,
      { info() {}, warn() {}, error() {} },
      {
        isLastAttempt: true,
        attemptNumber: 2,
        workerIdentity: withIntegrationPrefix("worker-retry-snapshot-second"),
      },
    );
  } finally {
    Object.defineProperty(
      OpenAIInvestigator.prototype,
      "investigate",
      originalInvestigateDescriptor,
    );
  }

  assert.equal(capturedInputs.length, 2);
  const [firstAttemptInput, secondAttemptInput] = capturedInputs;
  assert.ok(firstAttemptInput);
  assert.ok(secondAttemptInput);
  assert.deepEqual(secondAttemptInput, firstAttemptInput);
  assert.match(firstAttemptInput.contentMarkdown ?? "", /\[IMAGE:0\]/);
  assert.equal(firstAttemptInput.imagePlaceholders?.[0]?.matchBy, "ORIGINAL_INDEX");
});
