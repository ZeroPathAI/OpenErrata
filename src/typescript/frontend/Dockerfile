# Keep in step with node-version in .github/actions/setup-typescript-workspace.
FROM node:22.23.3-slim AS base
# corepack installs the pnpm version pinned by package.json's packageManager.
RUN corepack enable

FROM base AS build
WORKDIR /app
# Copy dependency manifests first so pnpm install is cached unless
# package.json or pnpm-lock.yaml changes.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY shared/package.json shared/
COPY frontend/package.json frontend/
RUN pnpm install --frozen-lockfile
# Now copy source files (changes here won't bust the install cache).
# @openerrata/shared is TypeScript source compiled into the server bundle.
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY frontend/ frontend/
RUN pnpm --filter @openerrata/frontend build

FROM base AS runtime
WORKDIR /app/frontend
# The bundle imports its npm dependencies (e.g. zod) at runtime; keep pnpm's
# workspace layout so the symlinks in frontend/node_modules resolve.
COPY --from=build /app/frontend/build /app/frontend/build
COPY --from=build /app/frontend/node_modules /app/frontend/node_modules
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/frontend/package.json /app/frontend/package.json

EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production
USER node

CMD ["node", "build/index.js"]
