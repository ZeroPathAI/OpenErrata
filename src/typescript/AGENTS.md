# TypeScript Workspace

pnpm monorepo with four packages: `shared`, `api`, `extension`, `pulumi`.

## Useful Commands

```bash
pnpm check            # typecheck all packages + lint
pnpm lint             # ESLint only
pnpm lint:fix         # ESLint with auto-fix
pnpm typecheck        # tsc/svelte-check across all packages
pnpm dev:api          # Start API dev server
pnpm dev:ext          # Build extension in watch mode
pnpm worker           # Start graphile-worker
pnpm selector         # Run investigation selector
pnpm db:migrate       # Create/apply Prisma migrations in development
pnpm db:migrate:deploy # Apply SQL migrations (e.g. Postgres views)
pnpm db:generate      # Regenerate Prisma client
```

## Type Safety Rules

**NEVER use `as any` or `as unknown` to bypass type errors.** These escape
hatches defeat the purpose of TypeScript's type system and often mask real bugs.

Prohibited patterns:
- `value as any`
- `value as unknown as SomeType`
- `{} as SomeType`
- `(obj as any).property`

Permitted patterns:
- `as const` for literal type inference
- `as SomeType` ONLY after runtime validation (e.g., after Zod `.parse()`)
- Type assertions in test files where mocking requires partial objects

## Enum Convention

Enums are plain string union types, not TypeScript `enum` declarations. This
ensures assignability with Prisma-generated types and Zod-inferred types:

```typescript
// Good — string union, compatible with Prisma and Zod
export type Platform = "LESSWRONG" | "X";

// Bad — TS enum, not assignable to/from Prisma's generated type
export enum Platform { LESSWRONG = "LESSWRONG", X = "X" }
```

## Package Dependencies

```
shared ← api       (types, schemas, normalization)
shared ← extension (types, schemas, normalization)
```

Extension/API procedure compatibility is enforced via the shared
`ExtensionApiProcedureContract` types:

- API asserts route input compatibility in `api/src/lib/trpc/router.ts`
- Extension uses typed query/mutation path wrappers in
  `extension/src/background/api-client.ts`

The `shared` package uses raw TypeScript source imports (`"main": "src/index.ts"`)
within the monorepo. Both Vite (extension) and SvelteKit (API) transpile TS on
the fly, so no separate build step is needed in dev.

## ESLint Configuration

Flat config (ESLint 9+) at `eslint.config.js`. Key rules:

- Type-aware linting (projectService) for `.ts` files across `api`, `shared`,
  `extension`, and `pulumi` (excluding generated files/configs plus selected
  tooling and extension test files).
- Svelte files get non-type-aware linting; `svelte-check` handles type errors.
- Security rules: `no-eval`, `no-new-func`, `eqeqeq`.
- Async safety: `no-floating-promises`, `no-misused-promises`, `await-thenable`.
- Exhaustiveness: `switch-exhaustiveness-check`.
