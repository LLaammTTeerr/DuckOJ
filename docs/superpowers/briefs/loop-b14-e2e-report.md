# B-14 — feature journeys through a real browser

Branch `worktree-agent-a0c735c14365e9e7a`, not pushed. Commits: `5286cee` the
certificates fix + its web test · `297f904` `apps/web/e2e/features.spec.ts` ·
this report. Web gate green: typecheck, lint, **454 tests / 45 files**,
`vite build`. **11 journeys, 11 passing** against the live stack.

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
   well as the query; the row set is checked against what the API itself
   answers, not a hardcoded list; a second topic **narrows** (D35's AND).
3. **Phone at 390 px** — exactly 5 tabs, the `Thêm` sheet opening and closing
   on Escape and on its button, `aria-expanded` tracking, ten routes with
   `scrollWidth <= innerWidth`. The only place the `matchMedia` phone tree is
   ever rendered by a browser (D76 shipped with the journeys unrun).
4. **Clarifications** — join-gated ask, private marker, answer, publish, and
   the asker's **bell badge** → `/notifications` (D31).
5. **Editorial** — served; withheld the moment the reader joins a contest
   using the problem (D43, with D35's tag mask beside it); served again on AC.
   Publishes `tong-hai-so`'s editorial, cleared in `afterAll` — the only
   seeded row this file touches.
6. **Booklet** — the link's `lang=vi`, then 200 · `application/pdf` · `%PDF`.
7. **Roster import** — dry-run preview, credentials table, an imported pupil's
   forced password change swapping **every** route (D61).
8. **Homework** — assign, pupil solves, `1/1`, the class grid (all three
   pupils, `tabindex` scroller) and its CSV (D66).
9. **Results** — a two-minute contest, two competitors on identical sources,
   then `results.csv` (BOM + both names), `results.pdf`, `certificates.pdf`.
10. **Similarity** — run, the identical pair at 100%, side by side with
    `mark.match` (D77).
11. **Progress** — solved counter, painted heatmap, topic bars (D83).

## The bug it found, fixed
**`certificates.pdf` had no way in.** The route shipped with F12 (D71/D74) and
nothing on the site linked it — the finished-contest line offered CSV and PDF
and stopped, so the one document a school prints needed a hand-typed URL.
Fixed in `contests.tsx` behind the same `canEdit && phase === 'finished'`
gate. The first spelling — a bare anchor — was **wrong, and the journey caught
it**: `CertificatesQuery` refuses a request carrying neither `top` nor
`username` (422), and D74 makes `top` a bound on the RANK, so the depth is the
organiser's to choose. It is a number box beside the link (the similarity
panel's shape), opening on **3**, clamped to 1…1000 so the link can never
address a 422. `test/contest-results-links.spec.tsx` is new — F12 shipped no
web test for these links at all; 4 cases, 2 mutants killed (drop the anchor,
drop the clamp). *The "opens on 3" ruling wants a D-entry; I had no number.*

## Concerns
1. **D82 landed on the deployment mid-run** (`csrf-origin.guard.ts`, absent
   from this worktree): a cookie-bearing `page.request` write now 403s
   `csrf_origin`. Handled with an explicit `Origin` header —
   **`journey.spec.ts`'s own `source_access` PATCH needs the same fix.**
2. In a worktree the secrets file is not at `../../.secrets/`: the documented
   command needs `E2E_SECRETS_FILE=<repo>/.secrets/duckadmin.txt`.
3. The forced-change confirmation is **unobservable** — the `me` refetch that
   clears the flag unmounts the page carrying it. Left as a UX nit; feature 8
   proves the new password instead.
4. **Registration is 30/IP/hour; this file needs 4 a run** beside
   `journey.spec.ts`'s seven. A 429 stopped journey 9 dead once.
5. No editorial is published on the deployment (`content/README.md` step 7 was
   never run), and the certificates LINK assertion stays conditional until the
   stack carries this branch — the vitest spec pins it meanwhile.
