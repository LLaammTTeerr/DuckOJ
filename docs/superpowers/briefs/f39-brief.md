# F-39 — More submission languages, with honest per-language limits

## Why this slot

The judge has run for two weeks with **exactly one language row**: `cpp17`.
A Vietnamese province cannot teach on that. Schools teach Python first and
C++ second; a student who only knows Python currently cannot submit at all.

The infrastructure is already built and unused:

- `languages` (key, name, extension, is_active) — one row today
- `language_driver_keys` (language_id, driver, executor_key) — the table
  whose header comment says it exists so "`CPP17` — judge-server's name —
  does not become our name"
- `apps/judged/.../bridge-server.ts` already resolves our key → executor,
  and back from the executor set a judge announces in its handshake

The live judge image (`podman exec duckoj_judge_1`) already carries
**Python 3.11.16** and **GCC 12.2**. No image rebuild is needed for
python3, cpp20, cpp14 or c17 — this is data plus the code that reads it.

## Scope

### 1. The languages themselves

Seed, via a normal migration (idempotent, safe to re-run):

| key       | name       | extension | DMOJ executor |
|-----------|------------|-----------|---------------|
| `cpp17`   | C++17      | cpp       | `CPP17` (exists — do not duplicate) |
| `cpp20`   | C++20      | cpp       | `CPP20` |
| `cpp14`   | C++14      | cpp       | `CPP14` |
| `c17`     | C17        | c         | `C11` or whatever the judge announces |
| `python3` | Python 3   | py        | `PY3` |

**Verify the executor names against what the live judge actually announces**
rather than trusting this table — the handshake carries the real set, and
`bridge-server.ts` logs or exposes it. A key that maps to an executor no
judge has means submissions in that language queue forever with no judge to
take them. If an executor is missing, leave that language row `is_active =
false` and say so in your report; do not invent a mapping.

### 2. Per-language time and memory multipliers (the load-bearing part)

A problem's limits are authored for C++. A correct Python solution to the
same problem is 10-50× slower. Without a multiplier, adding Python means
**every Python submission TLEs**, which is worse than not offering it.

There is no multiplier concept in the codebase today (`grep multiplier`
finds nothing). Design and build one. The shape is yours to choose, but it
must satisfy:

- The multiplier is **per language**, applied where the job's limits are
  computed, and the applied limit is what the student is shown — a
  scoreboard that says "2.0 s" while the judge enforced 6.0 s is a lie.
- A problem must be able to **override** it, because some problems are
  deliberately not solvable in Python and the setter should be able to say
  so, and some are I/O-bound and need no bonus.
- It must be visible in the API contract, not a hidden server constant.
- Memory gets the same treatment: a Python interpreter's floor is tens of
  megabytes before the solution allocates anything.

Record this as a decision — **use D154** (pre-assigned; do not renumber).
State the default multipliers you chose and why, and state plainly what
goes wrong if they are wrong in each direction.

### 3. The surfaces that must follow

- **Submit page**: the language picker offers every active language. Drafts
  are already per-(problem, language) (D84) — confirm that still holds when
  there is more than one language to switch between, because that code path
  has never actually run.
- **CodeMirror**: the right mode per language. Python in a C++ editor is a
  bad first impression. Load modes from the packages already in
  `apps/web/package.json` if they are there; do not add a heavyweight
  dependency for this.
- **Submission views**: the language name is shown and the source is
  highlighted correctly.
- **Admin**: an operator can see which languages are active and which
  executors are actually available on the connected judges. Read-only is
  fine for this slot; toggling `is_active` from the UI is not required.
- **Problem authoring**: if a problem can restrict languages, that belongs
  in this slot only if it falls out cheaply. If it does not, say so and
  leave it.

## How you work

**The live stack is production.** Six containers are up and healthy.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh`, or
  `scripts/deploy.sh`. Only the controller deploys. You may read the live
  database with `podman exec duckoj_postgres_1 psql -U duckoj -d duckoj -c
  '<SELECT>'`, and you may `podman exec` into the judge to inspect its
  toolchain. **No writes to the live database.**
- **Never** write to `apps/web/dist` — Caddy bind-mounts it. `pnpm build`
  in the web app writes there; if you need a bundle, build to a temp
  outDir, or don't build at all and rely on the dev server.
- **Never** read, print, or commit anything from `.secrets/`.

**Thermal caps** (this host has overheated before, 93 °C, and agents were
killed for it):

- Run every test command under `nice -n 19`.
- Vitest always gets `--no-file-parallelism`. Never run the whole workspace
  suite — run the specs you touched. CI runs the full suite.
- Never run a Testcontainers-backed spec and another suite at the same time.

**Toolchain**: `corepack pnpm` — bare `pnpm` is not on PATH, and neither is
`gh`. Typecheck passing is not lint passing; run both on what you touched.

**Tests**: every test you add must be demonstrated **red** against
deliberately broken code before you accept it. Put the demonstration in
your report — the actual failure output, not a claim that you did it.

**Commits**: work directly in this clone on the current branch. Commit in
coherent units with real messages in the house style (a sentence that says
what changed and why, not `feat: stuff`). **Do not push** — the controller
pushes and deploys. **Never** `git add -A` on a directory; stage the exact
paths you changed, because other work may be in flight in this tree.

**Decisions**: append to `docs/DECISIONS.md`. **D154 is yours** for the
multiplier design. If you need more, take **D155** and **D156**; do not go
past D156 and do not renumber anything that exists.

## Report

Write the full report to `docs/superpowers/briefs/f39-report.md` and return
only: status, the commits you made, one line of real test output (the
actual `N passed` line, never a bare exit code), and anything you could not
finish. If a claim in this brief turns out to be wrong when you check it —
an executor name, a table shape, a code path — say so; the brief is my
best reading, not ground truth.
