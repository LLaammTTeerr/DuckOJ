import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, createRootRoute, createRoute, createRouter, useParams, useSearch } from '@tanstack/react-router';
import { LoginForm, type LoginValues } from './routes/login.js';
import { DEFAULT_PROBLEM_CODE, SubmitPage } from './routes/submit.js';
import { ProblemsPage } from './routes/problems.js';
import { ProblemPage } from './routes/problem.js';
import { ProblemEditPage } from './routes/problem-edit.js';
import { ProblemRevisionsPage } from './routes/problem-revisions.js';
import { HomePage } from './routes/home.js';
import { api } from './api.js';

/**
 * `/auth/me`, as a shared query-options object rather than inlined at every
 * call site. Every route component below that calls `useQuery(meQueryOptions)`
 * reads and writes the *same* react-query cache entry (`['me']`) through the
 * one `QueryClient` created in `main.tsx` — this is what makes the session
 * check shared across client-side transitions instead of re-fetched on every
 * one, unlike before this task (see this file's history / the task report
 * for why that is a deliberate, not accidental, behaviour change).
 */
function fetchMe() {
  return api.GET('/auth/me').then(({ data }) => data ?? null);
}

const meQueryOptions = { queryKey: ['me'] as const, queryFn: fetchMe };

/**
 * Sign-in wiring shared by the two places that can show `LoginForm`: the
 * root/index route (signed out at `/`) and `/submit` (signed out, told to
 * sign in before submitting). Each caller gets its OWN `loginError`/
 * `needsTotp` state — deliberately not lifted any higher — so those two
 * ephemeral UI states still reset on navigation between them, matching the
 * pre-router behaviour where every navigation was a full page load. Only
 * `me` itself (via `meQueryOptions`, above) is shared.
 */
function useAuthGate() {
  const client = useQueryClient();
  const me = useQuery(meQueryOptions);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [needsTotp, setNeedsTotp] = useState(false);

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

  return { me, loginError, needsTotp, handleLogin };
}

/**
 * The shell: one nav, one column, on every route. Unchanged from before this
 * task except that the in-app links (`Problems`, `Sign in`) are now
 * `<Link>` — a client-side transition — while `/api/v1/docs` stays a plain
 * `<a>`: it is Scalar's own page, entirely outside this router's tree, and a
 * `<Link>` there would have nothing to resolve.
 *
 * `me` is read here directly (not passed down) because this is now the root
 * route's own component, rendered once for every child route via `<Outlet
 * />` — there is no longer an `App` component above it to thread the value
 * through.
 */
function RootComponent() {
  const me = useQuery(meQueryOptions);
  return (
    <>
      <nav className="shell-nav">
        <div>
          <strong>DuckOJ</strong>
          <Link to="/problems">Problems</Link>
          <a href="/api/v1/docs">API</a>
          {me.data ? <span>Signed in as {me.data.displayName}</span> : <Link to="/">Sign in</Link>}
        </div>
      </nav>
      <main>
        <Outlet />
      </main>
    </>
  );
}

/**
 * `/`, and also this app's `notFoundComponent` (see `rootRoute` below):
 * `parseRoute`'s old catch-all fell through to `{ name: 'root' }` for any
 * unmatched path, rendering exactly this. TanStack Router resolves an
 * unmatched path to a not-found state instead of a route by default, so
 * reusing this component there is what keeps that fallback behaviour intact
 * rather than replacing it with the router's own not-found page.
 */
function IndexComponent() {
  const { me, loginError, needsTotp, handleLogin } = useAuthGate();
  if (me.isLoading) return <p>Loading…</p>;
  return (
    <>
      <HomePage me={me.data ?? null} />
      {me.data ? null : <LoginForm onSubmit={handleLogin} error={loginError} needsTotp={needsTotp} />}
    </>
  );
}

/**
 * `/submit`. Submitting needs a session; browsing does not — see the
 * pre-router `App`'s doc comment (this file's history) for why the problems
 * and authoring routes are never gated the same way.
 *
 * `problem` comes from `useSearch`, not `window.location.search` — the
 * route's own `validateSearch` (below) is what actually parses it, and
 * `SubmitPage`'s doc comment explains why that distinction matters for a
 * problem code that collides with TanStack Router's default search
 * serializer's JSON-detection heuristic.
 */
function SubmitRouteComponent() {
  const { problem } = useSearch({ from: '/submit' });
  const { me, loginError, needsTotp, handleLogin } = useAuthGate();
  if (me.isLoading) return <p>Loading…</p>;
  if (!me.data) {
    return (
      <>
        <p>Sign in to submit a solution.</p>
        <LoginForm onSubmit={handleLogin} error={loginError} needsTotp={needsTotp} />
      </>
    );
  }
  return <SubmitPage problemCode={problem} />;
}

/**
 * `/problems/$code`. `useParams({ from: ... })` (a route id string, not the
 * `problemRoute` const) is used instead of `problemRoute.useParams()` so
 * this function does not have to be declared after `problemRoute` exists —
 * the route id is just a literal, type-checked once the `Register` module
 * augmentation below is in scope anywhere in this file.
 */
function ProblemRouteComponent() {
  const { code } = useParams({ from: '/problems/$code' });
  return <ProblemPage code={code} />;
}

function ProblemEditRouteComponent() {
  const { code } = useParams({ from: '/problems/$code/edit' });
  return <ProblemEditPage code={code} />;
}

function ProblemRevisionsRouteComponent() {
  const { code } = useParams({ from: '/problems/$code/revisions' });
  return <ProblemRevisionsPage code={code} />;
}

function ProblemNewRouteComponent() {
  return <ProblemEditPage />;
}

/**
 * The route tree. Static segments (`/problems/new`) are declared exactly
 * like dynamic ones (`/problems/$code`) — no manual ordering is needed, and
 * none is done here. TanStack Router resolves path specificity
 * structurally (a static segment always wins over a `$param` segment at the
 * same position), which is the whole reason for this task: `parseRoute`'s
 * old comment flagged getting this ordering right by eye as its "one
 * genuinely fragile spot." Verified directly in this task's report (a
 * request for `/problems/new` renders the create form, not
 * `ProblemPage({ code: 'new' })`).
 */
const rootRoute = createRootRoute({ component: RootComponent, notFoundComponent: IndexComponent });

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: IndexComponent });
const problemsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/problems', component: ProblemsPage });
const problemNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/problems/new',
  component: ProblemNewRouteComponent,
});
const problemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/problems/$code',
  component: ProblemRouteComponent,
});
const problemEditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/problems/$code/edit',
  component: ProblemEditRouteComponent,
});
const problemRevisionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/problems/$code/revisions',
  component: ProblemRevisionsRouteComponent,
});
const submitRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/submit',
  // Same default as `submit.tsx`'s `problemCodeFromSearch`/`DEFAULT_PROBLEM_CODE`:
  // absent `?problem=` still means `aplusb`, matching pre-router behaviour for
  // bare `/submit`.
  validateSearch: (search: Record<string, unknown>): { problem: string } => ({
    problem: typeof search.problem === 'string' ? search.problem : DEFAULT_PROBLEM_CODE,
  }),
  component: SubmitRouteComponent,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  problemsRoute,
  problemNewRoute,
  problemRoute,
  problemEditRoute,
  problemRevisionsRoute,
  submitRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
