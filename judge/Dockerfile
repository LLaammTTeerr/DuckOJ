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

FROM python:3.11-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      g++ libseccomp2 tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /env /env
COPY --from=build /judge /judge
RUN useradd -m -s /bin/bash judge && mkdir -p /problems && chown judge:judge /problems
ENV PATH="/env/bin:${PATH}" PYTHONUNBUFFERED=1 LANG=C.UTF-8 PYTHONIOENCODING=utf8
WORKDIR /judge
# Load-bearing, not hygiene: the judge refuses to start as uid 0
# (dmoj/judge.py: "running the judge as root is unsafe, please use an
# unprivileged user instead"). Any Compose `user:` override breaks this.
USER judge
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["dmoj", "--help"]
