/**
 * DB Trigger Behavioral Tests
 *
 * These tests verify that PostgreSQL triggers enforce data model invariants
 * at runtime. The existing `assertSchemaCatalogInvariants()` validates trigger
 * presence/structure but not behavior. These tests exercise the actual trigger
 * logic by creating real database records and verifying that invalid mutations
 * are rejected.
 *
 * Requires a running PostgreSQL instance (same as other integration tests).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { hashContent, normalizeContent } from "@openerrata/shared";

process.env["NODE_ENV"] = "test";
process.env["DATABASE_URL"] ??= "postgresql://openerrata:openerrata_dev@localhost:5433/openerrata";

const { getPrisma } = await import("../../src/lib/db/client.js");
const prisma = getPrisma();

const TEST_PREFIX = `trigger-test-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}-`;

// ── Helpers ─────────────────────────────────────────────────────────────

function uniqueId(label: string): string {
  return `${TEST_PREFIX}${label}-${randomUUID().slice(0, 8)}`;
}

async function createTestPost(
  platform: "LESSWRONG" | "X" | "SUBSTACK" | "WIKIPEDIA" = "LESSWRONG",
) {
  const externalId = uniqueId("post");
  return prisma.post.create({
    data: {
      platform,
      externalId,
      url: `https://example.com/${externalId}`,
    },
  });
}

async function createContentBlob(
  text = "test content",
): Promise<{ id: string; contentHash: string }> {
  const normalized = normalizeContent(text);
  const contentHash = await hashContent(normalized);
  const blob = await prisma.contentBlob.upsert({
    where: { contentHash },
    create: {
      contentHash,
      contentText: normalized,
      wordCount: normalized.split(/\s+/).length,
    },
    update: {},
  });
  return { id: blob.id, contentHash };
}

async function createImageOccurrenceSet(): Promise<string> {
  const hash = await hashContent(uniqueId("ios"));
  const ios = await prisma.imageOccurrenceSet.create({
    data: { occurrencesHash: hash },
  });
  return ios.id;
}

async function createHtmlBlob(html = "<p>test</p>"): Promise<string> {
  const htmlHash = await hashContent(html + uniqueId("html"));
  const blob = await prisma.htmlBlob.create({
    data: { htmlHash, htmlContent: html },
  });
  return blob.id;
}

async function createPostVersion(postId: string, options?: { serverVerifiedAt?: Date | null }) {
  const { id: contentBlobId, contentHash } = await createContentBlob(uniqueId("content"));
  const imageOccurrenceSetId = await createImageOccurrenceSet();
  const versionHash = await hashContent(contentHash + uniqueId("vh"));

  return prisma.postVersion.create({
    data: {
      postId,
      versionHash,
      contentBlobId,
      imageOccurrenceSetId,
      serverVerifiedAt: options?.serverVerifiedAt ?? null,
    },
  });
}

async function createPrompt(): Promise<string> {
  const version = uniqueId("prompt");
  const text = "test prompt text";
  const hash = await hashContent(text + version);
  const prompt = await prisma.prompt.create({
    data: { version, hash, text },
  });
  return prompt.id;
}

async function createInvestigation(
  postVersionId: string,
  options?: {
    status?: "PENDING" | "PROCESSING" | "COMPLETE" | "FAILED";
    parentInvestigationId?: string | null;
    contentDiff?: string | null;
    provenance?: "SERVER_VERIFIED" | "CLIENT_FALLBACK";
    checkedAt?: Date | null;
  },
) {
  const promptId = await createPrompt();
  const status = options?.status ?? "PENDING";
  const investigationId = randomUUID();
  const contentHash = await hashContent(uniqueId("inv-content"));

  // Create InvestigationInput first (required by the Investigation FK)
  await prisma.investigationInput.create({
    data: {
      investigationId,
      provenance: options?.provenance ?? "SERVER_VERIFIED",
      contentHash,
      markdownSource: "NONE",
      markdown: null,
      markdownRendererVersion: null,
    },
  });

  return prisma.investigation.create({
    data: {
      id: investigationId,
      postVersionId,
      inputId: investigationId,
      parentInvestigationId: options?.parentInvestigationId ?? null,
      contentDiff: options?.contentDiff ?? null,
      status,
      promptId,
      provider: "OPENAI",
      model: "OPENAI_GPT_5",
      checkedAt: options?.checkedAt ?? (status === "COMPLETE" ? new Date() : null),
    },
  });
}

// ── Cleanup ─────────────────────────────────────────────────────────────

after(async () => {
  // Clean up test data using prefix-based cascade
  const testPosts = await prisma.post.findMany({
    where: { externalId: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const postIds = testPosts.map((p) => p.id);

  if (postIds.length > 0) {
    const investigations = await prisma.investigation.findMany({
      where: { postVersion: { postId: { in: postIds } } },
      select: { id: true },
    });
    const investigationIds = investigations.map((i) => i.id);

    await prisma.$transaction(async (tx) => {
      if (investigationIds.length > 0) {
        await tx.source.deleteMany({
          where: {
            claimId: {
              in: await tx.claim
                .findMany({
                  where: { investigationId: { in: investigationIds } },
                  select: { id: true },
                })
                .then((c) => c.map((x) => x.id)),
            },
          },
        });
        await tx.claim.deleteMany({ where: { investigationId: { in: investigationIds } } });
        await tx.investigationImage.deleteMany({
          where: { investigationId: { in: investigationIds } },
        });
        await tx.corroborationCredit.deleteMany({
          where: { investigationId: { in: investigationIds } },
        });
        await tx.investigation.deleteMany({ where: { id: { in: investigationIds } } });
        await tx.investigationInput.deleteMany({
          where: { investigationId: { in: investigationIds } },
        });
      }

      // Delete version metas before post versions
      for (const postId of postIds) {
        const pvs = await tx.postVersion.findMany({ where: { postId }, select: { id: true } });
        const pvIds = pvs.map((pv) => pv.id);
        if (pvIds.length > 0) {
          await tx.lesswrongVersionMeta.deleteMany({ where: { postVersionId: { in: pvIds } } });
          await tx.xVersionMeta.deleteMany({ where: { postVersionId: { in: pvIds } } });
          await tx.substackVersionMeta.deleteMany({ where: { postVersionId: { in: pvIds } } });
          await tx.wikipediaVersionMeta.deleteMany({ where: { postVersionId: { in: pvIds } } });
        }
      }

      await tx.postVersion.deleteMany({ where: { postId: { in: postIds } } });
      await tx.post.deleteMany({ where: { id: { in: postIds } } });
    });
  }

  // Clean up prompts
  await prisma.prompt.deleteMany({
    where: { version: { startsWith: TEST_PREFIX } },
  });
});

// ── 3a: serverVerifiedAt one-way latch ──────────────────────────────────

describe("serverVerifiedAt one-way latch trigger", () => {
  test("null → timestamp succeeds", async () => {
    const post = await createTestPost();
    const pv = await createPostVersion(post.id, { serverVerifiedAt: null });

    // Create a LesswrongVersionMeta with server HTML so the deferred
    // constraint trigger (enforce_server_verified_html_snapshot) won't
    // reject the serverVerifiedAt update.
    const htmlBlobId = await createHtmlBlob();
    await prisma.lesswrongVersionMeta.create({
      data: {
        postVersionId: pv.id,
        slug: uniqueId("slug"),
        serverHtmlBlobId: htmlBlobId,
        imageUrls: [],
        tags: [],
      },
    });

    const updated = await prisma.postVersion.update({
      where: { id: pv.id },
      data: { serverVerifiedAt: new Date() },
    });

    assert.ok(updated.serverVerifiedAt !== null);
  });

  test("timestamp → different timestamp is rejected", async () => {
    const post = await createTestPost();
    const htmlBlobId = await createHtmlBlob();
    // Use null initially, then set serverVerifiedAt after VersionMeta exists
    const pv = await createPostVersion(post.id, { serverVerifiedAt: null });
    await prisma.lesswrongVersionMeta.create({
      data: {
        postVersionId: pv.id,
        slug: uniqueId("slug"),
        serverHtmlBlobId: htmlBlobId,
        imageUrls: [],
        tags: [],
      },
    });
    // Set initial timestamp
    await prisma.postVersion.update({
      where: { id: pv.id },
      data: { serverVerifiedAt: new Date("2024-01-01") },
    });

    // Now try to change it — should be rejected by the latch trigger
    await assert.rejects(
      prisma.postVersion.update({
        where: { id: pv.id },
        data: { serverVerifiedAt: new Date("2025-01-01") },
      }),
      (err: Error) => {
        assert.ok(
          err.message.includes("one-way latch") || err.message.includes("serverVerifiedAt"),
          `Expected latch error, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  test("timestamp → null is rejected", async () => {
    const post = await createTestPost();
    const htmlBlobId = await createHtmlBlob();
    const pv = await createPostVersion(post.id, { serverVerifiedAt: null });
    await prisma.lesswrongVersionMeta.create({
      data: {
        postVersionId: pv.id,
        slug: uniqueId("slug"),
        serverHtmlBlobId: htmlBlobId,
        imageUrls: [],
        tags: [],
      },
    });
    await prisma.postVersion.update({
      where: { id: pv.id },
      data: { serverVerifiedAt: new Date() },
    });

    await assert.rejects(
      prisma.postVersion.update({
        where: { id: pv.id },
        data: { serverVerifiedAt: null },
      }),
      (err: Error) => {
        assert.ok(
          err.message.includes("one-way latch") || err.message.includes("serverVerifiedAt"),
          `Expected latch error, got: ${err.message}`,
        );
        return true;
      },
    );
  });
});

// ── 3b: InvestigationInput immutability ─────────────────────────────────

describe("InvestigationInput immutability trigger", () => {
  test("UPDATE markdown is rejected", async () => {
    const post = await createTestPost();
    const pv = await createPostVersion(post.id);
    const inv = await createInvestigation(pv.id);

    await assert.rejects(
      prisma.investigationInput.update({
        where: { investigationId: inv.id },
        data: { markdown: "modified markdown" },
      }),
      (err: Error) => {
        assert.ok(
          err.message.includes("immutable") ||
            err.message.includes("InvestigationInput") ||
            err.message.includes("updates"),
          `Expected immutability error, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  test("UPDATE provenance is rejected", async () => {
    const post = await createTestPost();
    const pv = await createPostVersion(post.id);
    const inv = await createInvestigation(pv.id, { provenance: "SERVER_VERIFIED" });

    await assert.rejects(
      prisma.investigationInput.update({
        where: { investigationId: inv.id },
        data: { provenance: "CLIENT_FALLBACK" },
      }),
      (err: Error) => {
        assert.ok(
          err.message.includes("immutable") ||
            err.message.includes("InvestigationInput") ||
            err.message.includes("updates"),
          `Expected immutability error, got: ${err.message}`,
        );
        return true;
      },
    );
  });
});

// ── 3c: VersionMeta mutability policy ───────────────────────────────────

describe("VersionMeta mutability policy triggers", () => {
  test("LesswrongVersionMeta: serverHtmlBlobId null→non-null succeeds", async () => {
    const post = await createTestPost("LESSWRONG");
    const pv = await createPostVersion(post.id);
    // CHECK requires at least one HTML blob; start with client-only
    const clientHtmlBlobId = await createHtmlBlob("<p>client html</p>");
    await prisma.lesswrongVersionMeta.create({
      data: {
        postVersionId: pv.id,
        slug: uniqueId("slug"),
        serverHtmlBlobId: null,
        clientHtmlBlobId,
        imageUrls: [],
        tags: [],
      },
    });

    const serverHtmlBlobId = await createHtmlBlob("<p>server html</p>");
    const updated = await prisma.lesswrongVersionMeta.update({
      where: { postVersionId: pv.id },
      data: { serverHtmlBlobId },
    });
    assert.equal(updated.serverHtmlBlobId, serverHtmlBlobId);
  });

  test("LesswrongVersionMeta: metadata update (latest-wins) succeeds", async () => {
    // Migration 0020 made most metadata fields latest-wins (slug, title,
    // karma, tags, etc.). Only postVersionId and createdAt are immutable.
    const post = await createTestPost("LESSWRONG");
    const pv = await createPostVersion(post.id);
    const htmlBlobId = await createHtmlBlob();
    await prisma.lesswrongVersionMeta.create({
      data: {
        postVersionId: pv.id,
        slug: uniqueId("slug"),
        serverHtmlBlobId: htmlBlobId,
        imageUrls: [],
        tags: [],
      },
    });

    const updated = await prisma.lesswrongVersionMeta.update({
      where: { postVersionId: pv.id },
      data: { slug: "updated-slug", title: "New Title", karma: 42 },
    });
    assert.equal(updated.slug, "updated-slug");
    assert.equal(updated.title, "New Title");
    assert.equal(updated.karma, 42);
  });

  test("LesswrongVersionMeta: clientHtmlBlobId non-null→different is rejected (first-write-wins)", async () => {
    const post = await createTestPost("LESSWRONG");
    const pv = await createPostVersion(post.id);
    const serverHtmlBlobId = await createHtmlBlob("<p>server</p>");
    const clientHtmlBlobId = await createHtmlBlob("<p>client</p>");
    await prisma.lesswrongVersionMeta.create({
      data: {
        postVersionId: pv.id,
        slug: uniqueId("slug"),
        serverHtmlBlobId,
        clientHtmlBlobId,
        imageUrls: [],
        tags: [],
      },
    });

    const differentClientBlobId = await createHtmlBlob("<p>different client</p>");
    await assert.rejects(
      prisma.lesswrongVersionMeta.update({
        where: { postVersionId: pv.id },
        data: { clientHtmlBlobId: differentClientBlobId },
      }),
      (err: Error) => {
        assert.ok(
          err.message.includes("immutability") || err.message.includes("LesswrongVersionMeta"),
          `Expected immutability error, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  test("XVersionMeta: any update is rejected", async () => {
    const post = await createTestPost("X");
    const pv = await createPostVersion(post.id);
    await prisma.xVersionMeta.create({
      data: {
        postVersionId: pv.id,
        tweetId: uniqueId("tweet"),
        text: "original tweet text",
        authorHandle: "testuser",
        mediaUrls: [],
      },
    });

    await assert.rejects(
      prisma.xVersionMeta.update({
        where: { postVersionId: pv.id },
        data: { text: "modified text" },
      }),
      (err: Error) => {
        assert.ok(
          err.message.includes("immutable") ||
            err.message.includes("XVersionMeta") ||
            err.message.includes("reject"),
          `Expected immutability error, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  test("WikipediaVersionMeta: serverHtmlBlobId enrichment succeeds", async () => {
    const post = await createTestPost("WIKIPEDIA");
    const pv = await createPostVersion(post.id);
    // CHECK requires at least one HTML blob; start with client-only, then enrich server
    const clientHtmlBlobId = await createHtmlBlob("<p>client html</p>");
    await prisma.wikipediaVersionMeta.create({
      data: {
        postVersionId: pv.id,
        pageId: uniqueId("page"),
        language: "en",
        title: "Test Article",
        revisionId: uniqueId("rev"),
        serverHtmlBlobId: null,
        clientHtmlBlobId,
        imageUrls: [],
      },
    });

    const serverHtmlBlobId = await createHtmlBlob("<p>server html</p>");
    const updated = await prisma.wikipediaVersionMeta.update({
      where: { postVersionId: pv.id },
      data: { serverHtmlBlobId },
    });
    assert.equal(updated.serverHtmlBlobId, serverHtmlBlobId);
  });
});

// ── 3d: Investigation parent semantics ──────────────────────────────────

describe("Investigation parent semantics trigger", () => {
  test("parent not COMPLETE is rejected", async () => {
    const post = await createTestPost();
    const pv1 = await createPostVersion(post.id);
    const pv2 = await createPostVersion(post.id);

    // Create a PENDING parent
    const parent = await createInvestigation(pv1.id, {
      status: "PENDING",
      provenance: "SERVER_VERIFIED",
    });

    await assert.rejects(
      createInvestigation(pv2.id, {
        parentInvestigationId: parent.id,
        contentDiff: "some diff",
        provenance: "SERVER_VERIFIED",
      }),
      (err: Error) => {
        assert.ok(
          err.message.includes("COMPLETE") || err.message.includes("parent"),
          `Expected parent status error, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  test("parent on different post is rejected", async () => {
    const post1 = await createTestPost();
    const post2 = await createTestPost();
    const pv1 = await createPostVersion(post1.id);
    const pv2 = await createPostVersion(post2.id);

    const parent = await createInvestigation(pv1.id, {
      status: "COMPLETE",
      provenance: "SERVER_VERIFIED",
      checkedAt: new Date(),
    });

    await assert.rejects(
      createInvestigation(pv2.id, {
        parentInvestigationId: parent.id,
        contentDiff: "some diff",
        provenance: "SERVER_VERIFIED",
      }),
      (err: Error) => {
        assert.ok(
          err.message.includes("post") || err.message.includes("parent"),
          `Expected same-post error, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  test("parent not SERVER_VERIFIED is rejected", async () => {
    const post = await createTestPost();
    const pv1 = await createPostVersion(post.id);
    const pv2 = await createPostVersion(post.id);

    const parent = await createInvestigation(pv1.id, {
      status: "COMPLETE",
      provenance: "CLIENT_FALLBACK",
      checkedAt: new Date(),
    });

    await assert.rejects(
      createInvestigation(pv2.id, {
        parentInvestigationId: parent.id,
        contentDiff: "some diff",
        provenance: "SERVER_VERIFIED",
      }),
      (err: Error) => {
        assert.ok(
          err.message.includes("SERVER_VERIFIED") ||
            err.message.includes("provenance") ||
            err.message.includes("parent"),
          `Expected provenance error, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  test("valid parent (COMPLETE + SERVER_VERIFIED + same post) succeeds", async () => {
    const post = await createTestPost();
    const pv1 = await createPostVersion(post.id);
    const pv2 = await createPostVersion(post.id);

    const parent = await createInvestigation(pv1.id, {
      status: "COMPLETE",
      provenance: "SERVER_VERIFIED",
      checkedAt: new Date(),
    });

    const child = await createInvestigation(pv2.id, {
      parentInvestigationId: parent.id,
      contentDiff: "some content diff",
      provenance: "SERVER_VERIFIED",
    });

    assert.equal(child.parentInvestigationId, parent.id);
  });
});
