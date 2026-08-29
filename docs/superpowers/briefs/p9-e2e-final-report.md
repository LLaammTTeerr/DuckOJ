# P9 — journey 1 through `/register`, plus journeys 7 and 8

**DONE_WITH_CONCERNS.** One commit, `apps/web/e2e/journey.spec.ts` only.
`test:e2e` → **17 passed** (8 journeys + 9 smoke) on localhost:8080; ritual green
(`-r typecheck`, `-r lint`, web **202 / 28 files**). Screenshots in the
gitignored `e2e/screenshots/`; `j1a`, `j7a/b`, `j8a/b/c` are new.

## Shipped
**Journey 1 walks `/register`.** Nav link *Đăng ký* → five fields → a mismatched
confirmation is refused **client-side** (`Hai mật khẩu không khớp nhau.`, still
on `/register`, still signed out; the watchdog would have caught a request had
one been sent) → corrected → the page chains `POST /auth/login` and lands on `/`
**signed in**, nav showing the display name; then VI-by-default and EN as before. The bad attempt uses the *valid* 28-char password: the confirm
rule sits in an `else` behind the length rule. The API `register()` helper stays
for the six journeys whose accounts are mere scenery.

**Journey 7 — a submission names its contest.** A throwaway pupil joins the
seeded `thu-nghiem-1`, submits through `?contest=`, reaches AC; `/submissions`
shows the contest cell as an `a[href="/contests/thu-nghiem-1"]` labelled with the
contest's own name (read off its page, never typed here), and `/submissions/{id}`
carries the same link — asserted by **href**, since a label with no link is the
state this column replaced.

**Journey 8 — a freeze actually biting (D22/D23).** `duckadmin` creates
`e2e-p9-freeze-<run>` through the form: start = now − 55 min, end = now + 5 min,
`frozenLastMinutes = 10` (10 < 60 satisfies `assertFreezeFits`), so `now` is
inside `[end − 10, end)` — unlike journey 4's configured-but-idle freeze. A pupil
joins and grades to **AC**, unmasked to themselves; a second pupil sees that row
**listed** with `?`, titled *Được ẩn cho tới khi bảng điểm hết đóng băng.*, and
the frozen banner — while the admin, on the same two URLs, sees **AC** and none.

## Rulings (nobody was available to ask)
1. **The mask was unreachable from a browser.** `source_access` defaults to
   `private`, so `visibleSubmissionsWhere` admits only your own rows — proved on
   the live stack with two throwaway accounts (the rival's list came back
   `{"items":[]}`). D23 sits *inside* that visibility, so by default no viewer
   both sees the row and is subject to the mask. Journey 8 flips `tong-hai-so`
   to `source_access = 'solved'` — the setting D23 exists for — and the rival
   earns sight of the row with their own AC. **Setup, not a product ruling.**
2. **The flip is restored in `test.afterAll`**, not at the end of the body — a
   timeout aborts a body. Verified `private` again after the run.
3. The rival's AC is a **practice** submission made *before* the contest exists,
   so only the row under test sits inside the five-minute window. `?verdict=`
   never locates that row: D23 excludes frozen rows from that filter in SQL, so
   it would answer an empty page by design.

## Bugs found
None in the product. One **test** bug, red→green in the same run: journey 7's
`getByRole('link', {name:'Nộp bài'})` matched five links (the seeded contest has
five problems); now located by href. Journeys 1–6 passed unchanged, so the
`/register` rewrite needed no product change.

## Concerns
- Each run adds a throwaway participant and AC to `thu-nghiem-1`'s board and an
  `e2e-p9-freeze-*` contest ("clean up nothing") — the demo board accumulates.
- Journey 8 needs the judge to finish inside the contest's last five minutes;
  measured 7.1 s end to end. If a loaded stack flakes, −50/+10 with
  `frozenLastMinutes = 15` keeps the property.
- `source_access` has **no web UI**: an admin cannot open a problem to solvers
  from the app. Left alone — a feature, not a bug.
