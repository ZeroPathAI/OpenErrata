# OpenErrata

A browser extension that investigates the content people are reading throughout the internet with
LLMs, and provides inline rebuttals to empirically incorrect or unambiguously misleading
information.

---

# Part 1 — Design Goals

## 1.1 Problem

People on the internet frequently make content that accidentally or purposely misleads their users.
They cite non-existent or modified empirical claims based on incorrect statistics, papers, quotes,
and facts about the world. They misrepresent the positions of other users or the content of previous
conversations, they modify past predictions and the predictions of others to make themselves look
better, and soften or withhold key facts that would make their intended takeaways harder to swallow.

Even good-faith readers currently have no efficient way to verify the things they read without
either knowing everything about the world up front, successfully predicting which claims to verify
on their own, or relying on other users to do their homework for them. This is time-consuming, and
duplicates the work of staying sane across every user. Usually it just ends up just not being done.

## 1.2 Basic solution

Give people a browser extension that tells them whether the content they're reading is incorrect or
misleading.

## 1.3 Initial Goals (v1)

1. **Inline fact-checking** — The system should highlight empirically incorrect
   information inside posts people read, with an extremely low false positive
   rate.
2. **Non-intrusive UX** — The extension should enhance the reading experience
   without disrupting it. Unchecked posts show nothing; checked posts'
   highlights should color code the type of correction and show a summary of
   why the claim is incorrect on hover; the hover should include a link to the
   full investigation/breakdown.
3. **Data Collection** - As a side effect of the system's operations, we should
   develop a public database of individual authors and their incorrect claims,
   and gather data for incidence metrics such as the percentage of investigated
   posts that receive at least one fact check.
4. **Transparency** — the design goals, design, spec, and code of openerrata
   should be transparent and available for public inspection, as well as the
   individual investigations that this system makes. Users should be able to
   access as much information about the logic behind individual decisions as
   they need.
5. **Unimpeachable results** - Public trust in the system is more important
   than fact checking any particular claim, and the system's decisions will be
   adversarially scrutinized, and so the system should restrict its fact checks
   to things that are relatively uncontestable. Users in any particular tribe
   should be expected to read any given fact check and update their opinion of
   the post's content. If they're not expected to do that then we should
   refrain from marking up the post, even if it means a false negative.

---

# Part 2 — Design

## 2.1 Scope

v1 ships fact-checking for posts on LessWrong, X, and Substack. Investigations
use post text plus attached images when available. Posts with videos are
skipped.

Users can trigger investigations in two ways (both async queued):

- Instance-managed credentials
- A user provided OpenAI key

In addition to user-requested investigations (which are shared with everyone
who uses the same service), service operators can configure regular
investigations of posts, based on a measure designed to investigate the posts
most likely to be read by users in the future.

The following are explicitly out of scope:

**Not in v1 (but will be attempted in the future):**

- Additional platforms beyond LessWrong, X, and Substack.
- Analysis types other than fact-checking — the model supports extensibility, but v1
  doesn't ship it.
- Fact-checking comments or threads, in addition to top-level isolated posts.
- Mobile support.
- Analysis of:
  - Content with video
  - Comments
  - Quote Tweets
- End-user appeals/corrections.
- Rate limiting and tiered access controls.

**Non-goals:**

- Editing or contributing to fact-checks from within the extension (all fact-checking is
  driven by the machines).

## 2.2 Design Constraints

1. **Cross-browser from the start.** Use the WebExtension standard API surface. Chrome is the
   primary target, with Firefox compatibility. No browser-specific APIs unless feature-detected and
   gracefully degraded.
2. **Platform adapter pattern with two-stage detection.** Adapter selection uses URL matching first,
   then optional DOM-fingerprint fallback for custom-domain Substack pages. Adding a new platform
   should require only: (a) a new content adapter with extraction logic, (b) a metadata model, (c)
   host permissions/injection wiring.
3. **Analysis beyond fact-checking.** The investigation framework should be extensible to other
   analysis types in the future — context/background, logical structure, source quality,
   steelmanning. The v1 ships only fact-checking, but the data model and API should not hard-code
   this as the only analysis type.
4. **Lean on frontier model capabilities.** The LLM investigator should use provider-native tool use
   (web search, browsing) rather than us building and maintaining our own search-and-scrape
   pipeline. We orchestrate; the model investigates.
5. **Demand-driven by default, on-demand when explicitly requested.** Posts are not investigated on
   every view unless the user enables auto-investigate with their own key. The selector-based queue
   remains the default path for background coverage.
6. **User-provided model credentials are user-managed local settings.** User OpenAI keys may be
   persisted in extension local storage on the user's device, but must never be persisted server-side
   in plaintext or exposed in durable server logs.

## 2.3 Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Browser Extension                    │
│                                                         │
│  ┌────────┐ ┌───────────────────┐ ┌──────────────────┐  │
│  │ Popup  │ │ Content Scripts   │ │Background Worker │  │
│  │        │ │(platform adapters)│ │ (Service Worker) │  │
│  └────────┘ └─────────┬─────────┘ └────────┬─────────┘  │
│                       │                    │            │
└───────────────────────┼────────────────────┼────────────┘
                        │                    │
                        ▼                    ▼
            ┌───────────────────────────────────┐
            │         OpenErrata API            │
            ├───────────────────────────────────┤
            │  View Tracker (records reads)     │
            │  Investigation Selector (cron)    │
            │  LLM Orchestrator                 │
            │    └─ async queue (all runs)      │
            │  Transient credential handoff     │
            │  Blob media ingest (S3/R2)        │
            └───────────────────────────────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │  Blob Storage (S3/R2)│
                └──────────────────────┘
