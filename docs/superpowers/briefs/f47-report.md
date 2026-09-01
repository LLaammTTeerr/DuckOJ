# F-47 report — a language nobody can grade is now loud, and reachable without a restart

**Status: complete, not deployed.** All four scope items done. The fallback
that manufactured `pas` is gone (D172), the mapping reloads while `judged`
runs (D173), F-46's allow-list guard was found to be weaker than its own
comment and replaced (D174), and the Pascal/Java walk F-46 could not run is a
Playwright fixture that passes against the live edge today. Committed on
`main`, **not pushed**. **The judged half cannot be verified against the live
judge without a deploy and a restart, which are the controller's** — the
verification order is at the end.

Nothing was written to the live database, no container was restarted, no
image was built, the web build was never run, and no process of mine was left
running (checked: `pgrep` for chromium, playwright and vitest is empty).

**Two orphans that are not mine, worth an operator's eye**: `vite preview`
processes on ports 4178 and 4179, started 30 Aug 16:34 and 18:03 and still
alive after two days — one of them inside
`.claude/worktrees/agent-a8df150b174b74784`. Idle previews, not a thermal
load, but nothing is going to reap them.

## Commits

| | |
|---|---|
| `d0cf9d6` | `fix(judged)` — D172/D173: an unmapped executor is dropped, and the mapping reloads |
| `42cf48b` | `test(db)` — D174: the allow-list guard finds the judge service that has no flag |
| `030e15f` | `test(e2e)` — the Pascal and Java walk F-46 could not run, and a menu of seven |
| `383a906` | `docs(D172,D173,D174)` — why `pas` was a lie, when the mapping reloads, and what CI now refuses |

## 1. The fallback (D172)

`executorToLanguage` now answers **`undefined`** for an executor no row names,
and every caller drops it. `supportedLanguages()` omits it, `claim` never
takes a job for it, and `judge_nodes.capabilities` records the raw executor —
what the judge said — beside only the languages we can grade with it.

**Ignoring is not silence.** The executors that map to nothing are named
once, at handshake, and again after any reload that changes the answer:

```
{"msg":"judge announces executors no language maps","id":"judge-1","executors":["JAVA","PAS"]}
```

That is the line whose absence made this a silent defect. It is deliberately
**not** emitted from `supportedLanguages()`, which the claim loop calls twice a
second and which would have become a log flood.

**`BridgeOptions.executorToLanguage` is now required.** It was optional with a
lowercasing default, documented as "exactly the inverse of production's
`key.toUpperCase()` mapping" — true until F-39 made production's mapping a
table, after which the default outlived its own justification by seven slots
and was the second copy of the same bug. The argument for requiring it is
verbatim `verifyJudge`'s, three lines below it in the same interface. Thirty
test doubles across six spec files now supply the pair; `multi-judge.spec.ts`
lost its `executor.toLowerCase()` stand-in for a two-row table, since the
suite that most closely models a heterogeneous fleet should not be asserting
against the behaviour that caused this.

**`languageToExecutor` keeps `toUpperCase()`, and the asymmetry is argued in
D172.** An invented *executor* matches no judge, so the job parks with a
`blocked_reason` an operator reads — loud, and D68 already covers it. An
invented *language key* is the silent one. And with the inverse now exact the
fallback is unreachable on the production path: a job is claimed only if its
language is in `supportedLanguages()`, which now contains only mapped keys.

**Callers that depended on the lowercase behaviour, checked before removing
it:** the bridge's own default (removed), `multi-judge.spec.ts` (was supplying
it explicitly; replaced), and nothing else. `apps/api` does not depend on
`@duckoj/judge-protocol` at all.

## 2. The cache (D173) — and where the brief's suggested trigger falls short

The brief proposed a reload on handshake, because "a judge reconnects whenever
its executors change, which is exactly when the mapping matters". **That is
half the truth, and on its own it would not have covered this incident.**

