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

v1 ships fact-checking for posts on LessWrong, X, Substack, and Wikipedia.
Investigations use post text plus attached images when available. Posts classified
as `has_video` (any detected video/iframe embed) are skipped, even when text and
images are also present.

Users can trigger investigations in two ways (both async queued):

- Instance-managed credentials
- A user provided OpenAI key

In addition to user-requested investigations (which are shared with everyone
who uses the same service), service operators can configure regular
investigations of posts, based on a measure designed to investigate the posts
most likely to be read by users in the future.

The following are explicitly out of scope:

**Not in v1 (but will be attempted in the future):**

- Additional platforms beyond LessWrong, X, Substack, and Wikipedia.
- Analysis types other than fact-checking — the model supports extensibility, but v1
  doesn't ship it.
- Fact-checking comments or threads, in addition to top-level isolated posts.
- Mobile support.
- Analysis of:
  - Video content itself (video/iframe frames are not analyzed in v1)
  - Comments
  - Quote Tweets
- End-user appeals — users can flag errors or omissions in an investigation, and
  the system re-investigates with their feedback as additional context, updating
  the claim list accordingly (see §2.11).
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
| **OpenErrata API**         | Records post views, serves cached investigations, runs selection, and exposes both internal RPC endpoints and a public GraphQL API. All investigations execute asynchronously through the queue (including user-supplied key requests). |
| **Blob Storage**           | Stores downloaded investigation-time images (hash-deduplicated). The model receives the image bytes inline, not blob URLs.                                      |
| **Investigation Selector** | Cron job that periodically admits uninvestigated posts with the highest capped unique-view score, up to a per-UTC-day budget, and enqueues them. Pluggable selection algorithm — v1 uses capped unique-view score; future versions can factor in recency, engagement, author, etc. |
| **Public Website**         | Server-rendered SvelteKit site listing corrections and showing each investigation's claims, reasoning, and sources. A read-only client of the public GraphQL API (§3.4); it has no database access. |

## 2.4 LLM Investigation Approach

Six key design decisions:

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
   alongside text. Video is not analyzed in v1; posts classified as
   `has_video` (any detected video/iframe embed) are visibly
   skipped.
5. **Edited posts use incremental updates.** If a post is edited and a prior
   complete `SERVER_VERIFIED` investigation exists, we run an "update investigation"
   that uses the previous claims plus a content diff to avoid unnecessary churn.
6. **Two-stage pipeline: investigation + validation.** Each investigation runs
   in two stages. Stage 1 is the agentic fact-check call where the model uses
   `submit_correction` (fresh) or `submit_correction`/`retain_correction` (update)
   tools to incrementally submit candidate claims as it finds them. Stage 2 is a
   per-claim validation pass: each candidate claim is independently reviewed by a
   separate model call against strict quality criteria, and only claims that pass
   validation (`{approved: true}`) are persisted. This two-stage approach reduces
   false positives beyond what the investigator prompt alone achieves.

### 2.4.3 Update-Aware Prompting

For update investigations only, the prompt includes:

- `oldClaims`: claims from the latest complete `SERVER_VERIFIED` investigation for the same post
- `currentArticle`: normalized text of the new version
- `contentDiff`: a deterministic line-oriented diff from the previous version

The model is instructed to keep unchanged claims stable and only modify, remove, or add claims
that materially change due to the diff. The default full-investigation path remains unchanged when no
prior complete `SERVER_VERIFIED` investigation exists.

### 2.4.3.1 Incremental Claim Submission

The investigator submits claims incrementally via tool calls rather than returning
a single structured output at the end:

- **`submit_correction`** — called as each incorrect claim is found during
  investigation. The model does not batch or defer claims; it calls this tool
  immediately upon finding evidence of incorrectness.
- **`retain_correction(id)`** — update investigations only. Called for each prior
  claim that is still valid and unchanged. Prior claims not retained are
  automatically removed.

This incremental approach enables real-time progress visibility: as Stage 1
runs, the extension can display `pendingClaims` (submitted but not yet validated)
and `confirmedClaims` (passed Stage 2 validation) to the user.

### 2.4.3.2 Stage 2: Per-Claim Validation

Each candidate claim submitted by Stage 1 is independently validated by a
separate model call with a strict quality-filter prompt. Validation runs are
started in parallel (concurrency-limited to 4) as claims are submitted during
Stage 1, so validation overlaps with ongoing investigation.

The validation prompt instructs the model to approve the claim only if it
provides concrete contradictory evidence from credible sources, and to reject
it if the evidence is weak, ambiguous, disputed, or if the claim text is not
verbatim from the original post. The validator returns `{approved: true}` or
`{approved: false}`.

Only approved claims are included in the final investigation result. This
strict filter is the primary mechanism for maintaining the low false-positive
rate that the system's credibility depends on.

### 2.4.4 Structured Markdown Rendering

The investigator prompt uses a single content section:

1. **Markdown content when available** — generated from stored HTML snapshots
   and used as the article content section.
2. **Flat text fallback** — used only when markdown is unavailable (`markdownSource = NONE`).

Markdown is produced from version-scoped HTML (`HtmlBlob` referenced by
`*VersionMeta` rows), then snapshotted into immutable `InvestigationInput`
(`markdown`, `markdownSource`, `markdownRendererVersion`) when the investigation
is created, together with the source URL behind each `[IMAGE:N]` placeholder
(resolved to an absolute URL against the post URL; images without a fetchable
source get no placeholder) and the prompt context (post URL, author, publication
time, video flag). The investigator matches placeholders to downloaded images by
source URL, never by position. Every attempt reuses that snapshot verbatim, so
investigation input is stable across attempts even if markdown conversion logic or
the live post metadata change later.

Claim `text` and `context` still must anchor against normalized post text in the
extension, so markdown formatting characters are stripped from model outputs
before persistence when doing so preserves text anchoring.

### Why Single-Pass

|                   | Extract-then-investigate (per-claim) | Single-pass (whole post)                                   |
| ----------------- | ------------------------------------ | ---------------------------------------------------------- |
| **Context**       | Model sees one claim in isolation    | Model sees full post — understands caveats, qualifications |
| **Latency**       | N+1 API calls                        | 1 API call                                                 |
| **Cost**          | System prompt repeated N times       | One system prompt, amortized                               |
| **Deduplication** | We must deduplicate related claims   | Model naturally clusters/skips redundant claims            |

**Word count limit:** v1 only investigates posts up to ~10,000 words. Posts
exceeding this limit are skipped with an indication in the extension (just like
`has_video` posts). This keeps the single-pass model simple and avoids chunking
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
against the same normalized content text it reported to the API (one text index over the live
content root, block boundaries included as word breaks — §3.8 "Content normalization"), so claim
and context strings line up with the page exactly as they did for the investigator. Matches map
back to text-node pieces, which are highlighted individually; removing highlights restores the
page's own text nodes (it never merges text nodes the page owns). Matching uses:

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
- **Video is non-analyzable in v1.** Posts classified as `has_video` (any detected video/iframe
  embed) are skipped even when text is present and even when extracted images are present.

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
- **Advanced:** API server URL and instance API
  key. If unset, defaults to hosted instance. A stored value that is set but
  unusable (e.g. an API URL that fails validation) is an error shown in the
  options page and popup, and the extension makes no API calls until it is
  fixed — it never falls back to the hosted instance.

### Annotation Styling

One annotation type: **incorrect claim** — red underline. Only incorrect claims
are highlighted; correct and ambiguous claims are not annotated.

Subtle by default (thin red underline). Hover shows a tooltip with the one- or
two-sentence summary. Click expands full reasoning + source links. CSS custom
properties adapt to dark/light themes.

## 2.6 Data Flow

**View path (all users):**

The extension-to-API view path uses two sequential calls. The first call
(`registerObservedVersion`) sends platform-observed content, resolves the
canonical content version, and returns a `postVersionId`. The second call
(`recordViewAndGetStatus`) takes that `postVersionId`, records the view, and
returns investigation status. This split lets the second call use a cheap
primary-key lookup instead of re-deriving the content version.

```
User visits post
  → Content script extracts metadata + observed content text/media state/image URLs
  → If the adapter detects private/gated access, emit `PAGE_SKIPPED(reason="private_or_gated")`
    and stop (no API requests are sent)
  → Background worker calls API: registerObservedVersion(...)
      - Include observedContentText for X/Substack/Wikipedia
      - For LessWrong, include metadata.htmlContent (do not include observedContentText)
      - Include observed image URLs and image occurrences for metadata persistence
  → API upserts Post + platform metadata
  → API attempts server-side content verification (best effort):
      VERIFIED + matches observed content  → continue with `SERVER_VERIFIED`
      VERIFIED + mismatch                  → record integrity anomaly + continue with `SERVER_VERIFIED`
                                            (authoritative source is still server canonical content)
      NOT VERIFIED                         → continue with `CLIENT_FALLBACK`
  → API upserts PostVersion (content blob + image occurrences + provenance)
  → API returns { platform, externalId, versionHash, postVersionId, provenance }

  → Background worker calls API: recordViewAndGetStatus({ postVersionId })
  → API looks up PostVersion by primary key
      NOT FOUND → reject request (unknown post version)
  → API increments raw viewCount, updates uniqueViewScore, records corroboration credit
  → API checks the investigation of this content version (at most one exists, §3.5):
      COMPLETE → return { investigationState: "INVESTIGATED", investigationId, provenance, claims }
                 (already investigated for this content version; client is done)
      PENDING / PROCESSING →
         return { investigationState: "INVESTIGATING", investigationId, status, provenance,
                  pendingClaims, confirmedClaims, priorInvestigationResult }
         (queued by another viewer, the selector, or an earlier visit; the client polls
          getInvestigation({ investigationId }) until it settles, exactly as for its own;
          priorInvestigationResult carries claims forward as below)
      FAILED → return { investigationState: "FAILED", investigationId, provenance }
               (auto-investigate does not start new work for a failed version)
      NONE →
         return { investigationState: "NOT_INVESTIGATED",
                  priorInvestigationResult: { oldClaims, sourceInvestigationId } | null }
         (claims carried forward from another version, §2.8 "Interim carry-forward";
          null when none applies; no run is queued)
  → Client renders current state; recordViewAndGetStatus alone does not enqueue a new investigation
  → Investigation begins only via investigateNow(...) or selector queueing
```

**Investigate-now path (both auth modes, unified async queue):**

The extension reuses the `postVersionId` from `registerObservedVersion` (which
was already called during the view path) to call `investigateNow`. If the
content has changed since the view, the extension calls `registerObservedVersion`
again first.

```
User clicks "Investigate Now" (or auto-investigate triggers)
  → Background worker calls API: registerObservedVersion(...) (if not already done)
  → Background worker calls API: investigateNow({ postVersionId }),
    optionally including a user OpenAI key via x-openai-api-key header
  → The request's funding: its user OpenAI key if it sent one, otherwise the instance
    API key it authenticated with; neither → reject (UNAUTHORIZED)
  → API looks up PostVersion by primary key
      NOT FOUND → reject request (unknown post version)
  → API checks for an existing Investigation row for that content version
      no row     → reject if over the word limit; if funding is a user key, verify it with
                   OpenAI first (rejected or unverifiable → reject the request, nothing is
                   created); create the PENDING row with update lineage (§2.4.3) and the
                   request's funding (origin INSTANCE_REQUEST or USER_KEY_REQUEST, user key
                   attached in the same transaction), enqueue,
                   return { investigationId, status: PENDING }
  → If a row already exists, API returns immediately with status-based behavior:
      COMPLETE   → return { investigationId, status: COMPLETE, claims }
      FAILED     → return { investigationId, status: FAILED } (FAILED is terminal, §3.7)
      PROCESSING → return { investigationId, status: PROCESSING }; no second run is started
                   (an expired lease is recovered first, §3.7)
      PENDING    → funded (someone is paying): ensure a queue job exists; the request's
                   user key is never attached — it never takes over a run someone else funds
                   unfunded (its user key was dropped, §3.7): fund it with this request
                   (verifying a user key first), enqueue
                   return { investigationId, status: PENDING }
  → Extension polls getInvestigation({ investigationId }) until COMPLETE/FAILED
  → Worker claims queued job, sets PROCESSING, runs investigation, then writes COMPLETE/FAILED
```