```

| Component                  | Role                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Content Scripts**        | One per platform. Each implements a platform adapter interface: detect page ownership, extract content + media URLs, parse metadata, map annotations back to DOM. |
| **Background Worker**      | Service worker. Routes messages between content scripts, popup, and the API. Manages local cache. Can auto-trigger `investigateNow` when user key mode is enabled. |
| **Popup**                  | UI for extension state: toggle, summary of current page, settings.                                                                                            |
| **OpenErrata API**         | Records post views, serves cached investigations, runs selection, and exposes public API endpoints. All investigations execute asynchronously through the queue (including user-supplied key requests). |
| **Blob Storage**           | Stores downloaded investigation-time images (hash-deduplicated) and serves public URLs used in multimodal model input.                                         |
| **Investigation Selector** | Cron job that periodically selects uninvestigated posts with the highest capped unique-view score and enqueues them. Pluggable selection algorithm — v1 uses capped unique-view score; future versions can factor in recency, engagement, author, etc. |

## 2.4 LLM Investigation Approach

Four key design decisions:

1. **We don't build our own search-and-scrape infrastructure.** Frontier models
   now ship with native tool use (web search, browsing) maintained by the
   provider. We treat the model as an investigator with tools, not a
   text-completion endpoint wrapped in our own retrieval pipeline.
2. **The entire post is investigated in a single agentic call.** Rather than
   extracting claims first and investigating them individually, we send the
   full post text and ask the model to identify claims, investigate them, and
   return structured output mapping each verdict to a specific text span. This
   gives the model full context (a claim's meaning often depends on surrounding
   paragraphs) and reduces round-trips.
3. **The investigator has tools to pull author context.** The model can fetch
   the author's other posts (from our DB or, in future, directly from platform
   APIs like X's) when it decides context would help evaluate a claim. We don't
   pre-fetch entire timelines — the model decides when and how much author
   history it needs.
4. **Investigations are multimodal for images.** When image attachments are
   available, we include image URLs in the model input (`input_image`)
   alongside text. Video is not analyzed in v1, and posts with video are
   visibly skipped.

### Why Single-Pass

|                   | Extract-then-investigate (per-claim) | Single-pass (whole post)                                   |
| ----------------- | ------------------------------------ | ---------------------------------------------------------- |
| **Context**       | Model sees one claim in isolation    | Model sees full post — understands caveats, qualifications |
| **Latency**       | N+1 API calls                        | 1 API call                                                 |
| **Cost**          | System prompt repeated N times       | One system prompt, amortized                               |
| **Deduplication** | We must deduplicate related claims   | Model naturally clusters/skips redundant claims            |

**Word count limit:** v1 only investigates posts up to ~10,000 words. Posts
exceeding this limit are skipped with an indication in the extension (just like
video posts). This keeps the single-pass model simple and avoids chunking
complexity. The limit covers the vast majority of tweets and mid-length
LessWrong/SubStack posts.

### Why Native Tool Use

| Concern                  | BYO search pipeline                | Native tool use                            |
| ------------------------ | ---------------------------------- | ------------------------------------------ |
| **Search quality**       | We pick queries, hope they're good | Model formulates its own queries, iterates |
| **Source reading**       | We scrape + truncate               | Model reads what it needs                  |
| **Maintenance**          | We maintain integration            | Provider maintains it                      |
| **Multi-step reasoning** | We build a state machine           | Model does this naturally                  |
| **Provider flexibility** | Locked to our pipeline             | Swap providers with minimal code change    |

## 2.4.1 Claim-to-DOM Matching

LLMs are bad at counting characters, so we don't ask for offsets. The model returns the **exact
claim text** plus **surrounding context** (~10 words before and after). The extension matches claims
to DOM positions using:

1. **Exact substring match** — search for the claim text in the post content. Works for unique
   sentences.
2. **Context-disambiguated match** — if the same text appears multiple times, use surrounding
   context to find the right occurrence.
3. **Fuzzy fallback** — if exact match fails (whitespace normalization differences), use
   edit-distance search over text nodes.

**Match failure:** If all three tiers fail for a claim, the claim is shown in the popup summary
but not annotated inline. The popup displays the claim text and reasoning without a "show in page"
link. This avoids silent data loss while keeping inline annotations high-confidence.

### 2.4.2 Flagging Criteria (Prompt-Based, Binary)

The model's job is binary: **flag incorrect claims, or stay silent.** There are
no verdict categories or confidence scores. A claim is either demonstrably
wrong (flag it) or it isn't (don't mention it).

The prompt principles (exact wording TBD):

- **Only flag claims where you found concrete, credible evidence that the claim is wrong.** Absence
  of evidence is not evidence of incorrectness — if you can't find sources, don't flag.
- **Do not flag jokes/satire.** No need to explain this one.
- **Do not flag genuinely disputed claims.** If credible sources disagree with each other, stay
  silent. OpenErrata only flags things that are uncontestably incorrect.
- **Consider context.** A claim that is obviously hyperbolic, ironic, or a thought experiment is not
  a factual error. The author's identity and the platform matter.
- **When in doubt, don't flag.** A false positive (incorrectly flagging a true claim) is far worse
  than a false negative (missing a false claim), because false positives erode public trust in the
  system and will be selectively highlighted.
- **Claims must remain text-grounded.** Even when images are provided to the investigator, flagged
  claims must still be exact verbatim quotes from the post text so DOM matching remains reliable.
- **Video is non-analyzable in v1.** Video-only posts are skipped. Posts containing text/images plus
  video are investigated using text + images, and the model is expected to note that video was
  present but unanalyzed.

## 2.5 User Interface

### Popup

```
ISSUES FOUND:          CLEAN:                 NOT YET INVESTIGATED:

┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ OpenErrata   [⚙] │  │ OpenErrata   [⚙] │  │ OpenErrata   [⚙] │
├──────────────────┤  ├──────────────────┤  ├──────────────────┤
│                  │  │                  │  │                  │
│ "Against Ortho…" │  │ "Against Ortho…" │  │ "Against Ortho…" │
│                  │  │                  │  │                  │
│ 2 incorrect      │  │ No issues found. │  │ Not yet          │
│ claims found     │  │                  │  │ investigated.    │
│                  │  │                  │  │                  │
│ [View Details]   │  │                  │  │ Viewed by N      │
│                  │  │                  │  │ users.           │
├──────────────────┤  ├──────────────────┤  │                  │
│ ☐ Show highlights│  │                  │  │ [Investigate     │
└──────────────────┘  └──────────────────┘  │  Now]            │
                                            ├──────────────────┤
                                            │ ☐ Show highlights│
                                            └──────────────────┘
```

Settings are split into:

- **Basic:** OpenAI API key + auto-investigate toggle.
- **Advanced:** API server URL, attestation/HMAC secret override, instance API
  key. If unset, defaults to hosted instance.

### Annotation Styling

One annotation type: **incorrect claim** — red underline. Only incorrect claims
are highlighted; correct and ambiguous claims are not annotated.

Subtle by default (thin red underline). Hover shows a tooltip with the one- or
two-sentence summary. Click expands full reasoning + source links. CSS custom
properties adapt to dark/light themes.

## 2.6 Data Flow

**View path (all users):**

```
User visits post
  → Content script extracts metadata + observed content text/media state/image URLs
  → Background worker calls API: viewPost(...)
      - Always include observedContentText
      - Include observed image URLs for metadata persistence
  → API upserts Post + metadata and increments raw viewCount / unique-view signals
  → API checks whether this observed content version already has a completed investigation:
      HIT  → return { investigated: true, claims: [...] }
             (already investigated for this content version; client is done)
      MISS → continue
  → For misses only, API attempts server-side verification (best effort):
      VERIFIED + matches observed content → continue with `SERVER_VERIFIED`
      VERIFIED + mismatch                 → reject request (`CONTENT_MISMATCH`)
                                            and do not update post/view/corroboration signals
      NOT VERIFIED                        → continue with `CLIENT_FALLBACK`
  → API updates canonical content-version signals and corroboration signals
  → API checks whether the selected content version has a completed investigation:
      HIT  → return { investigated: true, claims: [...] }
             (already investigated for this content version; client is done)
      MISS → return { investigated: false }
             (no completed investigation yet for this content version)
  → Client renders current state; viewPost alone does not enqueue a new investigation
  → Investigation begins only via investigateNow(...) or selector queueing
