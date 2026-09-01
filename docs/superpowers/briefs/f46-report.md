# F-46 report — Pascal and Java, because a province teaches them

**Status: complete, not deployed.** The toolchain is in `judge/Dockerfile`,
`judge/judge.yml`'s `runtime:` block is regenerated from the image's own
`dmoj-autoconf -V`, `--only-executors` is widened on both judge services,
migration 0046 seeds two rows with limits measured on this image, and every
surface from the picker to the CLI follows. Committed on `main`, not pushed.
**The controller must build and deploy the judge image** — see the
verification order at the end.

## Commits

| | |
|---|---|
| `d0be262` | `feat(judge)` — a toolchain for Pascal and Java, and the allow-list that lets them out |
| `0a8a77c` | `feat(db)` — seed Pascal and Java with limits measured on this image (0046, D169) |
| `fc15d77` | `feat(web,oj)` — a Pascal starter with no grammar, and a CLI that infers the new keys |
| `fe0e101` | `docs(D169,D170)` — why Pascal gets 200 % and Java 300 % + 64 MB, and what Java inverts |

## The executor names, as the image actually reports them

Built to the throwaway tag `localhost/duckoj-judge:f46-probe` (one build,
`nice -n 19`, no container recreated, nothing tagged `:latest`), then run with
`podman run --rm --entrypoint`. The live `duckoj_judge_1` was only ever read
from.

```
Auto-configuring JAVA:   Using /usr/lib/jvm/java-17-openjdk-amd64/bin/java (client VM)
                           javac 17.0.20.1
Auto-configuring JAVA8:  Could not find JVM
Auto-configuring PAS:    Using /usr/bin/fpc
                           fpc 3.2.2

Self-testing JAVA:   Success [0.054s, 39900 KB]  javac 17.0.20.1
Self-testing PAS:    Success [0.002s,   196 KB]  fpc 3.2.2

AVAILABLE: ['AWK', 'C', 'C11', 'CPP03', 'CPP11', 'CPP14', 'CPP17', 'CPP20',
            'GAS64', 'JAVA', 'NODEJS', 'PAS', 'PY3', 'SED', 'TEXT']
```

Three things worth naming, all found by checking rather than by expecting:

1. **Free Pascal is `PAS`, not `PASCAL`.** The row is `pascal -> PAS`.
2. **`JAVA8` exists in the image and cannot be used.** Its own autoconf
   answers `Could not find JVM` — its `jvm_regex` wants a `java-8` tree and
   bookworm's JDK is 17. It is deliberately absent from `--only-executors`;
   announcing it would be announcing an executor that fails its own self-test.
3. **`NODEJS` self-tests green and is not offered.** `dmoj-autoconf` finds
   `node: /usr/local/bin/node` because judge-agent's own runtime is on PATH.
   The generated `runtime:` block keeps it verbatim (editing a generated block
   by hand is how the `KeyError` the file warns about gets introduced) and the
   allow-list — which is what the judge announces — leaves it out.

The allow-list on **both** judge services is now
`CPP14,CPP17,CPP20,C11,PY3,PAS,JAVA`.

## Image size

| | |
|---|---|
| `localhost/duckoj_judge:latest` (live) | **787 MB** |
| `localhost/duckoj-judge:f46-probe` | **1.14 GB** |
| delta | **+353 MB** |

Per package, `Installed-Size` from `dpkg-query` inside the probe:

| package | installed |
|---|---|
| `openjdk-17-jre-headless` | 184 MB |
| `openjdk-17-jdk-headless` | 75 MB |
| `fp-units-rtl-3.2.2` | 51 MB |
| `fp-compiler-3.2.2` | 10 MB |

So **Java costs ~259 MB and Pascal ~61 MB**, plus shared dependencies. Both
are installed `--no-install-recommends`, which is load-bearing rather than
hygiene: `fp-compiler` recommends `fp-docs`/`fp-ide` and
`openjdk-17-jdk-headless` recommends the non-headless JDK with X11 behind it.
A province that wants only Pascal can drop `openjdk-17-jdk-headless` from the
Dockerfile and `JAVA` from the allow-list and get most of that back.

