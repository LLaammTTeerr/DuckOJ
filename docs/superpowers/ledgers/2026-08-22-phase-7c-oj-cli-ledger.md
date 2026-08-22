# Phase 7c — the `oj` CLI (and 7b parked): ledger

## 7b — statement rendering: PARKED, deliberately

D15's design was port + adapter, adapter only where a `typst` binary
exists. **No binary exists here** (`which typst`, `which pandoc`: both
empty), installing one requires asking (the standing instruction
outranks "don't stop"), and a port with a null adapter and zero
consumers is dead scaffolding — YAGNI. Statements already render fully
via Markdown+KaTeX (`apps/web/src/markdown.ts`).

**Open question for the user:** install typst (or approve an install)
and 7b becomes real; a browser print stylesheet is a cheaper
alternative for onsite-PDF needs.

## 7c — what shipped

- `apps/oj` — `oj login | whoami | problems | languages | submit | watch`,
  built on the generated SDK (`createClient({ token })` existed for
  exactly this). Commands live behind `client`/`io`/`sleep` seams;
  `main.ts` is dispatch only.
- Config at `~/.config/duckoj/config.json`, chmod 600, env overrides
  (`DUCKOJ_URL`/`DUCKOJ_TOKEN`) winning field-by-field.

## Rulings

- **R1 — no argument-parsing dependency.** Six commands, two flags;
  a hand-rolled `flag()` is smaller than any parser's README.
- **R2 — language inference refuses to guess** beyond the `.cpp`
  family: a silent `cpp17` fallback for `.py` would submit Python as
  C++ and produce a baffling CE.
- **R3 — `watch` prints each state once** and stops the poll the
  moment the pipeline is done; the attempt budget makes "the queue is
  stuck" a message, not an infinite loop.

## Mutation evidence (isolated, restored green after each)

| Mutation | Result |
| --- | --- |
| watch never stops on done/errored | 2 fail |
| absent contestKey travels as undefined | 1 fail |
| state printed every poll | 1 fail |
| unknown extension silently cpp17 | 1 fail |

Also: one strictness error in a test caught by `typecheck` before push —
the fifth stale-artifact class has a cousin, "test written against
looser types than the suite compiles with".