```

**Investigate-now path (both auth modes, unified async queue):**

```
User clicks "Investigate Now" (or auto-investigate triggers)
  → Background worker calls API: investigateNow(...), optionally including a user OpenAI key
  → API resolves the post's current content version (same verification policy as viewPost)
  → API checks for an existing Investigation row for that content version
      no row     → create PENDING row, start background run,
                   return { investigationId, status: PENDING }
  → If a row already exists, API returns immediately with status-based behavior:
      COMPLETE   → return { investigationId, status: COMPLETE } (claims may be included)
      FAILED     → return { investigationId, status: FAILED } (unless explicit retry action is requested)
      PROCESSING → return { investigationId, status: PROCESSING }; no second run is started
      PENDING    → if request includes a user OpenAI key and no user-key source is attached yet,
                   attach one (first key wins)
                   once PROCESSING starts, user-key source is immutable for that run
                   ensure a background run exists
                   return { investigationId, status: PENDING }
  → Extension polls getInvestigation({ investigationId }) until COMPLETE/FAILED
  → Worker claims queued job, sets PROCESSING, runs investigation, then writes COMPLETE/FAILED
```

**Auto-investigate (extension-side):**

```
After viewPost returns { investigated: false }
  → If user OpenAI key exists and auto-investigate is enabled:
      background worker calls investigateNow(...) and then polls for completion
  → Result is cached locally when returned
```

**Background selection (server-managed budget):**

```
Cron job runs every N minutes
  → SELECT uninvestigated posts ORDER BY unique_view_score DESC LIMIT :budget
  → INSERT Investigation(status=PENDING) for each
  → Job queue workers pick up and investigate
