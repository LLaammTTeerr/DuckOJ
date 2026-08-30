# B-14 — feature journeys through a real browser

Branch `worktree-agent-a0c735c14365e9e7a`, not pushed. `5286cee` certificates
fix + web test · `297f904` `apps/web/e2e/features.spec.ts` · `c55b29d` this
report · `4e43afa` guide fix + test · one amendment (journey 9 re-uses two
accounts). Web gate green: typecheck, lint, **456 tests / 46 files**,
`vite build`. **11 journeys, 11 passing**;
`test:e2e e2e/features.spec.ts e2e/smoke.spec.ts` → **19 passed, 1 failed**,
the failure being `smoke.spec.ts`'s own registration hitting D26's meter.

## What shipped
`apps/web/e2e/features.spec.ts` — a second Playwright file beside
`journey.spec.ts` (which another loop is rewriting; untouched, as is
`submit.tsx`). Serial, Vietnamese locators, `RUN`-stamped names, every journey
asserting **zero console errors and zero broken subresources** through the
shared `watchForBrokenRequests` with expected 4xx passed in by route AND
status. Screenshots: gitignored `e2e/screenshots/b14-*`.

1. **`/help`** — three role tabs with `aria-pressed`, one `<h1>`, both language
   halves present, the tab surviving VI→EN→VI (F10's own concern).
2. **Topics + difficulty** — `?tag=`/`?difficultyMin=` seed the CONTROLS as
   well as the query; rows checked against what the API itself answers, not a
   hardcoded list; a second topic **narrows** (D35's AND).
3. **Phone at 390 px** — exactly 5 tabs, the `Thêm` sheet opening and closing
   on Escape and on its button, `aria-expanded` tracking, ten routes with
   `scrollWidth <= innerWidth`. The only place the `matchMedia` phone tree is
   ever rendered by a browser (D76 shipped with its journeys unrun).
4. **Clarifications** — join-gated ask, private marker, answer, publish, then
   the asker's **bell badge** → `/notifications` (D31).
5. **Editorial** — served; withheld the moment the reader joins a contest using
   the problem (D43, D35's tag mask beside it); served again on AC. Publishes
   `tong-hai-so`'s editorial, cleared in `afterAll` — the one seeded row
   touched.
6. **Booklet** — the link's `lang=vi`, then 200 · `application/pdf` · `%PDF`.
7. **Roster import** — dry run, credentials table, an imported pupil's forced
   password change swapping **every** route (D61).
8. **Homework** — assign, solve, `1/1`, the class grid (all three pupils,
   `tabindex` scroller) and its CSV (D66).
9. **Results** — a two-minute contest, two competitors on identical sources,
   then `results.csv` (BOM + both names), `results.pdf`, `certificates.pdf`.
10. **Similarity** — the identical pair at 100%, side by side with
    `mark.match` (D77). 11. **Progress** — solved count, painted heatmap, tag
    bars (D83).

## Bugs found and fixed
**`certificates.pdf` had no way in.** It shipped with F12 (D71/D74) and nothing
linked it — the finished-contest line offered CSV and PDF and stopped, so the
one document a school prints needed a hand-typed URL. Fixed behind the same
`canEdit && phase === 'finished'` gate. The first spelling, a bare anchor, was
**wrong and the journey caught it**: `CertificatesQuery` refuses a request with
neither `top` nor `username` (422) and D74 makes `top` a bound on the RANK, so
the depth is the organiser's to choose — a number box opening on **3**, clamped
to 1…1000. `test/contest-results-links.spec.tsx` is new (F12 shipped no web
test for these links at all): 4 cases, 2 mutants killed. *The "opens on 3"
ruling wants a D-entry; I had no number.*

**The student guide's nav lists lost `Tiến độ`.** D83 put it in both trees and
neither list, so `/help` described an account cluster ending at the reader's
name. Fixed in all four lists; `test/guide-nav.spec.ts` reads the labels out of
the catalogues the shell renders — F10's "nothing ties a guide sentence to the
screen it describes", for the one sentence where the tie is mechanical.

## Concerns
1. **D82 landed on the deployment mid-run** (`csrf-origin.guard.ts`, absent
   from this worktree): a cookie-bearing `page.request` write now 403s
   `csrf_origin`. Handled with an explicit `Origin` header —
   **`journey.spec.ts`'s `source_access` PATCH needs the same fix.**
2. In a worktree the secrets file is not at `../../.secrets/`: the documented
   command needs `E2E_SECRETS_FILE=<repo>/.secrets/duckadmin.txt`.
3. The forced-change confirmation is **unobservable** — the `me` refetch that
   clears the flag unmounts the page carrying it. Left as a UX nit; feature 8
   proves the new password instead.
4. **Registration is 30/IP/hour and shared.** Four accounts a run 429'd twice,
   so journey 9 re-uses journeys 4 and 5's pair — two a run, at the price that
   journey 9 can no longer run alone under `-g`.
5. No editorial is published on the deployment (`content/README.md` step 7 was
   never run), and the certificates LINK assertion stays conditional until the
   stack carries this branch; the vitest spec pins it meanwhile.