**Auto-investigate (extension-side):**

```
After recordViewAndGetStatus returns { investigationState: "NOT_INVESTIGATED",
                                       priorInvestigationResult: ... | null }
  → If user OpenAI key exists and auto-investigate is enabled:
      background worker calls investigateNow({ postVersionId }) and then polls for completion
  → Result is cached locally when returned
```

**Background selection (server-managed daily budget):**

```
Cron job runs every N minutes
  → Recover expired leases; re-enqueue funded PENDING investigations that are due
  → Admit uninvestigated latest versions (and unfunded investigations) ORDER BY
    unique_view_score DESC, while today's SELECTOR admissions < SELECTOR_DAILY_BUDGET
  → INSERT Investigation(status=PENDING, origin=SELECTOR) for each new one
  → Job queue workers pick up and investigate
```

## 2.7 API Surface, Author Tracking, & Public Data

Public GraphQL endpoints expose full flagged claims, reasoning, and sources for
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

- **On every view**: `registerObservedVersion` resolves the content version and returns a
  `postVersionId`; `recordViewAndGetStatus` increments raw viewCount, updates uniqueViewScore
  with capped credit rules, and checks for cached results.
- **Client input simplification**: the extension sends platform-observed content to
  `registerObservedVersion`; the API computes the version key internally. Subsequent calls
  (`recordViewAndGetStatus`, `investigateNow`) reference the resolved version by `postVersionId`.
- **Hit**: Return claims. The view still increments the counter.
- **Miss**: Return `{ investigationState: "NOT_INVESTIGATED", priorInvestigationResult }`, with
  claims carried forward from another version when any apply (below). The view is recorded;
  the selector may pick this post up later.
- **Strict version rule**: Never return or render an investigation for a different content version
  of the same post as that version's result. The only claims of another version a viewer sees
  are the interim ones below.
- **Interim carry-forward**: While the requested version has no finished investigation (not
  investigated yet, or investigating), `priorInvestigationResult` (`{ oldClaims,
  sourceInvestigationId }`) comes from the post's latest complete investigation (by
  `checkedAt`) on another version — never the requested version itself — of either
  provenance, and holds only the claims whose exact `text` still occurs in the requested
  version's content text (after the same normalization claim texts were taken from, §3.8).
  If there is no such investigation or none of its claims survives, it is null.
  Rationale: a correction is only shown while the exact text it corrects is still on the
  page. An edit (or a content-normalization change) then never leaves a correction pointing
  at text that is gone, and a correction of text that is still there stays visible until the
  new version's own investigation replaces it, however the earlier version's content was
  obtained. This is a temporary UI state only: it is not a cache hit, does not by itself
  queue an investigation, and does not change which investigation an update run uses as its
  parent (still the latest complete `SERVER_VERIFIED` one, §2.4.3).
- **Version key semantics**: The version key (`versionHash`) is derived from both normalized text
  and image occurrences: `sha256(contentHash + "\n" + occurrencesHash)`. For LessWrong and
  Wikipedia, normalized text is derived server-side from canonical sources; for X/Substack it is
  derived from `observedContentText`.
- **Idempotent creation**: If a duplicate investigation is requested (same post + content version), reuse the
  existing row rather than creating a second one.
- **Stale prompt**: If the investigation's prompt version doesn't match the current server prompt,
  the result is still served. Future versions will expand this to support refreshes.
- **TTL**: No expiry — fact-checks are durable.

## 2.9 Content Verification & Degraded Mode

One problem is how to verify the accuracy of the content that users send us
from the browser extension. For some platforms this is easier than others; it's
hard to cross-verify e.g. twitter posts, but it's easier to verify that a
particular person indeed wrote a particular LessWrong/Substack/Wikipedia article. The app
only displays highlights for posts when their content/metadata matches, but
verification is still necessary to support future endeavors like credibility
scores.

So server-side verification is preferred but best-effort.

- Identity binding rule: server-canonical responses define authoritative platform identity.
  For server-verifiable platforms (for example, Wikipedia `pageId` + `revisionId`), if
  client-submitted identity disagrees with the platform response, the API records an
  integrity anomaly and corrects stored identity to the server value. The post URL and
  author are identity too: when the server fetch succeeds (LessWrong: post URL from
  `_id` + `slug`, author and title from the post's user; Wikipedia: article URL from the
  parse API title), they come from the platform response and `Post.identityVerifiedAt`
  latches. Once latched, client-submitted URL/author never overwrite them.
- Client-submitted post URLs are validated per platform before they are stored: `https`
  only, on the platform's host (`lesswrong.com`, `x.com`/`twitter.com`,
  `<lang>.wikipedia.org`; Substack may use custom domains, so only a `/p/<slug>` path is
  required), naming the same post as `externalId` where the URL encodes it.
- The canonical fetch runs inside `registerObservedVersion`, so it is bounded: one
  10-second deadline across all transient retries and a 10 MB response cap; exceeding
  either falls back to `CLIENT_FALLBACK`.
- Primary path: server verifies platform content and derives the canonical content version.
- Mismatch policy: if identity-bound verification succeeds but conflicts with submitted content,
  record an integrity anomaly and continue with the server-derived canonical content
  (`SERVER_VERIFIED`). The request is not rejected because serving the server-canonical version is
  safer than dropping service, but the mismatch remains a real integrity signal to monitor.
- Degraded path: if server fetch fails (rate limit, temporary provider/platform outage, anti-bot
  block), investigations may proceed using client-observed content.
- Every investigation stores provenance (`SERVER_VERIFIED` or `CLIENT_FALLBACK`).

Image handling uses a single required path:

- Investigation-time image URLs are downloaded, hash-deduplicated, uploaded to blob storage, and
  attached to the investigation as multimodal input.
- Blob storage configuration is mandatory for all deployments.

The system stores raw verification signals, so users can decide what to trust:

- `provenance`: investigation input provenance (`SERVER_VERIFIED` or `CLIENT_FALLBACK`)
  stored on immutable `InvestigationInput`.
- `corroborationCredits`: one corroboration credit per distinct authenticated user who submitted
  matching content for that investigation.
- `serverVerifiedAt`: timestamp latch on `PostVersion` set on successful server-side verification
  (null if not yet verified).

Public-facing endpoints do not enforce an eligibility threshold in v1. Any
completed investigation can be returned, and public responses include raw trust
signals (provenance + corroboration count + verification timestamp) so
consumers can apply their own trust policy.

**Signal updates:** The raw signals change in two places:

- **On `recordViewAndGetStatus`**: when an authenticated user views a post with a client-fallback
  investigation and submits matching content, corroboration credit is added for that reporter
  (duplicate submissions from the same reporter are ignored).
- **On successful server-side fetch**: if a previously-failed server fetch later succeeds
  (e.g., on a subsequent `registerObservedVersion` where the server retries),
  matching `PostVersion` rows latch `serverVerifiedAt` from null to a timestamp.
  Existing investigation provenance snapshots are immutable and are not rewritten.
- **Interim display policy:** interim claims may come from a `CLIENT_FALLBACK` investigation as
  well as a `SERVER_VERIFIED` one (§2.8 "Interim carry-forward"): what makes a carried-forward
  claim safe to show is that the exact text it corrects is on the viewer's page, not how the
  earlier version's content was obtained.

## 2.10 Investigation Prioritization

The investigation selector is a cron job that runs every N minutes, selecting uninvestigated posts
ordered by capped unique-view score. The budget (`SELECTOR_DAILY_BUDGET`, default 100) caps the
investigations the selector admits per UTC day, however often it runs. Investigations admitted by
investigateNow (instance-key or user-key funded) do not count against it; re-enqueueing already
admitted work does not either.

Scoring rules (v1):

- Raw `viewCount` increments on every view for analytics.
- `uniqueViewScore` increments by +1 only when both conditions hold:
  - no existing credit for this viewer on this post today (max 1 credit per account/session per
    post per 24h)
  - IP-range credit cap for this post today has not been exceeded
- The IP-range credit cap is configurable.
- The client IP behind both rules is the viewer's, not the proxy's: behind the deployment's
  ingress the API reads it from the trusted proxy header (`ADDRESS_HEADER` / `XFF_DEPTH`), and
  refuses to start in production without that configuration. A client address that is not an IP
  address is a configuration error, not a bucket.

This naturally handles edits: if a post was investigated but then edited, the content hash no longer
matches any existing investigation, so it re-enters the selection pool.

Future selection signals (only the query changes):

- Recency
- Platform engagement (karma, likes, retweets)
- Author prominence
- Content characteristics (length, topic, claim density)
- Time since last investigation (for re-checks)

## 2.11 Appeals

v1 has no public appeal workflow. This is an explicit product choice — the
initial version establishes the baseline investigation pipeline and trust
signals before exposing user-driven feedback loops.

### Planned: End-User Appeals (post-v1)

After v1, users should be able to appeal an investigation by pointing out
specific things the AI got wrong — either false positives (claims flagged
incorrectly) or false negatives (incorrect claims the investigation missed).
The system would re-investigate the post with the appeal text as additional
context, producing an updated claim list that adds, removes, or modifies
errata.

Key design considerations for appeals:

- **Resistant to abuse.** We make it clear to the AI that it should not take
  any information in an appeal for granted, and should reverify everything that
  the user says.
- **Appeals are auditable, and produce a new investigation, not a mutation of
  the original.** The original investigation and its claims remain as an
  immutable audit record. Appeal investigations reference their parent and
  store appeal context. This preserves the transparency goal — anyone can see
  what the original pass found, what was appealed, and what the
  re-investigation concluded.
- **The `@@unique([postVersionId])` constraint needs a discriminator.**
  The v1 schema enforces one investigation per content version. Appeals require
  allowing multiple investigations for the same content, distinguished by type
  (e.g., `ORIGINAL` vs `APPEAL`) or by a parent investigation reference.
- **Appeal context is provided to the LLM alongside the original post.** The
  re-investigation prompt includes the original claims and the user's appeal
  text, so the model can specifically address the user's objections and look for
  things the first pass may have missed.
- **The extension and public API need to resolve which claims to display.** When
  an appeal investigation exists, the system must decide how to present results
  — likely showing the most recent investigation's claims, with a link to the
  appeal history for transparency.

## 2.12 Reproducibility & Auditability

Goal: investigations should be as reproducible as possible, while acknowledging
provider web-search results can change over time.

For every completed investigation, persist audit artifacts:

- Normalized input text and `contentHash`
- Content provenance and any server-fetch failure reason
- Prompt reference (`promptId` → `Prompt.version`, `Prompt.hash`, `Prompt.text`)
- Provider/model metadata: the provider enum, the provider model id the stage-1
  fact-check ran on (recorded at completion, never predicted at queue time), and
  the provider-reported model version of the final stage-1 response
- Normalized per-attempt records, with one request record per provider request
  (each stage-1 fact-check round and each stage-2 claim validation): the exact
  model, instructions, input (image parts recorded by content hash), previous
  response id, reasoning options, `include` values and tool definitions sent; and
  its response, if any: output items with their text parts + citations, reasoning
  summaries and tool calls (raw provider payloads, including web-search sources),
  and token usage. Attempt-level provider/parsing errors.
- Attempts recorded before per-request auditing (pre-2026-10) are kept as a single
  `LEGACY_COMBINED` request whose fields merge all of that attempt's requests
- Input lineage for update runs: `oldClaims`, current article text, and computed
  content diff included in request/input records so we can reconstruct why only parts changed
- The immutable excerpt (`snippet`) for each claim source; what the model actually retrieved
  (web search results, `fetch_url` bodies with retrieval timestamps) is in the attempt's raw
  tool-call payloads
