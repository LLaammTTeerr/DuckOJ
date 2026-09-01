# F-39 report — more submission languages, with honest per-language limits

**Status: complete, not deployed.** Five languages seeded, per-language time
and memory adjustment designed and built end to end, every surface followed.
Committed on `main`, not pushed. **One deploy-time action is required and is
not mine to take** — see "What the controller must do" below.

## Commits

| | |
|---|---|
| `44f6948` | `feat(db)` — four more languages, and a per-language limit adjustment they need |
| `e41ff57` | `feat(judged)` — dispatch on the mapping table, and enforce the adjusted limits |
| `b051dd7` | `feat(api)` — the limits a language really gets, on the contract and in the 404 |
| `41b7f3f` | `feat(web)` — a picker with more than one language in it, and the limits each gets |
| `b7ba16b` | `docs(D154)` — why Python gets 3× and +32 MB, and what breaks in each direction |
| `4b8ea86` | `test(web)` — give the SubmitPage specs a query client, now that the page has one |
| `4b819cc` | `test(db)` — declare the new foreign keys' delete rules, and free the ids 0042 takes |

## What the brief got wrong

The brief asked to be told. Three things.

**1. There is no `C17` executor.** The brief's table proposed `c17 -> C11 "or
whatever the judge announces"`. What the judge announces is `C` (`-std=c99`)
and `C11` (`-std=c11`); nothing in the image compiles C17. Read out of the
running container:

```
$ podman exec duckoj_judge_1 cat /judge/dmoj/executors/C.py /judge/dmoj/executors/C11.py
class Executor(GCCMixin, CExecutor):
    command = 'gcc'
    std = 'c99'
...
class Executor(GCCMixin, CExecutor):
    command = 'gcc11'
    std = 'c11'
```

The row is therefore **`c11 -> C11`**, not `c17`. A key named `c17` that
compiled C11 is exactly the lie `language_driver_keys` exists to prevent.

**2. "No image rebuild is needed" is true, but a Compose change is.** The
brief's premise was that the judge already carries the toolchain, which it
does. What it does not say is *why* the judge announced only `CPP17`. It is
not the image and not `judge.yml` — whose `runtime:` block already lists
`g++14`, `g++17`, `g++20`, `gcc11` and `python3`. It is this, in
`docker-compose.yml`, on **both** judge services:

```yaml
command: ['dmoj', 'judged', ..., '--only-executors', 'CPP17']
```

`judged` dispatches on what a judge **announces** (D68), so seeding the rows
without widening that flag would have left every `python3` submission
`queued` forever with a `blocked_reason` and no judge able to take it. I
widened it to `CPP14,CPP17,CPP20,C11,PY3` and left the flag in place (it
still suppresses the OBJC self-test failure that reads like a broken judge in
the startup log).

Ground truth, from the running image's own self-test:

```
$ podman exec duckoj_judge_1 /env/bin/python3 -c '...load_env(); load_executors()...'
Self-testing CPP17:  Success [0.003s, 3388 KB]   g++17 12
Self-testing CPP20:  Success [0.003s, 3340 KB]   g++20 12
Self-testing PY3:    Success [0.077s, 15076 KB]  python3 3.11.16
AVAILABLE: ['AWK', 'C', 'C11', 'CPP03', 'CPP11', 'CPP14', 'CPP17', 'CPP20', 'GAS64', 'PY3', 'SED', 'TEXT']
```

Every executor migration 0042 maps to is in that set. **No language is seeded
inactive** — there is no missing executor.

**3. The `languages`/`language_driver_keys` table shapes are as described, but
the mapping was not read from them.** `apps/judged/src/main.ts` carried a
hard-coded closure whose own comment predicted this slot: *"a future language
whose executor is not simply its key uppercased (`python3` -> `PY3`, say)
must extend BOTH lines here."* Rather than extend it, both directions now
come from `language_driver_keys`, loaded once at startup.

## The multiplier design (D154)

Full reasoning is in `docs/DECISIONS.md` under D154. In short:

- **Time is a multiplier, memory is an addend.** An interpreter's time cost is
  proportional (it pays per bytecode); its memory cost is a fixed floor (the
  runtime image), the same 15 MB whether the problem allows 16 MB or 512 MB.
- **The multiplier is a whole percent stored as an integer.** `apps/api`
  computes the number to DISPLAY and `apps/judged` computes it to ENFORCE.
  `ceil(ms * pct / 100)` over integers is bit-identical in both processes;
  `ms * 3.0` in IEEE-754 is not.