```

## 2.7 API Surface, Author Tracking, & Public Data

Public API endpoints expose full flagged claims, reasoning, and sources for
eligible investigations and support search across the corpus. This supports the
Transparency goal (anyone can inspect any decision). Each Author is a
first-class entity representing one platform identity. Posts link to their
Author. We track:

- `factCheckIncidence = investigated_posts_with_>=1_flagged_claim / total_investigated_posts`
- Per-author counts for investigated posts and flagged claims

No cross-platform linking in v1 — "the same person on two platforms" is two
Author rows. Merging them later (for cross-platform profiles) is a future
problem that doesn't require schema changes, just a linking/merge operation on
existing rows.

## 2.8 Cache Policy

Investigation creation is idempotent in v1: at most one investigation per
post + content version.

The cache is keyed by post + content version. On a view, the API checks for a
completed investigation matching the current version.

- **On every view**: The API records the latest observed post content/version, increments raw
  viewCount, updates uniqueViewScore with capped credit rules, and then checks for cached results.
- **Client input simplification**: the extension sends normalized text; the API computes the
  version key internally.
- **Hit**: Return claims. The view still increments the counter.
- **Miss**: Return `{ investigated: false }`. The view is recorded; the selector may pick this post
  up later.
- **Strict version rule**: Never return or render an investigation for a different content version
  of the same post. No fallback to older versions.
- **Version key semantics**: In v1 the version key is derived from normalized text only. Attached
  images are investigation context but are not part of the version key.
- **Idempotent creation**: If a duplicate investigation is requested (same post + content version), reuse the
  existing row rather than creating a second one.
- **Stale prompt**: If the investigation's prompt version doesn't match the current server prompt,
  the result is still served. Future versions will expand this to support refreshes.
- **TTL**: No expiry — fact-checks are durable.

## 2.9 Content Verification & Degraded Mode

One problem is how to verify the accuracy of the content that users send us
from the browser extension. For some platforms this is easier than others; it's
hard to cross-verify e.g. twitter posts, but it's easier to verify that a
particular person indeed wrote a particular LessWrong/Substack post. The app
only displays highlights for posts when their content/metadata matches, but
verification is still necessary to support future endeavors like credibility
scores.

So server-side verification is preferred but best-effort.

- Primary path: server verifies platform content and derives the canonical content version.
- Mismatch policy: if verification succeeds but conflicts with the submitted content, reject that
  request (`CONTENT_MISMATCH`) instead of silently proceeding.
- Degraded path: if server fetch fails (rate limit, temporary provider/platform outage, anti-bot
  block), investigations may proceed using client-observed content.
- Every investigation stores provenance (`SERVER_VERIFIED` or `CLIENT_FALLBACK`).

Image handling uses a single required path:

- Investigation-time image URLs are downloaded, hash-deduplicated, uploaded to blob storage, and
  attached to the investigation as multimodal input.
- Blob storage configuration is mandatory for all deployments.

The system stores raw verification signals, so users can decide what to trust:

- `contentProvenance`: whether the content was server-verified or client-fallback.
- `corroborationCredits`: one corroboration credit per distinct authenticated user who submitted
  matching content for that investigation.
- `serverVerifiedAt`: timestamp of successful server-side verification (null if not yet verified).

For indecisive users (and internal decisions), an investigation is "publicly
eligible" when either:

- `contentProvenance = SERVER_VERIFIED`, or
- `COUNT(corroborationCredits) >= 3`

Non-eligible investigations are not access-restricted — the extension's
`getInvestigation` endpoint returns them to any caller. The eligibility distinction controls
what appears in **public-facing outputs**: the public API, author metrics, and incidence
calculations exclude non-eligible investigations so that unverified results don't influence
published leaderboards or statistics.

**Signal updates:** The raw signals change in two places:

- **On `viewPost`**: when an authenticated user views a post with a client-fallback
  investigation and submits matching content, corroboration credit is added for that reporter
  (duplicate submissions from the same reporter are ignored).
- **On successful server-side fetch**: if a previously-failed server fetch later succeeds
  (e.g., on a subsequent `viewPost` where the server retries) **and the server-computed content
  version matches the investigation's version**, `contentProvenance` is updated to
  `SERVER_VERIFIED` and `serverVerifiedAt` is set. If the versions differ, the existing
  investigation is left unchanged — it was run against different content.

## 2.10 Investigation Prioritization

The investigation selector is a cron job that runs every N minutes, selecting uninvestigated posts
ordered by capped unique-view score. Budget is configurable (e.g. 100 investigations/day).

Scoring rules (v1):

- Raw `viewCount` increments on every view for analytics.
- `uniqueViewScore` increments by +1 only when both conditions hold:
  - no existing credit for this viewer on this post today (max 1 credit per account/session per
    post per 24h)
  - IP-range credit cap for this post today has not been exceeded
- The IP-range credit cap is configurable.

This naturally handles edits: if a post was investigated but then edited, the content hash no longer
matches any existing investigation, so it re-enters the selection pool.

Future selection signals (only the query changes):

- Recency
- Platform engagement (karma, likes, retweets)
- Author prominence
- Content characteristics (length, topic, claim density)
- Time since last investigation (for re-checks)

## 2.11 Governance & Safety (v1)

v1 has no public appeal workflow. This is an explicit product choice for V1.

## 2.12 Reproducibility & Auditability

Goal: investigations should be as reproducible as possible, while acknowledging
provider web-search results can change over time.

For every completed investigation, persist audit artifacts:

- Normalized input text and `contentHash`
- Content provenance and any server-fetch failure reason
- Prompt reference (`promptId` → `Prompt.version`, `Prompt.hash`, `Prompt.text`)
- Provider/model metadata (enum values for provider/model, plus provider-reported model version)
- Normalized per-attempt request/response records:
  requested tools, output items, output text parts + citations, reasoning summaries,
  tool calls (with raw provider payloads), token usage, and provider/parsing errors
- Source snapshots or immutable excerpts used for claims, with hash and retrieval timestamp

Stored artifacts are the canonical audit record. Re-running the same
investigation later may produce different outputs because external web content
and provider search indexes are time-varying.

## 2.13 Abuse Resistance

`viewPost` is an unauthenticated write endpoint. Without mitigation, an
attacker could inflate `uniqueViewScore` to prioritize arbitrary posts,
fabricate post content that gets sent to the LLM, or DoS the API with junk
views. Full rate limiting is out of scope for v1, but the following baseline
measures are required:

1. **Extension attestation signal (not authentication).** The extension includes an attestation
   signal generated from a bundled default secret (with an optional local override in extension
   settings). Because extensions are inspectable, this is
   treated only as a low-confidence abuse signal for filtering/telemetry, not a security boundary.
   Missing/invalid attestation is treated as "no signal" rather than an auth failure. Authorization
   and trust decisions must not rely on this signal alone.
2. **Server-side content verification.** The server always attempts to fetch canonical content
   from the platform (see §2.9). Client-submitted text is only used as fallback when the server
   fetch fails, limiting the attacker's ability to inject fabricated content into investigations.
3. **IP-range credit cap.** The `uniqueViewScore` credit system (§2.10) already caps per-IP-range
   credits per day, limiting the impact of a single actor inflating scores.
4. **Content-version pinning.** Investigations are bound to a specific post content version.
   Submitting fabricated content for the same post produces a different version key and therefore
   won't match a server-verified investigation shown to real users.
5. **User-key handling.** User-supplied OpenAI keys may be persisted locally in the extension, but
   plaintext keys must never be persisted server-side in application data or durable logs.
6. **SSRF-safe image fetch.** Investigation-time image downloading must block private/internal
   network targets and enforce count/size limits before upload to blob storage.

These measures are not sufficient against a determined attacker but are adequate for v1. Stronger
measures (API keys, proof-of-work, behavioral analysis) are planned for future versions.

---

# Part 3 — Spec

## 3.1 Tech Stack

| Layer           | Technology                                                        | Rationale                                                                     |
| --------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Extension UI    | **Svelte 5 + component-scoped CSS**                               | Lightweight UI layer with minimal runtime overhead and predictable styling     |
| Extension build | **Vite (custom multi-entry build + IIFE content-script build)**   | Produces MV3-compatible bundles for background, popup/options, and content scripts |
| Cross-browser   | **webextension-polyfill**                                         | Normalizes Chrome/Firefox API differences behind a single Promise-based API   |
| Type safety     | **TypeScript + Zod**                                              | Runtime validation at API boundary                                            |
| API framework   | **SvelteKit + tRPC**                                              | Type-safe RPC                                                                 |
| Database        | **Supabase (hosted Postgres) + Prisma**                           | Stores investigations, view counts, user accounts                             |
| Job queue       | **Postgres-backed** (graphile-worker or `FOR UPDATE SKIP LOCKED`) | No Redis dependency; runs against the same Supabase database                  |
| LLM             | **OpenAI Responses API with tools**                               | v1 provider. Anthropic support planned via `Investigator` interface           |
| Auth            | **Anonymous + request-scoped user OpenAI key + optional instance key** | Free tier by default; user can self-fund investigations without account provisioning |
| Deployment      | **Helm chart** (on-prem), **Pulumi** (official hosted, deploys the same chart) | Single artifact for both on-prem and hosted; no deployment drift              |

## 3.2 Data Model

### Post (shared base)

```prisma
model Post {
  id              String          @id @default(cuid())
  platform        Platform
  externalId      String          // Platform's native ID
  url             String
  authorId        String?
  author          Author?         @relation(fields: [authorId], references: [id])
  viewCount       Int             @default(0) // Raw views (analytics)
  uniqueViewScore Int             @default(0) // Capped selector score
  lastViewedAt    DateTime?
  latestContentHash String?       // Best-available content hash (server-verified preferred; fallback client-observed)
  latestContentText String?       // Best-available content text used for selection/investigation
  wordCount       Int             @default(0) // Computed on upsert from latestContentText. Posts >10000 words skipped by selector.
  investigations  Investigation[]
  viewCredits     PostViewCredit[]
  lesswrongMeta   LesswrongMeta?
  xMeta           XMeta?
  substackMeta    SubstackMeta?
  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt

  @@unique([platform, externalId])
  @@index([viewCount])
  @@index([uniqueViewScore])
  @@index([authorId])
}

model PostViewCredit {
  id              String    @id @default(cuid())
  postId          String
  post            Post      @relation(fields: [postId], references: [id])
  viewerKey       String    // Stable hashed viewer key (account if authenticated; anon session otherwise)
  ipRangeKey      String    // Stable hashed IP range key (/24 IPv4 or /48 IPv6)
  bucketDay       DateTime  // UTC day bucket used for credit caps
  createdAt       DateTime  @default(now())

  @@unique([postId, viewerKey, bucketDay]) // Max 1 credit per viewer/post/day
  @@index([postId, bucketDay])
  @@index([postId, ipRangeKey, bucketDay])
}

enum Platform {
  LESSWRONG
  X
  SUBSTACK
  // Adding a platform: add a value here + a new *Meta model.
}
```

### Author

Each Author row represents one platform identity — "eliezer-yudkowsky on LessWrong" and
"@ESYudkowsky on X" are two separate Authors. No cross-platform linking in v1; that can be added
later by merging rows.

```prisma
model Author {
  id              String    @id @default(cuid())
  platform        Platform
  platformUserId  String    // LW authorSlug, X handle, or Substack handle/publication-scoped fallback
  displayName     String    // Best-known name on this platform
  posts           Post[]
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@unique([platform, platformUserId])
}
```

### Platform metadata

```prisma
model LesswrongMeta {
  postId          String    @id
  post            Post      @relation(fields: [postId], references: [id])
  slug            String    @unique
  title           String
  htmlContent     String
  imageUrls       String[]
  wordCount       Int?
  karma           Int?
  authorName      String
  authorSlug      String?
  tags            String[]
  publishedAt     DateTime?
}

