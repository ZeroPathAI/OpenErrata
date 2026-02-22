# OpenErrata

<p align="center">
  <img src="assets/demo-hover.jpg" alt="OpenErrata highlighting an incorrect claim on Astral Codex Ten with a hover tooltip showing the correction and source" width="800" />
  <br />
  <em>OpenErrata highlighting an incorrect claim on Astral Codex Ten, with a hover tooltip.</em>
</p>

OpenErrata is a browser extension that uses LLMs to investigate the posts you're reading, and underline the unambiguously incorrect claims, with sources. The tool understands context, and is instructed not to surface corrections for satire, jokes, etc. It prioritizes an extremely low false-positive rate over coverage, and its prompts, details, and reasoning behind every investigation are designed to be auditable and free from bias.

## Install

**Chrome Web Store** — Coming soon.

**Manual install** from [GitHub Releases](https://github.com/ZeroPathAI/openerrata/releases):

1. Download the latest `openerrata-extension-*.zip` from the [Releases page](https://github.com/ZeroPathAI/openerrata/releases)
2. Unzip the file
3. Open `chrome://extensions` in Chrome
4. Enable **Developer mode** (toggle in the top-right)
5. Click **Load unpacked** and select the unzipped folder

The extension connects to the hosted API at `api.openerrata.com` by default — no configuration needed. To point it at a self-hosted instance, open the extension options page and change the API URL.

## How It Works

1. **You browse normally.** The extension detects supported posts and sends observed content to the API, which records views and returns any existing investigation results.
2. **Posts get investigated.** Either you click "Investigate Now" (having configured your own OpenAI key or instance-managed credentials), or the service selects it from the highest viewed posts that day.
3. **The LLM investigates.** A single agentic call sends the full post text (plus images) to the model, which uses native web search and browsing tools to verify claims. Only demonstrably incorrect claims are flagged — disputed, ambiguous, or unverifiable claims are left alone.
4. **Incorrect claims are highlighted.** For all extension users, every incorrect sentences get a red underline in the post. Hover for a summary; click for full reasoning and sources.

Currently supports only Substack, Twitter, and LessWrong.

## Repository Layout

```
src/
├── helm/openerrata/         # Helm chart (single artifact for on-prem + hosted)
└── typescript/
    ├── shared/              # @openerrata/shared — types, Zod schemas, normalization
    ├── api/                 # @openerrata/api — SvelteKit + tRPC backend, Prisma, job queue
    ├── extension/           # @openerrata/extension — Chrome MV3 browser extension
    └── pulumi/              # @openerrata/pulumi — deploys the Helm chart for hosted env
```

The monorepo uses **pnpm workspaces**. Dependencies flow: `shared` -> `api` and `shared` -> `extension`.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension UI | Svelte 5, component-scoped CSS |
| Extension build | Vite (multi-entry MV3 build) |
| Cross-browser | webextension-polyfill |
| Type safety | TypeScript + Zod |
| API | SvelteKit + tRPC (internal) + GraphQL (public) |
| Database | Postgres + Prisma |
| Job queue | Postgres-backed (graphile-worker) |
| LLM | OpenAI Responses API with native tool use |
| Deployment | Helm chart (on-prem), Pulumi (hosted) |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS)
- [pnpm](https://pnpm.io/)
- [Docker](https://www.docker.com/) (for local Postgres + MinIO)

### Local Development

```bash
# Start Postgres (port 5433) and MinIO S3-compatible storage (ports 9000/9001)
docker compose up -d

# Install dependencies
cd src/typescript
pnpm install

# Apply database migrations
pnpm db:migrate

# Start the API dev server
pnpm dev:api

# Build the extension in watch mode (separate terminal)
pnpm dev:ext

# Start the job queue worker (separate terminal)
pnpm worker
```

### Common Commands

```bash
pnpm check              # Typecheck all packages + lint
pnpm lint:fix            # ESLint with auto-fix
pnpm test               # Run unit + integration tests
pnpm selector            # Run investigation selector (cron equivalent)
pnpm db:migrate          # Create/apply Prisma migrations
pnpm db:migrate:deploy   # Apply SQL migrations (e.g. Postgres views)
pnpm db:generate         # Regenerate Prisma client
```

### Loading the Extension

After `pnpm dev:ext`, load the built extension as an unpacked extension in Chrome:

1. Navigate to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the extension build output directory

## Deployment

The Helm chart at `src/helm/openerrata/` is the single deployment artifact for both on-prem and hosted environments. It does not bundle a database — it takes a `DATABASE_URL` as config.

**On-prem:**
```bash
helm install openerrata ./src/helm/openerrata \
  --set secrets.databaseUrl="postgresql://..." \
  --set secrets.openaiApiKey="sk-..."
```

**Hosted:** The official hosted deployment uses Pulumi (`src/typescript/pulumi/`) to deploy the same Helm chart with hosted-specific overrides (Supabase connection, domain, TLS, autoscaling). This guarantees identical workload definitions between on-prem and hosted — no deployment drift.

## Supported Platforms

| Platform | Detection | Content Script |
|----------|-----------|----------------|
| LessWrong | URL match (`lesswrong.com`) | Static HTML extraction, MutationObserver for React re-renders |
| X (Twitter) | URL match (`x.com`, `twitter.com`) | SPA-aware with MutationObserver, `[data-testid="tweetText"]` selector |
| Substack | URL match (`*.substack.com/p/*`) + DOM fingerprint for custom domains | `link[href*="substackcdn.com"]` detection, `.body.markup` content root |

## Public API

Completed investigations are publicly accessible via GraphQL at `POST /graphql`. No authentication required. Responses include trust signals (content provenance, corroboration count, server verification timestamps) so consumers can apply their own trust policy.

See [SPEC.md](SPEC.md) for the full GraphQL schema and resolver semantics.

## Design Principles

- **When in doubt, don't flag.** False positives erode trust and will be adversarially scrutinized. The system only flags claims with concrete, credible counter-evidence.
- **Transparency.** The design, spec, code, and individual investigations are all publicly inspectable. Every investigation stores full audit artifacts (prompt, model metadata, tool traces, source snapshots).
- **Lean on frontier models.** The LLM uses provider-native web search and browsing rather than a custom search-and-scrape pipeline. We orchestrate; the model investigates.
- **Single-pass investigation.** The entire post is investigated in one agentic call, giving the model full context for understanding caveats, qualifications, and claim relationships.

## Documentation

- **[SPEC.md](SPEC.md)** — Full product spec covering design goals, architecture, data model, API surface, and implementation details. This is the source of truth for product behavior.

## License

[GNU Affero General Public License v3.0](LICENSE)
