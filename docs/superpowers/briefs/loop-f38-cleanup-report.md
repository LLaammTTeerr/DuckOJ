# F-38 — telling the rehearsal litter from the demo content

`scripts/cleanup-test-data.ts` (dry-run by default), a container-free spec,
`docs/guide/truoc-khi-trien-khai.md` (vi + English, D10), D153. **Nothing was
applied**; the live DB is unchanged (420 users / 137 contests / 59 problems).

**Live dry-run inventory** (2026-09-01, `podman exec duckoj_postgres_1 psql`).
Matched the allow-list: 417 users, 136 contests, 52 problems, 25 orgs, 45 teams, 20
problem sets.
**REFUSED — 28**, exactly the two cases the brief names: 24 accounts (`e2ej7*`,
`bh28-*`) that entered the demo contest `thu-nghiem-1`, and 4 rounds
(`fe1-freeze-*`, `fe6-phone-*` ×3) that `hocsinh1` entered. **DISCLOSED — 3 rules,
88 rows:** `duckadmin` loses 19 drill clarifications, 45 authoring roles on drill
problems, 24 rehearsal-school memberships — rows that die with their container
(D153). **KEPT problems whose counters change:** tong-hai-so −603, aplusb −80,
hello −2.
**Would delete — 12,210 rows in 32 tables**, in foreign-key order: notifications
170, grading_jobs 744, submission_cases 7575, contest_submissions 152, submissions
744, contest_problem_solvers 146, contest_problem_stats 130, contest_seats 230,
contest_participations 187, similarity_runs 20, contest_clarifications 62,
contest_orgs 23, contest_problems 154, contests 132, team_members 90, teams 45,
problem_set_items 20, problem_sets 20, problem_members 52, problem_tags 2,
problems.current_revision_id 52 (nulled), problem_revisions 48, problems 52,
org_members 98, org_join_requests 1, organizations 25, sessions 648,
access_tokens 6, totp_recovery_codes 16, totp_credentials 5, one_time_tokens 168,
users 393. Survivors: system, duckadmin, hocsinh1 + the 24 refused; thu-nghiem-1
+ the 4 refused; the five Vietnamese problems, aplusb, hello.
packages/package_files untouched.

**Ran vs only wrote.** The dry run above; `--print-plan`; the spec (14 passed,
2.6 s, starts **no** container); `nice -n 19` `-r typecheck`, `-r lint`,
`lint:scripts`, `typecheck:scripts` — all green; web untouched. **Deliberately also
ran** the `--apply` SQL with `commit` replaced by `rollback`, proving all 32 deletes
land in FK order: every statement succeeded, rolled back, counts unchanged.

**Concerns.**
1. Brief counts stale (420/137, not 177/102); `j*-` matched nothing and
   `b32drill` was D130's compose project, not rows — both recorded in D153.
2. The refuse/disclose line is a judgement: refuse-everything gave 258 refusals
   all reducing to "duckadmin touched it", leaving 24 orgs / 45 teams / 20 sets /
   19 contests undeletable. D153 has the argument and cost-if-wrong.
3. `docker-compose.yml` passes no `SMTP_*` into `api` — mail silently no-ops (D1)
   until a province edits it. A real gap, named in guide step 2.
4. `TOTP_ENC_KEY` stops being rotatable the first time anyone enrols in 2FA —
   guide step 1, first item. The 28 refusals need a human; the script never will.
