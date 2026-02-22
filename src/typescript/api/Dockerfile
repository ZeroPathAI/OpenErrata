FROM node:22-slim AS base
RUN corepack enable

FROM base AS build
WORKDIR /app
# Copy dependency manifests first so pnpm install is cached unless
# package.json or pnpm-lock.yaml changes.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY shared/package.json shared/
COPY api/package.json api/
RUN pnpm install --frozen-lockfile
# Now copy source files (changes here won't bust the install cache).
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY api/ api/
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" pnpm --filter @openerrata/api run prisma:generate
RUN pnpm --filter @openerrata/api build

FROM base AS runtime
WORKDIR /app
COPY --from=build /app/api/build build/
COPY --from=build /app/api/node_modules node_modules/
COPY --from=build /app/api/prisma prisma/
COPY --from=build /app/api/prisma.config.ts prisma.config.ts
COPY --from=build /app/api/src src/
COPY --from=build /app/api/package.json package.json

EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production

# Default: run the API server. Override CMD for worker/selector.
CMD ["node", "build/index.js"]
