FROM node:22-slim AS base
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY shared/ shared/
COPY api/ api/
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @openerrata/api run prisma:generate
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