The mapping also matters when the **rows** change, and a row landing involves
no reconnect at all. `FORCE_MIGRATE=1` — D171's own recovery path — applied
0046 against a running `judged` with every judge still connected. Worse,
D171's *sanctioned* deploy order is judge-first, migrate-second, deliberately,
so that no pupil can submit in a language no judge can take: in the blessed
flow every handshake systematically precedes the rows.

**The trigger is the claim loop's empty-claim scan.** `Worker.scanBlocked`
already runs exactly when a claim comes back empty with judges connected,
already at most once per five seconds per loop, never while the fleet is busy
— which is precisely the state a newly-added language is stuck behind. One
indexed read of a seven-row table on that clock.

**Unconditional within the window, never gated on what `markBlocked`
reports.** A job blocked *before* the rows landed already carries the right
reason, so nothing changes and `changed` comes back empty — and that
standing-blocked job is the incident. Gating the refresh on a reconciliation
that finds nothing would have reproduced the bug exactly.

Handshake stays as a cheaper second trigger, fired detached after
`handshake-success` and after the parked dispatches are woken, so it adds
neither latency nor a failure mode to a handshake that already succeeded.

Everything fails open: a reload that rejects keeps the map it has, logs one
line, and never costs a judge its connection. Both directions are swapped
wholesale, so the pair can never be read half-updated (D68). A reload that
changes anything re-announces every connected judge's capabilities, because
`judge_nodes.capabilities` is written at handshake and would otherwise
under-report a judge that gained a language without reconnecting.

**The reconciliation corrects previously blocked jobs, proved.**
`worker-language.spec.ts` drives the loop with a driver whose mapping widens
mid-run and asserts `markBlocked` is called with the **fresher** list:

```
✓ refreshes the mapping on an empty claim, and reconciles against the fresher list
  expect(markBlocked).toHaveBeenCalledWith(['cpp17', 'pascal'])
```

`markBlocked`'s own SQL — that it clears a reason in both directions — is
pinned against a real Postgres in `job-language-routing.spec.ts`, and
`JobStore.claim` clears `blocked_reason` in the same UPDATE that claims. That
is the chain the restart executed by hand on 2026-09-01 (`pascal AC 3 ms
204 KB`).

## 3. The guard (D174) — the brief's premise was stale, and the guard had two holes

**F-46 did not leave the rule unenforced.** It shipped
`packages/db/test/language-limits.spec.ts`'s "names the same allow-list on
every judge service, and it is a superset", demonstrated red. The F-47 brief
says otherwise; it is wrong, and F-46's own report records the red run.

The guard was, however, weaker than its own comment on both counts.

**A guard that matches a flag cannot see the flag's absence.** It regexed the
compose file for `--only-executors` and asserted `toHaveLength(2)`, under a
comment claiming "a third one added without the flag would drop this to a list
that no longer covers every judge". It would not — a third judge service with
no flag leaves exactly two matches and passes, while that judge announces
every executor in the image, `JAVA8` included, which fails its own self-test.
Services are now derived from the compose file's structure; every service
whose command runs `dmoj judged` must carry the flag; they must agree. The
count is no longer asserted, so a province that legitimately runs a third
judge is not failed for it.

**Superset becomes equality.** The unchecked direction is the one D172 just
reshaped: an allow-listed executor no row names is announced by the judge,
dropped by `judged`, and visible in no query. Announce exactly what we can
grade.

Demonstrated red three ways against the real `docker-compose.yml`, restored
after each:

```
→ judge services with no --only-executors: expected [ 'judge-3' ] to deeply equal []
→ allow-lists disagree: CPP14,…,JAVA,JAVA8 | CPP14,…,JAVA: expected 2 to be 1
→ allow-listed executors no language_driver_keys row names: expected [ 'JAVA8' ] to deeply equal []
```

