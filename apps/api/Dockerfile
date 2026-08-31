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
COPY packages/similarity/package.json packages/similarity/
COPY apps/api/package.json apps/api/
# --ignore-scripts: the whole-workspace install pulls ssh2 + cpu-features as
# OPTIONAL native transitive deps of @testcontainers/postgresql — a devDep of
# apps/api AND packages/db (testcontainers -> ssh-remote-port-forward -> ssh2
# -> cpu-features). Their install-time node-gyp compile has no Python/compiler
# in this alpine stage and intermittently fails the whole build (B29, D124 —
# and NOT apps/mcp: @modelcontextprotocol/sdk has no ssh2 in its dep tree).
# Nothing this image needs runs a lifecycle script: tsc is pure JS, and
# @node-rs/argon2 + esbuild ship their platform binaries AS prebuilt packages
# (optionalDependencies), not as script outputs — so skipping scripts is safe
# and makes the install deterministic. Do NOT add npm_config_optional=false:
# that would drop those same argon2/esbuild platform binaries and break boot.
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY . .
# `tsc -b` only — not the package's `typecheck` script, whose second half
# (`tsc --noEmit -p tsconfig.test.json`) checks the test tree, and the tests
# reach `apps/judged/src` by relative path (rejudge.spec.ts's fencing proof).
# judged's dependencies are not installed in this image, so that half fails
# here on a module the runtime never needs. The test tree is checked by CI
# and the verify ritual, not by the image build.
RUN pnpm --filter "@duckoj/api..." exec tsc -b

# Sever the test-only ssh2 native chain from the store so it can never reach
# the runtime image — the `COPY --from=build /app /app` below carries
# node_modules verbatim. ssh2/cpu-features enter only through testcontainers
# (a devDep), which the api never imports; --ignore-scripts already stops them
# building, and this removes the files themselves (B29, D124). AFTER the
# compile, so the type tree that references @types/ssh2 still resolves. The
# inert `nan`/`buildcheck` JS orphans are left as-is.
RUN rm -rf node_modules/.pnpm/ssh2@* \
           node_modules/.pnpm/ssh-remote-port-forward@* \
           node_modules/.pnpm/cpu-features@* \
           node_modules/.pnpm/@types+ssh2@* \
           node_modules/.pnpm/@types+ssh2-streams@*

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
