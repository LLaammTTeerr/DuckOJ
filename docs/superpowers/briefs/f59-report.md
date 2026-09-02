# F-59 — The operator's first hour

**Status**: done. Both defects fixed, **D204** ruled. D205 and D206 unused.

**The live `judge-1` was NOT rotated.** No container was started, stopped or
restarted — `podman ps` shows the same uptimes as at the start of the slot
(`postgres`/`redis`/`caddy` 2 days, `judge` 18 h, `judged` 16 h, `api` 3 h).
`podman-compose`, `scripts/compose-up.sh` and `scripts/deploy.sh` were never
run. The live `.env` was **read, never written**. `apps/web/dist` was never
written and no `vite build` ran. Nothing under `.secrets/` was read by me,
printed or committed — the smoke scripts parse it by username to
authenticate, and every line they print names the username only. Nothing
pushed.

The live database was written only through the API, by the three smoke
scripts, and only rows they create by design: six accounts (`e2e…`,
`e2eset…`, `e2evie…`, `e2ecmp…`), three problems (`e2e-sum-…`, `e2e-cst-…`),
one contest (`e2e-contest-…`) and their submissions. Every one of those names
is claimed by an existing `scripts/cleanup-test-data.ts` pattern — `^e2e` for
user, contest and problem alike (D153) — so no pattern needed widening.
`promoteToAdminBySql`'s raw `UPDATE users …` is gone from both scripts, so
this slot performed **no** direct write to the live database at all.

---

## Commits

`HEAD` before the slot was `987061b`.

| | |
| --- | --- |
| `cf01626` | `feat(judge)` — `judge:node rotate`, and a poll that asks by credential not by name |
| `23dcb08` | `fix(scripts)` — the three smoke scripts run on a default deployment again |
| `fdd3552` | `docs(ops,guide)` — D204, and the rotation sequence a province can actually run |

---

## 1. What `rotate` does

`judge:node rotate <name>` mints a new token for a node that already exists,
keeps the row (so `grading_jobs.judge_node_id` goes on naming the machine that
graded each submission), prints the token once, and refuses the old one from
the moment it returns. It works on a **revoked** node and says so — that is
the escape hatch for a province that already ran the struck
`revoke judge-1 && add judge-1` and is standing in the dead end now.

**To a connected judge**: it disconnects it, within one revalidation poll
(five seconds). The half that makes this work is on the bridge. D81's poll
asked `admittedJudgeNames(ids)` — "does this name still have an unburned
token" — which is right for `revoke` and wrong for `rotate`: a rotated row is
neither gone nor burned, so the old judge would have answered *still
admitted*, kept its socket, kept being dispatched to, and been 401'd by the
API on every package fetch. That is exactly the half-working judge D81 was
written to kill, reached from the other direction. `BridgeServer` now keeps
`hashJudgeToken(key)` per connection — the digest, never the key — and the
poll is `admittedJudgeCredentials(pairs)`, matching `(name, token_hash)` in
SQL. Revoke, rotate and a hand-deleted row collapse into one rule: **a
connection whose credential is no longer the stored credential goes**, through
`retire`.

**To an in-flight submission**: it is **requeued, not failed**.
`DmojDriver.onJudgeGone` emits **no** `GradingEvent` and releases the lease
immediately (D29) — a permanent IE for a submission whose only misfortune was
being on the judge that was rotated is B2's failure shape. It is graded again
when a judge returns, and meanwhile dispatch **parks** rather than rejecting,
because an empty fleet waits (D68). The cost of a rotation is latency, not
verdicts.

**Yes, the container must be recreated** — and a `podman restart` is not
enough. The judge reads `JUDGE_TOKEN` from its own environment
(`judge/entrypoint.sh` renders `judge/judge.yml` from it at start), and a
container's environment is fixed when the container is created, so a restart
brings back the same dead token. This is said in the runbook, in
`truoc-khi-trien-khai.md` §1, in `quan-tri.md` §8 both halves, and in the
command's own output.

---

## 2. The sequence the controller must run to rotate `judge-1`

Verbatim, in this order. Steps 1–5 are `docs/runbook.md`, *Rotating a judge's
token*.

**0. Note what the live stack is running today.** `duckoj_migrate:latest` and
`duckoj_judged:latest` were built at `987061b`, before this work. I verified
both halves of that against the running stack:

