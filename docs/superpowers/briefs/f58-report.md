# F-58 — The handover documents, checked against the machine

**Status**: done. **No D204.** The audit forced no ruling: every finding was a
document disagreeing with code or with the live edge, and in each case the code
was right. D203 remains the last decision.

`podman-compose`, `scripts/compose-up.sh`, `scripts/deploy.sh`,
`scripts/restore.sh` and `scripts/backup.sh` were **never run**, and **no
container was started, stopped or restarted**. **`apps/web/dist` was never
written and no `vite build` ran.** The live database was read with `SELECT`
only. The live `.env` was **read, never written**. Nothing under `.secrets/`
was read, printed or committed. Nothing pushed.

**Scope**: 5,081 lines across eight documents. Claim classes checked
exhaustively — commands and flags, routes and ports, counts, versions, limits
and defaults, "this is not deployed" claims, mail behaviour, and the two new
policy switches. Prose that names no fact was not audited, and is not claimed
to be.

---

## Commits

`HEAD` before the slot was `049b391`.

| | |
| --- | --- |
| `1b05855` | `docs(guide)` — the tokens page is `/account/tokens`, and `/tokens` and `/settings` never were |
| `8d6f368` | `docs(guide)` — three claims in the one-time checklist, and the two switches it never named |
| `abcaaf1` | `docs(ops,guide)` — the operations panel has eight panels, the queue does not self-heal, and mail is not silent |
| `32e3301` | `docs(guide)` — a display name has never been capped at 64, and the English half never heard about D200 |
| `aa6af6c` | `docs(ops)` — eleven runbook claims checked against the machine, and struck |
| `c4a5236` | `docs(ops)` — the readiness page's two struck gaps had both moved on, and its three counts by 2x |
| `5d1e9cd` | `docs(guide)` — a pupil is told who can see their real name (D197) |
| `67b1831` | `docs(guide)` — eight claims in the teacher's guide, four of which were never true |
| `7fc05d2` | `docs(guide)` — `judge:node list` needs `DATABASE_URL`, and `add` refuses a name it already has |
| *(this commit)* | `docs(f58)` — the brief and this report |

---

**Verdict counts**, counted from the rows below: **12 never true**, **23
stale**, **38 true**. Every verdict was earned by a command run in this
session — including every `git merge-base --is-ancestor` that decides
*never true* from *stale*. Where a subagent found a lead, both its
present-state evidence and its dating were re-run by hand before the finding
entered this document; nothing here rests on a subagent's word.

**The rule separating the two failing verdicts.** *Stale* means the sentence
described the system correctly when it was written and a later commit moved
the system. *Never true* means **the reading it teaches an operator was false
from the day the sentence entered**, dated by comparing the commit that
introduced the behaviour with the commit that introduced the sentence. Two
entries below — N9 and N11 — have a narrower literal reading that survives,
and are classified never-true under that rule because the reading a teacher
takes away from them was wrong from birth; each says so in its own entry
rather than hiding it.

## 1. NEVER TRUE — first, because these are the dangerous ones

Twelve sentences that no commit in this repository's history ever made true. Each
was dated by finding the commit that introduced the behaviour and the commit
that introduced the sentence, and comparing them with `git merge-base
--is-ancestor`.

### N1. `judge:node revoke judge-1` then `add judge-1` — step 1 of the highest-stakes page

`docs/guide/truoc-khi-trien-khai.md` §1, both halves. The rotation table told a
province to revoke the seeded judge token and re-register **the same name**.

`addJudgeNode` refuses it:

```
judge node 'judge-1' already exists — revoke it, or pick another name
```

`revoke` writes over the token hash and **keeps the row**, deliberately, so the
old node's grading history stays addressable — its own docstring says
"Rotation is `revoke` then `add` under a new name." The refusal has been there
since `c8a4672`, the commit that created the CLI; the checklist page is
`3b8ec1d`, a descendant. **The sequence has never worked.**

This is the worst finding in the set: it is step 1 of the one-time checklist a
province runs to take this host over, the step that burns a credential that has
been seen, and it fails on the second command with an error that reads like the
operator did something wrong.

