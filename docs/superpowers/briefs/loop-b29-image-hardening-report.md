# B29 — image hardening: the ssh2/cpu-features build flake (2026-08-31)

Status: DONE. Fix is Dockerfile-only, both `apps/api` and `apps/judged`. D124.

## Diagnosis (corrected — the brief's premise was wrong)

The flake is real: the deps-stage `pnpm install --frozen-lockfile` builds the
OPTIONAL native deps `ssh2` + `cpu-features` with `node-gyp`, which has no
Python/compiler in `node:22-alpine` and intermittently dies.

But these are NOT from `apps/mcp`. `@modelcontextprotocol/sdk@1.30.0`'s dep
block in `pnpm-lock.yaml` has NO ssh2. `ssh2`'s sole dependant is
`ssh-remote-port-forward`, whose sole dependant is `testcontainers`, entering via
`@testcontainers/postgresql` — a **devDependency of apps/api, apps/judged AND
packages/db**. The image pulls ssh2 through its own test harness; mcp's manifest
is never even copied into the build. (Full trace in D124.)

## Fix (files: apps/api/Dockerfile, apps/judged/Dockerfile)

1. deps stage install gains `--ignore-scripts` — kills the gyp flake at its
   mechanism; safe because tsc is pure JS and argon2/esbuild ship prebuilt
   platform binaries as optionalDependencies (not script outputs), and covers
   any future native devDep too.
2. build stage, AFTER the compile, `rm -rf` the ssh2 chain
   (`ssh2@* ssh-remote-port-forward@* cpu-features@* @types+ssh2@*
   @types+ssh2-streams@*`) from `node_modules/.pnpm`, so the wholesale
   `COPY --from=build /app /app` runtime carries no ssh2.

Rejected: filter-out-mcp (wrong source), `pnpm deploy --prod` (deletes tsx, a
db devDep the hardcoded migrate command needs), `npm_config_optional=false`
(would drop argon2/esbuild platform binaries → boot break). Lockfile, apps/mcp,
typst stage and the tsx/migrate path all untouched.

## Proof — `podman build` from a clean `git archive HEAD` export, throwaway tags

BEFORE (current HEAD, deps stage): live `ssh2 … install: gyp ERR!` in the log;
`ls node_modules/.pnpm | grep -c ssh2` = **4** (ssh2, cpu-features, ssh-remote, @types).

AFTER (both full images build green):
- `ls node_modules/.pnpm | grep -c ssh2` → **0** (api and judged); cpu-features
  → **0**; no ssh2/cpu-features/ssh-remote dirs remain.
- api: `packages/db/node_modules/.bin/tsx --version` → `tsx v4.23.12` (migrate
  path intact); `import('@node-rs/argon2')` → ok; `typst --version` → 0.15.1.
- Boot with dummy env: api runs full Nest init + route map then would hit DB;
  judged logs `bridge listening :9999`, `starting worker pool`, then
  `redis error ECONNREFUSED` — connection failure, NOT `ERR_MODULE_NOT_FOUND`.

Throwaway images/containers removed. No live `duckoj` stack touched. Runbook
"Deploying" left unchanged: the deploy story is identical, only the build is more robust.
