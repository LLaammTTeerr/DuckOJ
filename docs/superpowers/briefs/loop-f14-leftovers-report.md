# F14 — the leftovers F9/F10/F11/F12 named in their own reports

Six commits on `main`, no migration, one contract change (regen clean), not
pushed: `06b5f19` guides · `ca6caee` i18n · `b7e634c` ops · `b363422`
exports · `27c576d` problem sets · `c626c51` the D76 nav copy (asked mid-task).

## Shipped
1. **Guides**, both locales: homework is **Bài tập về nhà** on the org page
   (D66), the exports **Kết quả (CSV)/(PDF)** and `certificates.pdf?top=N`
   (D71), the import 500 rows a request that the panel splits for you (D61
   amended) — the three "DuckOJ has no such thing" sentences are gone, and
   `c626c51` swapped the one-flat-bar inventory for UI-2's two layouts (D76),
   which on a phone was a wrong instruction rather than stale prose.
2. **i18n.** `admin.totpNote` sends the admin to look for a **recovery code**
   first and says the reset deletes the rest; it had claimed since D39 that
   none existed. `problem.editorialShow` deleted; the grep parity test found
   three more orphans, all now *rendered* — `problem.tags` labels the chips
   beside "Độ khó: 4/10", the two admin stat blocks get headings; six
   dynamic prefixes are allow-listed, each by its builder.
3. **Multi-judge ops.** `compose-up.sh` gains `SCALE=1`, translates
   `COMPOSE_PROFILES=scale`, passes `--profile scale` on every compose call
   and waits on `judge-2` — **measured:** podman-compose 1.5 reads a profile
   only from its own command line. `.env.example` gains `JUDGE_TOKEN_2`.
   Dashboard: per-node **grading now** / **graded (1 h)** through
   `grading_jobs.judge_node_id` (0027, written by F11 and read by nothing),
   plus a **blocked jobs** panel by `blocked_reason`; the runbook names them.
4. **Exports.** `certificatesDocument` uses `loadOrgs` (now public) on the id
   `buildResults` already holds, not a second full `getVisible`.
5. **Problem sets.** Runbook `### Bài tập về nhà` for owners: the member
   gate, the inclusive deadline, the 422 codes, the CSV's 500-row walk /
   20 000 cap / `truncated,<rows>` trailer, and two edges — an assigned
   problem can no longer be deleted, and set creation is unmetered.

## Tests — every behaviour change red first, then a mutant
23 tests across `help`, `i18n`, web `admin`/`contests`/`problem-tags`/
`problem-sets`, api `admin-dashboard`/`contest-results`, two pinned plan
fragments, and `scripts/test/compose-up.test.sh` (11 cases, both binaries
stubbed, nothing started); thirteen mutation checks, all killed, each named
in its own commit. Ritual green — typecheck + lint (both `:scripts` too),
regen no-diff, `vite build`, **api 918/918 (97 files), web 413/413 (41)**,
others green. Parallel `pnpm -r test` reds `contest-scoreboard-cache`, the
flake F9/F11/F12 each recorded: green alone and sequentially.

## Concerns
- The two new dashboard queries are pinned by SOURCE fragments in the plan
  spec, not an `EXPLAIN`: its 100 000-row fixture seeds no `judge_node_id`.
- Certificates and the CSV each still resolve the contest **twice**
  (`loadVisible`, then `getScoreboardCached`'s); the test pins them equal.
- `compose-up.test.sh` is outside `pnpm -r test`, as `restore.test.sh` is,
  and `/help` still bundles the guides at build time.
