# OpenErrata Browser Extension

WebExtension (Chrome MV3 primary, Firefox-compatible) that extracts post
content from LessWrong, X, Substack, and Wikipedia, sends it to the OpenErrata
API, and renders inline annotations on incorrect claims.

## Build

```bash
pnpm dev    # vite build --watch (rebuilds on file change)
pnpm build  # production build to dist/ (Chrome) and dist/firefox/
# package CI artifacts (.zip/.crx/.xpi) after pnpm build:
OPENERRATA_EXTENSION_PACKAGE_VERSION=0.2.0 pnpm package:artifacts
```

Firefox package metadata uses `browser_specific_settings.gecko.id`. Override
the default id with `FIREFOX_GECKO_ID=<your-addon-id>` when running `pnpm build`.
Chrome `.crx` packaging uses `OPENERRATA_CHROME_CRX_PRIVATE_KEY` when set;
otherwise the packager generates a temporary signing key.
Set `OPENERRATA_REQUIRE_CRX_SIGNING_KEY=true` to fail instead of generating a
temporary key when no CRX key is configured.

After building:

- Chrome: load `dist/` via `chrome://extensions` (Developer mode).
- Firefox: load `dist/firefox/manifest.json` via `about:debugging#/runtime/this-firefox`.

## Architecture

### Message Flow

```
Content Script (runs on supported pages; one controller per page)
  → extract content via platform adapter (shared text index, src/content/dom-text-index.ts)
  → PAGE_CONTENT { tabSessionId, content }       (typed: src/lib/messaging.ts)
  → Background runtime (service worker in Chrome, event page in Firefox)
      → api-client.ts: post.registerObservedVersion → { postVersionId, ... }
      → api-client.ts: post.recordViewAndGetStatus({ postVersionId })
      → caches the page session's status in storage.session (background/tab-state.ts)
      → INVESTIGATING (started here or elsewhere) → polls post.getInvestigation
      → optional: post.investigateNow when auto-investigate is enabled
  ← reply: the cached ExtensionPostStatus; later updates arrive as STATUS_CHANGED
  → Content Script renders highlights (or reports PAGE_SKIPPED)
```

The message protocol (types, payloads, responses) is one table per direction
in `shared/src/schemas/extension-protocol.ts`; see SPEC §3.8.1. The popup asks
the background for a tab's status with `GET_TAB_STATUS { tabId }` and talks to
the tab's content script directly (`GET_VISIBILITY`, `REQUEST_INVESTIGATE`,
`FOCUS_CLAIM`, ...). The background relays History API navigations to the
content script as `LOCATION_CHANGED` (content scripts run in an isolated world
and cannot see the page's `pushState`) and probes for a live content script
with the side-effect-free `PING` before injecting one.

### Content Scripts — IIFE Build Requirement

**Content scripts MUST be built as IIFE (no ES module imports).** MV3 loads
content scripts as classic scripts — `import` statements are syntax errors.

The Vite config uses a multi-pass build:

1. Main build: Chrome runtime assets (module background + popup + options)
2. Content script build: `lib` mode with `formats: ["iife"]` → single file,
   all dependencies inlined
3. Firefox background build: `lib` mode with `formats: ["iife"]` so
   `background.scripts` can run without module imports

If you add a new dependency to the content script, it gets bundled into the
IIFE automatically. If the IIFE gets too large, refactor shared code into
the background worker and communicate via messages.

### Platform Adapters

Each adapter implements `PlatformAdapter` (`adapters/model.ts`):

- `matches(url)` / `detectFromDom(document)` — URL-first platform selection, DOM fallback
- `pageLocator(url)` — what the URL says about the post (`lib/page-locator.ts`, the one URL parser)
- `extract(document)` — `PlatformContent` (or a not-ready reason)
- `getContentRoot(document)` + `contentExclusionFilter(root)` — the root and the
  non-content subtrees; text extraction, claim matching and HTML snapshots all
  go through these, so they agree with each other and with the API

**Media detection**: content carries `hasVideo` and its image occurrences
(`has_video` > `has_images` > `text_only`). Image posts are investigated;
video posts are skipped. Adapters also skip private/protected/subscriber-only
views with `reason: "private_or_gated"` and do not send content to the API in
that case. The content script sends `PAGE_SKIPPED` when skipping.

### LessWrong Adapter

- URL pattern: `lesswrong.com/posts/{postId}/{slug}`
- Content selector: `#postContent` inside the `.PostsPage-postContent` whose JSON-LD names the post
- Media check: `img, video, iframe` inside the content element
- Source: `vendor/ForumMagnum/` has the LessWrong source for selector reference

### X/Twitter Adapter

- URL pattern: `x.com/{author}/status/{tweetId}` (also `twitter.com`)
- Content selector: `[data-testid="tweetText"]` (logged in) or the article's own
  `div[dir="auto"]` (logged-out frontend, no test IDs)
- Media check: `tweetPhoto`/`card.wrapper` images, `videoPlayer` or any `<video>`
- Note: X DOM selectors are fragile and change periodically

### Wikipedia Adapter

- URL pattern: `*.wikipedia.org/wiki/{title}`
- Content selector: main article content root
- Media check: same extension media classification rules (`text_only`, `has_images`, `has_video`)

### DOM Matching (spec §2.8)

Claims are matched to DOM positions in three tiers:

1. Exact substring match (unique occurrence)
2. Context-disambiguated match (find context string, then claim within it)
3. Fuzzy fallback (Levenshtein distance sliding window)

If all tiers fail, the claim appears in the popup but is not annotated inline.

### Annotation Rendering

- Red wavy underline via `<mark class="openerrata-annotation">`, one per text-node piece
- Hover tooltip with claim summary
- Click opens detail panel with full reasoning (markdown, no images, allowlisted tags) + source links
- Clearing restores the page's own text nodes (never `normalize()`s nodes React owns)
- MutationObserver re-applies annotations after SPA re-renders
- Page HTML sent to the API is serialized with marks unwrapped (`cloneWithoutAnnotations`)

### Extension Settings

The options page (`options/App.svelte`) stores settings in `browser.storage.local`:

- `openaiApiKey` — user-provided OpenAI key for request-scoped investigations
- `autoInvestigate` — auto-trigger investigate-now after the register+record flow returns `NOT_INVESTIGATED`
- `apiBaseUrl` — API server URL (default when unset: `https://api.openerrata.com`)
- `apiKey` — optional instance API key

`src/lib/settings-core.ts` is the source of truth for parsing and storage
shape: loading yields `VALID` settings or `INVALID` with the problem. An
invalid stored value (e.g. an API URL that fails validation) is shown in the
options page and popup and blocks API calls — it is never replaced by the
hosted default.

When a user saves an API URL, the options page requests host-origin
permission via `browser.permissions.request` before persisting it (`http://`
origins are optional host permissions). The background's `api-client.ts`
reads settings lazily, re-reads them on storage changes, and uses them for all
API calls. API calls are untyped at the tRPC level (`TRPCUntypedClient`);
inputs and outputs are pinned by the shared `ExtensionApiProcedureContract`
and validated with the shared output schemas.

### Tests

- `pnpm test:unit` — node:test + jsdom (`test/unit`, helpers in `test/helpers`).
- `pnpm test:e2e` — builds, then runs Playwright against the built extension in
  headless Chromium (`channel: "chromium"` new headless mode; no window opens,
  no virtual display needed). The API is mocked with `context.route`, which
  also intercepts the extension service worker's requests
  (`test/e2e/extension-harness.ts`).