- Per-attempt records are insert-only and keyed by a never-reset attempt number, so retries
  never overwrite earlier attempts

Stored artifacts are the canonical audit record. Re-running the same
investigation later may produce different outputs because external web content
and provider search indexes are time-varying.

## 2.13 Abuse Resistance

`registerObservedVersion` and `recordViewAndGetStatus` are unauthenticated
write endpoints. Without mitigation, an attacker could inflate
`uniqueViewScore` to prioritize arbitrary posts, fabricate post content that
gets sent to the LLM, or DoS the API with junk views. Full rate limiting is
out of scope for v1, but the following baseline measures are required:

1. **Extension attestation signal (not authentication).** The extension includes an attestation
   signal generated from a bundled default secret (with an optional local override in extension
   settings). Because extensions are inspectable, this is
   at most a low-confidence abuse signal for filtering/telemetry, never a security boundary.
   The v1 server does not verify or consume it; authorization and trust decisions must not rely
   on it.
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
6. **SSRF-safe fetching.** Investigation-time image downloads and the model's `fetch_url` tool
   fetch URLs chosen by untrusted input, so the check lives on the connection: every connection
   resolves through a DNS lookup that rejects the answer unless all addresses are public unicast
   (no private, loopback, link-local, CGNAT, multicast, reserved, IPv4-mapped, NAT64, 6to4 or
   Teredo ranges) and pins the connection to the addresses it checked, so DNS rebinding has no
   window. IP-literal hosts, embedded credentials and non-HTTP(S) schemes are rejected before
   dispatch; redirects are followed manually through the same check; bodies are read up to a
   byte cap. Images are downloaded only after the run's funding key is resolved.
7. **Transport limits.** The following limits are enforced on API inputs:
   - `MAX_OBSERVED_CONTENT_TEXT_CHARS` / `MAX_OBSERVED_CONTENT_TEXT_UTF8_BYTES`: 500,000
   - `MAX_IMAGES_PER_INVESTIGATION`: 10
   - `MAX_IMAGE_BYTES`: 20 MB
   - `MAX_BATCH_STATUS_POSTS`: 100

These measures are not sufficient against a determined attacker but are adequate for v1. Stronger
measures (proof-of-work, behavioral analysis) are planned for future versions.

---

# Part 3 — Spec

## 3.1 Tech Stack

| Layer           | Technology                                                        | Rationale                                                                     |
| --------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Extension UI    | **Svelte 5 + component-scoped CSS**                               | Lightweight UI layer with minimal runtime overhead and predictable styling     |
| Extension build | **Vite (custom multi-entry build + IIFE content-script build)**   | Produces MV3-compatible bundles for background, popup/options, and content scripts |
| Cross-browser   | **webextension-polyfill**                                         | Normalizes Chrome/Firefox API differences behind a single Promise-based API   |
| Type safety     | **TypeScript + Zod**                                              | Runtime validation at API boundary                                            |
| API framework   | **SvelteKit + tRPC + GraphQL**                                    | tRPC for extension/internal consumers; GraphQL for public third-party API     |
| Database        | **Postgres + Prisma**                                             | Stores posts, content versions, investigations, view credits, audit records   |
| Job queue       | **Postgres-backed** (graphile-worker)                             | No Redis dependency; runs against the same database                           |
| Public website  | **SvelteKit (server-rendered)**                                   | Reads only the public GraphQL API; parses responses with the shared public schemas |
| LLM             | **OpenAI Responses API with tools** (`gpt-6.1-sol`)               | v1 provider and model, fixed in code (`openai-request-config.ts`). Anthropic support planned via `Investigator` interface |
| Auth            | **Anonymous + required instance OpenAI key + optional request-scoped user OpenAI key** | Instance-managed investigations are always available; users may still override with their own key for on-demand runs |
| Deployment      | **Helm chart** (on-prem), **Pulumi** (official hosted, deploys the same chart)         | Single artifact for both on-prem and hosted; no deployment drift                                                     |

## 3.2 Data Model

### Post (shared base)

`Post` is a thin identity record. Content versions, text, and investigation linkage
flow through `PostVersion` (see §3.2.4).

```prisma
model Post {
  id              String   @id @default(cuid())
  platform        Platform
  externalId      String          // Platform's native ID
  url             String          // https on the platform host; server-verified when identityVerifiedAt is set
  authorId        String?
  author          Author?  @relation(fields: [authorId], references: [id])
  identityVerifiedAt DateTime?    // Latch: url/author came from a server fetch; client data never overwrites them
  viewCount       Int      @default(0) // Raw views (analytics)
  uniqueViewScore Int      @default(0) // Capped selector score
  lastViewedAt    DateTime?
  versions        PostVersion[]
  viewCredits     PostViewCredit[]
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

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
  WIKIPEDIA
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

### Instance API keys

Operators issue API keys that authorize `investigateNow` on the instance's own
OpenAI key. Only a SHA-256 hash of each key is stored; keys are managed with
`pnpm --filter @openerrata/api instance-api-key` (list / activate / revoke).

```prisma
model InstanceApiKey {
  id        String    @id @default(cuid())
  name      String
  keyHash   String    @unique  // SHA-256 of the trimmed key
  revokedAt DateTime?          // Revoked keys are kept for audit and never authorize
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  @@index([name])
  @@index([revokedAt])
}
```

### Extension version counts

`recordViewAndGetStatus` counts each page view against the reporting extension
version (`x-openerrata-extension-version`) and the UTC day, and nothing else: no
viewer key, IP range, post or time of day, so a row describes traffic, never a
viewer (see PRIVACY.md). The counts tell when an extension line the API still
serves has gone quiet, which is the retirement condition of the legacy v0
protocol adapter (§3.8.1).

```prisma
model ExtensionVersionDailyCount {
  day           DateTime @db.Date  // UTC day
  version       String             // 1–4 numeric components (CHECK)
  pageViewCount Int                // > 0 (CHECK); upserted atomically per view

  @@id([day, version])
}
```

### Platform metadata

Platform metadata is version-scoped only. Each `PostVersion` can have one
platform-specific metadata row (`LesswrongVersionMeta`, `XVersionMeta`,
`SubstackVersionMeta`, `WikipediaVersionMeta`). HTML snapshots are
content-addressed in `HtmlBlob` and referenced by version metadata via
source-scoped `serverHtmlBlobId` / `clientHtmlBlobId`.

### Content versioning

Content text and image positions are stored in content-addressed tables, shared
across `PostVersion` rows when identical. `PostVersion` is the central
intermediary linking a `Post` to its `Investigation`: each version captures
a snapshot of content + images, and at most one investigation may exist per
version.

```prisma
model ContentBlob {
  id          String   @id @default(cuid())
  contentHash String   @unique    // SHA-256 of contentText
  contentText String               // Normalized plain text
  wordCount   Int                  // Computed on creation; posts >10000 words skipped by selector
  createdAt   DateTime @default(now())

  postVersions PostVersion[]
}

model HtmlBlob {
  id          String   @id @default(cuid())
  htmlHash    String   @unique    // SHA-256 of htmlContent
  htmlContent String
  createdAt   DateTime @default(now())

  lesswrongServerVersionMetas LesswrongVersionMeta[] @relation("LesswrongServerHtml")
  lesswrongClientVersionMetas LesswrongVersionMeta[] @relation("LesswrongClientHtml")
  substackClientVersionMetas  SubstackVersionMeta[]  @relation("SubstackClientHtml")
  wikipediaServerVersionMetas WikipediaVersionMeta[] @relation("WikipediaServerHtml")
  wikipediaClientVersionMetas WikipediaVersionMeta[] @relation("WikipediaClientHtml")
}

model ImageOccurrenceSet {
  id              String   @id @default(cuid())
  occurrencesHash String   @unique    // SHA-256 of sorted occurrence data, for dedup
  createdAt       DateTime @default(now())

  occurrences  ImageOccurrence[]
  postVersions PostVersion[]
}

model ImageOccurrence {
  id                   String             @id @default(cuid())
  occurrenceSetId      String
  occurrenceSet        ImageOccurrenceSet @relation(fields: [occurrenceSetId], references: [id], onDelete: Cascade)
  originalIndex        Int                // 0-based ordinal position of the image in the page
  normalizedTextOffset Int                // Character offset in the normalized content text
  sourceUrl            String
  captionText          String?
  createdAt            DateTime           @default(now())

  @@unique([occurrenceSetId, originalIndex])
  @@index([occurrenceSetId, normalizedTextOffset, originalIndex])
}

model PostVersion {
  id                   String             @id @default(cuid())
  postId               String
  post                 Post               @relation(fields: [postId], references: [id], onDelete: Cascade)
  versionHash          String             // sha256(contentHash + "\n" + occurrencesHash)
  contentBlobId        String
  contentBlob          ContentBlob        @relation(fields: [contentBlobId], references: [id])
  imageOccurrenceSetId String
  imageOccurrenceSet   ImageOccurrenceSet @relation(fields: [imageOccurrenceSetId], references: [id])
  serverVerifiedAt     DateTime?          // One-way latch: null -> DateTime when canonical verification succeeds
  firstSeenAt          DateTime           @default(now())
  lastSeenAt           DateTime           @default(now())
  seenCount            Int                @default(1)

  investigation        Investigation?
  lesswrongVersionMeta LesswrongVersionMeta?
  xVersionMeta         XVersionMeta?
  substackVersionMeta  SubstackVersionMeta?
  wikipediaVersionMeta WikipediaVersionMeta?
  @@unique([postId, versionHash])
  @@unique([postId, contentBlobId, imageOccurrenceSetId])
  @@index([postId, lastSeenAt])
}

model LesswrongVersionMeta {
  postVersionId     String      @id
  postVersion       PostVersion @relation(fields: [postVersionId], references: [id], onDelete: Cascade)
  slug              String
  title             String?
  serverHtmlBlobId  String?
  serverHtmlBlob    HtmlBlob?   @relation("LesswrongServerHtml", fields: [serverHtmlBlobId], references: [id], onDelete: Restrict)
  clientHtmlBlobId  String?
  clientHtmlBlob    HtmlBlob?   @relation("LesswrongClientHtml", fields: [clientHtmlBlobId], references: [id], onDelete: Restrict)
  imageUrls         String[]
  karma             Int?
  authorName        String?
  authorSlug        String?
  tags              String[]
  publishedAt       DateTime?
  createdAt         DateTime    @default(now())

  @@index([slug])
}

model XVersionMeta {
  postVersionId      String      @id
  postVersion        PostVersion @relation(fields: [postVersionId], references: [id], onDelete: Cascade)
  tweetId            String
  text               String
  authorHandle       String
  authorDisplayName  String?
  mediaUrls          String[]
  likeCount          Int?
  retweetCount       Int?
  postedAt           DateTime?
  createdAt          DateTime    @default(now())
}

model SubstackVersionMeta {
  postVersionId          String      @id
  postVersion            PostVersion @relation(fields: [postVersionId], references: [id], onDelete: Cascade)
  substackPostId         String
  publicationSubdomain   String
  slug                   String
  title                  String
  subtitle               String?
  clientHtmlBlobId       String?    // No Substack server fetch exists, so only client HTML is stored
  clientHtmlBlob         HtmlBlob?   @relation("SubstackClientHtml", fields: [clientHtmlBlobId], references: [id], onDelete: Restrict)
  imageUrls              String[]
  authorName             String
  authorSubstackHandle   String?
  publishedAt            DateTime?
  likeCount              Int?
  commentCount           Int?
  createdAt              DateTime    @default(now())

  @@index([publicationSubdomain, slug])
  @@index([substackPostId])
}

