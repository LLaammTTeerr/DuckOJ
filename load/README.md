# Load testing

`k6-contest-day.js` is a read-only contest-day profile: 2000 virtual users
ramped over 2 minutes and held for 3, split 70% problem browsing / 20%
scoreboard / 10% own-submissions. It never submits, registers, or writes
anything.

k6 is at `~/.local/bin/k6` on this host.

## Read this before running the full profile

**The full profile is not safe to point at a stack that is serving people.**
2000 VUs is not a health check; it is the load itself. Run it against a
stack nobody is using — a staging copy, or the production stack inside a
maintenance window you have announced — and never during a contest.

The 10-VU smoke profile below *is* safe against a live stack: it is ordinary
read traffic at roughly the rate of a few dozen users refreshing.

## Smoke (safe anywhere)

```
SMOKE=1 k6 run load/k6-contest-day.js
```

10 VUs for 20s. Use it to check the script still parses and every endpoint in
the mix answers 200 after a deploy.

## Full profile

```
BASE_URL=http://localhost:8080 \
CONTEST_KEY=probe-cup \
PROBLEM_CODE=aplusb \
SESSION_COOKIE=<a duckoj_session value> \
k6 run load/k6-contest-day.js
```

| Env | Default | Meaning |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:8080` | Stack root. Caddy publishes 8080/8443, not 80/443 — rootless podman cannot bind privileged ports. |
| `CONTEST_KEY` | `probe-cup` | Must be a contest that exists; `setup()` fails loudly if its scoreboard does not answer 200. |
| `PROBLEM_CODE` | `aplusb` | Must be a published, public problem. |
| `SESSION_COOKIE` | *(unset)* | Value of the `duckoj_session` cookie for a real logged-in account. |
| `SMOKE` | *(unset)* | `1` selects the 10-VU/20s profile. |
| `VUS` | *(unset)* | Selects a fixed-VU hold profile instead: ramp 10s, then hold this many. |
| `DURATION` | `60s` | How long `VUS` holds for. |

## Fixed-VU hold — `VUS=500 DURATION=60s`

    VUS=500 DURATION=60s k6 run load/k6-contest-day.js

Neither smoke nor the full profile is a load you can read a CPU measurement
off: one is too small to saturate anything, the other spends its first two
minutes ramping. This third profile ramps for 10 seconds and then genuinely
holds, so `cpu.stat` deltas taken during it describe a steady state.

It exists as an env-selected profile rather than `--vus/--duration` on the
command line because k6 refuses to mix execution sources — passing those
flags while the script sets `options.stages` is an error, not an override.

500 VUs is **not** safe against a stack serving people. It is a diagnosis
tool, not a smoke test.

### Why `SESSION_COOKIE` matters

`GET /api/v1/submissions` requires a session — unauthenticated it answers
401. **Without `SESSION_COOKIE` the 10% submissions leg is skipped** and its
share folds into problem browsing; `setup()` prints a warning saying so. The
run is then a valid public-read test but says nothing about the authenticated
path, which is the one that joins against `submissions` and is the more
likely thing to be slow. Get a cookie by logging in through the web UI and
copying `duckoj_session` out of the browser's dev tools.

## Reading the result

Three thresholds decide pass/fail; k6 exits non-zero if any is breached.

- `http_req_duration p(95)<800` — 95% of requests under 800ms. p95, not the
  mean: the mean hides exactly the tail people experience as an outage.
- `http_req_failed rate<0.01` — under 1% transport/5xx failures.
- `leg_errors rate<0.01` — under 1% of requests answered with the wrong
  status. This is the one that catches a leg that is "up" but answering 404
  or 401 for every request, which `http_req_failed` alone can miss.

Look past the thresholds at:

- **`vus` vs `vus_max`.** If `vus` never reaches the target, k6 could not
  start the VUs it wanted — the client machine ran out of file descriptors
  or CPU, and the numbers describe k6, not the server.
- **`http_reqs` per second, flat or falling while VUs rise.** That is
  saturation. The service is at its ceiling and latency is about to go
  vertical.
- **Which leg degraded.** Every request carries two tags: `leg` (this
  script's own, which `leg_errors` counts against) and k6's built-in `name`.
  The summary now prints a `p(95)` line per `name` without any extra flags,
  and each route has its own `p(95)<800` threshold, so a run always says
  *which* endpoint was slow — not merely that something was. They fail for
  entirely different reasons: scoreboard is per-request aggregation, problems
  is a cheap indexed list.

  A threshold over a metric with **zero samples passes silently**. Without
  `SESSION_COOKIE` the `submissions` leg never runs, so its line reads
  `p(95)=0s ✓` — read it together with that leg's request count, never alone.
- **`judged` and the judge are not exercised at all.** This profile is reads
  only. Grading throughput is a separate question — see docs/runbook.md,
  "Judging throughput".

## Last recorded sanity pass

10 VUs / 20s against `http://localhost:8080` on 2026-08-29, no session cookie
(so: public legs only), on the live stack:

```
checks_succeeded...: 100.00% 10695 out of 10695
http_req_duration..: avg=9.19ms med=7.57ms p(90)=17.38ms p(95)=23.96ms max=114.1ms
http_req_failed....: 0.00%  0 out of 10697
http_reqs..........: 10697  533.92/s
✓ 'p(95)<800'  ✓ 'rate<0.01' (http_req_failed)  ✓ 'rate<0.01' (leg_errors)
```

That is the script and the endpoints proven, and nothing more: 10 VUs is
three orders of magnitude off the profile's own target, so it is evidence of
correctness, not of capacity.

## The 2000-VU profile has been run — see `RESULTS.md`

`load/RESULTS.md` records every full-profile run against this stack with the
date, the commit, the per-route p95s and the container CPU that explains
them. Short version as of 2026-08-29: a single-process API held ~969 req/s at
p95 3.46s; clustered to four workers it holds ~1715 req/s at p95 2.28s, and
the remaining tail is the scoreboard endpoint recomputing the whole board on
every request. The 800ms threshold is not met yet, and `RESULTS.md` says what
would move it.
