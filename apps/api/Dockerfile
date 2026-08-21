FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/api-prefix/package.json packages/api-prefix/
COPY packages/db/package.json packages/db/
COPY packages/contest-formats/package.json packages/contest-formats/
COPY packages/contracts/package.json packages/contracts/
COPY packages/observability/package.json packages/observability/
COPY packages/package-format/package.json packages/package-format/
COPY packages/realtime/package.json packages/realtime/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter "@duckoj/api..." typecheck

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
# PACKAGE_STORE_DIR (Task 13) is backed by a named volume mounted here in
# Compose. A named volume with no prior content is created root-owned on
# first use, and this container runs as the unprivileged `node` user below
# — without this, the first `FilesystemPackageStore.put()` fails EACCES.
# Same reasoning as judge/Dockerfile's `chown judge:judge /problems`.
RUN mkdir -p /var/lib/duckoj/packages && chown node:node /var/lib/duckoj/packages
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