*How checked*: `grep -n` on `addJudgeNode`; `git log -S "already exists — revoke it"`; `git merge-base --is-ancestor c8a4672 3b8ec1d`.

### N2. `/tokens` — the page an MCP user is sent to mint a token

`docs/guide/mcp.md` §2, both halves. There is no `/tokens` route and there
never has been: `git log -S "'/tokens'" -- apps/web/src` returns nothing, and
`apps/web/src/router.tsx` declares `/account/tokens`.

**Worse than a 404.** `createRootRoute({ notFoundComponent: IndexComponent })`
means an unmatched path renders the **front page**, silently. A setter follows
the guide, lands on the home page, sees no error, and concludes they are
signed in wrong or the feature is missing.

*How checked*: `grep -n "path: '" apps/web/src/router.tsx`; `git log -S`; `grep -n notFound apps/web/src/router.tsx`.

### N3. `/settings` — the same trap, for the publish flow

`docs/guide/chuan-bi-de.md` §4: "Mint ở `/settings`". `git log -S "'/settings'" -- apps/web/src` returns nothing; the settings page itself is `/account/settings`, and tokens are at `/account/tokens`. Same silent front page.

### N4. `/security` — the same trap, in the runbook's account-rescue procedure

`docs/runbook.md` twice, in "A student lost their authenticator": "the
self-service switch on `/security`" and "they can re-enrol from `/security`".
The route is `/account/security`. Bare `/security` has never existed.

### N5. "with no judge connected … submissions time out as `IE` after 300 s"

`docs/guide/quan-tri.md` §8, both halves. There is **no sweeper over queued
jobs at all**. `MAX_GRADING_MS` (300 s) is the watchdog on a grade that has
already been *claimed* — and since `c991ead` it is only the **floor** of
`gradingCeilingMs(job) = min(max(300 s, tests × timeMs × 3 + 60 s), 30 min)`.
`git log -S "queued_at <"` over `apps/judged` and `apps/api` finds no queued-age
expiry in the history.

An operator told to watch for `IE` as the alarm on a dead judge fleet watches
for a signal that will never come; the submissions sit at *Đang chờ*
indefinitely. The runbook carried the same misreading of `MAX_GRADING_MS` in
two more places, now corrected as a floor.

*How checked*: `apps/judged/src/worker.ts:15-33`, `apps/judged/src/job-store.ts:71`; `git log -S`; live `select state, count(*) from grading_jobs group by state` (queue empty, so code is the evidence, not a live reproduction).

### N6. "Tên hiển thị — từ 1 đến 64 ký tự" / "a display name (1–64 characters)"

`docs/guide/hoc-sinh.md` §1, both halves. `DisplayName` in
`packages/contracts/src/auth.ts` is `z.string().trim().min(1).max(100)`, and
that is its only definition ever. `a5dbbfb` is the commit that unified
registration's old 64 with the profile edit's 100 — and `211e7ad`, the commit
that wrote this page, is **38 commits after it**.

*How checked*: `openapi.json` register schema (`maxLength: 100`); `git log --all -S "DisplayName = z.string"`; `git merge-base --is-ancestor a5dbbfb 211e7ad` succeeds.

### N7. `corepack pnpm judge:node list` — a command that stops before it starts

`docs/guide/quan-tri.md` §8, both halves, printed all three `judge:node` lines
bare. **Ran it**: exit 1, `DATABASE_URL is required`. These are CLIs against
`DATABASE_URL`, and under compose `postgres` publishes no host port — §1 of the
same guide explains exactly that for `bootstrap:admin` and §8 did not. The CLI
has required the variable since `c8a4672`, the commit that created it.

### N8. "the **Results (CSV/PDF)** gain a members column" — the PDF never has

`docs/guide/giao-vien.md` §14, both halves. `standingsToTypst` is
`columns = 4 + problems + 2` — rank, user, name, org, per problem, total,
penalty — and `git show 0879821:apps/api/src/statements/results.ts` shows the
same at the commit that added team support. Only `results-csv.ts` adds
`members` (`byTeam ? ['members'] : []`). The **certificates** do list a team's
people; the standings PDF lists none. A teacher who prints the results PDF at
prize-giving gets team names and no roster, having been told otherwise.

