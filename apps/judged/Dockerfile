FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/db/package.json packages/db/
COPY packages/judge-protocol/package.json packages/judge-protocol/
COPY packages/observability/package.json packages/observability/
COPY packages/realtime/package.json packages/realtime/
COPY apps/judged/package.json apps/judged/
# --ignore-scripts: same B29/D124 flake as apps/api. ssh2 + cpu-features arrive
# as OPTIONAL native transitive deps of @testcontainers/postgresql — a devDep
# of apps/judged AND packages/db (testcontainers -> ssh-remote-port-forward ->
# ssh2 -> cpu-features), NOT of apps/mcp. Their node-gyp compile intermittently
# fails this compiler-less stage. Nothing judged needs runs a lifecycle script,
# so skipping them is safe and deterministic. Do NOT add npm_config_optional=
# false (it would drop legitimate prebuilt platform binaries).
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY . .
RUN pnpm --filter "@duckoj/judged..." typecheck

# Sever the test-only ssh2 native chain from the store before it is carried
# into the runtime image by `COPY --from=build /app /app`. Run AFTER typecheck
# (whose test-tree half type-references testcontainers). See apps/api/Dockerfile
# for the full rationale (B29, D124).
RUN rm -rf node_modules/.pnpm/ssh2@* \
           node_modules/.pnpm/ssh-remote-port-forward@* \
           node_modules/.pnpm/cpu-features@* \
           node_modules/.pnpm/@types+ssh2@* \
           node_modules/.pnpm/@types+ssh2-streams@*

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 9999 3001
CMD ["node", "apps/judged/dist/main.js"]