model WikipediaVersionMeta {
  postVersionId     String      @id
  postVersion       PostVersion @relation(fields: [postVersionId], references: [id], onDelete: Cascade)
  pageId            String
  language          String
  title             String
  displayTitle      String?
  serverHtmlBlobId  String?
  serverHtmlBlob    HtmlBlob?   @relation("WikipediaServerHtml", fields: [serverHtmlBlobId], references: [id], onDelete: Restrict)
  clientHtmlBlobId  String?
  clientHtmlBlob    HtmlBlob?   @relation("WikipediaClientHtml", fields: [clientHtmlBlobId], references: [id], onDelete: Restrict)
  revisionId        String
  lastModifiedAt    DateTime?
  imageUrls         String[]
  createdAt         DateTime    @default(now())

  @@index([language, pageId])
  @@index([revisionId])
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
  id                    String                 @id @default(cuid())
  postVersionId         String
  postVersion           PostVersion            @relation(fields: [postVersionId], references: [id])
  inputId               String                 @unique
  input                 InvestigationInput     @relation("InvestigationInputOwner", fields: [inputId], references: [investigationId], onDelete: Restrict)
  parentInvestigationId String?                // Prior completed investigation for update lineage
  parentInvestigation   Investigation?         @relation("InvestigationUpdateLineage", fields: [parentInvestigationId], references: [id])
  contentDiff           String?                // Line-oriented diff used for update-mode prompting
  status                CheckStatus
  promptId              String
  prompt                Prompt                 @relation(fields: [promptId], references: [id])
  provider              InvestigationProvider
  // INV-INV-MODEL-AT-COMPLETION: set iff status = COMPLETE (CHECK
  // "Investigation_model_consistency_check"); the provider model id the stage-1
  // fact-check requests were sent to, e.g. "gpt-6.1-sol".
  model                 String?
  modelVersion          String?                // Provider-reported revision of the final stage-1 response
  checkedAt             DateTime?              // Null until completion
  queuedAt              DateTime               @default(now())
  origin                InvestigationOrigin    // Who admitted (and pays for) the investigation, §3.7
  admittedAt            DateTime               // When the current origin admitted it; drives the daily selector budget
  // Monotonically increasing attempt counter, never reset. Incremented
  // atomically when a worker claims the lease, so every attempt has a distinct
  // attemptNumber in the InvestigationAttempt audit trail.
  attemptCount          Int                    @default(0)
  retryAfter            DateTime?              // Backoff gate for the selector after a transient failure
  // INV-LEASE: an InvestigationLease row exists iff status = PROCESSING.
  // Enforced at commit by deferred constraint triggers.
  lease                 InvestigationLease?
  openAiKeySource       InvestigationOpenAiKeySource?
  attempts              InvestigationAttempt[]
  updates               Investigation[]        @relation("InvestigationUpdateLineage")
  claims                Claim[]
  images                InvestigationImage[]
  corroborationCredits  CorroborationCredit[]
  createdAt             DateTime               @default(now())
  updatedAt             DateTime               @updatedAt

  @@unique([postVersionId])     // At most one investigation per content version
  @@index([status])
}

// Everything the investigator is given that could change after queue time,
// captured when the investigation is created; every attempt reuses it.
model InvestigationInput {
  investigationId            String             @id
  investigation              Investigation?     @relation("InvestigationInputOwner")
  // Immutable after insert; enforced by trigger "reject_investigation_input_updates_trigger".
  provenance                 ContentProvenance
  contentHash                String
  markdownSource             MarkdownSource
  markdown                   String?            // null iff markdownSource = NONE
  markdownRendererVersion    String?            // null iff markdownSource = NONE
  imagePlaceholderSourceUrls String[]           // Source URL behind each [IMAGE:N], indexed by N; empty when NONE
  postUrl                    String             // Prompt context, frozen at queue time
  authorName                 String?
  postPublishedAt            DateTime?
  hasVideo                   Boolean
  createdAt                  DateTime           @default(now())
}

// INV-LEASE: an InvestigationLease row exists iff its investigation is
// PROCESSING (checked at commit by deferred constraint triggers). All fields
// are NOT NULL — structurally prevents partial lease states. The row is
// deleted on every transition out of PROCESSING (COMPLETE, FAILED, release to
// PENDING, expired-lease recovery), so progressClaims is cleaned up with it.
model InvestigationLease {
  investigationId String        @id
  investigation   Investigation @relation(fields: [investigationId], references: [id], onDelete: Cascade)
  leaseOwner      String
  leaseExpiresAt  DateTime
  startedAt       DateTime
  heartbeatAt     DateTime
  progressClaims  Json?         // { pending: ClaimPayload[], confirmed: ClaimPayload[] }
  createdAt       DateTime      @default(now())

  @@index([leaseExpiresAt])
}