*How checked*: `apps/api/src/statements/results.ts:192-201` vs `apps/api/src/contests/results-csv.ts:53-56,79`; `git show 0879821:…`; §14 was written at `5c55764`, a descendant.

### N9. "chủ sở hữu tổ chức thấy thêm nút **Giao bài tập**"

`docs/guide/giao-vien.md` §9, both halves. `apps/web/src/routes/orgs.tsx:873`
computes `decider = myRole === 'owner' || myRole === 'admin'` and line 905
passes `canManage={decider || globalRole === 'admin'}`. An org **admin** may
assign homework.

The literal sentence is not a lie, but its exclusivity is — and it bites
because **§2 of the same guide teaches the opposite rule** for the import panel
("quản trị viên *của tổ chức* không đủ quyền"), which line 898 confirms is
owner-or-global-admin. A teacher who is an org admin reads §2, reads §9, and
concludes they cannot set homework. `a7f08be` shipped `canManage` in that shape
two hours before `06b5f19` wrote the sentence.

### N10. "bảng **Người giải đầu tiên** kèm thời gian và bộ nhớ"

`docs/guide/giao-vien.md` §11, both halves. Two elements are fused. The first
solver is a `<p>` carrying a **username and a submission timestamp** —
`problem.tsx:389-397` — and the table of *Competitor / Time / Memory /
Submission* beside it is a **separate, unlabelled** table over `stats.fastest`
(`:398-429`). `2eed697` shipped both shapes before `211e7ad` wrote §11.

### N11. "Số liệu này giống nhau với mọi người xem" / "identical for every viewer"

`docs/guide/giao-vien.md` §11, both halves. Administrators do see the same
numbers — the sentence's stated point survives — but a viewer **competing in a
running contest that uses the problem**, who did not create that contest, is
served `blankStats()`: identical in shape to a problem nobody has ever
attempted, and **flagged in no way at all** (D35). That is precisely the
viewer a teacher would quote the sentence to.

*How checked*: `apps/api/src/authz/problem.access.ts:995` and `blankStats` at `:2537`; `problem.visibility.ts:255-285`; `df4345d` predates `211e7ad`.

### N12. Five English button names that never matched the catalogue

`docs/guide/giao-vien.md`, English section only — **every Vietnamese twin is
correct**, which is what makes them dateable: each label predates the English
section it appears in.

| Doc says | `apps/web/src/i18n/en.ts` says |
| --- | --- |
| `Disqualify …` / `Reinstate …` | `DQ {name}` / `un-DQ {name}` (552–553) |
| `Download problems (PDF)` | `Problems (PDF)` (512) |
| `judges online` | `Judges up` (1190) |
| `Questions unanswered` *(as the panel)* | the panel is `Questions waiting` (1214); `Questions unanswered` is the tile (1192) |
| `Check list` / `Create accounts` | `Check the list` / `Create the accounts` (962–963) |

---

## 2. STALE — was true, no longer is

