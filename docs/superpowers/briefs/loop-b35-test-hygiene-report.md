# B-35 — "container contention" was a missing timeout, and four more test defects

Branch `worktree-agent-a0e5b66b35a9e4de9`, nothing pushed, one commit. **D149 spent** (policy, guard, three corollaries, an amendment, a
thermal postscript); **D144–D145 reserved and unspent**. No migration, no contract change, **no `src/` touched** — only test files,
vitest configs and DECISIONS.

**1. The D149 floor. 38 spec files ran container work on vitest's 5 s / 10 s defaults** — B-34 diagnosed one (`problem-comments`); the
audit found `app.smoke`, `route-marker-coverage`, `id-param-overflow` and `org-member-import`'s twenty-one cases among the rest, plus
**41** cases and `beforeAll`s that had opted DOWN to `60_000`/`30_000`. ONE mechanism, not 800 magic numbers: a new `vitest.config.ts`
in `apps/api`, `apps/judged`, `packages/db` declaring `testTimeout`/`hookTimeout` `180_000`, the 41 below-floor arguments deleted.
Red→green: a 7 s test passes with the config, "Test timed out in 5000ms" without it.

**2. The guard.** `apps/api/test/db-spec-timeout-policy.spec.ts`, a whole-workspace source scan in the `route-marker-coverage` /
`team-participation-invariant` shape: a package with container specs must declare both floors; no container-backed
`it`/`test`/`beforeAll`/`beforeEach` may pass an argument below `120_000`; discovery must stay ≥100 files so it cannot pass vacuously.
`afterAll`/`afterEach` exempt. Mutations: drop `testTimeout` → red; add `, 5_000` → red.

**3. Two blind spots in what already guarded us.** B-8's Redis guard scans for `const REDIS_DB = <n>;` and `problem-stats.spec.ts` wiped
Redis through an inline `ensureRedisUrl(2)` — invisible to it, so a second spec claiming 2 would have collided in silence. Constant
hoisted, two assertions added (a wiping spec must NAME its database; `flushall` banned); mutation: inline it again → red. And **web**'s
real budget is Testing Library's **1 s** `asyncUtilTimeout`, not vitest's — `submission-diff.spec.tsx` went red on it under `pnpm -r
test`, passed alone; `test/setup.ts` now sets 5 s for the package, `vite.config.ts` raises vitest to 30 s.

**4. Five cache specs asserted against the wall clock.** `SCOREBOARD_CACHE_TTL_MS` is **2 s** and two round trips do not always fit
inside it: `contest-scoreboard-cache` and `contest-booklet` each went `expected 'miss' to be 'hit'` once in seven runs, never in six
api-only runs. No timeout repairs that — the DATA expired, not the case. `cache.harness.ts`'s `longLivedCacheStore` is the REAL
`RedisScoreboardCacheStore` against the real container, through the `connect` seam its constructor already offers, `PX` floored at ten
minutes. It also makes two assertions honest: stub `del` and both invalidation cases now red, which they were not before.

## Measured

`apps/api` **134 files / 1172 tests** (B-34: 133/1167 — +1 file is the guard, +5 tests are 3 policy + 2 redis). Final tree, serial:
**134/1172 green, 712 s, no leaked containers**. Pre-directive at the 120 s floor: serial **3/3 green** (~12m30s each); `pnpm -r test`
**6/6 green** after fixes 3 and 4 (before them, 3 red in 7 — one web, two cache). **The parallel form is untested by policy and I did
not re-run it**: file parallelism put ~17 Testcontainers Postgres on this laptop and took it to 93 °C at load 18 — D106 already had CI
on `test:ci` for correctness and it is the thermal rule now too. The 120 s→180 s bump was bought by the one parallel red I did see:
`org-writes`'s container-start case, in a 279 s-wall run.

- **Left deliberately — ~800 redundant `≥120_000` arguments**: at the floor, so they change nothing; rewriting them is churn.
- **`judged`, `db`, `web` were not re-run on the FINAL tree**: green on the tree before, and the only later change is judged/db's config
  going 120 s→180 s, a strictly larger budget. k10temp read **91.9 °C** at the end of the api serial run (above the 85 °C stop rule) so
  the remaining three aborted by design — **even the fully serial api suite saturates this machine.**
- **Nothing is actually skipped** (nine `skipIf`s, all `TYPST_BIN`/corpus guards, and typst is installed here, so all nine ran); **no
  `.only` anywhere**; no shared mutable fixtures. **Sleeps audited, none changed** — `auth-totp`'s is bounded to the 30 s TOTP step,
  `rating-robustness`'s 1500 ms backs a NEGATIVE assertion a longer wait cannot improve, the rest is lock choreography.
- **`packages/db` keeps five private copies of the container harness**; **web's `asyncUtilTimeout` is not guard-enforced** (the guard's
  subject is packages that start containers, and `apps/web` starts none).

**Verify:** `-r typecheck`, `typecheck:scripts`, `-r lint`, `lint:scripts` green; contracts + SDK regen **no diff**; `vite build` and
`verify:csp` green. Live stack untouched — no `duckoj_*` container stopped, started or read.