model InvestigationOpenAiKeySource {
  investigationId String        @id
  investigation   Investigation @relation(fields: [investigationId], references: [id], onDelete: Cascade)
  ciphertext      String                     // AES-256-GCM encrypted user API key
  iv              String
  authTag         String
  keyId           String                     // Identifies the encryption key version
  expiresAt       DateTime                   // Short-lived lease; worker must start before expiry
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt

  @@index([expiresAt])
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

// Insert-only: each attemptNumber is claimed once per investigation and its
// audit is written once, at the attempt's terminal transition.
model InvestigationAttempt {
  id              String                        @id @default(cuid())
  investigationId String
  investigation   Investigation                 @relation(fields: [investigationId], references: [id], onDelete: Cascade)
  attemptNumber   Int
  outcome         InvestigationAttemptOutcome
  startedAt       DateTime
  completedAt     DateTime?
  requests        InvestigationAttemptRequest[]
  error           InvestigationAttemptError?
  createdAt       DateTime                      @default(now())
  updatedAt       DateTime                      @updatedAt

  @@unique([investigationId, attemptNumber])
  @@index([investigationId, startedAt])
}

// One provider request made during an attempt, exactly as sent.
model InvestigationAttemptRequest {
  id                 String                              @id @default(cuid())
  attemptId          String
  attempt            InvestigationAttempt                @relation(fields: [attemptId], references: [id], onDelete: Cascade)
  kind               InvestigationAttemptRequestKind
  // INV-ATTEMPT-REQUEST-SUBJECT: factCheckRound is set iff kind = FACT_CHECK_ROUND;
  // claimIndex is set iff kind = CLAIM_VALIDATION (CHECK "InvestigationAttemptRequest_subject_check").
  factCheckRound     Int?
  claimIndex         Int?
  model              String   // Provider request model id (e.g. gpt-6.1-sol)
  instructions       String   // Exact instructions/system prompt sent
  input              Json     // Exact `input` sent; image parts carry imageContentHash (ImageBlob.contentHash) instead of the data URI
  previousResponseId String?  // Set on fact-check rounds after the first
  reasoningEffort    String?
  reasoningSummary   String?
  include            String[]
  requestedTools     InvestigationAttemptRequestedTool[]
  response           InvestigationAttemptResponse?   // Absent when the request failed without a response
  createdAt          DateTime                            @default(now())

  @@unique([attemptId, factCheckRound])
  @@unique([attemptId, claimIndex])
  @@index([attemptId])
}

model InvestigationAttemptRequestedTool {
  id            String                      @id @default(cuid())
  requestId     String
  request       InvestigationAttemptRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  requestOrder  Int
  toolType      String
  rawDefinition Json     // Full provider tool-definition payload for this request position
  createdAt     DateTime                    @default(now())

  @@unique([requestId, requestOrder])
  @@index([requestId])
}

model InvestigationAttemptResponse {
  id                 String                           @id @default(cuid())
  requestId          String                           @unique
  request            InvestigationAttemptRequest      @relation(fields: [requestId], references: [id], onDelete: Cascade)
  providerResponseId String
  status             String?   // Provider-reported status; null if omitted (the attempt then fails)
  modelVersion       String    // Provider-reported model revision
  receivedAt         DateTime? // Null only on LEGACY_COMBINED requests
  outputItems        InvestigationAttemptOutputItem[]
  usage              InvestigationAttemptUsage?
  createdAt          DateTime                         @default(now())
}

model InvestigationAttemptOutputItem {
  id                 String                                 @id @default(cuid())
  responseId         String
  response           InvestigationAttemptResponse           @relation(fields: [responseId], references: [id], onDelete: Cascade)
  outputIndex        Int
  providerItemId     String?
  itemType           String   // Provider-defined output item type
  itemStatus         String?
  // By itemType: textParts for "message", reasoningSummaries for "reasoning",
  // toolCall for every other (tool call) item.
  textParts          InvestigationAttemptOutputTextPart[]
  reasoningSummaries InvestigationAttemptReasoningSummary[]
  toolCall           InvestigationAttemptToolCall?
  createdAt          DateTime                               @default(now())

  @@unique([responseId, outputIndex])
  @@index([responseId])
}

model InvestigationAttemptOutputTextPart {
  id           String                                     @id @default(cuid())
  outputItemId String
  outputItem   InvestigationAttemptOutputItem             @relation(fields: [outputItemId], references: [id], onDelete: Cascade)
  partIndex    Int
  partType     String   // output_text | refusal
  text         String
  annotations  InvestigationAttemptOutputTextAnnotation[]
  createdAt    DateTime                                   @default(now())

  @@unique([outputItemId, partIndex])
  @@index([outputItemId])
}

model InvestigationAttemptOutputTextAnnotation {
  id              String                             @id @default(cuid())
  textPartId      String
  textPart        InvestigationAttemptOutputTextPart @relation(fields: [textPartId], references: [id], onDelete: Cascade)
  annotationIndex Int
  annotationType  String   // url_citation | file_citation | file_path | ...
  startIndex      Int?
  endIndex        Int?
  url             String?
  title           String?
  fileId          String?
  createdAt       DateTime                           @default(now())

  @@unique([textPartId, annotationIndex])
  @@index([textPartId])
}

model InvestigationAttemptReasoningSummary {
  id           String                         @id @default(cuid())
  outputItemId String
  outputItem   InvestigationAttemptOutputItem @relation(fields: [outputItemId], references: [id], onDelete: Cascade)
  summaryIndex Int
  text         String
  createdAt    DateTime                       @default(now())

  @@unique([outputItemId, summaryIndex])
  @@index([outputItemId])
}

model InvestigationAttemptToolCall {
  id           String                         @id @default(cuid())
  outputItemId String                         @unique
  outputItem   InvestigationAttemptOutputItem @relation(fields: [outputItemId], references: [id], onDelete: Cascade)
  rawPayload   Json     // Full provider output item payload for this call
  createdAt    DateTime                       @default(now())
}

model InvestigationAttemptUsage {
  id                    String                       @id @default(cuid())
  responseId            String                       @unique
  response              InvestigationAttemptResponse @relation(fields: [responseId], references: [id], onDelete: Cascade)
  inputTokens           Int
  outputTokens          Int
  totalTokens           Int
  cachedInputTokens     Int?
  reasoningOutputTokens Int?
  createdAt             DateTime                     @default(now())
}

model InvestigationAttemptError {
  id           String               @id @default(cuid())
  attemptId    String               @unique
  attempt      InvestigationAttempt @relation(fields: [attemptId], references: [id], onDelete: Cascade)
  errorName    String
  errorMessage String
  statusCode   Int?
  createdAt    DateTime             @default(now())
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
  id           String   @id @default(cuid())
  claimId      String
  claim        Claim    @relation(fields: [claimId], references: [id], onDelete: Cascade)
  url          String
  title        String
  snippet      String   // Immutable excerpt the claim relies on; retrieval data is in the attempt's tool calls

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

enum MarkdownSource {
  SERVER_HTML
  CLIENT_HTML
  NONE
}

enum InvestigationProvider {
  OPENAI
  ANTHROPIC
}

enum InvestigationAttemptOutcome {
  SUCCEEDED
  FAILED
}

enum InvestigationAttemptRequestKind {
  FACT_CHECK_ROUND   // One round of the stage-1 fact-check tool loop
  CLAIM_VALIDATION   // One stage-2 per-claim validation call
  LEGACY_COMBINED    // Pre-2026-10 merged audit of a whole attempt; never written by current code
}

enum InvestigationOrigin {
  SELECTOR          // Background selection; server key; counts against SELECTOR_DAILY_BUDGET
  INSTANCE_REQUEST  // investigateNow from an instance-API-key client; server key
  USER_KEY_REQUEST  // investigateNow funded by the requester's verified OpenAI key
}

// No Verdict enum. Every Claim in the database is an incorrect claim.
// The model only reports claims it has clear evidence are wrong.
// Correct, ambiguous, and unverifiable claims are not stored.
```

### Public trust signals

Public API responses and metrics expose trust signals derived from canonical
tables at read time:

- `provenance` (`SERVER_VERIFIED` or `CLIENT_FALLBACK`)
- `corroborationCount` (count of corroboration credits)
- `serverVerifiedAt`

Public visibility applies only one hard constraint: `status = COMPLETE`.

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
// Register observed content version. Upserts Post + platform metadata. Resolves
// canonical content via server-side verification (best effort) or client fallback.
// Returns a postVersionId that subsequent calls use as a cheap PK reference.
postRouter.registerObservedVersion
  Input:  { platform, externalId, url,
            observedImageOccurrences?, // every observed image in page order; the distinct
                                       // image URLs are derived from it (absent = no images)
            observedContentText?, // required for X/Substack/Wikipedia; omitted for LessWrong
            metadata: { title?, authorName?, ... } }
  Output: { platform, externalId, versionHash, postVersionId, provenance: ContentProvenance }

// Record a view and return the status of this version's investigation, if any.
// Increments raw viewCount, updates uniqueViewScore and counts the view against
// the request's extension version for the UTC day (ExtensionVersionDailyCount).
// Uses postVersionId from registerObservedVersion for a direct primary-key lookup
// (no content re-derivation); rejects unknown post versions. Every variant about
// an existing investigation carries its id, so the client can poll an
// investigation it did not start.
postRouter.recordViewAndGetStatus
  Input:  { postVersionId }
  Output:
    | { investigationState: "NOT_INVESTIGATED",
        priorInvestigationResult: { oldClaims: Claim[], sourceInvestigationId: string } | null }
    | { investigationState: "INVESTIGATING", investigationId, status: "PENDING" | "PROCESSING",
        provenance: ContentProvenance,
        pendingClaims: ClaimPayload[], confirmedClaims: ClaimPayload[],
        priorInvestigationResult: { oldClaims: Claim[], sourceInvestigationId: string } | null }
    | { investigationState: "FAILED", investigationId, provenance: ContentProvenance }
    | { investigationState: "INVESTIGATED", investigationId, provenance: ContentProvenance,
        claims: Claim[] }

// Fetch results for a specific investigation (used for polling)
postRouter.getInvestigation
  Input:  { investigationId }
  Output:
    | { investigationState: "NOT_INVESTIGATED", // unknown investigationId
        priorInvestigationResult: null }
    | { investigationState: "INVESTIGATING", status: "PENDING" | "PROCESSING",
        provenance: ContentProvenance,
        pendingClaims: ClaimPayload[], confirmedClaims: ClaimPayload[],
        priorInvestigationResult: { oldClaims: Claim[], sourceInvestigationId: string } | null }
    | { investigationState: "FAILED", provenance: ContentProvenance }
    | { investigationState: "INVESTIGATED", provenance: ContentProvenance,
        claims: Claim[], checkedAt: DateTime }

// Request immediate investigation. Uses postVersionId from registerObservedVersion.
// Authorization: instance API key OR request-scoped user OpenAI key (`x-openai-api-key`).
// A user key is verified with OpenAI before it funds anything (rejected → UNAUTHORIZED,
// restricted → FORBIDDEN, unverifiable → BAD_GATEWAY) and only funds an investigation this
// request admits (§2.6).
// Rejects posts exceeding the word count limit (same 10,000-word cap as the selector).
// Idempotent: if an investigation already exists for this content version, returns its
// current status (which may be COMPLETE or FAILED, not just PENDING).
// All paths are async queue-backed; user-key requests attach an encrypted short-lived key source.
postRouter.investigateNow
  Input:  { postVersionId }
  Output:
    | { investigationId, status: "PENDING" | "PROCESSING", provenance: ContentProvenance }
    | { investigationId, status: "FAILED", provenance: ContentProvenance }
    | { investigationId, status: "COMPLETE", provenance: ContentProvenance, claims: Claim[] }

// Validate extension settings (API key, OpenAI key).
postRouter.validateSettings
  Input:  (none)
  Output:
    | { instanceApiKeyAccepted, openaiApiKeyStatus: "missing" }
    | { instanceApiKeyAccepted, openaiApiKeyStatus: "valid" }
    | { instanceApiKeyAccepted, openaiApiKeyStatus: "format_invalid" | "authenticated_restricted"
        | "invalid" | "error", openaiApiKeyMessage }

// Batch check (for listing pages — which posts have results?)
// Uses composite key (platform + externalId + versionHash) because it serves
// the public tRPC API and does not participate in the extension's PK-based flow.
postRouter.batchStatus
  Input:  { posts: { platform, externalId, versionHash }[] }  // min 1, max 100
  Output: { statuses: (
              | { platform, externalId, investigationState: "NOT_INVESTIGATED", incorrectClaimCount: 0 }
              | { platform, externalId, investigationState: "INVESTIGATED", incorrectClaimCount }
            )[] }
```

## 3.4 Public API (GraphQL)

Completed investigations are readable without authentication.
The public API endpoint is GraphQL (`POST /graphql`), while extension/internal
traffic remains on `postRouter.*` tRPC endpoints.

### GraphQL schema (contract)

```graphql
scalar DateTime

enum Platform {
  LESSWRONG
  X
  SUBSTACK
  WIKIPEDIA
}

enum ContentProvenance {
  SERVER_VERIFIED
  CLIENT_FALLBACK
}

type PublicInvestigation {
  id: ID!
  origin: InvestigationOrigin!
  corroborationCount: Int!
  checkedAt: DateTime!
  promptVersion: String!
  provider: String!
  model: String!
}

type PublicPost {
  platform: Platform!
  externalId: String!
  url: String!
}

type PublicSource {
  url: String!
  title: String!
  snippet: String!
}

type PublicClaim {
  id: ID!
  text: String!
  context: String!
  summary: String!
  reasoning: String!
  sources: [PublicSource!]!
}

type PublicInvestigationResult {
  investigation: PublicInvestigation!
  post: PublicPost!
  claims: [PublicClaim!]!
}

type ClaimSummary {
  id: ID!
  summary: String!
}

type PostInvestigationSummary {
  id: ID!
  contentHash: String!
  origin: InvestigationOrigin!
  corroborationCount: Int!
  checkedAt: DateTime!
  claimCount: Int!
  claimSummaries: [ClaimSummary!]!
}

type PostInvestigationsResult {
  post: PublicPost
  investigations: [PostInvestigationSummary!]!
}

type SearchInvestigationSummary {
  id: ID!
  contentHash: String!
  checkedAt: DateTime!
  platform: Platform!
  externalId: String!
  url: String!
  origin: InvestigationOrigin!
  corroborationCount: Int!
  claimCount: Int!
  claimSummaries: [ClaimSummary!]!
}

# SERVER_VERIFIED implies serverVerifiedAt is set; a CLIENT_FALLBACK
# investigation's serverVerifiedAt is set if the content was verified later.
type InvestigationOrigin {
  provenance: ContentProvenance!
  serverVerifiedAt: DateTime
}

type SearchInvestigationsResult {
  investigations: [SearchInvestigationSummary!]!
  hasMore: Boolean!
}

type PublicMetrics {
  totalInvestigatedPosts: Int!
  investigatedPostsWithFlags: Int!
  factCheckIncidence: Float # null when no investigated posts match the filters
}

type Query {
  publicInvestigation(investigationId: ID!): PublicInvestigationResult
  postInvestigations(
    platform: Platform!
    externalId: String!
  ): PostInvestigationsResult!
  searchInvestigations(
    query: String
    platform: Platform
    minClaimCount: Int
    limit: Int = 20
    offset: Int = 0
  ): SearchInvestigationsResult!
  publicMetrics(
    platform: Platform
    authorId: ID
    windowStart: DateTime
    windowEnd: DateTime
  ): PublicMetrics!
}
```

### Resolver semantics

- `publicInvestigation(investigationId)` returns `null` when investigation does
  not exist or is not `COMPLETE`.
- `postInvestigations(platform, externalId)` returns `{ post: null, investigations: [] }`
  when no post exists; otherwise includes all complete investigations for that post.
- `searchInvestigations(...)` returns all complete investigations matching the filters.
- `publicMetrics(...)` counts all complete investigations matching the filters.
- `searchInvestigations.limit` must be in `[1, 100]`; `offset >= 0`; `minClaimCount` (optional,
  `>= 0`) keeps only investigations with at least that many claims; `hasMore` is true when
  results exist beyond `offset + limit`.
- Post URLs and source URLs are always `http(s)` URLs.
- The shared `public*OutputSchema`s in `shared/src/schemas/public-api.ts` are the
  machine-readable form of these response shapes.
- Public responses include trust signals (`provenance`, `corroborationCount`,
  `serverVerifiedAt`) so clients can apply their own thresholds.

In v1, public metrics focus on incidence rather than truth-rate leaderboards:

`factCheckIncidence = investigated_posts_with_>=1_flagged_claim / total_investigated_posts`

### Public Surface

- External public integrations use GraphQL (`/graphql`); it is the only public read surface
  (there is no public tRPC router).
- The public website is one of those integrations: it sends only GraphQL queries and parses
  each response with the shared public schemas, so a response outside this contract renders
  an error page (HTTP 502) rather than partial or unchecked data.
- Extension/internal traffic uses `postRouter.*` tRPC procedures.

## 3.5 Cache & Idempotency Implementation

Investigations reference content versions via `postVersionId` FK to the `PostVersion` table.
`PostVersion` stores the `versionHash`, `contentBlobId` (normalized text), and
`imageOccurrenceSetId`. The `Investigation` table is unique on `postVersionId` —
at most one investigation per content version.

Cache lookup query (completed investigation for a given post version):

```sql
SELECT *
FROM "Investigation"
WHERE "postVersionId" = $1 AND "status" = 'COMPLETE'
LIMIT 1;
```

Interim carry-forward source query (latest complete investigation of the post on another
version, any provenance; its claims are then filtered to those still on the page, §2.8):

```sql
SELECT i.*
FROM "Investigation" i
JOIN "PostVersion" pv ON pv."id" = i."postVersionId"
WHERE pv."postId" = $1
  AND pv."id" <> $2 -- the requested version
  AND i."status" = 'COMPLETE'
ORDER BY i."checkedAt" DESC, i."id" DESC
LIMIT 1;
```

SQL examples in this document target Prisma's default quoted identifiers (`"Post"`,
`"PostVersion"`, `"Investigation"`, camelCase column names). If you use `@map`/`@@map`,
adjust queries accordingly.

Idempotent creation uses upsert semantics on `(postId, versionHash)` in `PostVersion` and
uniqueness on `postVersionId` in `Investigation` to prevent duplicates under concurrency.

## 3.6 Investigation Selector Queries

Each selector run (`runSelector({ dailyBudget })`) does three things, isolating
failures per item (a failing item is reported and the run continues; the
entrypoint exits non-zero if any item failed):

1. **Recover expired leases** — every PROCESSING investigation whose lease has
   expired goes through the single recovery path (§3.7).
2. **Re-enqueue funded work** — every funded PENDING investigation whose
   `retryAfter` has passed is enqueued again (the per-investigation jobKey
   collapses duplicates), so a lost queue job never strands one. Not budgeted.
3. **Admit new work** — while today's SELECTOR admissions (counted by
   `origin = SELECTOR AND admittedAt >= start of the UTC day`) are below
   `SELECTOR_DAILY_BUDGET`, admit candidates in score order. Each admission
   takes a transaction-scoped advisory lock and re-counts, so concurrent runs
   cannot overspend. New investigations get update lineage (§2.4.3) and an input
   snapshot exactly as investigateNow does; unfunded investigations are re-funded
   as SELECTOR.