`openjdk-17-jdk-headless` is pinned to a major version rather than
`default-jdk-headless`: a floating default silently moves the JVM under
`judge.yml`'s generated paths the next time the base image moves.

## The measurements behind each multiplier

Every number is `TracedPopen.execution_time` / `max_memory` — the same
instruments a verdict is reported with — for the same program written four
ways and compiled by this judge's own executors, in the probe image. Three
runs each; spread under 5 %.

| workload | C++17 | Pascal | Java | Python 3 |
|---|---|---|---|---|
| empty program | 0.002 s / 1.3 MB | **0.002 s / 0.20 MB** | **0.055 s / 39.9 MB** | 0.078 s / 14.8 MB |
| 2e7 modular-arithmetic loop | 0.049 s | 0.067 s (**1.37x**) | 0.112 s | 1.97 s |
| sieve to 1e7 | 0.022 s | 0.023 s (**1.05x**) | 0.088 s | — |
| read 1e6 integers | 0.043 s | 0.046 s (**1.07x**) | 0.079 s | — |
| sort 2e6 elements | 0.148 s | 0.158 s (**1.07x**) | 0.73 s (boxed `Integer`) | — |
| read 5e5 lines | 0.021 s | 0.058 s (**2.7x**) | 0.110 s | — |

### Pascal — 200 %, +0 KB

Native code behaves like native code: 1.05x on the sieve, 1.07x on integer
input and on sorting, 1.37x on the tight modular loop. **200 % dominates all
of those with margin** and costs the fleet at most 2x the authored limit on a
language that is otherwise as fast as C++ — nothing like Python's exposure. It
does **not** cover line-oriented string input at 2.7x, where the C++ baseline
is 21 ms and no realistic problem sets a limit that tight; the per-problem
override is there for the problem that does.

**The addend is zero, and that is a measurement, not an omission.** Pascal's
resident floor is 196-204 KB — an order of magnitude *below* C++'s 1.3 MB, and
below it on every workload (9968 KB vs 13352 KB on the sieve; 31452 KB vs
34784 KB holding the same 31250 KB array). A token addend would be inventing a
cost that does not exist.

### Java — 300 %, +65536 KB, and it inverts D154 in both columns

D154 generalised from an interpreter: *time is proportional, memory is a fixed
floor.* Java is neither, and the schema therefore offers the wrong instrument
in both columns.

**Time is a FIXED toll.** An empty `main` costs **0.055 s** of judged CPU, at
every heap size from 4 MB to 256 MB, and nothing in judge-server subtracts it.
Beyond that toll Java's *marginal* cost is ordinary — 1.2x C++ on the
arithmetic loop, 1.5x on the sieve, **0.56x** on integer input
(`StreamTokenizer` beats `scanf`), 2.5x on lines, and 5.2x only on the
boxed-`Integer` `ArrayList` a beginner reaches for first. With no time addend
in the schema, the multiplier has to pay a fixed cost, and what it can pay
depends on the authored limit: **at 300 % a 1000 ms problem grants 3000 ms,
which is the 55 ms toll plus a 2.9x marginal factor.** Every revision in the
live database is authored at 1000 ms or 2000 ms (70 of 70), so 300 % is honest
for all of them. Below roughly 110 ms of authored limit no multiplier can
cover the toll at all, and the setter needs the override.

**Memory is PROPORTIONAL, which is what an addend cannot express.**
`JavaExecutor.launch` swaps the memory limit out of the tracer (`memory=0`, so
RSS is never enforced) and passes it as **`-Xmx<limit>K`**. The limit becomes
the *heap cap*; the JVM's ~40 MB of non-heap RSS is never charged; MLE arrives
as `OutOfMemoryError`, not as a tracer kill. Measured — smallest surviving
`-Xmx` for a live `int[N]`:

