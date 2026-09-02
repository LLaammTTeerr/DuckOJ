## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- Reach for the graph on **cross-document** questions — "what else in this repo is like this?", "where was this decided and why?", "does this pattern appear in another phase?" — which span code, specs and ledgers at once and cannot be grepped. That is what the semantic extraction over every spec and decision ledger bought.
- Use `git grep` for **structural** questions — who calls what, does this symbol exist, which tests assert this. It is faster and exact. The graph's edges are imports/contains/calls, so a BFS from a hub node like `Actor` (69 edges) returns ~300 nodes and answers nothing; measured, on a question grep had already answered in six lines.
- `graphify query "<question>"` for traversal, `graphify path "<A>" "<B>"` for how two things connect, `graphify explain "<concept>"` for one node's neighbourhood.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Before you finish: the guards that fail in CI, not locally

Three CI failures now, all missed the same way: an agent ran the specs it
touched, and the blast radius was wider than the diff.

**`apps/api/test` is this repo's home for repo-wide guards**, and they read
files that belong to no package at all. So the rule is not "run the suite for
the code you changed" — it is **`apps/api` too, whenever you touch `scripts/`,
a `Dockerfile`, or a workspace `package.json`**, no matter which package you
thought you were working in:

```
corepack pnpm --filter @duckoj/api exec vitest run --no-file-parallelism
```

The ones that bite:

- `dockerfile-manifest.spec.ts` — reads every `Dockerfile` (twice red).
- `compose-project-name.spec.ts` — reads every file in `scripts/`, and pins
  the *set* of scripts that resolve a compose project name. F-59 legitimately
  removed two from that set and CI failed, correctly: the pin exists so a
  change in membership is deliberate rather than silent. **Update the pin and
  say why in a comment** — never delete the pin to make it pass.

When one of these does go red, the reason is usually right there in the check
run's annotations, which need no repository admin rights:

```
curl -s https://api.github.com/repos/LLaammTTeerr/DuckOJ/commits/<sha>/check-runs
curl -s https://api.github.com/repos/LLaammTTeerr/DuckOJ/check-runs/<id>/annotations
```

Downloading the job *log* returns 403 without admin, so reach for annotations
first rather than trying to reproduce the whole suite blind.

**If you added a workspace dependency to an app** (a new `@duckoj/*` in an
app's `package.json`, or an import that creates one), the image manifests go
stale and `apps/api/test/dockerfile-manifest.spec.ts` fails in CI while
everything you ran locally passes. Run it:

```
corepack pnpm --filter @duckoj/api exec vitest run test/dockerfile-manifest.spec.ts
```

**More generally:** run the FULL suite of every package you touched, not only
the spec files you edited. Cross-cutting guards live in packages you did not
open — route markers, migration journals, image manifests, CSP hashes.
`corepack pnpm --filter @duckoj/<pkg> test`.

Bare `pnpm` is not on PATH; always `corepack pnpm`. `gh` is not installed —
poll CI with `curl https://api.github.com/repos/LLaammTTeerr/DuckOJ/actions/runs?head_sha=<sha>`.

## A deploy that dies with exit 137 and no output

Check `uptime -s` and `journalctl -b -1 -n 25 --no-pager` **before** blaming OOM
or thermals. On 2026-09-02 a `scripts/deploy.sh api judged` returned 137 silently;
the real cause was a clean `systemd-poweroff` at 16:31 (boot 16:44) — the host was
shut down mid-build. Memory was never tight (14 GB free) and the die was at 51 °C.
Re-running the same deploy afterwards succeeded unchanged.

Symptoms that point at a reboot rather than a kill: every container reports the
same short uptime including postgres, and `tailscaled`/`redis-server` etimes match it.
