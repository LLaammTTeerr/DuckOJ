import { StrictMode, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoginForm, type LoginValues } from './routes/login.js';
import { SubmitPage } from './routes/submit.js';
import { ProblemsPage } from './routes/problems.js';
import { ProblemPage } from './routes/problem.js';
import { ProblemEditPage } from './routes/problem-edit.js';
import { ProblemRevisionsPage } from './routes/problem-revisions.js';
import { api } from './api.js';
import './app.css';

const queryClient = new QueryClient();

type Route =
  | { name: 'problems' }
  | { name: 'problem'; code: string }
  | { name: 'problem-new' }
  | { name: 'problem-edit'; code: string }
  | { name: 'problem-revisions'; code: string }
  | { name: 'root' };

// There is still no router — `@tanstack/react-router` remains an open
// question the rest of this file's history explains — so this is the
// smallest thing that lets each of Task 11's and Task 12's pages have a
// real, bookmarkable URL without resolving that question: read
// `window.location.pathname` once per render and match it against the
// shapes this app's problem pages need. Everything else falls through to
// `root`, which keeps today's auth-gate behaviour exactly as it was. Links
// to these pages are plain `<a href>` — a full navigation, not a
// client-side transition — which this matches: there is no History API
// listener here, so a route only ever changes on an actual page load.
//
// The three new shapes below (`/problems/new`, `/problems/:code/edit`,
// `/problems/:code/revisions`) MUST be checked before the plain
// `/problems/:code` pattern: a problem code's own grammar (contracts'
// `PROBLEM_CODE`) does not exclude the literal string "new", so
// `/problems/new` would otherwise parse as `{ name: 'problem', code: 'new' }`
// — this file's one genuinely fragile spot, and worth flagging for Task
// 13/Phase 3: a fifth route is still
// tractable by hand, but each new static segment under `/problems/:code/…`
// adds one more place that ordering has to be gotten right by eye rather
// than by a router's own path-specificity resolution.
function parseRoute(pathname: string): Route {
  if (pathname === '/problems' || pathname === '/problems/') return { name: 'problems' };
  if (pathname === '/problems/new' || pathname === '/problems/new/') return { name: 'problem-new' };
  // No `decodeURIComponent` on any `code` capture below: a problem code is
  // `[a-z0-9][a-z0-9_-]{1,63}` (contracts' `PROBLEM_CODE`), so it never
  // needs percent-decoding, and decoding a malformed segment (e.g.
  // `/problems/%zz/edit`) would throw a `URIError` mid-render and
  // white-screen the whole app for no benefit.
  const editMatch = /^\/problems\/([^/]+)\/edit\/?$/.exec(pathname);
  if (editMatch) return { name: 'problem-edit', code: editMatch[1]! };
  const revisionsMatch = /^\/problems\/([^/]+)\/revisions\/?$/.exec(pathname);
  if (revisionsMatch) return { name: 'problem-revisions', code: revisionsMatch[1]! };
  const match = /^\/problems\/([^/]+)\/?$/.exec(pathname);
  if (match) return { name: 'problem', code: match[1]! };
  return { name: 'root' };
}

/**
 * Sign in, or see the submit page — unchanged from before Task 11. The
 * problems browser (`/problems`, `/problems/:code`) is deliberately routed
 * *outside* this auth gate below: the API already supports anonymous
 * visibility for public problems, and a signed-in viewer's session cookie
 * still rides along automatically, so gating the browser on `me` would only
 * take away something the API already allows. `LoginForm` and the
 * `/auth/me` check both already existed (an earlier phase's scaffold) but
 * nothing rendered them; wiring them together here is what makes Task 15's
 * "open the page, sign in, submit" manual check reachable at all.
 *
 * Task 12's authoring routes (`/problems/new`, `/problems/:code/edit`,
 * `/problems/:code/revisions`) are routed outside the gate for the same
 * reason, not a new one: every write those pages attempt still goes through
 * the API's own authz, and an anonymous or under-privileged attempt fails
 * with the API's error `code` shown verbatim on the page (`problem_forbidden`,
 * and so on) rather than a client-side redirect masking why.
 */
function App() {
  const client = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await api.GET('/auth/me');
      return data ?? null;
    },
  });
  const [loginError, setLoginError] = useState<string | null>(null);
  const [needsTotp, setNeedsTotp] = useState(false);

  const route = parseRoute(window.location.pathname);

  async function handleLogin(values: LoginValues): Promise<void> {
    const { error } = await api.POST('/auth/login', {
      body: {
        usernameOrEmail: values.usernameOrEmail,
        password: values.password,
        ...(values.totpCode ? { totpCode: values.totpCode } : {}),
      },
    });
    if (error) {
      setLoginError(error.detail ?? 'Sign in failed.');
      setNeedsTotp(error.code === 'totp_required' || error.code === 'invalid_totp_code');
      return;
    }
    setLoginError(null);
    await client.invalidateQueries({ queryKey: ['me'] });
  }

  return <Shell me={me.data ?? null}>{renderRoute()}</Shell>;

  function renderRoute() {
    if (route.name === 'problems') return <ProblemsPage />;
    if (route.name === 'problem-new') return <ProblemEditPage />;
    if (route.name === 'problem-edit') return <ProblemEditPage code={route.code} />;
    if (route.name === 'problem-revisions') return <ProblemRevisionsPage code={route.code} />;
    if (route.name === 'problem') return <ProblemPage code={route.code} />;

    if (me.isLoading) return <p>Loading…</p>;
    if (!me.data) return <LoginForm onSubmit={handleLogin} error={loginError} needsTotp={needsTotp} />;

    return <SubmitPage />;
  }
}

/**
 * The shell: one nav, one column, on every route.
 *
 * It lives here rather than in each page because the problems routes render
 * OUTSIDE the auth gate — a signed-out visitor browsing `/problems` previously
 * had no route back to the sign-in form, which exists only at `/`. That gap
 * was found by a human clicking around, not by any test, and a shared nav is
 * what stops it recurring for every route added from here on.
 *
 * `me` is passed in rather than queried again so the nav cannot disagree with
 * the page about who is signed in.
 */
function Shell({ me, children }: { me: { displayName: string } | null; children: ReactNode }) {
  return (
    <>
      <nav className="shell-nav">
        <div>
          <strong>DuckOJ</strong>
          <a href="/problems">Problems</a>
          <a href="/api/v1/docs">API</a>
          {me ? <span>Signed in as {me.displayName}</span> : <a href="/">Sign in</a>}
        </div>
      </nav>
      <main>{children}</main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
