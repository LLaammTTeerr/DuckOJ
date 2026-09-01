# F-42 report — browser coverage for the organiser routes and the language path

**Status: complete.** Two new Playwright suites in the existing harness, one
residual closed, **one new defect found by a walk against the live stack** and
fixed. Seven commits on `main` in this clone, **not pushed, not deployed**.
**D161 is unused** — neither fix changes a stated behaviour, so neither spends
a decision (B-30's precedent for its defect 3).

`podman-compose`, `scripts/compose-up.sh` and `scripts/deploy.sh` were never
run. **`apps/web/dist` was never written and no `vite build` was run** —
Playwright drove the deployed bundle at the live edge, which is the point.
`.secrets/duckadmin.txt` was parsed by block for the admin username and
password (the existing `e2e/credentials.ts` path). **The password never
reached any output**, and nothing from the file was committed; the admin
*username* — `duckadmin`, which D153's own text already names — appeared once,
in a login-status line of a throwaway probe script. Live rows **were** created — see "Live
artefacts".

---

## Commits

| | |
| --- | --- |
| `cd827d4` | `fix(submit)` — the draft survives the mount that corrects an unofferable default |
| `04cd042` | `fix(teams)` — a roster saved in the form appears on the panel that saved it |
| `e11dc3a` | `test(e2e)` — browser walks for the organiser routes and the whole language path |
| `27f77fc` | `test(e2e)` — leave less of these walks behind on a production list |
| `b39d4bb` | `docs(f42)` — this report |
| `14ecde5` | `test(e2e)` — make the monitor's three counters pairwise different |
| *(HEAD)* | `docs(f42)` — the corrections that follow from `14ecde5` |

`docs/PROVINCE-READINESS.md` gap 4 was rewritten in `e11dc3a`: the coverage
half is closed, and what remains is that the two fixes above are **not
deployed**.

---

## The runs, verbatim

**The two new suites, against the live stack at `localhost:8080`, one worker**
(the config pins `workers: 1`; every command under `nice -n 19`):

```
Running 7 tests using 1 worker
  ✓  1 language.spec.ts:186 › journey 1 — the picker offers five languages and preselects C++17, by link and from the statement (2.2s)
  ✓  2 language.spec.ts:261 › journey 2 — switching language and back gives the pupil their own program again (1.2s)
  ✓  3 language.spec.ts:299 › journey 3 — a setter writes a language override, and clearing a box stores inherit (2.2s)
  ✓  4 language.spec.ts:389 › journey 4 — a refused language is off the menu, and the page does not post it (4.5s)
  ✓  5 organiser.spec.ts:213 › journey 1 — the monitor’s numbers are the API’s numbers, and the feed is live (56.0s)
  ✓  6 organiser.spec.ts:378 › journey 2 — a teacher assembles a team in the form, and the one-seat rule names the pupil (3.1s)
  ✘  7 organiser.spec.ts:565 › journey 2b — the panel shows the added pupil with no reload (red until the fix ships) (16.2s)
  1 failed
  6 passed (1.4m)
```

**The one failure is deliberate and is the defect below.** Journey 2b is the
browser demonstration of the stale-roster bug; it is red against the deployed
bundle (`908a6b8`) because the fix is a local commit, and it goes green the
moment the edge carries `04cd042`. It is its own `test()` precisely so that it
blocks nothing — journey 2, the one-seat walk the brief asked for, runs and
passes beside it.

**Similarity** — `features.spec.ts` feature 10 already covers it (see "What
the readiness gap actually said"), so it was **re-run rather than rewritten**.
Features 9 and 10 cannot be run as a subset (feature 9 needs the two
competitors features 4 and 5 register, and a subset run puts its submits
inside D80's ten-second meter), so the whole file was run:

```
Running 11 tests using 1 worker
  ✓   9 features.spec.ts:860 › feature 9 — once a contest is over its organiser can export the results and the certificates (2.0m)
  ✓  10 features.spec.ts:980 › feature 10 — the similarity check finds the identical pair and shows them side by side (1.6s)
  11 passed (2.6m)
```

**Vitest, `apps/web`, whole package, `--no-file-parallelism`:**

```
Test Files  68 passed (68)
     Tests  754 passed (754)
```

`tsc --noEmit` clean on `@duckoj/web`; `eslint src test e2e` clean. Nothing in
`packages/` or `apps/api` was touched, so nothing there was re-run and
`openapi.json` / `packages/sdk` cannot have moved.

---

## What the readiness gap actually said, and what was true

`docs/PROVINCE-READINESS.md` position 4 read:

> The new organiser routes — similarity, live monitor, teams — have no
> Playwright coverage; the web tests mock the SDK.

**That was half stale.** Checked before writing anything:

* **similarity** has had a full browser walk since B-14 —
  `features.spec.ts` feature 10 runs the check on a contest with two identical
  submissions, finds the pair, follows "So sánh" to the side-by-side route and
  asserts `mark.match` is really painted. Re-run green above; not rewritten.
* **the live monitor** is opened by `contest-day.spec.ts` journey 2, and
  **teams** appear on its scoreboard and in `a11y-surfaces.spec.ts`.

What was genuinely missing is narrower and sharper, and it is what this slot
built:

* the monitor's numbers were **never compared with anything**. Journey 2
  asserts that two headings, a room-count tile and an `AC` badge are on
  screen — every one of which survives a panel wired to the wrong contest, a
  `solvers` column reading `accepted`, or a feed that stopped refreshing an
  hour ago.
* **no team was ever assembled through the form.** Journey 2 seeds its rosters
  over the API, so `TeamForm` — the only surface a provincial teacher has —
  had never been driven at all, which is why the defect below survived.
* the **language path had no browser coverage whatsoever** across F-39, F-40
  and F-41, including F-41's limits form, which was deployed and had never
  been opened in a browser.

---

## Defect found by a walk — the teams panel shows the roster it just replaced

**Severity: medium-high (silent data loss).** Found by
`e2e/organiser.spec.ts` journey 2 on its first run against the live stack;
fixed in `04cd042`; **not deployed**.

### What is wrong

A teacher adds a second pupil to a team, presses Lưu, the form closes with no
error, the server really has both — and the panel goes on showing one name.
Read off the live stack at the moment the walk failed:

```
GET /api/v1/orgs/fe42-truong/teams/fe42-alpha-1788250878251
  -> {"slug":"...","members":["fe42-a1","fe42-a2"]}
GET /api/v1/orgs/fe42-truong/teams
  -> [{"slug":"...","memberCount":2}]
screen: row "FE42 Alpha … fe42-alpha-… fe42-a1 Sửa Giải thể"
```

The count says two. The names say one.

`OrgTeams.refresh()` invalidated `['org-teams', slug]` — the **summary** list,
which carries a member count and no names. The names on each row come from
`TeamMembers`' own query under `['org-team', slug, teamSlug]`, and TanStack
Query matches invalidations by key **prefix**: `'org-teams'` and `'org-team'`
are different first elements, so that query was never invalidated by anything
at all.

### The half that is worse, and is not visible from the panel

The same cache entry backs the **edit form's prefill**, and `members`
**replaces the whole roster** — the case `TeamForm`'s own comment calls the
dangerous one ("the empty box the reader is shown is a saved change, and the
save that looks like a no-op is the one that empties the team"). So a teacher
who re-opens the form to add a third pupil is prefilled with the roster as it
was **before** their last save, and saving drops the pupil they had just
added. Silently: no failed request anywhere, and the member count then agrees
with the wrong answer.

On contest day that is a pupil who is on the roster the teacher typed and not
on the roster that competes.

### Reproduction, red first

`apps/web/test/teams-roster-refresh.spec.tsx`, two tests driven through the
panel rather than asserted on a query key — the bug is not that a key was
missing, it is that the screen lied. Red against `04cd042`'s parent:

```
 ❯ test/teams-roster-refresh.spec.tsx (2 tests | 2 failed)
   × ... > shows the pupil who was just added, without a reload
   × ... > does not prefill the next edit with the roster it replaced
     → Unable to find role="link" and name "binh"
```

and in the browser, `organiser.spec.ts` journey 2b, still red on the live edge
(quoted above).

### Fix

Both keys are invalidated. `['org-team', slug]` is a prefix, so it reaches
every team on the panel — a roster edit can move another row's membership
(D104 reseats), and re-reading them costs one request per team already on
screen. Green:

```
 ✓ test/teams-roster-refresh.spec.tsx (2 tests)
 ✓ test/teams-read-errors.spec.tsx (5 tests)
 ✓ test/team-page.spec.tsx (5 tests)
 ✓ test/contest-teams.spec.tsx (10 tests)
 Test Files  4 passed (4)   Tests  22 passed (22)
```

No decision spent: this restores the behaviour the panel was written for.

---

## Residual closed — the draft dies on the mount that corrects the default

B-30 recorded it, F-41 left it open, the brief asked for it. Fixed in
`cd827d4`, **not deployed**.

D158 derives the picker's language from what the server offers, so on a
problem whose `allowed = false` kills the fallback language the key flips at
**mount** — the catalogue answers a tick after the first render — without ever
passing through `changeLanguage`, which is where B-30 put the per-language
draft restore. The opening buffer was decided once, in a `useRef`, against the
fallback language.

So the pupil lands on the one language the problem still accepts, is shown a
C++ starter template they never asked for, and their half-written Python
program is both invisible and one keystroke from being overwritten.

Red first, in `apps/web/test/submit-language-default.spec.tsx` (the file that
documents this mount path), through the real `SubmitPage` query so the
correction happens the way it happens in a browser:

```
 FAIL  ... > gives back the draft waiting in the language it corrected TO
 FAIL  ... > does not file the carried-over buffer over that draft
AssertionError: expected '#include <bits/stdc++.h>\nusing names…' to contain 'print(41)'
- print(41)
+ #include <bits/stdc++.h>
+ using namespace std;
...
      Tests  2 failed | 2 passed (4)
```

The second is the data loss, verbatim: the C++ starter template filed under
the **Python** key, on top of the program the pupil came back for.

The fix applies exactly `changeLanguage`'s rule, because it is the same event
seen from the other side — a pending write is flushed under the key it was
*scheduled* with, a stored draft in the language moved TO wins, and an
untouched starter template (the only buffer the pupil did not write) is
replaced by the real language's. `changeLanguage` claims the ref itself so an
explicit switch is not handled twice. Green:

```
 ✓ test/editor.spec.tsx (18 tests)
 ✓ test/submit.spec.tsx (15 tests)
 ✓ test/submit-language-default.spec.tsx (4 tests)
 Test Files  3 passed (3)   Tests  37 passed (37)
```

**This is deliberately NOT asserted in the browser suites.** The deployed
bundle predates it, so a live assertion would be red for a known cause and
would say nothing. The browser walks assert only what `908a6b8` can honestly
do.

No decision spent: it restores D84's stated behaviour.

---

## What each walk asserts

### `apps/web/e2e/organiser.spec.ts`

**Journey 1 — the live monitor.** Two entrants and four graded attempts on a
`fe42-` round: WA, AC, AC from the first, one AC from the second. That shape
is chosen so `submitted`, `accepted` and `solvers` are **pairwise different**
— 4, 3 and 2 — because each cheaper shape leaves a miswiring invisible: a room
where everybody was right first time makes `submitted = accepted`, and one AC
each makes `accepted = solvers`, which is the column-crossing this panel is
most likely to get wrong (D100 keeps `solvers` in a SET, on its own table,
precisely because it cannot be derived from the other two). The **second AC
from the same person** is what separates them. With nothing in flight,
`GET /contests/{key}/monitor` is read **once** through the signed-in page, and
the screen is asserted to be that answer: the four `.num` cells in the
header's declared order, the accept bar's own `aria-label` ("3 trên 4 lượt nộp
được chấp nhận"), and the two tiles. Then a **fourth
attempt is made over the API while the page is open** and has to reach the
feed and move the counter **with no navigation** — the WebSocket's
`contest-activity` frame, or the five-second poll behind it. A screen that
needs an F5 fails here.

**D100 is respected by omission.** Per-problem `pending` is a maintained
counter (`contest_problem_stats`); queue depth is a live fleet-wide count.
They are allowed to disagree, so **nothing in the file ties one to the
other** — the assertion is "each number equals the number the API served for
it", which a wrong wiring breaks and an honest disagreement does not. A
comment says so at both ends.

**Journey 2 — teams, and the one-seat rule.** Assembles a team in the form,
adds a member in the form, follows the team's own page (D99's "a record is a
thing you link to") and reads "Đội này chưa dự kỳ thi nào." Then a second team
and a round both enter, and the teacher meets D101/D104 as a teacher does: the
roster PATCH answers **409, never 500**, and the sentence in `role="alert"`
**names the pupil** — `fe42-c1 is already competing in a contest this team has
entered.` The roster is read back over the API afterwards and is unchanged, so
the refusal is a refusal and not a half-write. The round is running, and the
organiser's exemption from F-25's roster lock is what puts the seat rule in
reach at all.

**Journey 2b** — the defect above, in its own test.

### `apps/web/e2e/language.spec.ts`

Its fixture is a per-run clone of `aplusb`: `POST /problems/{code}/clone`
brings the package across as revision 1, so publishing it and opening it up is
two more calls and the run gets a real, judgeable, `fe42-` named problem
without building a package and without touching the demo set. Closed again to
`private` in `afterAll`, including when a walk above failed.

1. **The menu and its default (D158).** Five languages in the API's order
   (`cpp17, cpp20, cpp14, c11, python3`), C++17 preselected, and the **same
   answer by direct link and from the statement page** — the two arrivals
   B-30 found disagreeing, which are literally different first renders (cold
   against the fallback list, warm against the cache the statement page filled
   under the same key). The budget beside the picker moves with the selection:
   `Ngôn ngữ này được 1 giây và 64 MB.` → `3 giây và 96 MB.` (D154).
2. **The draft (D84).** Type C++, switch to Python (the code is kept — a pupil
   who opens the dropdown to read the options must not lose a half-written
   program), type Python, switch back: the C++ program returns with
   "Khôi phục bản nháp", and Python's is still there under its own key.
3. **F-41's form.** The base line reads the problem's own limits; the Python
   row's placeholders are the inherited **values** (`Kế thừa: 300%`,
   `Kế thừa: 32768 KB`), not the word "optional". An override of 150 % /
   +65536 KB previews as **`1.5 giây và 128 MB`** — 150 % of a second with the
   interpreter's floor **still added** — saves, and is still there after a real
   reload; `GET /problems/{code}` confirms a pupil is given `timeMs 1500,
   memoryKb 131072`. Then the time box is **cleared**: the preview falls back
   to `3 giây và 128 MB` (the inherited 300 %, never 0 %), the box comes back
   from a reload empty with its inherit placeholder, and
   `GET .../language-limits` is asserted `toBeNull()` rather than falsy —
   because `0` is falsy too and `0` is the exact value the whole form exists
   to rule out (a zero multiplier presents a policy refusal as a TLE, which
   D154 forbids by name).
4. **A refused language.** The setter unchecks "Cho phép nộp bằng C++17" in
   the form, sees `Không cho phép nộp bằng ngôn ngữ này` where a limit would
   be, and saves. The pupil's picker then offers four languages, not C++17,
   and defaults to `cpp20`. The submission is then **read off the POST body**,
   not off `select.value`: B-30's second reproduction is exactly the case
   where the select showed Python and the button posted C++17 into a 404, and
   the DOM cannot tell you which. `languageKey: "cpp20"`, 201, and an AC from
   the real judge. C++17 is allowed again at the end.

### The language walks were demonstrated red first

Beyond the two fixes. Each assertion family in `language.spec.ts` was run
against a deliberately wrong expectation before being accepted, because a walk
that passes in two seconds against a live stack is exactly the shape of this
campaign's two false greens. (`organiser.spec.ts` was not adversarially broken
this way: journey 2's red was organic — it is how the teams defect was found —
and journey 1's guard is the hardcoded `[4, 3, 2, 0]`, which is itself the
column-crossing check.)

```
default cpp17 → c11         ✘ Received: "cpp17"    (16.1s, real timeout)
draft restore → python      ✘ Received string: "// fe42 c++ half-written…"
preview 128 MB → 96 MB      ✘ element(s) not found
inherit toBeNull → toBe(0)  ✘ Expected: 0   Received: null
posted cpp20 → cpp17        ✘ Expected: "cpp17"    Received: "cpp20"
```

---

## Live artefacts (D153)

All named for `scripts/cleanup-test-data.ts`'s existing `fe<n>` patterns
(`^fe[0-9]+` for accounts, `^fe[0-9]+-` for problems, contests and orgs; teams
are classified by their org).

* accounts **`fe42-a1`, `fe42-a2`, `fe42-c1`** — fixed, reached login-first, so
  they cost D26's 30/IP/hour registration meter nothing after the first run
* org **`fe42-truong`** ("FE42 Trường thử nghiệm", private/invite)
* teams **`fe42-alpha-*`, `fe42-bravo-*`, `fe42-charlie-*`** — one set per run
  of `organiser.spec.ts` (14 at the time of writing)
* contests **`fe42-monitor-*`** (individual, public, 12 min) and
  **`fe42-doi-*`** (team, org-visible) — one set per run
* problems **`fe42-ngonngu-*`** — one clone of `aplusb` per run of
  `language.spec.ts` (10 at the time of writing), plus **`fe42-probe-…149`**,
  the manual probe that established the clone→publish→open recipe. **Every one
  of them is `private`**: the nine left public by development runs were closed
  by hand, and the suite now closes its own in `afterAll`.
* submissions on **`aplusb`** from `fe42-a1` and `fe42-a2` (the monitor round;
  `contest-day.spec.ts` uses the same demo problem for the same reason) and on
  each `fe42-ngonngu-*` clone

Nothing in the demo set was modified. `aplusb`'s own language limits were
never touched — that is why the fixture is a clone.

---

## What I could not finish

* **Nothing is deployed.** Both fixes are local commits on `main`. Until the
  controller ships `web`, the live teams panel still shows the roster it
  replaced (and still prefills the next edit from it, which drops a pupil),
  and the live submit editor still loses a draft across the mount that
  corrects an unofferable default. `organiser.spec.ts` journey 2b stays red
  until then, by design.
* **The monitor's `participantsOnline` was exercised at whatever the API
  said, which on these runs was a small number.** The walk's entrants submit
  through API contexts and hold no WebSocket, so the tile is asserted to equal
  the served value rather than to equal a room. D101 calls that number a floor
  rather than a roster; proving it against a real room of open sockets needs
  more browsers than one worker should hold.
* **Similarity was re-run, not re-written.** Feature 10 already asserts what
  the brief asks (run the check, find the pair, follow through to the
  side-by-side view, see `mark.match` painted), and duplicating it would have
  bought nothing. It cannot be run as a cheap subset — feature 9 needs the two
  competitors features 4 and 5 register — so the quoted green is the whole
  `features.spec.ts` file.
* **No `axe-core` work.** The brief's D120 note is a warning about how to
  inject it, not a scope item; `a11y-axe.spec.ts` and `a11y-surfaces.spec.ts`
  already cover the monitor and a team page and were not touched.
* **D161 is unused**, and D162/D163 were not needed.