model XMeta {
  postId          String    @id
  post            Post      @relation(fields: [postId], references: [id])
  tweetId         String    @unique
  text            String
  authorHandle    String
  authorDisplayName String?
  mediaUrls       String[]
  likeCount       Int?
  retweetCount    Int?
  postedAt        DateTime?
}

model SubstackMeta {
  postId                String    @id
  post                  Post      @relation(fields: [postId], references: [id])
  substackPostId        String    @unique
  publicationSubdomain  String
  slug                  String
  title                 String
  subtitle              String?
  imageUrls             String[]
  authorName            String
  authorSubstackHandle  String?
  publishedAt           DateTime?
  likeCount             Int?
  commentCount          Int?

  @@unique([publicationSubdomain, slug])
}
```

### Investigation & claims

```prisma
model Prompt {
  id              String          @id @default(cuid())
  version         String          @unique  // e.g. "v1.0.0"
  hash            String          @unique  // SHA-256 of text, for dedup
  text            String                   // Full prompt text for auditability
  investigations  Investigation[]
  createdAt       DateTime        @default(now())
}

model Investigation {
  id              String        @id @default(cuid())
  postId          String
  post            Post          @relation(fields: [postId], references: [id])
  contentHash     String        // SHA-256 of normalized contentText
  contentText     String        // Normalized plain text sent to LLM
  contentProvenance ContentProvenance
  fetchFailureReason String?    // Populated when provenance is CLIENT_FALLBACK
  serverVerifiedAt DateTime?    // Set when server-side fetch succeeds (null until then)
  status          CheckStatus
  promptId        String
  prompt          Prompt        @relation(fields: [promptId], references: [id])
  provider        InvestigationProvider
  model           InvestigationModel
  modelVersion    String?       // Provider-reported model revision/version when available
  checkedAt       DateTime?
  attempts        InvestigationAttempt[]
  claims          Claim[]
  images          InvestigationImage[]
  corroborationCredits CorroborationCredit[]
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt

  @@unique([postId, contentHash])
  @@index([postId, status])
}

model ImageBlob {
  id             String               @id @default(cuid())
  contentHash    String               @unique
  storageKey     String               @unique
  originalUrl    String
  mimeType       String
  sizeBytes      Int
  investigations InvestigationImage[]
  createdAt      DateTime             @default(now())
  updatedAt      DateTime             @updatedAt
}

model InvestigationImage {
  investigationId String
  investigation   Investigation @relation(fields: [investigationId], references: [id], onDelete: Cascade)
  imageBlobId     String
  imageBlob       ImageBlob     @relation(fields: [imageBlobId], references: [id], onDelete: Cascade)
  imageOrder      Int
  createdAt       DateTime      @default(now())

  @@id([investigationId, imageBlobId])
  @@unique([investigationId, imageOrder])
  @@index([imageBlobId])
}

model InvestigationAttempt {
  id                      String   @id @default(cuid())
  investigationId         String
  investigation           Investigation @relation(fields: [investigationId], references: [id])
  attemptNumber           Int
  outcome                 InvestigationAttemptOutcome?
  requestModel            String   // Provider request model id (e.g. gpt-5-*)
  requestInstructions     String   // Exact instructions/system prompt sent
  requestInput            String   // Exact user input sent
  requestReasoningEffort  String?
  requestReasoningSummary String?
  responseId              String?  // Provider response id
  responseStatus          String?
  responseModelVersion    String?
  responseOutputText      String?  // Raw structured output text returned
  startedAt               DateTime
  completedAt             DateTime?
  requestedTools          InvestigationAttemptRequestedTool[]
  outputItems             InvestigationAttemptOutputItem[]
  toolCalls               InvestigationAttemptToolCall[]
  usage                   InvestigationAttemptUsage?
  error                   InvestigationAttemptError?
  createdAt               DateTime @default(now())
  updatedAt               DateTime @updatedAt

  @@unique([investigationId, attemptNumber])
  @@index([investigationId, startedAt])
}

model InvestigationAttemptRequestedTool {
  id                String   @id @default(cuid())
  attemptId         String
  attempt           InvestigationAttempt @relation(fields: [attemptId], references: [id])
  requestOrder      Int
  toolType          String
  rawDefinition     Json     // Full provider tool-definition payload for this request position

  @@unique([attemptId, requestOrder])
  @@index([attemptId])
}

model InvestigationAttemptOutputItem {
  id                String   @id @default(cuid())
  attemptId         String
  attempt           InvestigationAttempt @relation(fields: [attemptId], references: [id])
  outputIndex       Int
  providerItemId    String?
  itemType          String   // Provider-defined output item type
  itemStatus        String?
  textParts         InvestigationAttemptOutputTextPart[]
  reasoningSummaries InvestigationAttemptReasoningSummary[]
  toolCall          InvestigationAttemptToolCall?

  @@unique([attemptId, outputIndex])
  @@index([attemptId])
}

model InvestigationAttemptOutputTextPart {
  id            String   @id @default(cuid())
  outputItemId  String
  outputItem    InvestigationAttemptOutputItem @relation(fields: [outputItemId], references: [id])
  partIndex     Int
  partType      String   // output_text | refusal
  text          String
  annotations   InvestigationAttemptOutputTextAnnotation[]

  @@unique([outputItemId, partIndex])
  @@index([outputItemId])
}

model InvestigationAttemptOutputTextAnnotation {
  id              String   @id @default(cuid())
  textPartId      String
  textPart        InvestigationAttemptOutputTextPart @relation(fields: [textPartId], references: [id])
  annotationIndex Int
  annotationType  String   // url_citation | file_citation | file_path | ...
  startIndex      Int?
  endIndex        Int?
  url             String?
  title           String?
  fileId          String?

  @@unique([textPartId, annotationIndex])
  @@index([textPartId])
}

model InvestigationAttemptReasoningSummary {
  id            String   @id @default(cuid())
  outputItemId  String
  outputItem    InvestigationAttemptOutputItem @relation(fields: [outputItemId], references: [id])
  summaryIndex  Int
  text          String

  @@unique([outputItemId, summaryIndex])
  @@index([outputItemId])
}

model InvestigationAttemptToolCall {
  id                  String   @id @default(cuid())
  attemptId           String
  attempt             InvestigationAttempt @relation(fields: [attemptId], references: [id])
  outputItemId        String   @unique
  outputItem          InvestigationAttemptOutputItem @relation(fields: [outputItemId], references: [id])
  outputIndex         Int
  providerToolCallId  String?
  toolType            String
  status              String?
  rawPayload          Json     // Full provider output item payload for this call
  capturedAt          DateTime
  providerStartedAt   DateTime?
  providerCompletedAt DateTime?

  @@unique([attemptId, outputIndex])
  @@index([attemptId])
}

