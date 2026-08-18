# Builds a tier1 (C++-only) DMOJ judge image.
#
# `docker.io/dmoj/judge-tier1` does not exist on Docker Hub, and
# `dmoj/runtimes-tier1` is a contestant-runtime image with no judge installed
# in it (verified: `command -v dmoj` is empty, `import dmoj` raises
# ModuleNotFoundError). `dmoj/judge-small` is real but was last pushed in
# 2017. Phase 1 is C++-only, so none of the multi-gigabyte official runtime
# images are needed — this recipe was proven end-to-end by a spike that
# graded a real C++ submission to AC through the resulting image (431 MB,
# versus 1.89 GB for runtimes-tier1).
FROM python:3.11-slim-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential libseccomp-dev git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Our own fork of judge-server (https://github.com/qhhoj/judge-server), not
# upstream DMOJ. Pin by commit, never by branch — an unpinned judge is a
# silent dependency on whatever the fork's HEAD happens to be the day someone
# rebuilds.
ARG JUDGE_REPO=https://github.com/qhhoj/judge-server
ARG JUDGE_COMMIT=a8cff35ca9b4d7052ff19781eb730e9cec99fafc
RUN git clone "$JUDGE_REPO" /judge && git -C /judge checkout "$JUDGE_COMMIT"
WORKDIR /judge
RUN python3 -m venv /env && \
    /env/bin/pip install --no-cache-dir -U pip setuptools wheel cython && \
    /env/bin/pip install --no-cache-dir -e .

# --- judge-agent (Task 13) ---
#
# apps/judge-agent writes the judge's own PROBLEMS_DIR, so it must run
# inside this same container (task-13-brief.md's Controller addendum C2) —
# not as a separate container sharing a volume. The judge image above is
# Debian-based but not Node-based, so judge-agent is built in its own Node
# stage here and only the compiled output plus a `node` binary are copied
# into the final image below; no pnpm/corepack needed at runtime, just
# `node dist/main.js`.
#
# `node:22-bookworm-slim`, not `-alpine`: the final image is
# `python:3.11-slim-bookworm` (Debian, glibc). An Alpine (musl-linked) node
# binary copied into it would fail to start (missing musl libc), and Debian
# `python:3.11-slim-bookworm` already installs g++ below, which pulls in
# libstdc++6 as a dependency — the one shared library `node` needs beyond
# glibc itself.
FROM node:22-bookworm-slim AS agent-build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/package-format/package.json packages/package-format/
COPY packages/observability/package.json packages/observability/
COPY apps/judge-agent/package.json apps/judge-agent/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/package-format packages/package-format
COPY packages/observability packages/observability
COPY apps/judge-agent apps/judge-agent
# `typecheck` is `tsc -b` (composite project references), which emits dist/
# as a side effect of type-checking — the same pattern apps/api and
# apps/judged's Dockerfiles use, not a separate `build` step.
RUN pnpm --filter "@qhhoj/judge-agent..." typecheck

FROM python:3.11-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      g++ libseccomp2 tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /env /env
COPY --from=build /judge /judge
COPY --from=agent-build /usr/local/bin/node /usr/local/bin/node
COPY --from=agent-build /app /app
COPY judge/entrypoint.sh /entrypoint.sh
COPY judge/render-config.mjs /app/render-config.mjs
COPY judge/wait-healthy.mjs /app/wait-healthy.mjs
RUN useradd -m -s /bin/bash judge \
    && mkdir -p /problems /judge-config \
    && chown judge:judge /problems /judge-config \
    && chmod +x /entrypoint.sh
ENV PATH="/env/bin:${PATH}" PYTHONUNBUFFERED=1 LANG=C.UTF-8 PYTHONIOENCODING=utf8
WORKDIR /judge
# Load-bearing, not hygiene: the judge refuses to start as uid 0
# (dmoj/judge.py: "running the judge as root is unsafe, please use an
# unprivileged user instead"). Any Compose `user:` override breaks this.
USER judge
# entrypoint.sh starts judge-agent, waits for its /healthz, then execs the
# judge (dmoj, per Compose's `command:`) — see the script's own comment and
# task-13-brief.md's Controller addendum C2. tini remains the ENTRYPOINT
# proper so it stays pid 1 and reaps both the backgrounded agent and
# whatever `exec "$@"` replaces the script with.
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["dmoj", "--help"]