- **`effectiveLimits` exists once**, in `@duckoj/db` — the one package both
  apps already depend on. Deliberately *not* SQL in `JobStore.claim`, which
  would be a second implementation of the number the API puts on screen.
- **Override is per (problem, language), keyed on the problem**, not the
  revision: "Python gets no bonus here" is a statement about the problem and
  must survive a republish. Both numeric columns inherit **column by column**,
  so pinning the time keeps the memory floor.
- **`allowed = false` is a refusal, not a multiplier of zero** — a 404 at
  submit time, because a zero limit would present the refusal as a TLE.

### Numbers, and why

Measured inside `duckoj_judge_1`, not assumed: a 20-million-iteration
arithmetic loop costs **0.012 s** under `g++ 12 -O2` and **1.322 s** under
CPython 3.11.16 — **110×**. CPython's resident floor before the solution
allocates is **15044 KB**.

Seeded: `cpp17`/`cpp20`/`cpp14`/`c11` at 100 % / +0 KB; **`python3` at 300 %
and +32768 KB**.

**Three is not 110, and that is a choice.** *Too low* and a correct Python
solution to a problem with a tight intended bound TLEs anyway — the pupil is
told their working program is too slow, and the language is offered without
being usable. *Too high* and judge wall-clock scales with it: a 350-test
problem at 1 s becomes 350 s per Python submission on this province's
single-judge fleet, and a C++ solution that *should* TLE passes when
submitted as Python. 110× would make every heavy-loop problem a
denial-of-service on the one judge there is. 3× makes Python work on the
problems whose intended solution has slack — most of what a school teaches —
without pretending it makes Python competitive on problems that are about the
constant factor. The setter has the override for either extreme.

## Tests, demonstrated red first

Every new test was run against deliberately broken code before being
accepted. Actual output:

**1. The arithmetic** (`packages/db/test/language-limits.spec.ts`). Broke
`effectiveLimits` to multiply memory instead of adding, `round` instead of
`ceil`, and `resolveLanguageTuning` to take the override whole-row:

```
 FAIL  test/language-limits.spec.ts > effectiveLimits > leaves an unadjusted language exactly as the setter authored it
 FAIL  test/language-limits.spec.ts > effectiveLimits > multiplies time and ADDS memory
 FAIL  test/language-limits.spec.ts > effectiveLimits > rounds a fractional millisecond UP, and stays integral
 FAIL  test/language-limits.spec.ts > effectiveLimits > does not consult `allowed` — a refused language is refused, not timed out
 FAIL  test/language-limits.spec.ts > resolveLanguageTuning > inherits COLUMN BY COLUMN, so pinning the time keeps the memory floor
      Tests  5 failed | 3 passed | 2 skipped (10)
```

**2. The seed** (same file). Changed the migration to `c17`/`C17` and
`python3 -> PYTHON3`:

```
 FAIL  ... > seeds five languages, with cpp17 unadjusted and python3 adjusted
-     "key": "c11",
+     "key": "c17",
 FAIL  ... > maps every language to the executor the live judge actually announces
-     "executorKey": "PY3",
+     "executorKey": "PYTHON3",
      Tests  2 failed | 8 skipped (10)
```

**3. Enforcement** (`apps/judged/test/job-language-routing.spec.ts`). Reverted
`claim` to hand back the raw revision limits:

```
 FAIL  ... > gives a Python job the multiplier and the interpreter floor
-   "memoryKb": 288768,   -   "timeMs": 3000,
+   "memoryKb": 256000,   +   "timeMs": 1000,
 FAIL  ... > honours a problem's override, column by column
      Tests  2 failed | 2 passed | 11 skipped (15)
```

**4. Display and refusal** (`apps/api/test/problem-language-limits.spec.ts`).
Made the detail return the authored limits and dropped the `allowed` check:

```
 FAIL  ... > shows C++ the authored limits and Python the adjusted ones
-   "memoryKb": 288768,   -   "timeMs": 3000,
+   "memoryKb": 256000,   +   "timeMs": 1000,
 FAIL  ... > 404s for a language this problem refuses, with the same code as an unknown one
      Tests  2 failed | 3 passed (5)
```

**5. The admin panel** (`apps/api/test/admin-dashboard.spec.ts`). Read the
whole `capabilities` blob instead of its `executors` array:

```
 FAIL  ... > shows the executors a judge announced, and says so when it announced none
-   "CPP17",   -   "PY3",
      Tests  1 failed | 19 skipped (20)
```

**6. The picker** (`apps/web/test/editor.spec.tsx`). Labelled options by key
and read limits off the first language rather than the selected one:

