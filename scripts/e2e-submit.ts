/**
 * End-to-end proof that the walking skeleton works.
 *
 * This is the only test in the phase that exercises the real sandbox, and it
 * is the reason the phase exists. It cannot run in ordinary CI (it needs a
 * judge container), so its output is pasted into the acceptance report.
 */

// Rootless Podman cannot bind privileged ports without extra host
// configuration (see docs/runbook.md), so docker-compose.yml maps Caddy to
// 8080:80 and 8443:443, not 80/443. `https://localhost` would connect to 443
// and fail outright.
const BASE = process.env.E2E_BASE_URL ?? 'https://localhost:8443';

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'duckoj_session';

// The stack terminates TLS with a self-signed certificate under Caddy. This
// disables certificate verification for the WHOLE process, not just this
// request — acceptable only because this throwaway script talks exclusively
// to a local self-signed stack. Never copy this line into anything that also
// talks to the internet.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const CORRECT = `#include <iostream>
int main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}`;

const WRONG = `#include <iostream>
int main(){long long a,b;std::cin>>a>>b;std::cout<<0<<"\\n";}`;

const UNCOMPILABLE = `int main(){ this is not c++ }`;

// `hello` (`problems/hello/`) is a genuinely different problem from
// `aplusb` — string I/O instead of arithmetic — seeded separately by
// `scripts/seed-problem.ts hello`. Submitting against it exercises a
// package the judge has never seen materialise before this run: see
// docs/runbook.md's "A second problem: building, uploading, and diagnosing
// a package" for the before/after `/problems/<hash>/` check that proves
// the fetch actually happened, not just that the grading path works.
const HELLO_CORRECT = `#include <iostream>
#include <string>
int main(){std::string name;std::cin>>name;std::cout<<"Hello, "<<name<<"!\\n";}`;

let cookie = '';

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...init.headers },
    redirect: 'follow',
  });
  // `res.headers.get('set-cookie')` joins multiple Set-Cookie values into one
  // comma-separated string, which a naive `split(';')[0]` can mangle the
  // moment a response sets more than one cookie. `getSetCookie()` returns
  // them as a proper array; pick the session cookie by name, not position.
  const setCookies = res.headers.getSetCookie();
  const sessionSetCookie = setCookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (sessionSetCookie) cookie = sessionSetCookie.split(';')[0]!;
  return res;
}

async function submitAndWait(source: string, problemCode = 'aplusb'): Promise<Record<string, unknown>> {
  const created = await call('/submissions', {
    method: 'POST',
    body: JSON.stringify({ problemCode, languageKey: 'cpp17', source }),
  });
  if (created.status !== 201) throw new Error(`submit failed: ${created.status} ${await created.text()}`);
  const { id } = (await created.json()) as { id: number };

  const deadline = Date.now() + 120_000;
  for (;;) {
    const detail = (await (await call(`/submissions/${id}`)).json()) as Record<string, unknown>;
    if (detail.state === 'done' || detail.state === 'errored') return detail;
    if (Date.now() > deadline) throw new Error(`submission ${id} never finished; last state ${String(detail.state)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const username = `e2e${Date.now()}`;
await call('/auth/register', {
  method: 'POST',
  body: JSON.stringify({
    username,
    email: `${username}@example.com`,
    password: 'a-long-enough-password',
    displayName: 'E2E',
  }),
});
await call('/auth/login', {
  method: 'POST',
  body: JSON.stringify({ usernameOrEmail: username, password: 'a-long-enough-password' }),
});

const failures: string[] = [];

const accepted = await submitAndWait(CORRECT);
console.log('correct  →', accepted.verdict, `${String(accepted.points)}/${String(accepted.maxPoints)}`);
if (accepted.verdict !== 'AC') failures.push(`expected AC, got ${String(accepted.verdict)}`);
if (accepted.points !== 3) failures.push(`expected accepted points === 3, got ${String(accepted.points)}`);
if (accepted.maxPoints !== 3) failures.push(`expected accepted maxPoints === 3, got ${String(accepted.maxPoints)}`);

// WRONG always prints 0. Test case 02 is `-5 5`, whose expected output is
// also 0 — so this fixture accidentally passes exactly one of the three
// cases. That is deliberate (see task-15-brief.md's Controller addendum,
// F4): it is worth keeping rather than fixing, because it proves per-case
// points aggregate correctly through the driver, the event writer and the
// API, not just that the overall verdict lands on WA.
const wrong = await submitAndWait(WRONG);
console.log('wrong    →', wrong.verdict, `${String(wrong.points)}/${String(wrong.maxPoints)}`);
if (wrong.verdict !== 'WA') failures.push(`expected WA, got ${String(wrong.verdict)}`);
if (wrong.points !== 1) failures.push(`expected wrong points === 1, got ${String(wrong.points)}`);
if (wrong.maxPoints !== 3) failures.push(`expected wrong maxPoints === 3, got ${String(wrong.maxPoints)}`);

// A compile error came back as verdict `IE` for all of Phase 1 and 2a —
// `case_verdict` had no CE member, so `EventWriter` reused `IE` and this
// script deliberately asserted nothing but a non-empty `compileOutput`.
// Phase 2b Task 9 added `CE` to the enum and changed the mapping, and Task
// 13 confirmed `CE` against the real judge on a fresh stack, so the
// assertion is now the real one. If this ever regresses to `IE`, that is a
// bug in `apps/judged/src/event-writer.ts`, not an expected wart.
const broken = await submitAndWait(UNCOMPILABLE);
console.log('broken   →', broken.verdict, '| compileOutput:', String(broken.compileOutput ?? '').slice(0, 80));
if (broken.verdict !== 'CE') failures.push(`expected CE for uncompilable source, got ${String(broken.verdict)}`);
if (!broken.compileOutput) failures.push('expected a non-empty compileOutput for uncompilable source');

// A second, distinct problem — `hello` — not seeded until Task 14, and not
// materialised on the judge until this submission triggers `POST
// /packages/ensure`. AC here is the proof that a package the judge has
// never seen arrives on demand rather than the walking skeleton only ever
// having worked because `aplusb` happened to be pre-seeded.
const hello = await submitAndWait(HELLO_CORRECT, 'hello');
console.log('hello    →', hello.verdict, `${String(hello.points)}/${String(hello.maxPoints)}`);
if (hello.verdict !== 'AC') failures.push(`expected hello AC, got ${String(hello.verdict)}`);
if (hello.points !== 3) failures.push(`expected hello points === 3, got ${String(hello.points)}`);
if (hello.maxPoints !== 3) failures.push(`expected hello maxPoints === 3, got ${String(hello.maxPoints)}`);

if (failures.length > 0) {
  console.error('\nFAILED:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log('\nall four paths behaved as expected');
