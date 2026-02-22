# OpenErrata Browser Extension

Chrome MV3 extension that extracts post content from LessWrong and X, sends it
to the OpenErrata API, and renders inline annotations on incorrect claims.

## Build

```bash
pnpm dev    # vite build --watch (rebuilds on file change)
pnpm build  # production build to dist/
```

After building, load `dist/` as an unpacked extension in Chrome via
`chrome://extensions` (Developer mode).

## Architecture

### Message Flow

```
Content Script (runs on LessWrong/X pages)
  → extract content via platform adapter
  → chrome.runtime.sendMessage({ type: "PAGE_CONTENT", payload })
  → Background Service Worker
      → api-client.ts: HTTP POST to /trpc/post.viewPost
      → OpenErrata API
  ← response with investigated + claims
  → Content Script renders annotations (or records "skipped")
```

The popup communicates with the background via `chrome.runtime.sendMessage`
using the same message protocol. The popup sends `GET_CACHED` to fetch the
active tab's status; the background queries `chrome.tabs.query` to resolve
the active tab (since popup messages have no `sender.tab`).

### Content Scripts — IIFE Build Requirement

**Content scripts MUST be built as IIFE (no ES module imports).** MV3 loads
content scripts as classic scripts — `import` statements are syntax errors.

The Vite config uses a two-pass build:
1. Main build: background (ES module), popup, options → can use `import`
2. Content script build: `lib` mode with `formats: ["iife"]` → single file,
   all dependencies inlined

If you add a new dependency to the content script, it gets bundled into the
IIFE automatically. If the IIFE gets too large, refactor shared code into
the background worker and communicate via messages.

### Platform Adapters

Each adapter implements `PlatformAdapter` (defined in `adapters/lesswrong.ts`):

- `matches(url)` — does this URL belong to this platform?
- `extract(document)` — extract `PlatformContent` from the DOM
- `getContentRoot(document)` — return the element containing the post body

The `PlatformContent` includes a `platform` field (the string union value)
and `metadata` with platform-specific fields (slug, title, author, etc.).

**Media detection**: adapters classify posts as `text_only`, `has_images`, or
`video_only`. Image posts are investigated; `video_only` posts are skipped.
Adapters also skip private/protected/subscriber-only views with
`reason: "private_or_gated"` and do not send content to the API in that case.
The content script sends `PAGE_SKIPPED` when skipping.

### LessWrong Adapter

- URL pattern: `lesswrong.com/posts/{postId}/{slug}`
- Content selector: `.PostsPage-postContent`
- Media check: `img, video, iframe` inside the content element
- Source: `vendor/ForumMagnum/` has the LessWrong source for selector reference

### X/Twitter Adapter

- URL pattern: `x.com/{author}/status/{tweetId}` (also `twitter.com`)
- Content selector: `[data-testid="tweetText"]`
- Media check: `tweetPhoto`, `videoPlayer`, `card.wrapper` test IDs
- Note: X DOM selectors are fragile and change periodically

### DOM Matching (spec §2.8)

Claims are matched to DOM positions in three tiers:
1. Exact substring match (unique occurrence)
2. Context-disambiguated match (find context string, then claim within it)
3. Fuzzy fallback (Levenshtein distance sliding window)

If all tiers fail, the claim appears in the popup but is not annotated inline.

### Annotation Rendering

- Red wavy underline via `<mark class="openerrata-annotation">`
- Hover tooltip with claim summary
- Click opens detail panel with full reasoning + source links
- `clearAnnotations()` unwraps all marks before re-applying
- MutationObserver re-applies annotations after SPA re-renders

### Extension Settings

The options page (`options/App.svelte`) stores settings in `chrome.storage.local`:
- `openaiApiKey` — user-provided OpenAI key for request-scoped investigations
- `autoInvestigate` — auto-trigger investigate-now after `viewPost` misses
- `apiBaseUrl` — API server URL (default: `https://api.openerrata.com`)
- `hmacSecret` — optional override for request attestation secret
- `apiKey` — optional instance API key

`src/lib/settings.ts` is the source of truth for parsing defaults and storage
shape. Both the options page and background API client use it.

When a user saves a non-localhost API URL, the options page requests
host-origin permission via `chrome.permissions.request` before persisting the
URL. The background's `api-client.ts` then reads settings on init (and on
storage changes) and uses them for all API calls.