| live data | smallest surviving Xmx | ratio |
|---|---|---|
| 3906 KB | 6144 KB | 1.57 |
| 7812 KB | 12288 KB | 1.57 |
| 15625 KB | 24576 KB | 1.57 |
| 31250 KB | 49152 KB | 1.57 |
| 62500 KB | 98304 KB | 1.57 |

Constant to two decimals across a sixteen-fold range, **with no fixed
component**: it is SerialGC's generational geometry (a single live array must
fit the old generation, ~2/3 of the heap), not a floor. So the addend is sized
against the limits this deployment actually authors — read-only from the live
database, `problem_revisions` grouped by limit:

```
 time_ms | memory_kb | count
    1000 |     65536 |    51
    2000 |    131072 |    13
    2000 |    262144 |     5
    1000 |    262144 |     1
```

**+64 MB** makes the modal 64 MB problem grant 128 MB, i.e. enough heap for
81 MB of live data — *more than the C++ budget itself*, so on 51 of 70
revisions Java can hold everything C++ can. On the 128 MB problems it covers
98 % of the budget and on the 256 MB ones 79 %; the override covers the rest.
This narrows D159 by one clause and D169 says so: the addend means "a fixed
memory cost this runtime imposes", and for a runtime that *replaces* the limit
with a heap cap, the fixed cost it must buy is generational headroom.

**Two things an operator should not read as bugs.** A Java submission reports
~40 MB of memory on a 64 MB problem even when it allocates nothing, because
the reported number is RSS and the enforced number is the heap cap; and
nothing in `apps/judged` re-derives a verdict from reported memory (checked —
`worker.ts`/`event-writer.ts` record it and the flags come from judge-server),
so a report above the limit never becomes an MLE by itself.

## Tests, demonstrated red first

**1. The seed** (`packages/db/test/language-limits.spec.ts`). Run against the
old assertions with 0046 in place, before the spec was updated:

```
 FAIL  test/language-limits.spec.ts > seeds five languages, with cpp17 unadjusted and python3 adjusted
 FAIL  test/language-limits.spec.ts > maps every language to the executor the live judge actually announces
+     "executorKey": "JAVA",  +     "key": "java",
+     "executorKey": "PAS",   +     "key": "pascal",
      Tests  2 failed | 7 passed (9)
```

**2. The allow-list guard** (new, same file). Reverted `--only-executors` in
`docker-compose.yml` to F-39's five and re-ran:

```
 FAIL  ... > names the same allow-list on every judge service, and it is a superset
 ❯ test/language-limits.spec.ts:411:22
     expect(list).toEqual(expect.arrayContaining(seeded));
      Tests  1 failed | 10 skipped (11)
```

**3. Enforcement** (`apps/judged/test/job-language-routing.spec.ts`). Changed
0046 to seed Pascal at 100 % and Java at +32768 KB:

```
 FAIL  ... > gives Pascal its 200 % and no addend, and Java its 300 % and heap headroom
-   "timeMs": 2000,
+   "timeMs": 1000,
      Tests  1 failed | 15 skipped (16)
```

**4. Display** (`apps/api/test/*`). The three catalogue-enumerating specs went
red on the migration by themselves, before being extended:

```
 FAIL  test/languages.spec.ts > is reachable with no credentials at all, and answers the seeded catalogue
 FAIL  test/languages.spec.ts > lists an inactive language, flagged rather than hidden
 FAIL  test/problem-language-limit-settings.spec.ts > hands back the INPUTS — inherit as null, beside the default it inherits
 FAIL  test/problem-language-limits.spec.ts > shows C++ the authored limits and Python the adjusted ones
      Test Files  3 failed | 142 passed (145)
      Tests  4 failed | 1236 passed (1240)
```

Java's two numbers are now pinned **from both ends**, as D154 requires:
`judged`'s claim spec asserts the judge is handed 3000 ms / 321536 KB, and the
API spec asserts the same pair is what `GET /problems/aplusb` shows, on the
same 1000 ms / 256000 KB problem.