It stays in `packages/db/test` beside the seed it reads: the seeded half needs
a migrated database, and moving it to `apps/api/test` would put a
container-backed check into the 121-file serial API run for no gain.

## 4. The fixtures (`apps/web/e2e/language.spec.ts`)

Two things this file could not have been right about since the F-46 deploy.

**`OFFERED` was five languages against a live menu of seven.** Read off the
live edge: `GET /problems/aplusb` returns `languageLimits` ordered by
`languages.id` (D158 — the order an operator added them in), which is
`['cpp17','cpp20','cpp14','c11','python3','pascal','java']`. Journeys 1 and 4
both read that list, so this suite was red before I started.

**Journey 5 walks a `.pas` and a `.java` submission to a verdict** through the
picker a pupil uses: select the language, check D169's budget on the screen
where it is chosen (Pascal 2 s / 64 MB, Java 3 s / 128 MB — the multiplier
applied to the clone's authored 1000 ms / 65536 KB), read what the page POSTS,
wait for a real verdict from the real judge, and assert D160's waiting notice
is **absent**. Pascal reaching `AC` rather than sitting in `queued` is the
assertion F-47 exists for.

**Green against the deployed edge, not red-by-design.** Unlike
`organiser.spec.ts` journey 2b, this needs no marker: the controller's restart
already recovered the live judge, so Pascal and Java grade today. What it
cannot show green is the F-47 *fix* — the mapping only reloads in a `judged`
that has yet to ship — and the file says so in as many words.

D153: the fixture reuses the existing `fe42-` prefix (already on
`scripts/cleanup-test-data.ts`'s list), the pupil is the fixed `fe42-a1`
account, and the cloned problem is set back to `private` in `afterAll`.
Confirmed closed afterwards — `GET /problems?q=fe42` returns `{"items":[]}`.
The meter wait is before *every* submission, not between them: journey 4
submits as the same pupil and D80 does not care which walk spent the window.

## Tests

Full suite of every package touched, `nice -n 19`,
`--no-file-parallelism`, one container-backed spec at a time.

```
@duckoj/judge-protocol   Test Files   3 passed (3)     Tests   18 passed (18)
@duckoj/judged           Test Files  19 passed (19)    Tests  148 passed (148)
@duckoj/db               Test Files  19 passed (19)    Tests   93 passed (93)
apps/web e2e (live)                                            5 passed (37.0s)
```

Plus the two cross-cutting API guards CLAUDE.md names, run even though
`apps/api` was not touched and no workspace dependency was added:

```
apps/api  dockerfile-manifest.spec.ts + submission-awaiting-judge.spec.ts
          Test Files  2 passed (2)    Tests  6 passed (6)
```

Lint green on `@duckoj/db`, `@duckoj/judged`, `@duckoj/judge-protocol` and
`@duckoj/web`; `pnpm -r typecheck` green. No contract changed, so `openapi.json`
and `packages/sdk` are untouched by design (`git status` clean).

### Demonstrated red first

**1. The fallback** — restored `?? executorKey.toLowerCase()` in
`BridgeServer.toLanguage`:

```
FAIL  language-mapping.spec.ts > drops the unmapped executor instead of lowercasing it into a language
AssertionError: expected [ 'c11', 'cpp14', 'cpp17', …(4) ] to deeply equal [ 'c11', 'cpp14', 'cpp17', …(2) ]
+   "java",
+   "pas",
     Tests  2 failed | 4 passed (6)
```

`+ "pas"` is the production line, reproduced in a unit test.

**2. The reload** — made `refreshLanguages` a no-op:

```
× becomes gradeable through the claim loop’s refresh, with no reconnect
× re-announces capabilities, so the dashboard stops under-reporting the judge
× refreshes on handshake too, for the judge that dials in after a migration
     Tests  3 failed | 3 passed (6)
```

**3. The claim loop's trigger** — dropped the refresh from `scanBlocked`:

```
× refreshes the mapping on an empty claim, and reconciles against the fresher list
AssertionError: expected "spy" to be called at least once
     Tests  1 failed | 7 passed (8)
```

**4. The guard** — the three compose mutations quoted in §3.

## What the controller must do, and in what order

Only **`judged`** needs redeploying. `judge/`, `judge.yml` and
`docker-compose.yml` are untouched, so **the judge container needs no rebuild
and no restart**; migrations are unchanged (still through 0046), so there is
no migrate step and no D171 marker question.

**Deploy:** `scripts/deploy.sh judged`.

Then, in this order:

**1. The boot log must be quiet about executors.**

```
podman logs --since 5m duckoj_judged_1 | head -40
```

Expect `bridge listening` and `starting worker pool`, and **no**
`judge announces executors no language maps` line at all — all seven executors
the judge announces now have rows. If that line *does* appear it names exactly
which executor lacks a row; that is D172 working, not a regression, and D174
should have caught it in CI first.

**2. What the judge is believed to be able to grade.** Read-only:

```sql
select name, capabilities from judge_nodes where name = 'judge-1';
```

The query is validated: this is the row on the live host **right now**, after
the controller's recovery restart, read `-A -t` out of `duckoj_postgres_1` —
so it is also the exact value the deploy must not change.

```
judge-1|{"problems": 1, "executors": ["C11", "CPP14", "CPP17", "CPP20", "JAVA", "PAS", "PY3"],
         "languages": ["c11", "cpp14", "cpp17", "cpp20", "java", "pascal", "python3"],
         "concurrency": 1}
```

`capabilities.languages` must read

```
["c11","cpp14","cpp17","cpp20","java","pascal","python3"]
```

— **`pascal`, and never `pas`**. That is the corrected form of the line that
read `["c11","cpp14","cpp17","cpp20","java","pas","python3"]` on 2026-09-01.
The order follows the judge's announcement order, which this judge happens to
emit alphabetically; if a future judge does not, compare it as a set.

**3. Pascal and Java still grade, from a browser.**

```
corepack pnpm --filter @duckoj/web exec playwright test e2e/language.spec.ts
```

Expect `5 passed`, with journey 5 taking both `pascal` and `java` to `AC`. It
leaves a private `fe42-ngonngu-<ts>` problem behind and nothing else.

**4. The no-restart drill — at the next language addition, not now.** It needs
a row to appear while `judged` runs, which on this host means a migration, so
it belongs to the next language rather than to a synthetic write against
production. When that migration lands with `judged` left running, within about
five seconds of the queue next going idle the log must read, sorted, exactly:

```
{"msg":"language mapping reloaded","supportedLanguages":["c11","cpp14","cpp17","cpp20","java","pascal","python3"]}
```

(with the new key in that list), followed — if a submission was already
blocked on it — by

```
{"msg":"queue blocked_reason reconciled","jobIds":[…],"supportedLanguages":[…]}
```

and the job grading on the next claim, with **no restart**. That is the
sequence the controller performed by hand on 2026-09-01.

## What I could not finish

- **The judged half is unproven against the live judge.** Everything in §1 and
  §2 is proved in unit and integration tests against real sockets and a real
  Postgres; none of it is running on the live host, because that needs a
  deploy and a restart that are not mine. §4 above is the drill.
- **No live no-restart demonstration.** Proving the reload on the real stack
  requires inserting a `languages` row into production, which the brief's
  read-only rule forbids and which I did not do. It is deferred to the next
  language addition, where it costs nothing extra.
- **`judge_nodes.capabilities` is still handshake-plus-reload only.** A judge
  whose *own* executor set changes still has to reconnect for us to notice —
  unchanged from D68, which is correct (judge-server never re-announces
  executors), but worth naming as the remaining staleness in that column.
- **The 2b-style question does not arise.** Journey 5 is green against the
  deployed edge, so nothing here is a red-by-design walk.
