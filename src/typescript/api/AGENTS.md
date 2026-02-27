# OpenErrata API

SvelteKit application that serves as the backend for OpenErrata. Hosts the tRPC
API, runs the investigation job queue, and exposes the public investigation
browser.

## Architecture

### Request Flow

Extension background worker → HTTP POST/GET → SvelteKit `hooks.server.ts` →
tRPC handler → `postRouter` or `publicRouter` → Prisma → PostgreSQL.

### tRPC Routers

- `src/lib/trpc/routes/post.ts` — Extension-facing API:
  `registerObservedVersion` (mutation), `recordViewAndGetStatus` (mutation),
  `getInvestigation` (query), `investigateNow` (mutation),
  `validateSettings` (query), `batchStatus` (query).
- `src/lib/trpc/routes/public.ts` — Legacy public tRPC API: investigation
  browser, search, metrics. Uses shared read-model logic.
- `src/routes/graphql/+server.ts` — Public GraphQL API endpoint (`POST /graphql`).

### Key Handlers

**`registerObservedVersion`** is the canonicalization/versioning entrypoint. It:

1. Normalizes client-observed content and image-occurrence payloads
2. Resolves canonical content version (server-verified when available; client-fallback otherwise)
3. Rejects mismatches (`CONTENT_MISMATCH`) when server-verified content conflicts with observed content
4. Upserts PostVersion-backed storage (`ContentBlob`, `ImageOccurrenceSet`, `PostVersion`)
5. Returns `{ platform, externalId, versionHash, postVersionId, provenance }`

**`recordViewAndGetStatus`** is the view-credit/read-status entrypoint. It:

1. Takes `postVersionId` from `registerObservedVersion` (no canonical fetch in this handler)
2. Increments Post view counters and unique-view credits
3. Records corroboration credits for authenticated viewers on fallback-provenance investigations
4. Returns completed claims if present, otherwise `NOT_INVESTIGATED` plus optional `priorInvestigationResult`

### Investigation Pipeline

1. Selector cron (`src/lib/services/selector.ts`) picks uninvestigated posts by
   uniqueViewScore, attempts server-side fetch, and creates PENDING investigations.
2. graphile-worker (`src/lib/services/queue.ts`) picks up jobs.
3. Orchestrator (`src/lib/services/orchestrator.ts`) calls the investigator,
   stores claims + sources, marks COMPLETE or FAILED.
4. The investigator (`src/lib/investigators/openai.ts`) runs a two-step OpenAI
   Responses workflow: (a) tool-enabled fact-check generation, then (b) a
   second model validation pass that filters claims against OpenErrata
   principles before structured output is accepted.

### Failure Classification (spec §3.7)

- **TRANSIENT**: Provider 5xx, 429, network timeouts → graphile-worker retries
  with backoff. Orchestrator resets investigation status back to `PENDING`
  before rethrow so only one worker run is active at a time.
- **NON_RETRYABLE**: Zod validation failure, content-policy refusal, auth errors
  → mark FAILED immediately, don't rethrow.
- **FAILED is terminal** for a given `postVersionId`. No automatic
  re-selection by the selector.

### Prisma Schema

`prisma/schema.prisma` — uses Prisma's default naming (PascalCase tables,
camelCase columns). Raw SQL in the codebase uses quoted identifiers (`"Post"`,
`"contentHash"`, etc.).

### Prompt Management

Prompts are stored in a `Prompt` table, deduplicated by SHA-256 hash.
Investigations reference prompts via `promptId` FK, not inline text fields.
`src/lib/services/prompt.ts` provides `getOrCreateCurrentPrompt()` which
upserts by hash.

### Authentication

- Anonymous viewers: identified by hashed IP+UA.
- Authenticated viewers: provide a valid `x-api-key` header. Valid keys are
  looked up in the `InstanceApiKey` table by SHA-256 hash.
- Manage instance keys with:
  `pnpm --filter @openerrata/api run instance-api-key <list|activate|revoke>`.
- Attestation: extension sends HMAC signature in `x-openerrata-signature` header.
  Verified in context but treated as a low-confidence signal, not a security boundary.

### SQL Injection Prevention

All raw SQL MUST use parameterized queries (`prisma.$queryRaw` with tagged
template literals, or `$queryRawUnsafe` with `$1`/`$2` placeholders). NEVER
string-interpolate user input into SQL.