model InvestigationAttemptUsage {
  id                    String   @id @default(cuid())
  attemptId             String   @unique
  attempt               InvestigationAttempt @relation(fields: [attemptId], references: [id])
  inputTokens           Int
  outputTokens          Int
  totalTokens           Int
  cachedInputTokens     Int?
  reasoningOutputTokens Int?
}

model InvestigationAttemptError {
  id           String   @id @default(cuid())
  attemptId    String   @unique
  attempt      InvestigationAttempt @relation(fields: [attemptId], references: [id])
  errorName    String
  errorMessage String
  statusCode   Int?
}

model CorroborationCredit {
  id              String        @id @default(cuid())
  investigationId String
  investigation   Investigation @relation(fields: [investigationId], references: [id])
  reporterKey     String        // Hashed authenticated user identifier
  createdAt       DateTime      @default(now())

  @@unique([investigationId, reporterKey]) // Prevents double-counting
  @@index([investigationId])
}

model Claim {
  id              String    @id @default(cuid())
  investigationId String
  investigation   Investigation @relation(fields: [investigationId], references: [id])
  text            String    // Exact claim text from the post
  context         String    // ~10 words before + after for DOM matching
  summary         String    // One-sentence explanation of why the claim is incorrect
  reasoning       String    // Full reasoning chain
  sources         Source[]
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@index([investigationId])
}

model Source {
  id              String    @id @default(cuid())
  claimId         String
  claim           Claim     @relation(fields: [claimId], references: [id])
  url             String
  title           String
  snippet         String
  snapshotText    String?   // Immutable excerpt/body used during the run (if retained)
  snapshotHash    String?   // Hash of snapshotText or archived source bytes
  retrievedAt     DateTime

  @@index([claimId])
}

// Lifecycle: PENDING → PROCESSING → COMPLETE | FAILED
enum CheckStatus {
  PENDING
  PROCESSING
  COMPLETE
  FAILED
}

enum ContentProvenance {
  SERVER_VERIFIED
  CLIENT_FALLBACK
}

enum InvestigationProvider {
  OPENAI
  ANTHROPIC
}

enum InvestigationModel {
  OPENAI_GPT_5
  OPENAI_GPT_5_MINI
  ANTHROPIC_CLAUDE_SONNET
  ANTHROPIC_CLAUDE_OPUS
}

enum InvestigationAttemptOutcome {
  SUCCEEDED
  FAILED
}

// No Verdict enum. Every Claim in the database is an incorrect claim.
// The model only reports claims it has clear evidence are wrong.
// Correct, ambiguous, and unverifiable claims are not stored.
```

### Public eligibility (derived view)

Public eligibility is not stored — it's derived from `contentProvenance` and the corroboration
credit count. A Postgres view materializes the predicate:

```sql
CREATE VIEW "investigation_public_eligibility" AS
SELECT
  i."id" AS "investigationId",
  (
    i."status" = 'COMPLETE'
    AND (
      i."contentProvenance" = 'SERVER_VERIFIED'
      OR (SELECT COUNT(*) FROM "CorroborationCredit" cc
          WHERE cc."investigationId" = i."id") >= 3
    )
  ) AS "isPubliclyEligible"
FROM "Investigation" i;
```

The public API, author metrics, and incidence calculations join against this view.
Investigations that are not yet publicly eligible are not access-restricted (see §2.10).

### LLM output type

```typescript
interface InvestigationResult {
  // Only incorrect claims. If the model finds nothing wrong, this array is empty.
  claims: {
    text: string; // Exact incorrect claim text from the post
    context: string; // ~10 words before + after for DOM matching
    summary: string; // One-sentence explanation of why it's wrong
    reasoning: string; // Full reasoning chain
    sources: {
      url: string;
      title: string;
      snippet: string;
    }[];
  }[];
}
```

## 3.3 API Endpoints (tRPC)

```typescript
// Record a view. Returns cached results if they exist.
// Upserts Post + platform metadata. Increments raw viewCount and updates uniqueViewScore.
// Client sends observed content text only; API computes hashes server-side.
postRouter.viewPost
  Input:  { platform, externalId, url, observedContentText, observedImageUrls?,
            metadata: { title?, authorName?, ... } }
  Output: { investigated: boolean, provenance?: ContentProvenance, claims: Claim[] | null }

// Fetch results for a specific investigation (used for polling)
postRouter.getInvestigation
  Input:  { investigationId }
  Output: { investigated: boolean, status?: CheckStatus, provenance?: ContentProvenance,
            claims: Claim[] | null, checkedAt? }

// Request immediate investigation.
// Authorization: instance API key OR request-scoped user OpenAI key (`x-openai-api-key`).
// Rejects posts exceeding the word count limit (same 10,000-word cap as the selector).
// Idempotent: if an investigation already exists for this content version, returns its
// current status (which may be COMPLETE or FAILED, not just PENDING).
// All paths are async queue-backed; user-key requests attach an encrypted short-lived lease.
postRouter.investigateNow
  Input:  { platform, externalId, url, observedContentText, observedImageUrls?,
            metadata: { title?, authorName?, ... } }
  Output: { investigationId, status: CheckStatus, provenance: ContentProvenance, claims?: Claim[] }

// Batch check (for listing pages — which posts have results?)
postRouter.batchStatus
  Input:  { posts: { platform, externalId }[] }
  Output: { statuses: { platform, externalId, investigated, incorrectClaimCount }[] }
```

## 3.4 Public API (tRPC)

Publicly eligible investigations (see §2.10) are readable without authentication.

```typescript
// Get a single investigation with full claims, reasoning, and sources
publicRouter.getInvestigation
  Input:  { investigationId }
  Output: { investigation, post, claims: ClaimWithSources[] }

// List investigations for a post
publicRouter.getPostInvestigations
  Input:  { platform, externalId }
  Output: { post, investigations: InvestigationSummary[] }

// Search investigations
publicRouter.searchInvestigations
  Input:  { query?, platform?, limit?, offset? }
  Output: { investigations: InvestigationSummary[] }

// Aggregate metrics
publicRouter.getMetrics
  Input:  { platform?, authorId?, windowStart?, windowEnd? }
  Output: { totalInvestigatedPosts, investigatedPostsWithFlags, factCheckIncidence }