```sql
-- Admission candidates: latest version per post with no investigation, or an
-- unfunded one (user key dropped), ordered by unique-view score.
WITH latest_versions AS (
  SELECT DISTINCT ON (pv."postId")
    pv."id" AS "postVersionId",
    pv."postId",
    pv."contentBlobId"
  FROM "PostVersion" pv
  ORDER BY pv."postId", pv."lastSeenAt" DESC, pv."id" DESC
)
SELECT
  lv."postVersionId",
  i."id" AS "unfundedInvestigationId"
FROM latest_versions lv
JOIN "Post" p ON p."id" = lv."postId"
JOIN "ContentBlob" cb ON cb."id" = lv."contentBlobId"
LEFT JOIN "Investigation" i ON i."postVersionId" = lv."postVersionId"
WHERE cb."wordCount" <= 10000
  AND (
    i."id" IS NULL
    OR (i."status" = 'PENDING' AND i."origin" = 'USER_KEY_REQUEST'
        AND NOT EXISTS (SELECT 1 FROM "InvestigationOpenAiKeySource" ks
                        WHERE ks."investigationId" = i."id"))
  )
ORDER BY p."uniqueViewScore" DESC, lv."postVersionId"
LIMIT :remainingDailyBudget;
```

## 3.7 Job Queue

Postgres-backed (graphile-worker). No Redis.
Used by selector work and all `investigateNow` requests.

Every investigation is admitted with an origin that fixes who pays for its runs:
`SELECTOR` (server key, daily budget), `INSTANCE_REQUEST` (server key, trusted
instance-API-key client) or `USER_KEY_REQUEST` (the requester's verified OpenAI
key, stored as an encrypted, 30-minute InvestigationOpenAiKeySource). A
`USER_KEY_REQUEST` run never falls back to the server key.

Each graphile-worker job is enqueued with `maxAttempts: 1` and a per-investigation
`jobKey` (`investigate:${investigationId}`). Retry control is managed by the
application, not graphile-worker: transient failures reclaim the investigation to
PENDING and explicitly re-enqueue with a backoff delay.

```
Investigation admitted (by selector or any investigateNow request)
  → Upsert investigation for postVersionId (idempotent: one investigation per content version)
  → If already exists: reuse existing investigation row and do not enqueue duplicate work
  → Worker picks up job → claim lease (funded PENDING → PROCESSING, atomically increment attemptCount)
  → Worker resolves the funding key (before downloading any image), then calls Investigator.investigate()
  → Heartbeat renews the lease every 15s; if a renewal finds the lease gone (or renewals fail
    past its expiry) the run is aborted and writes nothing further
  → On success: delete lease, UPDATE status = COMPLETE, record the model that ran
  → On failure: classify and retry, drop the user key, or fail permanently

Lease invariant:
  - An InvestigationLease row exists iff status = PROCESSING, enforced by deferred
    constraint triggers at commit.
  - One recovery path for expired leases (used by the worker, the selector and
    investigateNow): delete the lease; PENDING again, or FAILED if the lost attempt
    was attempt MAX_INVESTIGATION_ATTEMPTS or later.

Retry model:
  - Investigation.attemptCount numbers attempts (incremented at lease claim, never reset),
    so every InvestigationAttempt audit row keeps its own attemptNumber.
  - MAX_INVESTIGATION_ATTEMPTS = 4: a transient failure on attempt 4 or later marks FAILED.
  - Transient retries use exponential backoff: delay = 10s × 2^(attempt - 1).

Failure classes:
  TRANSIENT (reclaim to PENDING, re-enqueue with backoff, up to MAX_INVESTIGATION_ATTEMPTS):
    - Provider 5xx errors, rate limits (429) on the server key, network timeouts and connection errors
  USER KEY UNUSABLE (drop the key; the investigation becomes unfunded PENDING, not re-enqueued):
    - User-key source missing, expired or undecryptable when the worker starts
    - OpenAI refuses the user key: 401, 403, 404 (no model access), 429 (rate/quota)
    The failed attempt is still recorded. Unfunded investigations wait until the selector
    (within its budget) or a new investigateNow funds them, so a bad key can never make a
    post permanently uninvestigable.
  NON_RETRYABLE (mark FAILED immediately):
    - Unusable model output: an unparseable validation verdict, or the stage-1
      tool loop exceeding its round limit
    - Provider content-policy refusal
    - Provider request rejections on the server key: malformed request (400),
      authentication/authorization (401, 403), unknown model/resource (404),
      unprocessable (422)
    - Investigator input violating its contract
  PARTIAL (mark FAILED, keep the partial output in the attempt audit):
    - A provider response that ends with any status other than "completed"
      (e.g. "incomplete": truncated output or tool-call trace)

Claim submissions that fail the shared claim schema (e.g. a non-http(s) source
URL) are not failures: the tool call's output tells the model the claim was not
recorded, and the model may resubmit within the same run.

Before taking jobs, the worker sends a probe with the investigation request's
exact shape (model, tools, include, reasoning options; tool use disabled, output
capped) and refuses to start if OpenAI rejects it; user-key validation in
settings runs the same probe.

Key sources are consumed (deleted) on every terminal transition (COMPLETE, FAILED)
and when the key is dropped.

`FAILED` is terminal for a given `postVersionId` in v1: investigateNow returns it
unchanged and the selector never re-admits it. Re-running that exact content
version requires an explicit operator/admin action (e.g. delete/recreate the row),
not automatic retries.
```

## 3.8 Platform Adapter Interface

Each content script implements:

```typescript
// hydrating / ambiguous_dom / missing_identity are transient (the page may
// still be rendering); unsupported is final for the current DOM.
type AdapterNotReadyReason =
  | "hydrating"
  | "ambiguous_dom"
  | "missing_identity"
  | "unsupported";

type AdapterExtractionResult =
  | { kind: "ready"; content: PlatformContent }
  | { kind: "not_ready"; reason: AdapterNotReadyReason };

interface PlatformAdapter {
  platformKey: Platform;
  matches(url: string): boolean; // URL-first selection
  detectFromDom?(document: Document): boolean; // custom-domain fallback
  pageLocator(url: string): PageLocator | null; // what the URL says about the post (below)
  detectPrivateOrGated?(document: Document): boolean;
  extract(document: Document): AdapterExtractionResult;
  getContentRoot(document: Document): Element | null;
  // Subtrees under the root that are not post content on this platform; used
  // alike for text extraction, claim matching and HTML snapshots.
  contentExclusionFilter(root: Element): (element: Element) => boolean;
}

interface ImageOccurrence {
  originalIndex: number; // 0-based ordinal position of the image in the page
  normalizedTextOffset: number; // Character offset in the normalized content text
  sourceUrl: string;
  captionText?: string;
}

interface PlatformContent {
  platform: Platform;
  externalId: string; // per-platform format, validated: LessWrong post ID,
  // numeric tweet ID, numeric Substack post ID,
  // Wikipedia `{language}:{pageId}`
  url: string;
  contentText: string; // Client-observed normalized plain text
  hasVideo: boolean; // any video/audio/video-iframe embed
  imageOccurrences: ImageOccurrence[]; // every image, in page order; the only image data
  // (sent to the API as observedImageOccurrences)
  metadata: Record<string, unknown>;
}
```

Media state is derived, not stored: `has_video` if `hasVideo`; otherwise
`has_images` when there are image occurrences; otherwise `text_only`.

A `PageLocator` is what a URL alone says about the post a page shows:
LessWrong post ID, tweet ID, Substack origin + slug, or Wikipedia language +
page ID and/or title. It identifies pages whose external ID is not (yet)
known — skipped pages, and the popup's check that a cached status still
describes the tab's page — and is parsed in one shared module.

Adapter selection is URL-first (`matches(url)`), then optional DOM-fingerprint fallback
(`detectFromDom(document)`) for custom-domain platform pages.

When an adapter stays `not_ready` with a transient reason for 5 seconds on the
same URL (e.g. a tweet whose identity cannot be proven), the page is reported
as skipped with `unsupported_content`; it keeps being re-checked on DOM changes.

### Content normalization (shared package)

Both client (extension) and server (API) must produce identical normalized text from
the same HTML. The extension reads content text from the live content root
through one text index — the same index the claim mapper (§2.4.1) and the
content-change check use — skipping `NON_CONTENT_TAGS` and the adapter's
exclusions; word separators exist only in the text (they have no DOM
position). Two shared components ensure parity with the server:

**Word separator injection:** `WORD_SEPARATOR_TAGS` defines the HTML elements whose
boundaries are treated as word separators during extraction: block-level elements, and the
line-breaking void elements `br` and `hr` (`hard.<br>This` reads `hard. This`, not
`hard.This`). Both the extension (DOM TreeWalker) and API (parse5 traversal) inject a space
character at the entry and exit of these elements, ensuring compact HTML without whitespace
text nodes still normalizes identically.

```typescript
const WORD_SEPARATOR_TAGS = new Set([
  "p",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "figcaption",
  "blockquote",
  "tr",
  "td",
  "th",
  "div",
  "br",
  "hr",
]);

const NON_CONTENT_TAGS = new Set(["script", "style", "noscript"]);
```

**Text normalization:** After extraction, raw text is normalized via `normalizeContent`:

```typescript
const TYPOGRAPHIC_REPLACEMENTS: [RegExp, string][] = [
  [/[\u201C\u201D]/g, '"'], // Left/right double quotes → "
  [/[\u2018\u2019]/g, "'"], // Left/right single quotes → '
  [/[\u2010-\u2015]/g, "-"], // Hyphens + en/em dashes → -
  [/\u2026/g, "..."], // Horizontal ellipsis → ...
];

function normalizeContent(raw: string): string {
  let text = raw.normalize("NFC");
  for (const [pattern, replacement] of TYPOGRAPHIC_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // Remove zero-width characters
    .replace(/\s+/g, " ") // Collapse whitespace
    .trim();
}
```

Page HTML sent to the API (LessWrong/Substack/Wikipedia `metadata.htmlContent`) is
serialized from a copy of the content root with the extension's own highlight
marks unwrapped and excluded subtrees removed; marks never leave the page.

`contentText` must be non-empty. Posts that normalize to empty text are currently
treated as unsupported and are skipped by the extension (`reason: "no_text"`).
This includes textless/image-only posts for now.

Adapters may also detect private/gated access (e.g., protected or subscriber-only
views). In that case, the extension must skip sending content to the API and emit
`PAGE_SKIPPED` with `reason: "private_or_gated"`.

**All skip reasons:**

| Reason                | Condition                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `has_video`           | Any video/iframe embed detected                                                                    |
| `word_count`          | Normalized text exceeds `WORD_COUNT_LIMIT` (10000)                                                 |
| `no_text`             | Content normalizes to empty string                                                                 |
| `private_or_gated`    | Private/protected/subscriber-only content                                                          |
| `unsupported_content` | Content not extractable (non-article page, or post still unextractable after the 5 s grace period) |

Skipped pages are identified by platform, page URL and reason only: a skip can
be decided before the post's external ID is known.

### 3.8.1 Extension Message Protocol

Messages between the extension's contexts are `{ type, payload }` and every
reply is an envelope `{ ok: true, value } | { ok: false, error, errorCode? }`;
listeners always reply with a promise, so error replies are delivered.
Each direction has one request map (`BACKGROUND_REQUESTS`,
`CONTENT_REQUESTS` in the shared package) from type to payload and response
schemas; senders and handler tables are typed from it and receivers validate
against it.

