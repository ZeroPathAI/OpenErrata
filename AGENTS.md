# TrueSight

TrueSight is a browser extension that investigates the content people read on the
internet with LLMs, and provides inline rebuttals to empirically incorrect or
unambiguously misleading information. The design goals, architecture, data model,
and API are documented in `SPEC.md` — that is the source of truth for product
behavior.

## Repository Layout

```
src/
├── helm/truesight/          # Helm chart (single deployment artifact for on-prem + hosted)
└── typescript/
    ├── shared/              # @truesight/shared — types, Zod schemas, normalization
    ├── api/                 # @truesight/api — SvelteKit + tRPC backend, Prisma, job queue
    ├── extension/           # @truesight/extension — Chrome MV3 browser extension
    └── pulumi/              # @truesight/pulumi — deploys the Helm chart for hosted env
```

The monorepo uses pnpm workspaces. Dependencies flow: `shared` → `api` and
`shared` → `extension`. The extension imports the API's `AppRouter` type (type-only,
no runtime code) for tRPC client typing.

## Key Files

- `SPEC.md` — Product spec. All product behavior questions are answered here.
- `src/typescript/api/prisma/schema.prisma` — Database schema (source of truth
  for data model).
- `src/typescript/api/src/lib/investigators/prompt.ts` — The LLM investigation
  prompt.
- `src/typescript/api/prisma/migrations/20260219120000_add_investigation_public_eligibility_view/migration.sql`
  — SQL definition for the `investigation_public_eligibility` Postgres view.

## Programming Guidelines

Code can be "correct" in the sense of doing what we want, and yet still be bad
in the sense of encouraging further mistakes, making it harder for other AI
agents to read or iterate on your code, or making it unclear what the intent
behind it was. Here are some rules so you do not write code that is bad in
these ways.

Always take the time to introduce new features and fix bugs in the codebase in
the most maintainable way, even if it means modifying more than your user
initially expects. Be sure to highlight such roundabout changes in your
response, but otherwise feel free to perform refactors of bad code not
originally mentioned in your prompt.

**The underlying driving spec behind the software you're tasked with writing
should be clearly understandable just by reading your code.** This is the most
important rule. As the product evolves, a larger and larger proportion of the
spec will live outside of the SPEC.md and implicitly in the code. If it is not
immediately clear what the code you are writing is designed to do, refactor it
until that is apparent just from its structure. Anyone looking at your code
should be able to tell why it is designed that way and what purpose it serves.
This helps AI models and humans that have to reread the codebase and infer this
information from scratch.

Treat the public interface of code you're writing or using as advertising an
implicit or explicit "spec", distinct from its internal implementation. As
previously stated, the spec should be clear, consumers should depend only on
the spec and not incidental implementation details, and consumers should
support the whole range of behavior that the spec suggests rather than just
what the code exhibits at the present date.

When modifying code you didn't write, do not maintain legacy behavior that you
can't identify a design motivation for. Clearly explain any differences in
behavior that your operator might not be aware of, but otherwise feel free to
make sensible design changes if they serve the purpose of making the code more
maintainable.

When designing data structures and functions, adhere to the representable-valid
principle as much as possible. Do not tolerate datatypes, structs, or database
tables with possible "invalid" configurations. Don't even let groups of
variables accessible from the same namespace have invalid configurations. Each
"invalid" datatype value is a possible failure state for the program to enter
into, and another requirement of the application for data accessors to reason
about, that could be offloaded to the type checker.

Bad:

```
type StreetLightStatus = {
  red_light: bool
  yellow_light: bool
  green_light: bool
}
var asyncLoadedData: Data | undefined = undefined
var asyncLoadedDataError: str | undefined = undefined
```

Better:
```
type StreetLightStatus = enum {
  RED
  YELLOW
  GREEN
}
var asyncDataState: {
   state: "loading"
} | {
   state: "errored"
} | {
   state: "loaded"
   data: Data
}
```

For untyped languages that do not support strict type definitions but still
support 'type hints', you should use those to express constraints.

Variables should always contain an accurate copy of the data they advertise in
their name at each program step. Never populate datatypes with "dummy" or
placeholder values, even temporarily, because that creates a condition for
access that other programmers have to reason about. Neither should you return
objects or values that would give callers a literally incorrect state of the
world. If you catch yourself doing this, come up with a refactor that does not
require you to do so instead.

When key assumptions that your code relies upon to work appear to be broken,
and you cannot use the type system or good architectural design to remove the
possibility of errors entirely (which is always the first preference), fail
early and visibly, rather than attempting to patch things up. In particular:
* Lean towards propagating errors up to callers, instead of silently "warning"
  about them inside of try/catch blocks.
* Push error handling to type systems where possible by specifying stricter
  input & output types instead of attempting to throw errors or create
  fallbacks
* If you are fairly certain data should always exist, assume it does, rather
  than producing code with unnecessary guardrails or existence checks (esp. if
  such checks might mislead other programmers)
* Avoid the use of hasattr/getattr (or non-python equivalents) when accessing
  attributes and fields that should always exist.
* Never produce knowingly incorrect 'defaults' as a result of errors or missing
  data, either for users, or downstream callers.

Do not assume your user has context about system architecture, files, line
numbers, or programming concepts. Re-explain these details as necessary if they
have not already come up. This is also helpful for verifying that *you*
understand what's going on.

## Testing Philosophy

The purpose of tests is to automate the collection of evidence that the
explicit + implicit spec is being adhered to. This can be accomplished at
multiple levels:
- Unit tests of individual or groups of functions that are required to operate
  correctly in order for the program to work well, like an `assert text ==
  decompress(compress(text))` test of a compression lib
- Mocks of components that have individual properties that we want to verify,
  like a guard that panics() on invalid SQL statements sent to the DB
- Integreation tests of direct components of the SPEC.md

Our primary test suite should be:
- Fast, easy to run
- Produce few false negatives as possible (i.e., fail the code when it's behaving poorly)
- Produce as few false positives as possible (i.e., fail the code when it complies with the spec). This can happen because either:
  - The test is jittery
  - The test is testing things that are not actually part of the spec, and are just incidental implementation details

New code that you write should be written so that it's easily tested. Keep the
test coverage of the code high.

## Dev Environment

```bash
# Start local Postgres (port 5433) + MinIO S3-compatible storage (9000 API / 9001 console)
docker compose up -d

# Install dependencies
cd src/typescript && pnpm install

# Apply schema + SQL migrations
cp ../../.env.example api/.env   # edit OPENAI_API_KEY
# .env.example includes local MinIO defaults for BLOB_STORAGE_*.
# If testing real OpenAI multimodal fetches, use a publicly reachable BLOB_STORAGE_PUBLIC_URL_PREFIX.
pnpm db:migrate

# Run
pnpm dev:api        # API on localhost:5173
pnpm worker         # graphile-worker (separate terminal)
pnpm dev:ext        # build extension to extension/dist/ (separate terminal)

# Quality
pnpm check          # typecheck + lint
pnpm lint:fix       # auto-fix lint issues
```
