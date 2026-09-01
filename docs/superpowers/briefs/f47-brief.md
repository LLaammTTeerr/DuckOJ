# F-47 — A language nobody can grade must be loud, not lowercase

## What happened, in full

F-46 shipped Pascal and Java and could not prove them end to end, because that
needed a deploy. The controller deployed and proved them:

```
python3  AC   78 ms  15028 KB
java     AC  104 ms  43364 KB
pascal   TIMED OUT — queued, never graded
```

Pascal sat in `queued`. The judge had self-tested `PAS` successfully at
startup and the mapping table was correct — `pascal → PAS` — yet `judged`
announced its supported languages as:

```
["c11","cpp14","cpp17","cpp20","java","pas","python3"]
```

**`pas`, not `pascal`.** `judged` loads the executor→key mapping **once at
boot**. It had booted before migration 0046 inserted the `pascal` row, so the
lookup missed, and `executorToLanguage` fell back to **lowercasing the
executor name**. `PAS` became `pas`; no language with that key exists; every
Pascal submission was blocked against a judge that could in fact run it.

Restarting `judged` fixed it, and the blocked job graded itself immediately:
`pascal AC 3 ms 204 KB`. Nothing is broken on the live host now. The defect
is that this could happen silently at all.

Two things make it worth a slot rather than a runbook line:

1. **The fallback manufactures a plausible wrong answer.** `PY3 → py3` and
   `PAS → pas` are exactly the shape of a real key, so nothing downstream can
   tell a fallback from a mapping. `language_driver_keys` exists, in its own
   words, "so that `CPP17` — judge-server's name — does not become our name",
   and the fallback is that rule quietly inverted.
2. **The cache has no invalidation.** Adding a language is now a supported
   operation — F-41 gave limits a form, F-46 added two languages — and it
   silently requires a `judged` restart that nothing tells anyone about.

## Scope

### 1. The fallback

Decide what `executorToLanguage` should do when an announced executor has no
row. Options include ignoring that executor (the judge simply does not support
it, which is *true* and safe), or logging loudly and ignoring it. What it must
not do is invent a key. Weigh whether any current caller depends on the
lowercase behaviour before removing it — F-39 replaced a hardcoded closure
with this table and the fallback may be a leftover from that.

Record the ruling as **D172**.

### 2. The cache

Make a language added while `judged` is running reachable without a restart,
or make the requirement impossible to miss. Both are legitimate; argue the one
you pick. A reload on handshake is cheap and natural — a judge reconnects
whenever its executors change, which is exactly when the mapping matters. A
periodic refresh is more code for less precision.

Whatever you choose, the reconciliation that already exists (the
`queue blocked_reason reconciled` line, D68/D160) should end up *correcting*
previously blocked jobs, as it did on the restart. Prove that it does.

### 3. The guard

F-46 noted that nothing enforces "`--only-executors` must stay a superset of
the seeded executor keys, and be identical on every judge service" — it wrote
the rule down and left it unenforced. Enforce it, in the style of the other
source-scan guards in this repo (`route-marker-coverage`,
`team-participation-invariant`, `dockerfile-manifest`). A guard that fails in
CI is what stops the next language addition repeating this.

### 4. The fixtures F-46 could not add

`.pas` and `.java` end-to-end coverage. The submissions that proved this
live — 881 Pascal, 882 Java on `aplusb` — are the shape; make them a fixture
rather than a thing a controller does by hand. Follow D153 naming for
anything you create on the live host, and close what you open.

## How you work

**The live stack is production**, deployed at `f5f5ea6`, CI green, seven
languages live, migrations through 0046, all seven proven grading.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`, and **never restart a container** — the controller did
  that once, deliberately, to recover service; it is not yours to do.
- Live database is **read-only**: `SELECT`/`EXPLAIN`.
- **Never** write to `apps/web/dist`. **Do not run the web build.**
- **Never** read, print or commit anything from `.secrets/`.

**Read `CLAUDE.md`** before you finish — it names the cross-cutting guards
that fail in CI and not locally, and the command for the one that has gone red
twice. Run the **full suite of every package you touch**.

**Thermal**: `nice -n 19` on everything; vitest `--no-file-parallelism`; one
container-backed spec at a time; no load test. **When you finish, leave no
process running** — a Java benchmark loop was left orphaned today and held the
host at 94 °C for fifty minutes.

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D172** is yours; **D173** and **D174** after it. Do not go
past D174, do not renumber.

## Report

Write `docs/superpowers/briefs/f47-report.md`. Return only: status, commits,
the real `N passed` line, and what you could not finish.