```
$ podman run --rm --network duckoj_default --env-file .env \
    localhost/duckoj_migrate:latest \
    sh -c 'DATABASE_URL="…" packages/db/node_modules/.bin/tsx scripts/judge-node.ts rotate judge-1'
usage:
  judge:node add <name>       register a node and print its token (once)
  judge:node list             every registered node, and whether it is revoked
  judge:node revoke <name>    refuse the node's token, keeping its grading history
```

The deployed image has no `rotate` (it printed usage and wrote nothing), and
the deployed `judged` still polls by name, so **rotating against today's stack
would produce the zombie described above.** Step 1 is not optional.

**1. Deploy this branch.** `scripts/deploy.sh`. The done-condition is that the
command below runs instead of printing that usage block.

**2. Rotate, and keep the token.** `postgres` publishes no host port, so this
is a one-off container on the Compose network — the same invocation the
runbook already documents for `bootstrap:admin`, which I ran in its `list`
form against this stack and confirmed works:

```
podman run --rm --network duckoj_default --env-file .env \
  localhost/duckoj_migrate:latest \
  sh -c 'DATABASE_URL="postgres://duckoj:$POSTGRES_PASSWORD@postgres:5432/duckoj" \
         packages/db/node_modules/.bin/tsx scripts/judge-node.ts rotate judge-1'
```

The token is printed once and nothing can recover it. **From this second the
old token is refused everywhere** — the bridge handshake and the API's
package-fetch guard both go through `verifyJudgeCredential`.

**3. Put the new token in `.env`.** Replace `JUDGE_TOKEN=`'s value. Nothing
else needs editing: `judge/judge.yml` is a template rendered at container
start from `JUDGE_NAME`/`JUDGE_TOKEN`, and `scripts/seed-problem.ts` only ever
seeded the row this rotation has just replaced.

**4. RECREATE the judge — do not restart it.**

```
podman-compose up -d judge
```

(or `scripts/compose-up.sh`, which recreates everything and waits for health).
`podman restart judge` re-uses the environment the container was created with
and would bring the old, dead token straight back.

**5. Confirm, in three places.**

```
podman run … scripts/judge-node.ts list        # judge-1, revoked:false, a FRESH lastSeen
podman logs duckoj_judged_1 --since 2m 2>&1 | grep -i judge
corepack pnpm exec tsx scripts/e2e-submit.ts   # must end "all four paths behaved as expected"
```

`lastSeen` moving is the decisive one — it is written on the handshake and on
any packet after it, so a stale value means the new token was not accepted.
The `e2e-submit.ts` `AC` is the end-to-end proof: it goes through dispatch,
the bridge, a package fetch authenticated with the **new** token, and the
sandbox.