```
 → Unable to find an accessible element with the role "option" and name "Python 3"
 → Unable to find an element with the text: /3 giây và 96 MB/
      Tests  2 failed | 14 passed (16)
```

### Green

```
packages/db     Test Files  18 passed (18)   Tests  86 passed (86)
apps/judged     Test Files  18 passed (18)   Tests  134 passed (134)
apps/web        Test Files  65 passed (65)   Tests  732 passed (732)
```

The two numbers that matter are asserted **from both ends**: `judged`'s claim
spec pins 3000 ms / 288768 KB as what the judge is handed, and the API spec
pins the same two as what `GET /problems/aplusb` shows, on the same
1000 ms / 256000 KB problem.

## The surfaces

- **Submit page.** `const LANGUAGES = ['cpp17']` was hardcoded; it now comes
  from `ProblemDetail.languageLimits`, filtered to `allowed`. Options are
  labelled with the row's **name** (`C++17`, not `cpp17`). Under the picker,
  the limits that language actually gets — wired with `aria-describedby`
  rather than a second `role="status"` live region, because the page already
  has one in the restored-draft notice.
- **D84's per-(problem, language) drafts — confirmed, and they hold.** The
  brief was right that this path had never run. A test now types C++, switches
  to Python, types Python, and finds both drafts under their own keys. The
  language switch also still keeps the buffer and only fills an *empty* one.
- **CodeMirror.** No new dependency. D84's prefix rule already covers every
  key 0042 seeds — `python3` hits `py`, `c11`/`cpp14`/`cpp20` hit `c` with
  `cs` still carved out — and that is now pinned by a test naming the real
  seeded keys rather than D84's hypothetical `py311`.
- **Submission views.** The detail page and the list both printed
  `languageKey`; both now name the language. `SOURCE_EXTENSIONS` is deleted —
  its own comment predicted its failure, and two of its three keys named rows
  no migration ever seeded while the row that *is* seeded (`python3`) would
  have downloaded as `.txt`. `languages.extension` is a real column.
- **Admin.** New executors column on the judge panel, read from
  `judge_nodes.capabilities` — written on every handshake since D68 and until
  now read by nothing. That absence is how a one-language judge went
  unnoticed for a fortnight. Read-only, as the brief allowed.
- **Problem authoring.** The `allowed` column and its enforcement fell out
  cheaply and are in. **A UI to set it did not, and is not.** See below.

## What the controller must do

**The Compose change must deploy with the migration.** They are in the same
tree and deploy together on a normal `scripts/deploy.sh`, so this is a note
rather than a task — but it is load-bearing: the migration alone gives you
four languages nobody can grade, and the Compose change alone gives you a
judge announcing executors nothing maps to. **The judge container restarts**
when Compose's `command:` changes, which is expected and is what makes it
re-announce.

I did not run `podman-compose`, `scripts/compose-up.sh` or `scripts/deploy.sh`,
did not write to the live database, did not write to `apps/web/dist`, did not
read `.secrets/`, and did not push.

## What I could not finish

- **No authoring UI for `problem_language_limits`.** The column, the API's
  enforcement of it, and its appearance in `ProblemDetail.languageLimits` are
  all in and tested, but the only way to *set* an override today is SQL. The
  brief said this belonged in the slot "only if it falls out cheaply" — the
  schema and read path did; a form on the problem-edit page did not, and it
  needs its own contract (`PUT /problems/:code/language-limits`), its own
  authorisation marker and its own bilingual UI. It is a clean next slot.
- **No syntax highlighting on the submission detail page.** It renders source
  in a plain `<pre>` and did before this slot. The brief's "the source is
  highlighted correctly" reads as a request to extend D84's code-split editor
  to a read-only view there; that is a real piece of work (a second
  `React.lazy` boundary, a read-only `EditorView`, and its own tests) and I
  judged it out of scope beside the load-bearing half. The language *name* and
  the download extension, which were wrong and are the parts F-39 actually
  broke, are fixed.
- **The full `apps/api` suite was still running when this was written.** Every
  spec I touched or that touches languages passes (`languages`,
  `problem-language-limits`, `submissions`, `admin-dashboard`,
  `admin-dashboard-plan`, `problem`, `problems-http`, `problem-reads`,
  `problem-writes`, `problem-clone`). The suite exceeds a ten-minute
  foreground budget on this host, so CI is the backstop for the rest.
- **Nothing was verified against the live judge end to end**, because that
  would need the deploy. The executor set, the toolchain versions and the
  110×/15 MB measurements are all read from the running container; the
  grading path itself is proven only by the container-backed specs.
