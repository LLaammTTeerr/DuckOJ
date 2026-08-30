# B-14 — feature journeys through a real browser

Branch `worktree-agent-a0c735c14365e9e7a`, not pushed. `5286cee` certificates fix
+ web test · `297f904` `apps/web/e2e/features.spec.ts` · `4e43afa` guide fix +
test · `46f1829` account re-use · this report. Web gate green: typecheck, lint,
**456 tests / 46 files**, `vite build`. **11 journeys, 11 passing**;
`test:e2e e2e/features.spec.ts e2e/smoke.spec.ts` → **19 passed, 1 failed** — that
failure `smoke.spec.ts`'s own registration hitting D26's meter, not a journey.

## What shipped
`apps/web/e2e/features.spec.ts`, a second file beside `journey.spec.ts` (which
another loop is rewriting; untouched, as is `submit.tsx`). Serial, Vietnamese
locators, `RUN`-stamped names, screenshots to the gitignored
`e2e/screenshots/b14-*`, every journey asserting **zero console errors and zero
broken subresources** via `watchForBrokenRequests`, expected 4xx allowed by route
AND status.

**1 `/help`** — three role tabs with `aria-pressed`, one `<h1>`, both language
halves present, the tab surviving VI→EN→VI. **2 topics + difficulty** — the URL
seeds the CONTROLS, not only the query; rows checked against what the API answers
rather than a hardcoded list; a second topic **narrows** (D35's AND). **3 phone
at 390 px** — exactly 5 tabs, the `Thêm` sheet opening and closing on Escape and
on its button, ten routes with no sideways scroll; the only place the
`matchMedia` phone tree is ever browser-rendered. **4 clarifications** (D31) —
join-gated ask, private marker, answer, publish, the asker's **bell badge**.
**5 editorial** (D43) — served, withheld once the reader joins a contest using
the problem, served again on AC; publishes `tong-hai-so`'s editorial and clears
it in `afterAll`, the one seeded row touched. **6 booklet** — 200 ·
`application/pdf` · `%PDF`. **7 roster import** (D61) — dry run, credentials
table, forced password change swapping **every** route. **8 homework** (D66) —
assign, solve, `1/1`, the class grid and its CSV. **9 results** — a two-minute
contest, `results.csv` (BOM + both names), `results.pdf`, `certificates.pdf`.
**10 similarity** (D77) — the identical pair at 100%, side by side with
`mark.match`. **11 progress** (D83) — solved count, heatmap, tag bars.

## Bugs found and fixed
**`certificates.pdf` had no way in.** It shipped with F12 (D71/D74) and nothing
linked it, so the one document a school prints needed a hand-typed URL. Fixed
behind the results line's own `canEdit && phase === 'finished'` gate. The first
spelling, a bare anchor, was **wrong and the journey caught it**:
`CertificatesQuery` refuses a request with neither `top` nor `username` (422),
and D74 makes `top` a bound on the RANK — so the depth is the organiser's, a
number box opening on **3**, clamped to 1…1000.
`test/contest-results-links.spec.tsx` is new (F12 shipped none): 4 cases, 2
mutants killed. *"Opens on 3" wants a D-entry.*

**The student guide's nav lists lost `Tiến độ`.** D83 put it in both trees and
neither list, so `/help` described an account cluster ending at the reader's
name. Fixed in all four lists; `test/guide-nav.spec.ts` reads the labels out of
the catalogues the shell renders — F10's "nothing ties a guide sentence to the
screen it describes", mechanised for the one sentence that can be.

## Concerns
1. **D82 landed on the deployment mid-run** (`csrf-origin.guard.ts`, absent from
   this worktree): a cookie-bearing `page.request` write now 403s `csrf_origin`.
   Fixed here with an explicit `Origin` header — **`journey.spec.ts`'s
   `source_access` PATCH needs the same.**
2. In a worktree the secrets file is not at `../../.secrets/`; the command needs
   `E2E_SECRETS_FILE=<repo>/.secrets/duckadmin.txt`.
3. The forced-change confirmation is **unobservable** — the `me` refetch that
   clears the flag unmounts the page carrying it. A UX nit, untested.
4. **Registration is 30/IP/hour and shared.** Four accounts a run 429'd twice, so
   journey 9 borrows journeys 4 and 5's pair — two a run, at the price that
   journey 9 can no longer run alone under `-g`.
5. No editorial is published on the deployment (`content/README.md` step 7 was
   never run); the certificates LINK assertion stays conditional until the stack
   carries this branch, the vitest spec pinning it meanwhile.
