# OpenErrata API

SvelteKit application that serves as the backend for OpenErrata. Hosts the tRPC
API, runs the investigation job queue, and exposes the public investigation
browser.

## Architecture

### Request Flow

Extension background worker → HTTP POST/GET → SvelteKit `hooks.server.ts` →
tRPC handler → `postRouter` or `publicRouter` → Prisma → PostgreSQL.

### tRPC Routers

- `src/lib/trpc/routes/post.ts` — Extension-facing API: `viewPost` (mutation),
  `getInvestigation` (query), `investigateNow` (mutation),
  `validateSettings` (query), `batchStatus` (query).
- `src/lib/trpc/routes/public.ts` — Public API: investigation browser, search,
  metrics. Joins against the `investigation_public_eligibility` Postgres view.

### Key Handlers

**`viewPost`** is the highest-traffic handler. It:
1. Normalizes client-submitted content
2. Fast-checks for a completed investigation using the observed content version
3. For misses, attempts server-side canonical fetch (LessWrong GraphQL API; X/Substack stub to CLIENT_FALLBACK)
4. Rejects mismatches (`CONTENT_MISMATCH`) when server-verified content conflicts
5. Upserts the Post + increments viewCount and unique-view credits
6. Upgrades provenance on existing CLIENT_FALLBACK investigations if server hash matches
7. Records corroboration credits for authenticated viewers
8. Returns cached investigation results if available

### Investigation Pipeline

1. Selector cron (`src/lib/services/selector.ts`) picks uninvestigated posts by
   uniqueViewScore, attempts server-side fetch, and creates PENDING investigations.
2. graphile-worker (`src/lib/services/queue.ts`) picks up jobs.
3. Orchestrator (`src/lib/services/orchestrator.ts`) calls the investigator,
   stores claims + sources, marks COMPLETE or FAILED.
4. The investigator (`src/lib/investigators/openai.ts`) uses the OpenAI Responses
   API with `web_search_preview` tool and structured JSON output.

### Failure Classification (spec §3.7)

- **TRANSIENT**: Provider 5xx, 429, network timeouts → graphile-worker retries
  with backoff. Orchestrator resets investigation status back to `PENDING`
  before rethrow so only one worker run is active at a time.
- **NON_RETRYABLE**: Zod validation failure, content-policy refusal, auth errors
  → mark FAILED immediately, don't rethrow.
- **FAILED is terminal** for a given (postId, contentHash). No automatic
  re-selection by the selector.

### Prisma Schema

`prisma/schema.prisma` — uses Prisma's default naming (PascalCase tables,
camelCase columns). The `InvestigationPublicEligibility` Prisma view maps to
the SQL view name `investigation_public_eligibility` via `@@map`. Raw SQL in
the codebase uses quoted identifiers (`"Post"`, `"contentHash"`, etc.).

The SQL definition for `investigation_public_eligibility` lives in
`prisma/migrations/0002_views_and_constraints/migration.sql` and is managed as
the canonical migration source.

### Prompt Management

Prompts are stored in a `Prompt` table, deduplicated by SHA-256 hash.
Investigations reference prompts via `promptId` FK, not inline text fields.
`src/lib/services/prompt.ts` provides `getOrCreateCurrentPrompt()` which
upserts by hash.

### Authentication

- Anonymous viewers: identified by hashed IP+UA.
- Authenticated viewers: provide a valid `x-api-key` header. Valid keys are
  configured via `VALID_API_KEYS` env var (comma-separated).
- Attestation: extension sends HMAC signature in `x-openerrata-signature` header.
  Verified in context but treated as a low-confidence signal, not a security boundary.

### SQL Injection Prevention

All raw SQL MUST use parameterized queries (`prisma.$queryRaw` with tagged
template literals, or `$queryRawUnsafe` with `$1`/`$2` placeholders). NEVER
string-interpolate user input into SQL.