| Direction                  | Type                                                                            | Purpose                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| content → background       | `PAGE_CONTENT`                                                                  | Register observed content, record the view; replies with the page session's status                                                 |
| content → background       | `PAGE_SKIPPED`                                                                  | Report a skipped page                                                                                                              |
| content → background       | `PAGE_RESET`                                                                    | The page session ended; its status is discarded                                                                                    |
| content → background       | `INVESTIGATE_NOW`                                                               | Investigate the session's post; replies with its status                                                                            |
| popup → background         | `GET_TAB_STATUS`                                                                | A tab's cached status, or the upgrade-required notice                                                                              |
| background/popup → content | `PING`                                                                          | Liveness probe; no side effects                                                                                                    |
| popup → content            | `GET_VISIBILITY`                                                                | Highlight visibility; no side effects                                                                                              |
| popup → content            | `SHOW_ANNOTATIONS` / `HIDE_ANNOTATIONS` / `REQUEST_INVESTIGATE` / `FOCUS_CLAIM` | User actions                                                                                                                       |
| background → content       | `LOCATION_CHANGED`                                                              | Relay of `webNavigation.onHistoryStateUpdated`: content scripts run in an isolated world and cannot observe the page's `pushState` |
| background → content       | `STATUS_CHANGED`                                                                | The background cached a new status for the tab                                                                                     |

**Page sessions.** A content script starts a page session (with a random
UUID `tabSessionId`) for each distinct observed page state: a tracked post
version or a skip. The background treats the first message from a new session
as the tab's current one and retires the previous; replies for retired
sessions are dropped. A tab's status lives in `storage.session` (it survives
service-worker restarts, never browser restarts) and is cleared when the tab
commits a new document. `INVESTIGATING` statuses — whether this tab started
the investigation or the API reported one already running — are polled until
they settle; transient poll failures back off and give up after 5 attempts
(`API_ERROR`).

**Injection.** Each page gets one content-script controller: injection is
probed with `PING` first, and a repeated injection finds the live controller
and does not boot a second one. A controller orphaned by an extension
reload/update shuts itself down and removes its highlights.

The protocol is not versioned: all contexts ship in one bundle, and a content
script orphaned by an extension update can no longer reach the new background.
API compatibility is versioned separately over HTTP
(`x-openerrata-extension-version`, minimum supported version → upgrade
required). Extensions from 0.2.0 up to 0.4.0 speak the legacy v0 API protocol
(the API of the 0.3 line: no investigation ids or FAILED state from
`recordViewAndGetStatus`, `observedImageUrls` in inputs). The API serves them
through a time-boxed adapter (`api/src/lib/trpc/legacy-extension-v0`) that
converts their requests to the current procedures and the answers back, so the
current procedures carry no legacy branches. It is retired on 2026-12-01 or
once the extension version counts (§3.2) show no 0.3.x traffic for 14
consecutive days, whichever is later; the minimum supported version then
becomes 0.4.0.

Future work: design a dedicated UI/UX flow for fact-checking image-only posts
without relying on text-span highlighting.

## 3.9 LessWrong Content Script

LessWrong renders post bodies via `ContentItemBody` using `dangerouslySetInnerHTML` (static HTML).
DOM manipulation is reliable.

**Extraction:**

