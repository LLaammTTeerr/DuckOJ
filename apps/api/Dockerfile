FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/api-prefix/package.json packages/api-prefix/
COPY packages/db/package.json packages/db/
COPY packages/contest-formats/package.json packages/contest-formats/
COPY packages/glicko2/package.json packages/glicko2/
COPY packages/contracts/package.json packages/contracts/
COPY packages/observability/package.json packages/observability/
COPY packages/package-format/package.json packages/package-format/
COPY packages/realtime/package.json packages/realtime/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter "@duckoj/api..." typecheck

# typst for statement PDFs (Phase 7b). x86_64 musl release — this Dockerfile
# already assumes the build host's arch for node's own binaries; a different
# arch means changing this URL. The mitex probe pre-seeds the package cache
# at BUILD time, so a math statement renders even if the running container
# has no outbound network (the compose stack guarantees none — the same
# reason the web fonts are vendored).
FROM base AS typst
ADD https://github.com/typst/typst/releases/download/v0.15.1/typst-x86_64-unknown-linux-musl.tar.xz /tmp/typst.tar.xz
RUN tar -xJf /tmp/typst.tar.xz -C /tmp \
 && install /tmp/typst-x86_64-unknown-linux-musl/typst /usr/local/bin/typst \
 && printf '#import "@preview/mitex:0.2.7": mi\n#mi(`\\frac{a}{b}`)\n' | typst compile - /tmp/probe.pdf

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
# PACKAGE_STORE_DIR (Task 13) is backed by a named volume mounted here in
# Compose. A named volume with no prior content is created root-owned on
# first use, and this container runs as the unprivileged `node` user below
# — without this, the first `FilesystemPackageStore.put()` fails EACCES.
# Same reasoning as judge/Dockerfile's `chown judge:judge /problems`.
RUN mkdir -p /var/lib/duckoj/packages && chown node:node /var/lib/duckoj/packages
COPY --from=typst /usr/local/bin/typst /usr/local/bin/typst
COPY --from=typst --chown=node:node /root/.cache/typst /home/node/.cache/typst
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