```

In v1, public metrics focus on incidence rather than truth-rate leaderboards:

`factCheckIncidence = investigated_posts_with_>=1_flagged_claim / total_investigated_posts`

## 3.5 Cache & Idempotency Implementation

Cache lookup query:

```sql
SELECT *
FROM "Investigation"
WHERE "postId" = $1 AND "contentHash" = $2 AND "status" = 'COMPLETE'
LIMIT 1;
```

SQL examples in this document target Prisma's default quoted identifiers (`"Post"`,
`"Investigation"`, camelCase column names). If you use `@map`/`@@map`, adjust queries accordingly.

Idempotent creation uses `INSERT ... ON CONFLICT ("postId", "contentHash") DO NOTHING` and then
fetches the row ID. This prevents duplicate investigations under concurrency.

## 3.6 Investigation Selector Queries

```sql
-- Select posts with the highest capped unique-view score that have no investigation
-- for their current content version.
SELECT p."id", p."uniqueViewScore", p."latestContentHash", p."latestContentText"
FROM "Post" p
WHERE p."latestContentHash" IS NOT NULL
  AND p."wordCount" <= 10000
  AND NOT EXISTS (
    SELECT 1 FROM "Investigation" i
    WHERE i."postId" = p."id"
      AND i."contentHash" = p."latestContentHash"
  )
ORDER BY p."uniqueViewScore" DESC
LIMIT :budget;
```

```sql
-- Enqueue idempotently (race-safe under concurrency)
WITH candidates AS (
  SELECT p."id", p."latestContentHash", p."latestContentText", p."uniqueViewScore"
  FROM "Post" p
  WHERE p."latestContentHash" IS NOT NULL
    AND p."wordCount" <= 10000
    AND NOT EXISTS (
      SELECT 1 FROM "Investigation" i
      WHERE i."postId" = p."id"
        AND i."contentHash" = p."latestContentHash"
    )
  ORDER BY p."uniqueViewScore" DESC
  LIMIT :budget
)
INSERT INTO "Investigation" (
  "postId", "contentHash", "contentText", "status", "contentProvenance",
  "promptId", "provider", "model"
)
SELECT
  c."id", c."latestContentHash", c."latestContentText", 'PENDING', :content_provenance,
  :prompt_id, :provider, :model
FROM candidates c
ON CONFLICT ("postId", "contentHash") DO NOTHING;
```

## 3.7 Job Queue

Postgres-backed (graphile-worker or `FOR UPDATE SKIP LOCKED`). No Redis.
Used by selector work and all `investigateNow` requests.
User-key requests attach an encrypted short-lived lease for worker-side credential handoff.

```
Investigation selected (by selector or any investigateNow request)
  → INSERT INTO "Investigation" (...) ON CONFLICT ("postId", "contentHash") DO NOTHING
  → If conflict: reuse existing investigation row and do not enqueue duplicate work
  → Worker picks up job → UPDATE status = PROCESSING
  → Worker calls Investigator.investigate()
  → On success: UPDATE status = COMPLETE
  → On failure: classify and retry or fail permanently

Failure classes:
  TRANSIENT (retry up to 3x with exponential backoff):
    - Provider 5xx errors, rate limits (429), network timeouts
  NON_RETRYABLE (mark FAILED immediately):
    - Structured output fails Zod validation (likely prompt/schema issue, not transient)
    - Provider content-policy refusal
    - Authentication/authorization errors (401, 403)
  PARTIAL (mark FAILED, log partial output for debugging):
    - Provider returns truncated or incomplete tool-call trace

If a user-key lease is missing/expired when the worker starts, the run fails and
requires an explicit user re-request.

`FAILED` is terminal for a given `(postId, contentHash)` in v1. Re-running that exact content
version requires an explicit operator/admin action (e.g., reset status or delete/recreate row),
not automatic selector retries.
```

## 3.8 Platform Adapter Interface

Each content script implements:

```typescript
interface PlatformAdapter {
  matches(url: string): boolean;
  detectFromDom?(document: Document): boolean;
  extract(document: Document): PlatformContent | null;
  getContentRoot(document: Document): Element | null;
  platformKey: string;
}

