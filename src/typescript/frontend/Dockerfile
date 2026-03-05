FROM node:22-slim AS base
RUN corepack enable

FROM base AS build
WORKDIR /app
# Copy dependency manifests first so pnpm install is cached unless
# package.json or pnpm-lock.yaml changes.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY frontend/package.json frontend/
RUN pnpm install --frozen-lockfile
# Now copy source files (changes here won't bust the install cache).
COPY frontend/ frontend/
RUN pnpm --filter @openerrata/frontend build

FROM base AS runtime
WORKDIR /app/frontend
COPY --from=build /app/frontend/build /app/frontend/build
COPY --from=build /app/frontend/node_modules /app/frontend/node_modules
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/frontend/package.json /app/frontend/package.json

EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "build/index.js"]
