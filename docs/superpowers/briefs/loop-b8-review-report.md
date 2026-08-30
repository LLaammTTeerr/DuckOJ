# B8 — whole-diff review of the feature/bug loop (`b28f350..HEAD`)

247 files, ~45.8k insertions; every non-generated source diff read. Six defects
confirmed with a failing test, fixed, mutation-checked, one commit apiece. Rulings
**D62**, **D63**; D64 unspent. Full ritual green.

## Blocker

**1. The booklet published private problem statements to anyone who could see the
contest** — `authz/contest.access.ts:349` (`loadBookletRows`), route
`contests.controller.ts:129`. It read `problems.statement` gated only on contest
visibility + started, while `GET /problems/{code}` and `.../statement.pdf` hang on
`canViewProblem`, whose contest clause is a **participation** (`inJoinedContest`).
D56 makes that a leak, not an inconsistency: an org-restricted contest refuses `join`
with 403, so a rival school has no route to a participation — "the same access by a
longer route" does not apply, and at the bell they could download every statement. Every
booklet test seeded public problems. Fixed with `visibleProblemsWhere`. **68dbc62** (D62)

## Majors

**2.** `authz/contest.clarifications.ts:359` — the clarification feed had no bound at all
("not paginated"). `ask` admits 20 questions/user/contest/hour (a 2000-seat room writes
40 000 rows of ≤2 000 chars in hour one) and `web/src/routes/contests.tsx:400` repolls it
**every 30 s for every reader** while the contest runs. Capped at 200 newest, plus
`truncated`; mutation → 201 rows, red. **d8a7166** (D63)

**3.** `statements/markdown-to-typst.ts:75` — a backtick inside `$…$` kills the whole
booklet: the math span excluded only `$` and newline while the LaTeX goes into a
single-backtick typst raw literal, so `` $a`b$ `` in ONE statement 500s the PDF of every
problem beside it. Real typst: `error: unclosed delimiter` — fa4f0b4's failure. **b0206e9**

## Mediums

**4.** `app.setup.ts:78` — `X-Stats-Cache`/`X-Booklet-Cache` invisible cross-origin. B-5
exposed three headers (e04d056); F-6 shipped two more two commits later and left them
off. The new assertion derives the list from source. **c7c686a**

**5.** `authn/expired-rows.sweeper.ts:88` — the sweep materialised every deleted id; its own
header estimates `rate_events` at ~8.6M rows/day under stuffing and `.returning({id})`
built that array in-process. **acaafdb**

**6.** `web/src/org-picker.tsx:35` — a failed `GET /orgs` read as "you belong to no
organization": `openapi-fetch` resolves on HTTP errors, so `?? []` hid every 500. **05dfa82**

## Recorded, not fixed

- `authz/dashboard.access.ts:263` — `workers()` LEFT JOINs `grading_jobs` to `submissions`
  with no time bound, every 15 s: worse than D47's recorded "aggregates over
  `grading_jobs`". Extend that upgrade path rather than re-rule it.
- The `{ data } = await api.GET(…)` swallow survives at 9 query functions despite B-4's
  "every read query carries its status"; two are new — `web/src/tags.ts:20` (filter bar
  silently empty), `web/src/routes/orgs.tsx:230` ("no contests").
- `apps/api/test/route-fuzz.spec.ts` holds raw NUL bytes (5114, 6136, 6249) so git treats
  it as **binary** and its diff is unreviewable; use escapes. `markdown-to-typst.ts:291`
  hardcodes `BOOKLET_TZ` to ICT beside D57's new per-account timezone (fine for print).

**Cleared:** migrations 0016–0023 (no drift; the 0020 gap is harmless — drizzle-kit
0.31.10 uses `lastEntry.idx + 1`); contracts/SDK regen (no diff); i18n parity; route
markers; `assertMayJoin` (intersection, not whole membership); every date call site
passing the D57 zone; every decompression path carrying D53's cap.
