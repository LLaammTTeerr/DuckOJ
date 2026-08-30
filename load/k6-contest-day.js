// Contest-day read load for DuckOJ.
//
// Models what a province-scale contest actually does to the stack: most of
// the room is reading problem statements and browsing the catalogue, a sixth
// are refreshing the scoreboard, a tenth are looking at their own
// submissions, and a thin tail pulls the clarification feed, a problem's
// statistics and the printable booklet. It is
// deliberately READ-ONLY — it never submits, never registers, never writes.
// A write mix would need real accounts and would leave rows behind in a
// database this script has no business mutating.
//
// Run it:  k6 run load/k6-contest-day.js       (see load/README.md)
// Env:     BASE_URL, CONTEST_KEY, PROBLEM_CODE, TAG_SLUG, SESSION_COOKIE,
//          SMOKE=1, VUS + DURATION (a fixed-VU hold, for diagnosis)
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
// The tag the filtered-list leg asks for. Resolved in `setup` from the live
// `GET /tags` when unset, rather than hardcoded: the tag corpus is seeded
// content (D35) and a slug that does not exist would still answer 200 with an
// empty page — a leg that measures nothing while looking green.
const TAG_SLUG = __ENV.TAG_SLUG || '';
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
    // The reads the feature loop added after this file was written. Same bar,
    // same reasoning; `booklet` gets it too even at 1% weight, because a
    // typst compile behind a 60 s cache is the one leg here whose MISS is
    // seconds rather than milliseconds and a p95 is exactly how that shows.
    'http_req_duration{name:tags_list}': ['p(95)<800'],
    'http_req_duration{name:problems_filtered}': ['p(95)<800'],
    'http_req_duration{name:problem_stats}': ['p(95)<800'],
    'http_req_duration{name:clarifications}': ['p(95)<800'],
    'http_req_duration{name:booklet}': ['p(95)<800'],
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

  // Resolve the tag ONCE, here, not per-VU: `setup` runs in its own context
  // and its return value is handed to every iteration, so this is one request
  // for the whole run rather than 2000 of them racing at ramp-up.
  let tag = TAG_SLUG;
  if (tag === '') {
    const tags = http.get(`${BASE_URL}/api/v1/tags`);
    if (tags.status !== 200) {
      throw new Error(`GET /api/v1/tags answered ${tags.status} — set TAG_SLUG to skip the lookup`);
    }
    const items = tags.json('items');
    if (!items || items.length === 0) {
      throw new Error('GET /api/v1/tags returned no tags — seed the tag corpus, or set TAG_SLUG');
    }
    tag = items[0].slug;
  }
  // A filter that matches nothing still answers 200, so the leg would look
  // green while measuring an empty page. Say so rather than fail: an empty
  // result is a legitimate state of a fresh deployment, and the run is still
  // useful for every other leg.
  const filtered = http.get(`${BASE_URL}/api/v1/problems?tag=${encodeURIComponent(tag)}`);
  const filteredCount = filtered.status === 200 ? (filtered.json('items') || []).length : -1;
  if (filteredCount <= 0) {
    console.warn(`GET /api/v1/problems?tag=${tag} matched no problems: the problems_filtered leg measures an EMPTY page.`);
  }

  // The booklet is 404 before a contest starts (D48) and 501 on a server with
  // no typst, and either way it is not this profile's job to fail the run over
  // a leg the deployment cannot serve. Probed once, and skipped for the whole
  // run if it does not answer 200.
  const booklet = http.get(`${BASE_URL}/api/v1/contests/${CONTEST_KEY}/booklet.pdf`);
  if (booklet.status !== 200) {
    console.warn(`GET /api/v1/contests/${CONTEST_KEY}/booklet.pdf answered ${booklet.status}: the booklet leg is SKIPPED and folded into problem browsing.`);
  }

  return { authed: AUTHED, tag, booklet: booklet.status === 200 };
}

// The mix. Reading down: statement browsing is still the bulk of it, the
// scoreboard keeps its share, and the loop's new reads take the tail in
// proportion to how a room actually reaches them — the catalogue filter and
// the tag list are one navigation step off the problem list, a problem's
// statistics are a scroll past its statement, the clarification feed is what
// the contest page polls every 30 s, and the booklet is a thing a handful of
// people download once. Every unavailable leg folds back into problem
// browsing so the profile's total is always 1 and the rows still compare.
//
// | leg                 | share |
// | problems            |  45%  |
// | problems_filtered   |  10%  |
// | tags_list           |   5%  |
// | problem_stats       |   8%  |
// | scoreboard          |  17%  |
// | clarifications      |   4%  |
// | submissions (authed)|  10%  |
// | booklet             |   1%  |
export default function (data) {
  const roll = Math.random();

  if (roll < 0.45) {
    group('problems', () => {
      get('problems_list', '/api/v1/problems', 200);
      get('problem_detail', `/api/v1/problems/${PROBLEM_CODE}`, 200);
    });
    return;
  }

  if (roll < 0.55) {
    group('catalogue', () => {
      get('problems_filtered', `/api/v1/problems?tag=${encodeURIComponent(data.tag)}`, 200);
    });
    return;
  }

  if (roll < 0.6) {
    group('catalogue', () => {
      get('tags_list', '/api/v1/tags', 200);
    });
    return;
  }

  if (roll < 0.68) {
    group('problems', () => {
      get('problem_stats', `/api/v1/problems/${PROBLEM_CODE}/stats`, 200);
    });
    return;
  }

  if (roll < 0.85) {
    group('scoreboard', () => {
      get('scoreboard', `/api/v1/contests/${CONTEST_KEY}/scoreboard`, 200);
    });
    return;
  }

  if (roll < 0.89) {
    group('contest', () => {
      get('clarifications', `/api/v1/contests/${CONTEST_KEY}/clarifications`, 200);
    });
    return;
  }

  if (roll < 0.99) {
    if (data.authed) {
      group('submissions', () => {
        get('submissions', '/api/v1/submissions', 200);
      });
      return;
    }
    group('problems', () => {
      get('problems_list', '/api/v1/problems', 200);
      get('problem_detail', `/api/v1/problems/${PROBLEM_CODE}`, 200);
    });
    return;
  }

  if (data.booklet) {
    group('contest', () => {
      get('booklet', `/api/v1/contests/${CONTEST_KEY}/booklet.pdf`, 200);
    });
    return;
  }
  group('problems', () => {
    get('problems_list', '/api/v1/problems', 200);
    get('problem_detail', `/api/v1/problems/${PROBLEM_CODE}`, 200);
  });
}
