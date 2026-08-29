// Contest-day read load for DuckOJ.
//
// Models what a province-scale contest actually does to the stack: almost
// everyone is reading problem statements, a fifth are refreshing the
// scoreboard, and a tenth are looking at their own submissions. It is
// deliberately READ-ONLY — it never submits, never registers, never writes.
// A write mix would need real accounts and would leave rows behind in a
// database this script has no business mutating.
//
// Run it:  k6 run load/k6-contest-day.js       (see load/README.md)
// Env:     BASE_URL, CONTEST_KEY, PROBLEM_CODE, SESSION_COOKIE, SMOKE=1,
//          VUS + DURATION (a fixed-VU hold, for diagnosis)
//
// SMOKE=1 swaps the full profile for 10 VUs over 20s — enough to prove the
// script parses and the endpoints answer, and small enough to point at a
// stack that is serving real users. The full profile is NOT safe to point at
// a live stack; read load/README.md before you do.

/* global __ENV, console */
// k6 injects `__ENV` and a `console` into the VU runtime; neither is a browser
// or Node global, so ESLint's `no-undef` cannot know about them. Declared here
// rather than in eslint.config.js because this directory is outside the lint
// gate (`pnpm -r lint` + `lint:scripts`) and should not need a config entry to
// stay clean under a broader `eslint .`.

import http from 'k6/http';
import { check, group } from 'k6';
import { Rate } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const CONTEST_KEY = __ENV.CONTEST_KEY || 'probe-cup';
const PROBLEM_CODE = __ENV.PROBLEM_CODE || 'aplusb';
const SESSION_COOKIE = __ENV.SESSION_COOKIE || '';
const SMOKE = __ENV.SMOKE === '1';
// A third, explicit profile for diagnosis: `VUS=500 DURATION=60s`. It exists
// because k6 refuses to mix execution sources — passing `--vus/--duration` on
// the command line while `options.stages` is set is an error, not an override
// — so a "hold N VUs for D" measurement run has to be selectable from inside
// the script. Neither smoke nor the full profile answers "what is saturated
// right now"; this one does, at a load small enough to sample `podman stats`
// through.
const VUS = Number(__ENV.VUS || 0);
const DURATION = __ENV.DURATION || '60s';

// GET /submissions is @RequireScope, not @Public: unauthenticated it answers
// 401, which is the correct answer and not a failure — but it also means the
// 10% leg measures the guard rather than the query. Without a cookie the leg
// is skipped and its share folds into problem browsing, and `setup` says so
// out loud, so a run is never quietly narrower than the profile claims.
const AUTHED = SESSION_COOKIE !== '';

const smokeStages = [{ duration: '20s', target: 10 }];
// A 10s ramp then a real hold. A single `{ duration, target }` stage is a
// LINEAR RAMP from whatever is running now (zero, at start) — so
// `VUS=500 DURATION=60s` as one stage averages ~250 VUs and never holds 500
// at all, which is exactly the wrong shape for reading a CPU sample off.
const holdStages = [
  { duration: '10s', target: VUS },
  { duration: DURATION, target: VUS },
];
const fullStages = [
  // 2 minutes to 2000, then hold 3. The ramp is part of the test: a stack
  // that survives 2000 steady VUs can still fall over on the arrival rate,
  // which is what the first minutes of a contest actually look like.
  { duration: '2m', target: 2000 },
  { duration: '3m', target: 2000 },
  { duration: '30s', target: 0 },
];

/** Non-2xx per leg, so a failure can be attributed without reading the log. */
const legErrors = new Rate('leg_errors');

export const options = {
  stages: SMOKE ? smokeStages : VUS > 0 ? holdStages : fullStages,
  thresholds: {
    // The brief's acceptance bar. p95, not mean: the mean hides the tail that
    // people actually experience as "the site is down".
    'http_req_duration': ['p(95)<800'],
    'http_req_failed': ['rate<0.01'],
    'leg_errors': ['rate<0.01'],
    // The same bar again, once per route. An aggregate p95 says the stack is
    // slow; it never says *which* endpoint spent the time, and the three legs
    // fail for entirely different reasons (scoreboard is aggregation, the
    // problem list is a cheap indexed read, submissions joins under a
    // session). These are `abortOnFail: false` by construction — k6 reports
    // every crossed threshold — so a run always yields the full per-route
    // breakdown rather than stopping at the first one over.
    //
    // A threshold whose metric took ZERO samples passes silently: without
    // SESSION_COOKIE the `submissions` leg never runs, so its line below is
    // vacuously green. Read it together with the leg's request count.
    'http_req_duration{name:problems_list}': ['p(95)<800'],
    'http_req_duration{name:problem_detail}': ['p(95)<800'],
    'http_req_duration{name:scoreboard}': ['p(95)<800'],
    'http_req_duration{name:submissions}': ['p(95)<800'],
  },
  // Connection reuse on: 2000 VUs each opening a fresh TCP+TLS connection per
  // iteration measures the kernel's accept backlog, not the API.
  noConnectionReuse: false,
  discardResponseBodies: false,
};

function headers() {
  return SESSION_COOKIE ? { Cookie: `duckoj_session=${SESSION_COOKIE}` } : {};
}

// `leg` AND `name`: they are not redundant. `leg` is this script's own tag,
// which `leg_errors` and load/README.md's breakdown instructions already use.
// `name` is k6's built-in URL-grouping system tag — thresholds and the
// end-of-run summary sub-metrics key off it, and a sub-metric can only be
// defined over tags k6 collects by default. Setting both means the per-route
// thresholds above work without changing what `leg` means to anything that
// already reads it.
function get(name, path, expected) {
  const res = http.get(`${BASE_URL}${path}`, {
    headers: headers(),
    tags: { leg: name, name },
  });
  const ok = check(res, { [`${name} -> ${expected}`]: (r) => r.status === expected });
  legErrors.add(!ok);
  return res;
}

export function setup() {
  const problems = http.get(`${BASE_URL}/api/v1/problems`);
  if (problems.status !== 200) {
    throw new Error(`GET /api/v1/problems answered ${problems.status} at ${BASE_URL} — wrong BASE_URL, or the stack is down`);
  }
  const scoreboard = http.get(`${BASE_URL}/api/v1/contests/${CONTEST_KEY}/scoreboard`);
  if (scoreboard.status !== 200) {
    throw new Error(`GET /api/v1/contests/${CONTEST_KEY}/scoreboard answered ${scoreboard.status} — set CONTEST_KEY to a contest that exists`);
  }
  if (!AUTHED) {
    console.warn('SESSION_COOKIE is unset: the 10% GET /submissions leg is SKIPPED and folded into problem browsing. This run does not cover the authenticated read path.');
  }
  return { authed: AUTHED };
}

export default function (data) {
  const roll = Math.random();

  if (roll < 0.7 || (roll >= 0.9 && !data.authed)) {
    group('problems', () => {
      get('problems_list', '/api/v1/problems', 200);
      get('problem_detail', `/api/v1/problems/${PROBLEM_CODE}`, 200);
    });
    return;
  }

  if (roll < 0.9) {
    group('scoreboard', () => {
      get('scoreboard', `/api/v1/contests/${CONTEST_KEY}/scoreboard`, 200);
    });
    return;
  }

  group('submissions', () => {
    get('submissions', '/api/v1/submissions', 200);
  });
}