1. Wait for `document_idle`.
2. Extract post ID from URL: `/posts/{postId}/{slug}`.
3. Locate the post body: the `.PostsPage-postContent` whose `#postBody` JSON-LD names that
   post ID (never extract before that identity appears, so SPA switches cannot hash another
   post's DOM), then its canonical `#postContent`.
4. Read content text and image occurrences through the shared text index, excluding the
   client-rendered linkpost callout (`.LinkPostMessage-root`), which GraphQL `contents.html`
   lacks.
5. Tags are the tag chips (`.FooterTag-root` links to `/w/<slug>`, formerly `/tag/<slug>`),
   once each.
6. Send `{ platform: "LESSWRONG", externalId, url, metadata.htmlContent, observedImageOccurrences }`
   to the background worker.

**Media behavior:** Posts with images and no video are investigated. Posts detected as private/gated
are skipped (`reason: "private_or_gated"`). Among public posts, any `has_video` post
(video/iframe detected, even when images and/or text are present) is skipped.

**React reconciliation:** LessWrong uses React 16+. Use `MutationObserver` to detect re-renders and
re-apply annotations. Store annotations in extension state, not DOM.

## 3.10 X.com Content Script

X uses a React SPA with aggressive DOM recycling.

1. `MutationObserver` to detect tweet content in viewport.
2. For individual tweet pages (`/status/{id}`), extract main tweet text: the `<article>` that
   links to the status permalink — when several do (replies, quotes), the one whose author
   (first profile link) is the URL's handle.
3. Logged in, tweet text is `[data-testid="tweetText"]`; the logged-out frontend has no test
   ids and renders it as the article's own first `div[dir="auto"]`. Acknowledge these
   selectors are fragile and may need maintenance.

**Media behavior:** Extract image URLs separately from video detection. Investigate image-only
tweets. Skip private/protected tweets (`reason: "private_or_gated"`). Among accessible tweets, skip
any `has_video` tweet (video present, even when extracted images and/or tweet text exist).

## 3.11 Substack Content Script

1. For `*.substack.com/p/*`, declarative content script injection is used.
2. For custom domains, the background worker probes `/p/*` pages after tab load and checks
   for `link[href*="substackcdn.com"]`. If matched, it injects content script + CSS via
   `chrome.scripting`.
3. `externalId` is the numeric Substack post ID parsed from social image metadata
   (`post_preview/{numericId}/twitter.jpg` pattern).
4. Content root selector: `.body.markup`. Editor components in the body that are not the
   post's own text are excluded from content text, image occurrences and transported HTML,
   by their `data-component-name`: calls to action (`SubscribeWidget`,
   `ButtonCreateButton` share/comment/subscribe buttons) and embeds of content from
   elsewhere — tweets (`Twitter2ToDOM`: another author's words, like the quote tweets v1
   does not analyze, §2.1; the avatar and tweet media go with it) and other posts
   (`DigestPostEmbed`, `EmbeddedPostToDOM`).
5. Subscriber-only/paywalled views are skipped (`reason: "private_or_gated"`) and are not sent
   to `registerObservedVersion`/`recordViewAndGetStatus`/`investigateNow`. A post whose JSON-LD
   declares `isAccessibleForFree: false` is subscriber-only whatever paywall copy it shows —
   including for a paid subscriber who can read it in full; paywall wording and markers are
   checked as well.

Because custom-domain Substack publishers can use arbitrary hostnames, the extension cannot
pre-enumerate all required origins in the manifest. v1 therefore keeps broad HTTPS host
permissions and applies strict runtime checks before injection (path must be `/p/*` and Substack
fingerprint must be present). This is an intentional tradeoff for custom-domain support.

## 3.12 Wikipedia Content Script

Wikipedia articles are served as static HTML with MediaWiki metadata available via
JavaScript globals (`mw.config`).

1. Declarative injection on `*.wikipedia.org/wiki/*` and `*.wikipedia.org/w/index.php*`.
   The `*.wikipedia.org` wildcard covers all language subdomains.
2. `externalId` is `{language}:{pageId}` (e.g. `en:12345`), derived from `wgArticleId`
   and the hostname language code.
3. The adapter reads MediaWiki config values (`wgArticleId`, `wgRevisionId`,
   `wgNamespaceNumber`, `wgPageName`, `wgRevisionTimestamp`) and filters out
   non-article namespaces (namespace !== 0). `wgNamespaceNumber` is authoritative:
   URL parsing only recognizes MediaWiki's canonical (English) namespace names, which
   every language edition accepts, not localized ones such as German `Diskussion:`.
4. Content root: `#mw-content-text .mw-parser-output`. Excluded sections and
   non-article elements are pruned before text extraction, by one predicate shared
   with the API (`shared/src/wikipedia-canonicalization.ts`):
   - Non-article elements are recognized by markup every wiki emits, whatever its
     language: citation superscripts, reference lists, edit links, navboxes; anything
     with `role="navigation"` (navboxes, series sidebars, "main article" links); the
     `navigation-not-searchable` class (what Wikimedia search leaves out: hatnotes,
     navboxes, authority control); the `metadata` class (maintenance and quality
     banners, sister-project boxes, person-data tables); plus a few per-wiki boxes those
     conventions miss (fr.wikipedia's portal bar, nl.wikipedia's appendix and
     sister-project boxes). Inline styles are never read: Wikipedia's scripts and reader
     interaction change them on the live page, so they cannot agree with the Parse API.
   - Excluded sections are the appendices listing citations, sources and outbound links
     (English: References, Notes, Further reading, External links, Bibliography, Sources,
     Citations), matched by title in English and in the equivalent titles of the largest
     wikis (de, fr, es, it, pt, nl, pl, ru, ja, zh). An excluded section is its heading and
     the heading's following siblings up to the next sibling heading of the same or a
     higher level (subsections go with it), which holds both for the flat Parse API
     output and for read views that nest each section in a `<section>` element.
     "See also" and its equivalents are intentionally **not** excluded — they contain
     substantive content about related topics.
5. Server-side canonical fetch uses the MediaWiki `action=parse` API pinned to
   the observed `revisionId`, ensuring content verification matches exactly the
   revision the user saw.
6. Wikipedia articles have no single author; no `Author` row is linked.

**Media behavior:** Same rules as other platforms — extract image occurrences from the
article body; any `has_video` article is skipped. Video is detected on the live content
root, not through the text exclusions: Wikipedia's player script wraps `<video>` in
`.mw-tmh-player`, which text extraction excludes as UI. Elements Wikipedia's own scripts
add to the article (collapsible toggles, the player, fr.wikipedia's `cachelinks` archive
links) are excluded so client text matches the Parse API's.

## 3.13 Extension Manifest (v3)

The canonical manifest is `extension/src/manifest.json`. This section documents
the design decisions rather than duplicating the file.

**Required permissions:** `storage`, `scripting`, `webNavigation`, `alarms`.

**Host permissions:** Broad HTTPS (`https://*/*`). Required because
custom-domain Substack publishers use arbitrary hostnames that cannot be
pre-enumerated (see §3.11); Substack serves custom domains over HTTPS only.
Runtime checks restrict actual injection to recognized platforms.
`http://*/*` is an optional host permission, requested by the options page
only for a self-hosted API at a local/private-network HTTP address.

**Firefox:** minimum version 128 — Firefox grants MV3 host permissions at
install only from 127 on, and `storage.session` needs 115.

**Content script injection strategy:**

| Platform  | Injection             | Match patterns                                                                                    |
| --------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| LessWrong | Declarative           | `lesswrong.com/*`                                                                                 |
| X         | Declarative           | `x.com/*`, `twitter.com/*`                                                                        |
| Substack  | Declarative + dynamic | `*.substack.com/p/*` (declarative); custom domains via `chrome.scripting` after fingerprint check |
| Wikipedia | Declarative           | `*.wikipedia.org/wiki/*`, `*.wikipedia.org/w/index.php*`                                          |

All declarative entries inject the same content script and annotation CSS at
`document_idle`. Dynamic injection uses the same assets via
`chrome.scripting.executeScript` / `chrome.scripting.insertCSS`: for
custom-domain Substack pages at `DOMContentLoaded`, and for any post page that
lacks a live content script (tabs open before install/update, SPA navigations
into post paths the declarative patterns did not match) on tab activation,
History API navigation and service-worker start.

**Background:** Module service worker (Chrome MV3); IIFE fallback for Firefox.

## 3.14 Project Layout

```
openerrata/
├── src/
│   ├── aws/ci-iam/setup.sh            # IAM role hosted deploys assume via GitHub OIDC
│   ├── kubernetes/ci-rbac/            # RBAC for that role's Kubernetes group
│   ├── helm/
│   │   └── openerrata/                # Helm chart — single source of truth for deployment
│   │       ├── Chart.yaml
│   │       ├── values.yaml            # Defaults for on-prem; Pulumi overrides for hosted
│   │       └── templates/
│   │           ├── _helpers.tpl
│   │           ├── api-deployment.yaml / api-service.yaml / api-ingress.yaml
│   │           ├── worker-deployment.yaml
│   │           ├── selector-cronjob.yaml
│   │           ├── migration-job.yaml # prisma migrate deploy; workloads wait for it
│   │           ├── frontend-*.yaml    # Public website (optional)
│   │           ├── network-policies.yaml
│   │           ├── serviceaccounts.yaml
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
│       │   │   │   ├── api-client.ts           # tRPC client
│       │   │   │   ├── api-client-core.ts      # HTTP transport layer
│       │   │   │   ├── cache.ts                # browser.storage.local cache
│       │   │   │   ├── cache-store.ts
│       │   │   │   ├── investigation-polling.ts # 5s poll for PENDING/PROCESSING
│       │   │   │   ├── investigation-state.ts
│       │   │   │   ├── message-dispatch.ts     # Runtime message routing
│       │   │   │   ├── page-content-action.ts  # PAGE_CONTENT handler
│       │   │   │   ├── page-content-decision.ts
│       │   │   │   ├── post-status.ts
│       │   │   │   └── toolbar-badge.ts
│       │   │   ├── content/
│       │   │   │   ├── adapters/      # Platform adapters (one per site)
│       │   │   │   │   ├── model.ts   # PlatformAdapter interface + AdapterExtractionResult
│       │   │   │   │   ├── lesswrong.ts
│       │   │   │   │   ├── x.ts
│       │   │   │   │   ├── substack.ts
│       │   │   │   │   ├── wikipedia.ts
│       │   │   │   │   ├── utils.ts   # Shared extraction helpers (image occurrences)
│       │   │   │   │   └── index.ts   # Registry
│       │   │   │   ├── annotator.ts   # Annotation rendering
│       │   │   │   ├── annotations.ts
│       │   │   │   ├── annotation-dom.ts
│       │   │   │   ├── dom-mapper.ts  # Claim text → DOM ranges
│       │   │   │   ├── page-session-controller.ts  # Per-page session lifecycle
│       │   │   │   ├── observer.ts    # MutationObserver for SPA re-renders
│       │   │   │   ├── main.ts        # Entry point (IIFE)
│       │   │   │   └── bootstrap.ts
│       │   │   ├── popup/
│       │   │   │   ├── index.html
│       │   │   │   ├── App.svelte
│       │   │   │   └── main.ts
│       │   │   ├── options/
│       │   │   │   ├── index.html
│       │   │   │   ├── App.svelte
│       │   │   │   └── main.ts
│       │   │   ├── lib/
│       │   │   │   ├── settings.ts             # Settings storage shape + defaults
│       │   │   │   ├── settings-core.ts
│       │   │   │   ├── view-post-input.ts
│       │   │   │   ├── post-identity.ts
│       │   │   │   ├── protocol-version.ts
│       │   │   │   └── substack-url.ts
│       │   │   └── manifest.json
│       │   ├── vite.config.ts
│       │   ├── tailwind.config.ts
│       │   ├── tsconfig.json          # Extends ../tsconfig.base.json
│       │   └── package.json
│       │
│       ├── api/                       # Backend API service
│       │   ├── src/
│       │   │   ├── routes/            # SvelteKit routes (health, graphql)
│       │   │   │   └── graphql/+server.ts     # Public GraphQL endpoint
│       │   │   ├── lib/
│       │   │   │   ├── trpc/
│       │   │   │   │   ├── router.ts
│       │   │   │   │   ├── context.ts
│       │   │   │   │   ├── init.ts
│       │   │   │   │   └── routes/
│       │   │   │   │       ├── post.ts         # Extension-facing tRPC router
│       │   │   │   │       ├── post/
│       │   │   │   │       │   ├── content-storage.ts     # Barrel for content-storage/
│       │   │   │   │       │   ├── content-storage/       # Content canonicalization pipeline
│       │   │   │   │       │   │   ├── register-observed-version.ts
│       │   │   │   │       │   │   ├── content-preparation.ts
│       │   │   │   │       │   │   ├── blobs.ts
│       │   │   │   │       │   │   ├── occurrences.ts
│       │   │   │   │       │   │   ├── observed-url.ts
│       │   │   │   │       │   │   ├── post-upsert.ts
│       │   │   │   │       │   │   ├── post-version.ts
│       │   │   │   │       │   │   ├── metadata.ts
│       │   │   │   │       │   │   ├── hashing.ts
│       │   │   │   │       │   │   └── shared.ts
│       │   │   │   │       │   ├── investigation-queries.ts
│       │   │   │   │       │   └── wikipedia.ts
│       │   │   │   ├── investigators/
│       │   │   │   │   ├── interface.ts               # Investigator contract + attempt audit types
│       │   │   │   │   ├── errors.ts                  # Investigator error classes
│       │   │   │   │   ├── prompt.ts                  # System prompts (fresh, update, validation)
│       │   │   │   │   ├── openai.ts                  # v1 OpenAI Responses investigator + factory
│       │   │   │   │   ├── openai-request-config.ts   # The model (gpt-6.1-sol) and every request shape
│       │   │   │   │   ├── openai-probe.ts            # Request-shape probe (startup, key validation)
│       │   │   │   │   ├── openai-claim-tools.ts      # submit_correction/retain_correction schemas
│       │   │   │   │   ├── openai-tool-loop.ts        # Stage 1 fact-check rounds
│       │   │   │   │   ├── openai-tool-dispatch.ts    # Function-call routing and research tools
│       │   │   │   │   ├── openai-input-builder.ts    # Multimodal request input builder
│       │   │   │   │   ├── openai-response-audit.ts   # Request/response → audit records
│       │   │   │   │   └── openai-claim-validator.ts  # Stage 2 per-claim validation
│       │   │   │   ├── services/
│       │   │   │   │   ├── orchestrator.ts            # Main investigation orchestrator
│       │   │   │   │   ├── orchestrator-errors.ts     # Error classification
│       │   │   │   │   ├── investigation-lease.ts      # Lease claim, heartbeat, expired-lease recovery
│       │   │   │   │   ├── attempt-audit.ts           # Audit record persistence
│       │   │   │   │   ├── markdown-resolution.ts     # Trust-policy-based markdown resolution
│       │   │   │   │   ├── investigation-admission.ts # Creating/funding investigations with an origin
│       │   │   │   │   ├── investigation-input.ts     # Immutable InvestigationInput snapshot
│       │   │   │   │   ├── investigate-now.ts         # investigateNow state handling
│       │   │   │   │   ├── update-lineage.ts          # Update-investigation parent + diff
│       │   │   │   │   ├── user-key-source.ts         # Verified, encrypted user OpenAI keys
│       │   │   │   │   ├── selector.ts                # Investigation selection cron (daily budget)
│       │   │   │   │   ├── queue.ts                   # graphile-worker integration
│       │   │   │   │   ├── content-fetcher.ts         # Server-side HTML fetch + parse5 extraction
│       │   │   │   │   ├── canonical-resolution.ts    # Server-verified vs client-fallback
│       │   │   │   │   ├── html-to-markdown.ts        # Turndown-based HTML → Markdown
│       │   │   │   │   ├── blob-storage.ts            # S3/R2 image storage
│       │   │   │   │   ├── image-downloader.ts        # SSRF-safe image fetch
│       │   │   │   │   ├── view-credit.ts
│       │   │   │   │   └── prompt.ts                  # Prompt table upsert
│       │   │   │   ├── graphql/
│       │   │   │   │   └── public-schema.ts
│       │   │   │   ├── network/
│       │   │   │   │   ├── host-safety.ts             # Public-unicast address classification
│       │   │   │   │   ├── public-http-fetch.ts       # SSRF-safe fetch (connection-level DNS check)
│       │   │   │   │   └── ip.ts
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
│       │   │   ├── index.ts           # Barrel re-export
│       │   │   ├── enums.ts           # Platform, CheckStatus, ContentProvenance, etc.
│       │   │   ├── types.ts           # InvestigationResult, PlatformContent, etc.
│       │   │   ├── constants.ts       # WORD_COUNT_LIMIT, POLL_INTERVAL_MS, etc.
│       │   │   ├── normalize.ts       # normalizeContent(), WORD_SEPARATOR_TAGS
│       │   │   ├── schemas.ts         # Barrel re-export for schemas/
│       │   │   ├── schemas/
│       │   │   │   ├── common.ts              # Branded IDs, platform metadata schemas
│       │   │   │   ├── investigation.ts       # registerObservedVersion, recordViewAndGetStatus, etc.
│       │   │   │   ├── settings.ts            # validateSettings, batchStatus
│       │   │   │   ├── extension-protocol.ts  # Extension message protocol + status schemas
│       │   │   │   └── public-api.ts
│       │   │   ├── version-identity.ts
│       │   │   ├── wikipedia-canonicalization.ts  # Excluded sections, heading detection
│       │   │   ├── image-occurrence-validation.ts
│       │   │   ├── extension-version.ts
│       │   │   ├── trpc-paths.ts
│       │   │   ├── type-guards.ts
│       │   │   └── optional-non-empty.ts
│       │   ├── tsconfig.json
│       │   └── package.json
│       │
│       ├── frontend/                  # Public website (SvelteKit, adapter-node)
│       │   ├── src/
│       │   │   ├── lib/
│       │   │   │   ├── public-queries.ts      # GraphQL documents + shared response schemas
│       │   │   │   ├── server/public-api*.ts  # GraphQL client; API errors → 502 page
│       │   │   │   └── claim-markdown.ts      # Reasoning markdown (no HTML, no images)
│       │   │   ├── routes/            # /, /corrections, /corrections/[id], /health, +error
│       │   │   └── hooks.server.ts    # Startup check of API_BASE_URL
│       │   ├── svelte.config.js       # Content Security Policy
│       │   ├── Dockerfile
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
pointing at any Postgres database. On-prem operators deploy with
`helm install openerrata ./src/helm/openerrata` and override `values.yaml` for their environment.
The official hosted deployment uses Pulumi's `@pulumi/kubernetes` Helm provider to deploy the same
chart with hosted-specific overrides (image, hostnames, Cloudflare DNS, and either a supplied
database URL or a Pulumi-managed RDS instance and S3 bucket). This guarantees that on-prem and
hosted deployments use identical workload definitions — no drift between two separate deployment
manifests.

Hosted deploys run in GitHub Actions without long-lived credentials: the job's OIDC token joins
the tailnet (the cluster's API endpoint is private) and assumes an IAM role scoped to the resources
Pulumi manages, which EKS maps to a Kubernetes group allowed into the two OpenErrata namespaces
only. The managed database accepts connections only from the cluster's VPC, and blob storage is
private (images reach the model inline, never by public URL).

Migrations: Helm runs the migrate Job as a hook (after the first install, before upgrades), while
Pulumi's Helm support ignores hooks and creates it alongside the workloads. In both cases every
database-using pod has a `wait-for-migrations` init container that blocks until all migrations in
its image are applied, so new code never starts on an older schema.

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
4. ~~**Privacy**~~ — No anonymization. Investigations are public by default, and public responses
   include raw verification signals (provenance + corroboration count + verification timestamps/reasons).
5. ~~**Monetization**~~ — Free tier + paid subscription.
6. ~~**Provider selection**~~ — OpenAI v1, Anthropic planned.
7. ~~**Public appeals workflow**~~ — Not in v1. Planned for post-v1; see §2.11
   for design direction.
8. ~~**Primary public metric**~~ — Track fact-check incidence (% investigated posts with >=1 flag).
9. ~~**Reproducibility target**~~ — Best-effort reproducibility via persisted run artifacts (prompt,
   model metadata, tool trace, source snapshots).
10. ~~**LessWrong API vs. DOM scraping**~~ — Server-side verification uses LessWrong's GraphQL API
    to fetch canonical HTML. Server content is authoritative for LessWrong (and Wikipedia via
    MediaWiki Parse API).

### Open

1. **Future analysis types** — What ships after fact-checking? Candidates: source quality, logical
   structure, steelmanning, background context. TBD.
2. **Investigation prompt** — The exact system prompt. Needs careful iteration.
