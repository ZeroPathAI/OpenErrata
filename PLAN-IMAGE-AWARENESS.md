# Image-Aware Investigations — Post-v1 Plan

This document describes the planned upgrade to support image content in investigations.
v1 is text-only; this work is targeted for v1.x.

---

## Motivation

- v1 skips posts that contain images or other media attachments entirely. This is a
  deliberate scope cut — investigating only the text of an image-bearing post risks
  misinterpreting or missing claims that depend on the image content.
- A tweet saying "This is insane" with a screenshot of a news article is making a claim
  about the screenshot's content, not just the text. Investigating the text alone would
  either miss the claim or produce a nonsensical flag.
- Both X (media attachments) and LessWrong (inline `<img>` embeds in `htmlContent`) have
  image content that can change the meaning of a post.
- GPT-5 and Claude are multimodal — the LLM can process images natively as part of the
  investigation input. This upgrade would let us investigate image-bearing posts rather
  than skipping them.

## Scope

- **v1.x milestone: images only** (no video/audio).
- **Platforms:** X.com, Nitter (mirrors X media), LessWrong.

---

## Image Storage

We store images ourselves rather than passing third-party CDN URLs at investigation time.

**Rationale:** CDN URLs are ephemeral — X CDN links expire, LessWrong images could be
replaced or moved. If we pass the original URL at investigation time, it may 404 or return
different content.

**Approach:**

- At extraction time, download and store images in blob storage (S3 or Cloudflare R2).
- Store a content hash (SHA-256) of each image for deduplication.
- Investigation references our stored copy, not the original URL.

---

## Data Model Changes

### Existing models — new fields

- `Investigation`: add `imageUrls String[]` — URLs of stored images sent to the LLM.
- `NitterMeta`: add `mediaUrls String[]` (currently missing; mirrors `XMeta.mediaUrls`).
- `LesswrongMeta`: add `imageUrls String[]` for inline images extracted from `htmlContent`.

### New model: ImageBlob

```prisma
model ImageBlob {
  id            String   @id @default(cuid())
  contentHash   String   @unique  // SHA-256 of image bytes
  storageUrl    String             // URL in our blob storage (S3/R2)
  originalUrl   String             // Where the image was originally found
  mimeType      String             // e.g. "image/png", "image/jpeg"
  sizeBytes     Int
  createdAt     DateTime @default(now())
}
```

### TypeScript interfaces

- `PlatformContent` interface: add `imageUrls: string[]`.
- `InvestigationInput` interface: add `imageUrls?: string[]`.

---

## Content Script Changes

### X.com

Extract image URLs from media attachments:

```typescript
// Selector may need maintenance as X changes its DOM
document.querySelectorAll('[data-testid="tweetPhoto"] img');
```

### Nitter

Extract image URLs from attachment containers:

```typescript
// Varies by Nitter fork
document.querySelectorAll('.attachment img');
```

### LessWrong

Extract `<img>` src URLs from the post body HTML:

```typescript
const body = document.querySelector('[class*="ContentItemBody"]');
const images = body?.querySelectorAll('img') ?? [];
```

---

## API Changes

- `viewPost` and `investigateNow`: add `observedImageUrls?: string[]` to input.
- Server-side: on first observation, download images and store in blob storage. Deduplicate
  by content hash.
- Image URLs passed to the investigator point to our stored copies, not the original CDN
  URLs.

---

## Pipeline Changes

- Investigator receives images as multimodal input alongside text (provider-native image
  input — OpenAI vision, Anthropic image blocks).
- Flagging criteria updated: "Consider attached images when evaluating claims."
- `contentHash` remains text-only — same text with different CDN URLs should still be a
  cache hit. Image content is handled separately (image hashes stored on the investigation).

---

## Open Questions

1. **Image size limits / max images per post** — Large images need resizing before LLM
   input. What's the max resolution and max count per investigation?
2. **Storage cost budgeting** — How much blob storage budget per month? Need estimates
   based on average images per post and average image size.
3. **OCR as text fallback** — Should we OCR images as a text fallback for non-multimodal
   providers or as supplementary context? This would let text-only models still benefit
   from screenshot content.
4. **Nitter image extraction** — Do Nitter instances proxy X media through their own
   servers, or do they link directly to X/Twitter CDN URLs? This affects whether Nitter
   images expire independently of X images.