| # | Document | Claim | What is true | How checked | What changed it |
| --- | --- | --- | --- | --- | --- |
| S1 | `truoc-khi-trien-khai.md` §2 (vi+en) | "`docker-compose.yml` does **not** currently pass `SMTP_*` into the `api` service — add them to its `environment:` block" | All six plus `MAIL_FROM` are passed, each defaulting to empty | `grep -n SMTP_ docker-compose.yml` → lines 126–134 | F-40's `f63370c`, the **next** commit after this page's `3b8ec1d` |
| S2 | `truoc-khi-trien-khai.md` §2, `quan-tri.md` §10, `PROVINCE-READINESS.md` supply #1 (all vi+en) | mail without SMTP is "silent", "no error anywhere" | Boot warning; `readyz` → `"mail":"log"`; `/admin` Mail panel says *not configured*; production reset → `503 mail_unavailable` | live `POST /api/v1/auth/password/forgot` → 503 `mail_unavailable`; `curl /readyz` → `{"status":"ok","database":"ok","mail":"log"}` | D155, F-40 |
| S3 | `truoc-khi-trien-khai.md` §8 en, `hoc-sinh.md` §1 en | "Register a new account → the confirmation mail arrives" / "You are signed in the moment you register" | Anonymous register → `403 registration_closed` | live `POST /api/v1/auth/register` → 403 | D200; `e186ea3` amended the **Vietnamese halves only** |
| S4 | `PROVINCE-READINESS.md` gap 2 | "the edge at `2c8617e` still answers 201 to an anonymous registration" | Edge is `01e59f2`; `{"registration":"closed"}` and 403 | live curl, both routes | the deploy F-56 could not perform |
| S5 | `PROVINCE-READINESS.md` gap 3 | "**Neither migration is applied to production**" (0045, 0048) | 44 journal rows against 44 files; `submissions.subtask_summary` and `contest_participations.ends_at` both present | `select count(*) from drizzle.__drizzle_migrations` → 44; `information_schema.columns` | the deploy |
| S6 | `PROVINCE-READINESS.md` | "393 generated accounts, 132 generated contests and 52 generated problems" | 507 / 234 / 89 on 2026-09-02 | `psql` counts using D153's own prefix and deny lists | twenty slots of rehearsal runs |
| S7 | `PROVINCE-READINESS.md` (×2) | `load/RESULTS.md` "latest tables dated 2026-08-30" | Latest is the 2026-08-31 c1 re-baseline | `grep -n '^## 2026' load/RESULTS.md` | the c1 consolidation loop |
| S8 | `quan-tri.md` §3 (vi+en) | "Sáu mảng" / "Six panels" | Eight: **Blocked jobs** (conditional) and **Mail** (with a send-a-test box) were added | `apps/web/src/routes/admin.tsx` `<h3>` list; `/admin/dashboard` schema keys | F-40 (mail), the blocked-jobs panel |
| S9 | `quan-tri.md` §3 (vi+en) | "Runtime configuration — database and Redis, API workers, judging concurrency" | Also `NAME_DISCLOSURE` and `REGISTRATION`, untranslated, with hint text | `admin.tsx:648-690`; `runtime` schema has `nameDisclosure`, `registration` | D197, D200, `813006b` |
| S10 | `runbook.md` (~8 places) | `curl -k https://localhost:8443/...`; `BASE=https://localhost:8443/api/v1`; both `scripts/e2e-*.ts` defaults | Nothing listens on 8443: `SITE_ADDRESS=:80` makes Caddy bind port 80 only. `http://localhost:8080` is the entry point | `curl -sk https://localhost:8443/healthz` → `000`; `grep '^SITE_ADDRESS' .env`; `head -1 Caddyfile`; `scripts/deploy.sh:64` already says so | the `.env` move to a `:80` front |
| S11 | `runbook.md` "Running the script" ×2 | `corepack pnpm exec tsx scripts/e2e-submit.ts` / `e2e-problem.ts` | Both open with an anonymous `POST /auth/register`; `e2e-problem.ts` calls `fail()` on the 403. Neither has an admin path | `grep -n 'auth/register' scripts/e2e-*.ts`; live 403 | D200 |
| S12 | `runbook.md` | "the compose `judge` services pass `--only-executors CPP17`" | `CPP14,CPP17,CPP20,C11,PY3,PAS,JAVA` | `grep -n only-executors -A1 docker-compose.yml` → 307/391 | D154/D169/D170's seven languages |
| S13 | `runbook.md` | "this database is missing `0025_dashboard_bounds` and always will be" | `0041_dashboard_bounds_repair` put its four indexes back; all four in `pg_indexes` | `select count(*) from pg_indexes where indexname in (…)` → 4 | `fcaba40` |
| S14 | `runbook.md` "Statement PDFs (optional)" | "**off by default** — 501 until … add the binary to `apps/api/Dockerfile`"; "pre-seed that cache or accept a 500" | typst 0.15.1 and the mitex cache are baked in; `TYPST_BIN` is set in compose; live route answers 200 `%PDF-1.7` | `curl -o /dev/null -w '%{http_code}' …/problems/aplusb/statement.pdf` → 200; `grep -n typst apps/api/Dockerfile`; `grep -n TYPST_BIN docker-compose.yml` | `b085757`, 39 minutes after `2fe0655` wrote the paragraph |
| S15 | `runbook.md` | "Two-factor authentication on DuckOJ has **no recovery codes** … without an admin there is no way back into the account at all" | Eight single-use codes at enrolment, spendable, regenerable via `POST /auth/totp/recovery/regenerate` | `RECOVERY_CODE_COUNT = 8`; route in `openapi.json`; `totp_recovery_codes` table live | D39 (`b82682e`, `3c4ee08`), descendants of `a25a2b5` |
| S16 | `runbook.md` "No router library is adopted … extend `parseRoute`" | five routes, hand-rolled `parseRoute`, router "imported by nowhere" | `@tanstack/react-router` is mounted in `main.tsx`; 30 modules under `apps/web/src/routes/`; `parseRoute` does not exist | `ls apps/web/src/routes | wc -l` → 30; `grep -rn 'function parseRoute' apps/web/src` → nothing | `401682f`, **inside Phase 2b itself** |
| S17 | `runbook.md` | "Production leaves `WS_EXTRA_ORIGINS` empty and none of this applies" | This host runs `WS_EXTRA_ORIGINS=http://localhost:8080,http://localhost:4321` | `grep '^WS_EXTRA_ORIGINS' .env` | D150's preview origin |
| S18 | `runbook.md` ×2 | `MAX_GRADING_MS` as a flat 300 s ceiling | It is the floor of `gradingCeilingMs`, up to `ABSOLUTE_MAX_GRADING_MS` (30 min) | `apps/judged/src/worker.ts:15-33` | `c991ead` |
| S19 | `runbook.md` ×2 | `/healthz` → `{"status":"ok"}`, `/readyz` → `{"status":"ok","database":"ok"}` | `{"status":"ok","workers":4}` and `{"status":"ok","database":"ok","mail":"log"}` | live curl | D86 (`workers`), D155 (`mail`) |
| S20 | `hoc-sinh.md` §4 (vi+en) | on a lost live channel, "just reload the page" | Two different sentences ship. `submit.liveSlow` says the page is polling itself every four seconds and **not** to reload; only `liveUnavailable` asks for a reload | `apps/web/src/i18n/{vi,en}.ts`; `LIVE_POLL_MS = 4_000` in `submit.tsx` | D152 |
| S21 | `giao-vien.md` §8 (vi+en) | "**Giấy chứng nhận** chưa có nút riêng" / "Certificates have no button yet" | There is a button, with a **Cấp tới hạng** / **Down to rank** box (default 3, 1–1000) that builds `?top=N` | `apps/web/src/routes/contests.tsx:65-107,811`; `vi.ts:479-480` | `5286cee`, titled "link the contest certificates PDF, **which shipped with no way in**", three hours after `06b5f19` wrote the sentence |
| S22 | `giao-vien.md` §8 (vi+en) | a finished contest "offers the organisers **two** links" | Three (CSV, PDF, certificates), and a fourth — **Phiếu dự thi (PDF)** — that organisers get at *any* hour, before the gun | `contests.tsx:794-813` | `5286cee`; D129's `66daaf7` |
| S23 | `giao-vien.md` §2 (vi+en) | only a pupil with a placeholder address "cannot use Forgot your password?" | On a stack with no `SMTP_HOST` **nobody** can: refused `503 mail_unavailable` before the limiter and before the lookup | live `POST /auth/password/forgot` → 503; `account-recovery.service.ts:125-134,147` | D155's `a512ec1`, after the doc's last edit `5c55764` |

