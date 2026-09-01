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

Two CI failures in one day came from the same guard, missed the same way: an
agent ran the specs it touched, and the blast radius was wider than the diff.

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