**What is unavailable, and for how long.** From the moment step 2 returns
until step 4's container is healthy, **no judge is connected**. Submissions
are accepted and **queued**; nothing is rejected and nothing is failed.
Anything mid-grade at step 2 is requeued and graded again afterwards. The
window is however long steps 3 and 4 take — an edit and a container start,
call it a minute unhurried. Throughout it, `judged` logs one
`judge handshake rejected` line per redial as the not-yet-recreated judge
retries with the old token: **that loop is the proof the old credential is
dead**, not a fault, and it stops at step 4. On the drop itself, `judged` logs
`dropping judge no longer admitted` once (renamed from D81's `dropping revoked
judge`, which would have sent an operator hunting a revocation nobody made).

**Do it outside a contest.** A queue that drains is still a room full of
pupils watching a spinner.

---

## 3. Tests

Red first, on `packages/db/test/judge-node-script.spec.ts` before any
implementation existed:

```
 FAIL  test/judge-node-script.spec.ts > judge-node.ts > refuses to re-register a name rather than silently rotating a live judge out
 FAIL  test/judge-node-script.spec.ts > judge-node.ts > admittedJudgeCredentials drops a revoked judge, which is how a live socket is closed (D81)
 FAIL  test/judge-node-script.spec.ts > judge-node.ts > rotate mints a new token and the OLD one stops being accepted (D204)
 FAIL  test/judge-node-script.spec.ts > judge-node.ts > rotate re-admits a REVOKED node, which is the only way out of the struck runbook sequence
 FAIL  test/judge-node-script.spec.ts > judge-node.ts > rotate refuses a name that was never registered
 FAIL  test/judge-node-script.spec.ts > judge-node.ts > rotate needs a node name, and says so with the usage line
      Tests  6 failed | 4 passed (10)
```

The case the brief asked for by name — *an old token stops being accepted* —
is asserted three ways in `rotate mints a new token and the OLD one stops
being accepted (D204)`: `verifyJudgeCredential` refuses the old token and
accepts the new one; `admittedJudgeCredentials` returns `[]` for a connection
holding the old digest and `['judge-rot']` for one holding the new; and the
row survives, so the grading-history join does too.

On the bridge, `apps/judged/test/bridge-auth.spec.ts` gained the live-socket
half: *drops a judge whose token was ROTATED, though its row is neither gone
nor revoked (D204)* drives a real fake judge over the real wire format, moves
the stored hash out from under it, and asserts the socket closes and
`onDisconnect` fires; *re-admits the judge once it reconnects holding the
rotated token* is the other side of step 4. The poll's own call shape is
pinned by *keeps a judge the poll still admits, and asks by (name,
credential)*.

Full suites of every package touched:

```
@duckoj/db        Test Files  20 passed (20)     Tests  106 passed (106)
@duckoj/judged    Test Files  19 passed (19)     Tests  150 passed (150)
@duckoj/web       Test Files  75 passed (75)     Tests  798 passed (798)
```

Plus `corepack pnpm --filter @duckoj/api exec vitest run
test/dockerfile-manifest.spec.ts` → `Tests  4 passed (4)` (CLAUDE.md's
cross-package guard), `pnpm typecheck:scripts`, `pnpm lint:scripts`, and
`@duckoj/web` typecheck + lint (which cover `e2e/credentials.ts`'s new
optional parameter). `apps/web/e2e/credentials.ts` was also exercised directly
to confirm both existing callers still resolve with no arguments:
`admin username: duckadmin | password resolved: true`, `student username:
hocsinh1 | password resolved: true`.

---

## 4. The three smoke scripts, against this live stack

Real output, final code, run back to back. All three exited `0`.

```
$ corepack pnpm exec tsx scripts/e2e-submit.ts
base=http://localhost:8080 admin=duckadmin pupil=e2e1788336888005

correct  → AC 3/3
         (metered — waiting 10s)
wrong    → WA 1/3
         (metered — waiting 10s)
broken   → CE | compileOutput: solution.cpp: In function ‘int main()’:
solution.cpp:1:13: error: invalid use of
         (metered — waiting 10s)
hello    → AC 3/3

all four paths behaved as expected
```

```
$ corepack pnpm exec tsx scripts/e2e-problem.ts
base=http://localhost:8080 admin=duckadmin problem=e2e-sum-1788336925638

   1. ok   signed in as duckadmin (globalRole=admin)
   2. ok   duckadmin registered e2eset1788336925638 and e2evie1788336925638
   3. ok   PATCH /admin/users/e2eset1788336925638 promoted them to setter
   4. ok   a plain user is refused problem creation (403 problem_forbidden)
   5. ok   POST /problems created e2e-sum-1788336925638 (private, author=e2eset1788336925638)
   6. ok   a private problem is invisible (404 problem_not_found) to a non-member
   7. ok   POST /packages stored c65df540c60de887b896c10c5983e17886a85d34da17e3e84cad77cb48ad276d (9 files, 434 bytes)
   8. ok   revision 1 attached: 2000ms / 131072KiB / 4 tests / 10 points / standard
   9. ok   submitting against an unpublished revision is refused (409 problem_not_submittable)
  10. ok   revision 1 published
  11. ok   PATCH /problems/:code made it public
  12. ok   anonymous callers see the published public problem in both list and detail
      correct → AC 10/10
  13. ok   a correct submission graded AC 10/10 against a package uploaded over HTTP this run
      … metered, waiting 10s
      broken  → CE | compileOutput: solution.cpp: In function ‘int main()’: solution.cpp:1:13: e
  14. ok   uncompilable source came back CE from a real judge

every step of the problems path behaved as expected
```

```
$ corepack pnpm exec tsx scripts/e2e-contest.ts
base=http://localhost:8080 admin=duckadmin problem=e2e-cst-1788336941758 contest=e2e-contest-1788336941758

   1. ok   duckadmin registered e2eset1788336941758 (setter) and e2ecmp1788336941758
   2. ok   published a private problem e2e-cst-1788336941758 (9 package files)
   3. ok   POST /contests created e2e-contest-1788336941758 (icpc, public, 1 problem)
   4. ok   the contest problem is invisible (404) to a competitor who has not joined
   5. ok   submitting before joining is refused at the problem, not at the participation
   6. ok   joined e2e-contest-1788336941758 (idempotently), and the private problem is now visible in read and list
   7. ok   submission 1094 graded AC 10/10 by a real judge
   8. ok   the scoreboard scores e2ecmp1788336941758 100 — derived from submission_cases, not a stored column
      … metered, waiting 10s
   9. ok   an AC submitted without contestKey grades normally and does NOT touch the scoreboard

All 9 steps passed.
```

Nothing was set in the environment for any of those runs — no
`E2E_BASE_URL`, no `E2E_ADMIN_PASSWORD`. `base=http://localhost:8080` is
derived from `.env`'s own `SITE_ADDRESS=:80`, and `admin=duckadmin` came from
`.secrets/duckadmin.txt` through the Playwright walks' own parser.

### Two more defects the running found

F-58 named two (the base URL and the anonymous register). Running the scripts
turned up two more of exactly the same shape — **assumptions about a stack
nobody has used yet**:

- **The submission meter.** `POST /submissions` allows one per ten seconds per
  account (D26/D80, no exemption for admins), and all three scripts submit
  three or four times back to back, so every run died on a `429` with a stack
  trace. They now wait out the server's own `Retry-After` and say so — the
  `metered, waiting 10s` lines above.
- **`e2e-contest.ts` asserted its problem appears in a bare `GET /problems`.**
  That list is cursor-paged, so the assertion holds on a nearly-empty database
  and fails on an instance carrying dozens of problems — which this one does.
  It filters with `?q=` now, which is what `e2e-problem.ts` step 12 already
  did.

`promoteToAdminBySql` is retired from both scripts. It registered an
`e2eadm<epoch>` anonymously (a 403 under D200) and promoted it with a `podman
exec` into the postgres container, to prove the runbook's bootstrap SQL
bootstraps — a step `scripts/bootstrap-admin.ts` (D19) replaced, with
`bootstrap-admin.spec.ts` proving it against a real database. What is left
uses what an operator HAS, writes only through the API, and needs no podman.

The admin parser is **imported** from `apps/web/e2e/credentials.ts`, not
re-implemented: two parsers of one secrets file is how one of them ends up
authenticating as whoever is written last. That file gained one optional
parameter (the default secrets path, because Playwright runs from `apps/web`
and these run from the repo root); every existing caller is unchanged.

---

## 5. What I could not finish

- **The live `judge-1` is still on the seeded token.** By instruction: the
  rotation's second half is a container recreate, which this slot may not
  perform, and rotating without it leaves this host unable to grade. §2 is the
  sequence; it is untested end to end on this host and cannot be until
  somebody may deploy and recreate.
- **The rotation sequence's steps 1–5 were not executed.** Two of their
  components were verified individually against the live stack — the one-off
  `podman run … judge-node.ts list` invocation works and printed `judge-1`,
  and the deployed image's lack of `rotate` was confirmed by running it (it
  printed usage and wrote nothing). The rotate → drop → recreate → re-admit
  cycle itself is proven only in `bridge-auth.spec.ts` against a fake judge
  over the real wire format, and in `judge-node-script.spec.ts` against a real
  Postgres. **Nothing has driven it against a real dmoj judge-server**, and
  the one assumption that carries is that a recreated container's fresh
  handshake looks to `BridgeServer` exactly like any other — which it does in
  the spec, and which D68 already relies on for a judge that restarts.
- **`judged`'s displacement path was not re-verified under rotation.** If a
  judge somehow redialled with the NEW token while the old connection was
  still in the map, the handshake's displacement branch would retire the old
  entry and the new digest is recorded after it (deliberately — `retire`
  clears the map). That ordering is argued in the code and covered by the
  reconnect test, but not by a test that races the two.
- **No Playwright walk was run.** `apps/web/e2e/credentials.ts` changed, and
  it was checked by typecheck, lint, and a direct call of both exported
  functions; the browser suite itself was not run, on the slot's thermal
  budget. The change is a defaulted optional parameter and every existing call
  site passes no argument.
- **The `metered, waiting 10s` waits are wall-clock.** Three scripts now take
  roughly 30–40 s longer each than they used to. That is the meter's price and
  not something the scripts should be exempt from (D80 is explicit that admins
  are not), but a province timing their first hour should know.