**Omissions fixed** (not false, but the reader is stranded without them):
`quan-tri.md` documented **neither** `NAME_DISCLOSURE` nor `REGISTRATION`
(F-56's open finding) — both rungs are now in §3 with what each costs;
`truoc-khi-trien-khai.md` named neither, and §3 is now the place they are
decided, with a done-condition that reads the running process rather than
`.env`; `hoc-sinh.md` never told a pupil that a signed-out stranger sees their
username (D197's `affiliated` rung, confirmed live).

---

## 3. TRUE — verified, and left alone

Every one of these was checked because it names a fact, and every one held.

| Claim | Document | How checked |
| --- | --- | --- |
| Every command uses `corepack pnpm`, never bare `pnpm` | all eight | `grep -nE "(^|[\`\"' (])pnpm "` across all eight: 0 bare invocations; the 8 hits are prose about pnpm's behaviour |
| `corepack pnpm tsx scripts/cleanup-test-data.ts --print-plan` prints SQL and opens no connection | `truoc-khi-trien-khai.md` §4 | **ran it**: emitted `begin; set transaction read only; …`, exit 0 |
| the dry run is the default and Postgres enforces it | same | the emitted plan opens `set transaction read only` and ends in `ROLLBACK` |
| `--apply` needs `CONFIRM=yes` | same | `cleanup-test-data.ts:1245` |
| `corepack pnpm prepare:problem` has `check` / `package` / `publish` / `stress`, `--quick`, `--code`, `--base-url`, `--token`, `--publish`, `--visibility`, `--brute`, `--gen`, `--rounds` | `chuan-bi-de.md` | **ran** `corepack pnpm prepare:problem --help`; every flag matches |
| gate limits: time 100–60000 ms, memory 16 MiB–1 GiB | `chuan-bi-de.md` §2 | `packages/prepare/src/validate.ts:35-39` |
| publish token needs `problems:write`, `problems:publish`, `packages:write` | `chuan-bi-de.md` §4 | `packages/contracts/src/scopes.ts`; `packages/prepare/src/publish.ts:29` |
| MCP: 12 read tools unset, 7 more under `DUCKOJ_MCP_WRITES=1`, and the exact names | `mcp.md` §5–6 | 19 tool names in `apps/mcp/src`; the 12 and the 7 both match name for name |
| `oj login` / `oj mcp` exist; config at `~/.config/duckoj/config.json` | `mcp.md` §4 | `apps/oj/src/main.ts` cases; `apps/oj/src/config.ts:16` |
| eight TOTP recovery codes | `quan-tri.md` §5, `hoc-sinh.md` §3 | `RECOVERY_CODE_COUNT = 8` |
| `JUDGED_CONCURRENCY` default 1, max 16 | `quan-tri.md` §8 | `apps/judged/src/config.ts:21` |
| a judge silent for 90 s reads offline | `quan-tri.md` §3 | `JUDGE_SILENCE_SECONDS = 90` |
| the Admin page has four sections in that order | `quan-tri.md` §2 | `AdminPage()` renders `Operations`, `GrantRole`, `ResetTotp`, `RateContests` |
| the operations snapshot refreshes every 15 s, nothing cached | `quan-tri.md` §3 | `refetchInterval: 15_000`, `admin.tsx:572` |
| `deploy.sh` probes `GET /api/v1/languages` through Caddy | `quan-tri.md` §9 | `scripts/deploy.sh:91` |
| `backup.sh` keeps `KEEP` = 14; timer at 03:00 Asia/Ho_Chi_Minh, `Persistent=true` | `quan-tri.md` §6 | `deploy/duckoj-backup.timer`, `scripts/backup.sh` |
| 20 clarifications per user per contest per hour; feed shows the newest 200 | `hoc-sinh.md` §7 | `ASK_LIMIT = 20`, `FEED_CAP = 200` |
| username 3–32, password ≥ 10 | `hoc-sinh.md` §1 | `openapi.json` register schema |
| difficulty runs 1–10 | `hoc-sinh.md` §9 | `byDifficulty.difficulty` `minimum: 1, maximum: 10` |
| 365-day heatmap; last **ten** submissions; streak over twelve months | `hoc-sinh.md` §12 | `HEATMAP_DAYS = 365`, `RECENT_LIMIT = 10` |
| submissions filter by problem, user, contest, verdict | `hoc-sinh.md` §5 | `GET /submissions` parameters |
| the four-second polling fallback, and that the page says so | `truoc-khi-trien-khai.md` §8.3 | `LIVE_POLL_MS = 4_000`; `submit.liveSlow` in both catalogues |
| `corepack pnpm tsx scripts/integrity-check.ts --live` is clean | `truoc-khi-trien-khai.md` §4, §8.5 | **ran it**: 27 checks, 0 violations, exit 0 — including `participation-ends-at-drifted` and `submission-summary-disagrees-with-cases`, which are 0048's and 0045's own invariants and further evidence for S5 |
| 500-row import cap; the panel chunks a longer list itself | `giao-vien.md` §2 | `packages/contracts/src/orgs.ts:244`; `apps/web/src/routes/orgs.tsx:430-509` |
| 10 imports per organisation per minute; a dry run consumes nothing; "5000 pupils in a minute" | `giao-vien.md` §2 | `IMPORT_LIMIT_PER_WINDOW = 10`, `IMPORT_WINDOW_MS = 60_000`, keyed on org **id** not slug (`org.import.ts:55-57,93-101`) |
| the roster import panel is owner-or-global-admin; an org admin is refused | `giao-vien.md` §2 | `orgs.tsx:898`; `org.access.ts` |
| the live monitor refreshes every 5 s; six tiles; newest **fifty** submissions with true verdicts | `giao-vien.md` §12 | `contest-monitor.tsx:233`; `FEED_LIMIT = 50` in `contest.monitor.ts:99` |
| clarifications refresh every 30 s **while the contest runs**, and not after | `giao-vien.md` §7 | `contests.tsx:889` — `refetchInterval: phase === 'running' ? 30_000 : false` |
| the four contest formats `icpc`, `ioi16`, `legacy_ioi`, `default` | `giao-vien.md` §3 | `fixtures/contest-goldens/` carries a directory per format; `contest-new.tsx:28` |
| certificates: signed by the contest's orgs or `DuckOJ`, dated by the end, DQ and virtual excluded, `top` counted **after** the exclusion | `giao-vien.md` §8 | `statements/results.ts`; `results.service.ts` |
| the results CSV's columns, its UTF-8 BOM, and that a disqualified row is exported and flagged | `giao-vien.md` §8 | `results-csv.ts:47-102` |
| a teacher still sees real names on every export (D197 authority path) | `giao-vien.md` §8, §9 | `authz/name-disclosure.ts:127-165`; `problem-set.access.ts:135-141` |
| the guide never assumes a pupil self-registers — accounts come from the panel or `org:import` | `giao-vien.md`, throughout | read in full; D200 introduces no falsehood here |
| `org:import` caps at 500 rows; all-or-nothing; sheet to stdout | `runbook.md` | `scripts/org-import.ts`, `apps/api/src/authz/org-import.core.ts` |
| `pnpm@9.12.0`; every `corepack pnpm <script>` name resolves | `runbook.md` | root `package.json` scripts block |
| the demo contest `thu-nghiem-1` and five Vietnamese problems are on D153's deny list | `truoc-khi-trien-khai.md` §4 | the emitted plan's `not in (…)` clauses; the contest row exists live |
| `API_WORKERS` default 4, `JUDGED_CONCURRENCY` default 1, Caddy maps 8080:80 / 8443:443 | `runbook.md`, `PROVINCE-READINESS.md` | `docker-compose.yml`; `podman port duckoj_caddy_1` |
| seven live languages with their multipliers and addends | (background) | `GET /api/v1/languages`: java 300%/+64 MiB, python3 300%/+32 MiB, pascal 200%, the four C/C++ at 100%/+0 |

---

## 4. The corrections a summary of this system would repeat

These are the ones the atlas artifact, or any prose summary derived from these
documents, will have inherited. In order of how wrong they make the summary:

1. **Registration is closed on this deployment, and the deploy has happened.**
   Anonymous `POST /auth/register` answers `403 registration_closed`; the
   probe answers `{"registration":"closed"}`. Any sentence saying the edge
   still answers 201, or that D200 is committed-but-not-deployed, is wrong.
2. **Migrations 0045 and 0048 are applied.** 44 of 44. Any "not applied to
   production" caveat about the subtask summary or the participation `ends_at`
   is wrong.
3. **Mail is never silent.** No `SMTP_HOST` means logged mail *plus* a boot
   warning, `readyz: "mail":"log"`, a Mail panel on `/admin`, and a **503
   `mail_unavailable`** on a production password reset. "Silently no-ops" is
   the single most-repeated false sentence in the set — it appears in three
   documents, six places.
4. **`docker-compose.yml` passes the full `SMTP_*` set, plus `NAME_DISCLOSURE`
   and `REGISTRATION`.** No hand-edit of the compose file is needed for any of
   them; they are `.env` values.
5. **The rehearsal host carries 507 generated accounts, 234 contests and 89
   problems** — not 393 / 132 / 52. Re-count rather than quote: these move.
6. **The account pages are `/account/tokens`, `/account/settings`,
   `/account/security`.** Not `/tokens`, `/settings`, `/security`. Unmatched
   paths render the front page rather than a 404.
7. **The team results PDF has no members column** — only the CSV does, and
   the certificates. **Contest certificates have a button**, with a
   down-to-rank box. **An org admin may set homework** though not import a
   roster. A **competitor in a running contest is served blank problem
   statistics**, unflagged.
8. **The operations dashboard has eight panels** and reports both policy
   rungs and the mail transport.
9. **`https://localhost:8443` is dead on this host** (`SITE_ADDRESS=:80`).
   `http://localhost:8080` is the only working entry point.
10. **Statement PDFs are on**, not "off by default"; **recovery codes exist**,
    eight of them; **`@tanstack/react-router` is adopted** and `parseRoute` is
    gone.
11. **A stalled grading queue does not turn `IE`.** Nothing sweeps an
    unclaimed job.
12. **`load/RESULTS.md`'s latest tables are 2026-08-31**, not 2026-08-30.

---

## 5. A product defect found, and not fixed here (out of scope per the brief)

`scripts/e2e-submit.ts` and `scripts/e2e-problem.ts` cannot run on a default
deployment. Both open with an anonymous `POST /auth/register`, which D200's
default rung refuses `403`, and neither has an admin-cookie path or an
`E2E_SECRETS_FILE` — `e2e-problem.ts` calls `fail()` on that status. Their
`E2E_BASE_URL` default is also `https://localhost:8443`, which resets under
`SITE_ADDRESS=:80`, and that origin is not on D82's allow-list.

The Playwright suite was taught to mint its pupils as the admin in F-56/F-57
(`91a8402`, `6309fe2`); these three CLI scripts were not. This is a code fix,
not a documentation one, so the runbook now warns loudly and the scripts are
untouched. **Evidence**: `scripts/e2e-submit.ts:89`, `scripts/e2e-problem.ts:268,275`, `scripts/e2e-contest.ts:43`; live 403.

---

## 6. What I could not finish

- **`docs/runbook.md` was swept by claim class, not sentence by sentence.**
  Commands, routes, ports, counts, defaults, "not deployed" claims, mail and
  the two switches were checked exhaustively; its long prose rationales were
  not re-derived. Every finding reported above was re-run by hand in this
  session before it entered this document.
- **Two live behaviours could not be reproduced, only read from code**: the
  queued-job non-expiry of N5 (the live queue is empty — 1,078 jobs, all
  `done`), and the mail *delivery* path, because this host has never had an
  `SMTP_HOST` and configuring one would mean editing the live `.env`.
- **Nothing was checked through an authenticated browser session.** The
  operations dashboard's rendering, the teacher screens and the organiser
  lists were checked against `apps/web/src` and `openapi.json` rather than
  against pixels; reaching them needs a credential from `.secrets/`, which
  this slot may not read.
- **Three `giao-vien.md` claims are unverified**, and are the next slot's:
  the booklet cover's exact contents and its `Bài A.` labelling; the
  editorial's mid-contest gating; and the exact wording a reader sees when no
  PDF toolchain is installed (unreachable here — typst is installed).
- **One omission left in place, deliberately**: `giao-vien.md` says an
  announcement notifies every participant, and `NOTIFY_CAP = 10_000`
  (`contest.clarifications.ts:55-59`) silently drops the excess above that.
  Unreachable on a 510-account host, so it is a future omission rather than a
  present falsehood, and correcting it would mean writing about a path I
  cannot exercise.
- **`PROVINCE-READINESS.md`'s header** still says "2026-08-29" and "decisions
  D16–D105" while `DECISIONS.md` runs to D203. Left alone deliberately: it
  scopes the *campaign record* the page was written for, not the project.