### Green

```
apps/api           Test Files  145 passed (145)   Tests  1240 passed (1240)
apps/web           Test Files  71 passed (71)     Tests  764 passed (764)
apps/judged        Test Files  18 passed (18)     Tests  138 passed (138)
packages/db        Test Files  18 passed (18)     Tests  87 passed (87)
apps/mcp           Test Files  8 passed (8)       Tests  90 passed (90)
apps/oj            Test Files  3 passed (3)       Tests  36 passed (36)
apps/judge-agent   Test Files  1 passed (1)       Tests  8 passed (8)
packages/contracts Test Files  9 passed (9)       Tests  39 passed (39)
packages/contest-formats  Test Files 5 passed (5) Tests  125 passed (125)
packages/prepare   Test Files  5 passed (5)       Tests  62 passed (62)
packages/package-format   Test Files 6 passed (6) Tests  54 passed (54)
packages/similarity Test Files 3 passed (3)       Tests  43 passed (43)
packages/glicko2   Test Files  3 passed (3)       Tests  41 passed (41)
packages/polygon-import   Test Files 2 passed (2) Tests  19 passed (19)
packages/judge-protocol   Test Files 3 passed (3) Tests  18 passed (18)
packages/statement-samples Test Files 1 passed (1) Tests 12 passed (12)
packages/language-limits  Test Files 1 passed (1) Tests  11 passed (11)
packages/observability    Test Files 1 passed (1) Tests   4 passed (4)
packages/sdk       Test Files  1 passed (1)       Tests  2 passed (2)
packages/api-prefix / realtime  1 passed each
```

`pnpm -r typecheck`, `pnpm -r lint`, `typecheck:scripts`, `lint:scripts` and
`verify:csp` all clean. `openapi.json` and `packages/sdk/src/generated.ts`
regenerate with **no diff** — nothing about this slot is on the wire; two more
rows in an existing collection is data.

## The rest of the path — what extended, and what F-39 had hardcoded

**Extended for free, as the brief expected.** The picker, the per-language
limit statement beside it, D84's per-(problem, language) drafts, the
submission list and detail's language *name*, the download extension
(`languages.extension` — `pas` and `java`), the admin panel's executors
column, and the D159 override form, whose "inherit: 300 %" placeholder is read
from `languages` and so shows D169's numbers with no code knowing them.

**Two places did not, and both are F-39 hardcodes.**

1. **The editor had no Pascal mode.** `modeForLanguage` answers two questions
   at once — grammar and starter — and every mode answered both or neither, so
   `pascal` fell to `plain` and got an empty editor. It is now a mode with a
   template and no grammar (**D170**). There is no Lezer Pascal parser in the
   `@codemirror/lang-*` family; `@codemirror/legacy-modes` has one and was
   **declined** rather than put a new runtime dependency and a new bundle
   chunk on the submit page for colour in one language, in a slot that may not
   run the web build to measure the cost. **Pascal source is not
   syntax-highlighted**, and that is the one visible gap.
   The starter's first line is `{$mode objfpc}{$H+}`, measured rather than
   styled: without it FPC's `string` is a 255-character ShortString and a
   longer `readln` truncates in silence — which is how this slot's own Pascal
   string benchmark first hung at the 60 s limit.
2. **`oj`'s extension map still held three C++ spellings.** `oj submit main.py`
   answered "cannot infer a language" for a language the judge had been
   running for a fortnight. Every extension exactly one seeded row claims now
   infers it (`.c`, `.py`, `.pas`, `.java`); `.cpp`/`.cc`/`.cxx` stay ambiguous
   between three C++ rows and keep the `cpp17` default.

**One comment was false and is corrected.** The Java starter claimed the class
name `Main` was "a hard requirement of the java driver". It is not:
judge-server's `java_executor.find_class` derives the class name from the
source and names the file after it, so any single `public class` compiles.
What the driver *does* reject is a `package` declaration and a non-public main
class.