interface PlatformContent {
  platform: Platform;
  externalId: string;
  url: string;
  contentText: string; // Client-observed normalized plain text
  mediaState: "text_only" | "has_images" | "video_only";
  imageUrls: string[];
  metadata: Record<string, unknown>;
}
```

Adapter selection is URL-first (`matches(url)`), then optional DOM-fingerprint fallback
(`detectFromDom(document)`) for custom-domain platform pages.

### Content normalization (shared package)

```typescript
function normalizeContent(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
```

## 3.9 LessWrong Content Script

LessWrong renders post bodies via `ContentItemBody` using `dangerouslySetInnerHTML` (static HTML).
DOM manipulation is reliable.

**Extraction:**

1. Wait for `document_idle`.
2. Locate post body: `document.querySelector('.PostsPage-postContent')`.
3. Extract post ID from URL: `/posts/{postId}/{slug}`.
4. Normalize `textContent`.
5. Extract image URLs (`<img src>`), filter malformed/data URLs, and compute `mediaState`.
6. Send `{ platform: "LESSWRONG", externalId, url, observedContentText, observedImageUrls? }` to background worker.

**Media behavior:** Posts with images are investigated. Only `video_only` posts (video/iframe
without images) are skipped.

**React reconciliation:** LessWrong uses React 16+. Use `MutationObserver` to detect re-renders and
re-apply annotations. Store annotations in extension state, not DOM.

## 3.10 X.com Content Script

X uses a React SPA with aggressive DOM recycling.

1. `MutationObserver` to detect tweet content in viewport.
2. For individual tweet pages (`/status/{id}`), extract main tweet text.
3. Target `[data-testid="tweetText"]`. Acknowledge this selector is fragile and may need
   maintenance.

**Media behavior:** Extract image URLs separately from video detection. Investigate image posts.
Skip only `video_only` tweets (video present, no extracted images).

## 3.11 Substack Content Script

1. For `*.substack.com/p/*`, declarative content script injection is used.
2. For custom domains, the background worker probes `/p/*` pages after tab load and checks
   for `link[href*="substackcdn.com"]`. If matched, it injects content script + CSS via
   `chrome.scripting`.
3. `externalId` is the numeric Substack post ID parsed from social image metadata
   (`post_preview/{numericId}/twitter.jpg` pattern).
4. Content root selector: `.body.markup`.

## 3.12 Extension Manifest (v3)

```jsonc
{
  "manifest_version": 3,
  "name": "OpenErrata",
  "version": "0.1.0",
  "description": "Fact-check LessWrong, X, and Substack posts with AI-powered claim verification.",
  "permissions": ["activeTab", "storage", "scripting"],
  "host_permissions": [
    "https://www.lesswrong.com/*",
    "https://lesswrong.com/*",
    "https://*.substack.com/*",
    "https://x.com/*",
    "https://twitter.com/*",
    "https://api.openerrata.com/*",
    "http://localhost/*",
  ],
  "background": {
    "service_worker": "src/background/index.ts",
    "type": "module",
  },
  "content_scripts": [
    {
      "matches": ["https://www.lesswrong.com/*", "https://lesswrong.com/*"],
      "js": ["src/content/main.ts"],
      "css": ["src/content/annotations.css"],
      "run_at": "document_idle",
    },
    {
      "matches": ["https://x.com/*", "https://twitter.com/*"],
      "js": ["src/content/main.ts"],
      "css": ["src/content/annotations.css"],
      "run_at": "document_idle",
    },
    {
      "matches": ["https://*.substack.com/p/*"],
      "js": ["src/content/main.ts"],
      "css": ["src/content/annotations.css"],
      "run_at": "document_idle",
    },
  ],
  "action": {
    "default_popup": "src/popup/index.html",
    "default_icon": {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
    },
  },
}
```

## 3.13 Project Layout

```
openerrata/
├── src/
│   ├── helm/
│   │   └── openerrata/                # Helm chart — single source of truth for deployment
│   │       ├── Chart.yaml
│   │       ├── values.yaml            # Defaults for on-prem; Pulumi overrides for hosted
│   │       └── templates/
│   │           ├── _helpers.tpl
│   │           ├── api-deployment.yaml
│   │           ├── api-service.yaml
│   │           ├── worker-deployment.yaml
│   │           ├── selector-cronjob.yaml
│   │           ├── configmap.yaml
│   │           └── secrets.yaml       # DATABASE_URL, OPENAI_API_KEY, etc.
│   │
│   └── typescript/
│       ├── tsconfig.base.json         # Shared TS config (strict, paths, target)
│       │
│       ├── extension/                 # Browser extension (Chrome MV3 + Firefox)
│       │   ├── src/
│       │   │   ├── background/        # Service worker
│       │   │   │   ├── index.ts
│       │   │   │   ├── api-client.ts  # tRPC client
│       │   │   │   └── cache.ts       # IndexedDB local cache
│       │   │   ├── content/
│       │   │   │   ├── adapters/      # Platform adapters (one per site)
│       │   │   │   │   ├── lesswrong.ts
│       │   │   │   │   ├── x.ts
│       │   │   │   │   └── index.ts   # Registry
│       │   │   │   ├── annotator.ts   # Annotation rendering
│       │   │   │   ├── dom-mapper.ts  # Claim text → DOM ranges
│       │   │   │   ├── main.ts        # Entry point
│       │   │   │   └── annotations.css
│       │   │   ├── popup/
│       │   │   │   ├── index.html
│       │   │   │   ├── App.svelte
│       │   │   │   └── components/
│       │   │   ├── options/
│       │   │   │   ├── index.html
│       │   │   │   └── App.svelte
│       │   │   ├── lib/
│       │   │   │   ├── types.ts
│       │   │   │   ├── messages.ts    # Extension message protocol (Zod)
│       │   │   │   └── constants.ts
│       │   │   └── manifest.json
│       │   ├── vite.config.ts
│       │   ├── tailwind.config.ts
│       │   ├── tsconfig.json          # Extends ../tsconfig.base.json
│       │   └── package.json
│       │
│       ├── api/                       # Backend API service
│       │   ├── src/
│       │   │   ├── routes/            # SvelteKit routes (health, webhooks)
│       │   │   ├── lib/
│       │   │   │   ├── trpc/
│       │   │   │   │   ├── router.ts
│       │   │   │   │   └── routes/
│       │   │   │   │       └── post.ts
│       │   │   │   ├── investigators/
│       │   │   │   │   ├── interface.ts
│       │   │   │   │   ├── openai.ts          # v1
│       │   │   │   │   └── anthropic.ts       # planned
│       │   │   │   ├── services/
│       │   │   │   │   ├── orchestrator.ts
│       │   │   │   │   ├── selector.ts        # Investigation selection cron
│       │   │   │   │   └── queue.ts
│       │   │   │   ├── cache/
│       │   │   │   │   └── investigation-cache.ts
│       │   │   │   └── db/
│       │   │   │       └── client.ts
│       │   │   └── hooks.server.ts
│       │   ├── prisma/
│       │   │   └── schema.prisma
│       │   ├── Dockerfile
│       │   ├── svelte.config.js
│       │   ├── vite.config.ts
│       │   ├── tsconfig.json          # Extends ../tsconfig.base.json
│       │   └── package.json
│       │
│       ├── shared/                    # Shared types between extension + API
│       │   ├── src/
│       │   │   ├── types.ts           # InvestigationResult, Claim, PlatformContent, etc.
│       │   │   ├── schemas.ts         # Zod schemas
│       │   │   └── normalize.ts       # normalizeContent()
│       │   ├── tsconfig.json
│       │   └── package.json
│       │
│       ├── pulumi/                    # Official hosted infra — deploys helm/openerrata
│       │   ├── index.ts               # Uses @pulumi/kubernetes.helm.v3.Chart
│       │   ├── tsconfig.json
│       │   ├── package.json
│       │   └── Pulumi.yaml
│       │
│       ├── package.json               # pnpm workspace root
│       └── pnpm-workspace.yaml
│
├── SPEC.md
└── README.md
```

The chart does not bundle a database — it takes a `DATABASE_URL` as config (via `secrets.yaml`),
pointing at Supabase for the official hosted deployment or any Postgres-compatible database for
on-prem. On-prem operators deploy with `helm install openerrata ./src/helm/openerrata` and override
`values.yaml` for their environment. The official hosted deployment uses Pulumi's
`@pulumi/kubernetes` Helm provider to deploy the same chart with hosted-specific overrides
(Supabase connection string, domain, TLS, autoscaling). This guarantees that on-prem and hosted
deployments use identical workload definitions — no drift between two separate deployment
manifests.

Each sub-project's `tsconfig.json` extends the shared base:

```jsonc
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    // project-specific overrides (e.g. DOM lib for extension, node for api)
  },
}
```

---

## Open Questions

### Resolved

1. ~~**Claim granularity**~~ — Single-pass investigation. Model identifies and clusters claims
   naturally.
2. ~~**Confidence threshold**~~ — No numeric threshold. Prompt-based criteria. See 2.4.
3. ~~**User feedback**~~ — Not in v1.
4. ~~**Privacy**~~ — No anonymization. Investigations are public by default. Public eligibility is
   derived from raw verification signals (provenance + corroboration count), not stored as state.
5. ~~**Monetization**~~ — Free tier + paid subscription.
6. ~~**Provider selection**~~ — OpenAI v1, Anthropic planned.
7. ~~**Public appeals workflow**~~ — Not in v1.
8. ~~**Primary public metric**~~ — Track fact-check incidence (% investigated posts with >=1 flag).
9. ~~**Reproducibility target**~~ — Best-effort reproducibility via persisted run artifacts (prompt,
   model metadata, tool trace, source snapshots).

### Open

1. **LessWrong API vs. DOM scraping** — Using LW's GraphQL API server-side would verify against what
   LessWrong actually serves, not what appears in the user's DOM. Trade-off: adds a request + API
   dependency. Worth investigating.
2. **Future analysis types** — What ships after fact-checking? Candidates: source quality, logical
   structure, steelmanning, background context. TBD.
3. **Investigation prompt** — The exact system prompt. Needs careful iteration.
