# Task P4 — first-admin bootstrap + five demo problems

Branch `worktree-agent-a33ac2f450a6db5eb`; commits `262f016`, `4a5b989`, + this one.

**1. `scripts/bootstrap-admin.ts`** — `corepack pnpm bootstrap:admin <username> [--email e] [--password p]` against `DATABASE_URL`: creates the user when absent (argon2id via the new `apps/api/src/authn/password.hash.ts`, `email_verified_at = now()`, random printed password if `--password` is omitted) and **only** promotes when present. Exports `bootstrapAdmin(db, opts)`; root script added to `package.json`; `password.service.ts` is now a delegate over that framework-free module. The runbook's "Bootstrapping the first admin" prescribes the command and keeps the `UPDATE` as the documented recovery fallback.

**2. `content/problems/<code>/`** — `tong-hai-so`, `so-nguyen-to`, `day-con-tang`, `duong-di-ngan-nhat`, `cay-khung-nho-nhat`, each with `problem.xml`, `statement.md` (Vietnamese + an English section, D10), `solution.cpp`, `gen.py`, and 12 tests in groups `samples`/`nho`/`lon` worth 0/40/60 points. `content/gen_common.py` writes each input and runs the freshly compiled model solution on it to produce the `.a` in the same pass, so a test and its answer cannot come from different versions of the solution. `content/README.md` carries the import → build → upload → attach → publish sequence. D19/D20 (renumbered at merge from D16/D17) added to `docs/DECISIONS.md`.

## Tests — `packages/db/test/bootstrap-admin.spec.ts` (4 tests, subprocess CLI)

Red before the script existed: 3 failed / 1 passed (the empty-password case passed vacuously). Then one mutation per behaviour, each shown red and restored:

| Mutation | Failing assertion |
| --- | --- |
| drop the empty/short-password refusal | `expect(result.code).not.toBe(0)` |
| promote also sets `passwordHash` | `after.passwordHash === before.passwordHash` |
| `memoryCost` 19_456 → 8_192 | `/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/` |
| drop `emailVerifiedAt` | `expect(user.emailVerifiedAt).not.toBeNull()` |
| constant generated password | `expect(b).not.toBe(a)` |

Then 4/4 green. Full gate green: `-r typecheck`, `typecheck:scripts`, `-r lint`, `lint:scripts`, `-r test` (905 tests / 121 files, 0 failures), contracts + SDK regen leaving no diff, and `@duckoj/web` `vite build`.

**Content proof.** All five ran through `polygon:import` to a temp dest: `imported "Sum of two numbers": 12 tests, 1000 ms / 262144 KB, checker standard` (the other four identical at 2000 ms), each with `skipped: statements` and `skipped: solutions`; all five then `package:build` to 25-file packages. Every model solution reproduced all 12 of its committed `.a` files, the two samples included.

## Rulings (no one to ask)

1. The briefs are absent from this worktree (untracked in the shared checkout) — read from there; this report creates `docs/superpowers/briefs/`.
2. The test lives in `packages/db/test/`, not `scripts/__tests__/`: root-script tests already live there (`seed-script.spec.ts`), it is the only place `pnpm -r test` reaches, and `apps/api/test/` cannot import the script under its `rootDir: "."`.
3. `password.hash.ts` extracted — one file outside the brief's touch list, sanctioned by its "import from there": `@Injectable()` needs `reflect-metadata` at import time, and `scripts/tsconfig.json` has no `experimentalDecorators`.
4. `email_verified=true` → `emailVerifiedAt: new Date()`, the real column name.
5. Refuses passwords under 10 characters, not merely empty — the `Password` contract's own bound. Stricter than the brief asked.
6. `--email` defaults to `<username>@bootstrap.local`; promotion touches neither password nor address; an already-`admin` row is a printed no-op.
7. Standard checker for all five: every answer is a single integer, so `wcmp` and the standard token comparison coincide. No testlib.
8. Committed tests are deliberately sub-maximal (largest N/M = 5000, ~1.2 MB total), each generator exposing `LARGE_N`/`LARGE_M` for bound-sized data — **so as committed they do not prove a solution is fast enough at the constraints the statements advertise.**
9. The runbook's second `UPDATE` (§Phase 2b) is a transcript of a real run, so it is annotated rather than rewritten.
10. `__pycache__/` added to `.gitignore` — the generators produce it.

**Concerns (none blocking).** `apps/web/test/orgs.spec.tsx` went red once under load (`findByRole` timeout) and green on rerun; nothing in this task touches `apps/web`. `gen.py` output is byte-reproducible for a given Python version, not guaranteed across major ones (3.14 here). Nothing was run against the live stack — `content/README.md`'s upload sequence is assembled from the runbook's verified commands, not re-executed.