**No new UI strings**, so D18 needs nothing: language names come from
`languages.name` and the limits beside the picker were already bilingual.

**New guard.** `--only-executors` must stay a superset of the seeded executor
keys and must be identical on every judge service. F-39 wrote that rule down
and nothing enforced it; `packages/db/test/language-limits.spec.ts` now reads
the real `docker-compose.yml` against a real migrated database, so a future
migration that seeds a language nobody widened the flag for fails in CI rather
than as D68's `blocked_reason` in production.

## What the controller must verify after deploying, in this order

The image, the Compose change and the migration deploy together on a normal
`scripts/deploy.sh`; the judge container restarts because its `command:`
changed, which is what makes it re-announce.

1. **The image built the toolchain in.**
   `podman run --rm --entrypoint bash localhost/duckoj_judge:latest -c 'fpc -iV; javac -version'`
   → `3.2.2` and `javac 17.x`. If this fails, stop: nothing below can pass.
2. **The migration ran.** `select key, time_multiplier_pct, memory_extra_kb
   from languages order by id` → seven rows, ending `pascal 200 0` and
   `java 300 65536`; `select count(*) from language_driver_keys where driver =
   'dmoj'` → 7. Migration 0046 must appear in `drizzle.__drizzle_migrations`
   (D133's guard throws if it does not).
3. **The judge announced them.** The admin dashboard's judge panel executors
   column, or `select capabilities from judge_nodes` → must contain `PAS` and
   `JAVA`. **This is the step that fails if the image did not rebuild**, and it
   fails silently in the sense that everything else looks healthy: an online,
   idle judge beside a queue it has no executor for is exactly the state that
   went unnoticed for a fortnight before F-39.
4. **The startup log is clean.** `podman logs duckoj_judge_1 | grep
   Self-testing` → `PAS` and `JAVA` both `Success`, no `OBJC` traceback (the
   allow-list still suppresses it), no `KeyError` (that would mean a stale
   `runtime:` path).
5. **A real submission each, end to end.** One Pascal and one Java solution to
   `aplusb` from the web submit box — the picker must offer both, and both
   must reach `AC`. The limits printed under the picker are
   `ceil(time_ms x pct / 100)` and `memory_kb + extra_kb` off the problem's
   own authored row, so check them against that row rather than against a
   number in this report: **live `aplusb` is authored 1000 ms / 65536 KB**, so
   it must read **2 s / 64 MB for Pascal** and **3 s / 128 MB for Java** (and
   3 s / 96 MB for Python, unchanged). A problem authored 2000 ms / 262144 KB
   would read 4 s / 256 MB and 6 s / 320 MB instead. Nothing before this step
   proves the grading path; everything before it is proven by
   container-backed specs.
6. **Then, only if 1-5 pass**, the throwaway probe image can go:
   `podman rmi localhost/duckoj-judge:f46-probe` (1.14 GB).

## What I could not finish

- **Nothing was graded end to end.** The toolchain, the executor names, the
  timings and the heap measurements are all read out of the probe image; the
  grading path itself is proven only by container-backed specs, because
  proving it needs the deploy and a container restart, which are not mine.
- **Pascal source is not syntax-highlighted** (D170). It gets a correct
  starter and a plain-text editor. Adding `@codemirror/legacy-modes` is a
  one-import change behind the editor's existing `React.lazy` boundary
  whenever a province asks for it.
- **The 5.2x boxed-`Integer` case is not covered by Java's 300 %.** A pupil
  who builds an `ArrayList<Integer>` of two million elements will TLE where
  the same program with `int[]` passes. That is a real teaching cost and it is
  deliberate: covering it would need ~600 %, which is judge wall clock this
  province's single judge does not have. The per-problem override is the
  escape.
- **No `.pas`/`.java` fixtures in the e2e suite.** `apps/web/e2e/language.spec.ts`
  still exercises C++ and Python only; extending it needs a running stack with
  the new image.
