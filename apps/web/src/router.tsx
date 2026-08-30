import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { LoginForm, type LoginValues } from './routes/login.js';
import { RegisterPage } from './routes/register.js';
import { DEFAULT_PROBLEM_CODE, SubmitPage } from './routes/submit.js';
import { ProblemsPage, type ProblemFilterValues } from './routes/problems.js';
import { ProblemPage } from './routes/problem.js';
import { ProblemEditPage } from './routes/problem-edit.js';
import { ProblemRevisionsPage } from './routes/problem-revisions.js';
import { SubmissionsPage } from './routes/submissions.js';
import { SubmissionPage } from './routes/submission.js';
import { HomePage } from './routes/home.js';
import {
  ForgotPasswordPage,
  ResetPasswordPage,
  VerifyEmailPage,
} from './routes/account-recovery.js';
import { ContestPage, ContestsPage, ScoreboardPage } from './routes/contests.js';
import { ContestNewPage } from './routes/contest-new.js';
import { ContestEditPage } from './routes/contest-edit.js';
import { TokensPage } from './routes/tokens.js';
import { SecurityPage } from './routes/security.js';
import { UserPage } from './routes/user.js';
import { OrgPage, OrgsPage } from './routes/orgs.js';
import { AdminPage } from './routes/admin.js';
import { NotificationsPage, notificationsQueryOptions } from './routes/notifications.js';
import { api } from './api.js';
// `meQueryOptions` moved to `./me.js` (see that file's doc comment) so
// `routes/problems.tsx` — which needs the viewer's username for the `me`
// verdict column, but is not itself part of the route tree — can share the
// same `['me']` cache entry without importing this file.
import { meQueryOptions } from './me.js';
import { useLocale, useT } from './i18n/index.js';

/**
 * Sign-in wiring shared by the two places that can show `LoginForm`: the
 * root/index route (signed out at `/`) and `/submit` (signed out, told to
 * sign in before submitting). Each caller gets its OWN `loginError`/
 * `needsTotp` state — deliberately not lifted any higher — so those two
 * ephemeral UI states still reset on navigation between them, matching the
 * pre-router behaviour where every navigation was a full page load. Only
 * `me` itself (via `meQueryOptions`, above) is shared.
 */

/**
 * The only route into password recovery.
 *
 * Rendered beside `LoginForm` rather than inside it: that component is
 * deliberately router-free so its tests can render it bare, and a `<Link>`
 * inside it needs a router context they do not build.
 */
function RecoveryLink() {
  const t = useT();
  return (
    <p className="muted">
      <Link to="/forgot-password">{t('auth.forgotPassword')}</Link>
      {' · '}
      {/* Beside recovery rather than inside `LoginForm`, for the same reason
          recovery is: the form is deliberately router-free so its tests can
          render it bare. Every place that shows the signed-out form — `/`,
          `/submit`, `/submissions` — renders this component right after it,
          so all three grow the way in as well as the way back in. */}
      <Link to="/register">{t('auth.registerLink')}</Link>
    </p>
  );
}

/**
 * The VI | EN switch. Two buttons rather than one that toggles: "the other
 * language" is a riddle in a language you cannot read, while both names
 * present at once is legible to either reader. The active one carries
 * `aria-pressed`, and `setLocale` persists the choice (see i18n/index.tsx).
 */
function LocaleToggle() {
  const t = useT();
  const { locale, setLocale } = useLocale();
  return (
    <span aria-label={t('nav.language')}>
      <button type="button" aria-pressed={locale === 'vi'} onClick={() => setLocale('vi')}>
        VI
      </button>
      <button type="button" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>
        EN
      </button>
    </span>
  );
}

/**
 * The way out. `POST /auth/logout` has existed since Phase 1 with no control
 * anywhere in the app — the only way to end a session was to clear the
 * cookie by hand, which on a shared school machine means the previous pupil
 * stays signed in. Found by Task P5.
 *
 * The cache is RESET rather than merely invalidated: `['me']` is not the
 * only entry holding the departing viewer's data (the notification feed, a
 * private problem list, a contest participation), and leaving those to
 * refetch would paint one person's data under the next person's session.
 * A failed call still signs out locally — a cookie the server has already
 * forgotten must not trap the browser in a session it cannot leave.
 */
function SignOutButton() {
  const t = useT();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function signOut(): Promise<void> {
    setBusy(true);
    try {
      await api.POST('/auth/logout');
    } catch {
      // openapi-fetch rethrows network-level failures rather than resolving
      // them to `{ error }` — see submit.tsx's handleSubmit for the pattern.
    } finally {
      setBusy(false);
      // `['me']` first, and to exactly what a signed-out `fetchMe` returns:
      // every `enabled` flag in the app keys off it (the bell polls only
      // while signed in), so flipping it before touching anything else is
      // what stops the shell from firing one more authenticated request that
      // can only 401. `resetQueries()` — the first attempt — did fire one,
      // because it refetches active queries before any of them has
      // re-rendered as signed out.
      client.setQueryData(meQueryOptions.queryKey, null);
      // Everything else is REMOVED rather than invalidated or reset: those
      // answers belong to the person leaving, and re-asking for them as a
      // visitor is both pointless and, on a shared machine, the wrong
      // instinct. `clear()` cannot do this job — it drops `['me']` too, and
      // a mounted observer whose query vanished keeps rendering the data it
      // last saw, so the nav went on showing the departed viewer's name.
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' });
    }
  }
  return (
    <button type="button" disabled={busy} onClick={() => void signOut()}>
      {t('nav.signOut')}
    </button>
  );
}

function useAuthGate() {
  const client = useQueryClient();
  const t = useT();
  const me = useQuery(meQueryOptions);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [needsTotp, setNeedsTotp] = useState(false);

  async function handleLogin(values: LoginValues): Promise<void> {
    // openapi-fetch resolves HTTP errors to `{ error }` but RETHROWS
    // network-level failures (submit.tsx documents this); without the catch
    // a sign-in click during an outage was silently lost.
    let response;
    try {
      response = await api.POST('/auth/login', {
        body: {
          usernameOrEmail: values.usernameOrEmail,
          password: values.password,
          ...(values.totpCode ? { totpCode: values.totpCode } : {}),
          ...(values.recoveryCode ? { recoveryCode: values.recoveryCode } : {}),
        },
      });
    } catch {
      setLoginError(t('common.networkError'));
      return;
    }
    const { error } = response;
    if (error) {
      // `error.detail` is the server's own wording and is shown verbatim —
      // it is not in either catalogue, by design (see i18n/en.ts).
      setLoginError(error.detail ?? t('auth.signInFailed'));
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
  return (
    <>
      <ShellNav />
      <main>
        <Outlet />
      </main>
    </>
  );
}

/**
 * The nav bar itself, split out of `RootComponent` so `test/i18n.spec.tsx`
 * can render the REAL nav — every link label and the real language toggle —
 * rather than a hand-built stand-in that could drift from it. `RootComponent`
 * is untestable on its own: its `<Outlet />` needs a matched route, which
 * `RouterContextProvider` (the pattern every other spec in this suite uses)
 * deliberately does not supply.
 */
export function ShellNav() {
  const t = useT();
  const me = useQuery(meQueryOptions);
  // The bell. Polled once a minute while signed in; `enabled` keeps a
  // signed-out shell from asking at all.
  const feed = useQuery({
    ...notificationsQueryOptions,
    enabled: me.data != null,
    refetchInterval: 60_000,
  });
  const unread = feed.data?.unreadCount ?? 0;
  return (
    <nav className="shell-nav">
      <div>
        {/* The product name, not a translatable string. */}
        <strong>DuckOJ</strong>
        <Link to="/problems">{t('nav.problems')}</Link>
        <Link to="/contests">{t('nav.contests')}</Link>
        <Link to="/orgs">{t('nav.orgs')}</Link>
        <Link to="/submissions">{t('nav.submissions')}</Link>
        <a href="/api/v1/docs">{t('nav.api')}</a>
        {me.data?.globalRole === 'admin' ? <Link to="/admin">{t('nav.admin')}</Link> : null}
        {me.data ? <Link to="/account/tokens">{t('nav.tokens')}</Link> : null}
        {/* Beside Tokens: both are `/account/*`, both are session-only, and
            a 2FA screen nobody can find is a 2FA screen nobody turns on. */}
        {me.data ? <Link to="/account/security">{t('nav.security')}</Link> : null}
        {me.data ? (
          <Link to="/notifications" aria-label={t('nav.notifications', { count: unread })}>
            {unread > 0 ? `[${String(unread)}]` : '[ ]'}
          </Link>
        ) : null}
        <LocaleToggle />
        {me.data ? (
          <>
            <Link to="/users/$username" params={{ username: me.data.username }}>
              {me.data.displayName}
            </Link>
            <SignOutButton />
          </>
        ) : (
          <>
            <Link to="/">{t('nav.signIn')}</Link>
            <Link to="/register">{t('nav.register')}</Link>
          </>
        )}
      </div>
    </nav>
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
  const t = useT();
  const { me, loginError, needsTotp, handleLogin } = useAuthGate();
  if (me.isLoading) return <p>{t('common.loading')}</p>;
  return (
    <>
      <HomePage me={me.data ?? null} />
      {me.data ? null : (
        <>
          <LoginForm onSubmit={handleLogin} error={loginError} needsTotp={needsTotp} />
          <RecoveryLink />
        </>
      )}
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
  const t = useT();
  const { problem, contest } = useSearch({ from: '/submit' });
  const { me, loginError, needsTotp, handleLogin } = useAuthGate();
  if (me.isLoading) return <p>{t('common.loading')}</p>;
  if (!me.data) {
    return (
      <>
        <p>{t('submit.gate')}</p>
        <LoginForm onSubmit={handleLogin} error={loginError} needsTotp={needsTotp} />
        <RecoveryLink />
      </>
    );
  }
  return <SubmitPage problemCode={problem} {...(contest ? { contestKey: contest } : {})} />;
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
  // Keyed: the router reuses a mounted component across $code changes, and
  // an edit form whose state survives that carries problem A's content into
  // a save against problem B. The component also reseeds itself (belt and
  // suspenders — see problem-edit.tsx), but the remount is the hard wall.
  return <ProblemEditPage key={code} code={code} />;
}

/**
 * `/problems`, with its topic and difficulty filters in the URL.
 *
 * The same two-way wiring `SubmissionsRouteComponent` uses, plus the return
 * leg: `key` remounts the page when the search changes from OUTSIDE (a chip
 * link, a nav click, the back button) so its seeds are fresh, and
 * `onFiltersChange` writes a filter the person just picked back into the
 * URL. `replace: true` — building a practice set is one act of narrowing,
 * not eight, and a back button that walks a checkbox at a time is a back
 * button nobody presses twice.
 */
function ProblemsRouteComponent() {
  const search = useSearch({ from: '/problems' });
  const navigate = useNavigate();
  const filters: ProblemFilterValues = {
    tags: search.tag ?? [],
    difficultyMin: search.difficultyMin,
    difficultyMax: search.difficultyMax,
  };
  return (
    <ProblemsPage
      key={`${filters.tags.join(',')}|${String(search.difficultyMin ?? '')}|${String(search.difficultyMax ?? '')}`}
      initialFilters={filters}
      onFiltersChange={(next) => {
        void navigate({
          to: '/problems',
          replace: true,
          // Absent, never present-but-undefined — an empty filter must
          // leave the URL clean rather than spell out `?tag=`.
          search: {
            ...(next.tags.length > 0 ? { tag: next.tags } : {}),
            ...(next.difficultyMin !== undefined ? { difficultyMin: next.difficultyMin } : {}),
            ...(next.difficultyMax !== undefined ? { difficultyMax: next.difficultyMax } : {}),
          },
        });
      }}
    />
  );
}

function ProblemRevisionsRouteComponent() {
  const { code } = useParams({ from: '/problems/$code/revisions' });
  return <ProblemRevisionsPage code={code} />;
}

function ProblemNewRouteComponent() {
  return <ProblemEditPage />;
}

/**
 * `/submissions`. `GET /submissions` answers 401 signed-out (contracts'
 * `SubmissionListQuery` registration) — unlike `/problems`, which is
 * readable without a session — so this is gated exactly like `/submit`
 * above, via the same `useAuthGate`. Without this gate, a signed-out visit
 * would fire a request that 401s, which `smoke.spec.ts`'s
 * `watchForBrokenRequests` does NOT whitelist for any path but
 * `/auth/me` — an unguarded query here would turn every e2e test that
 * walks this route while signed out red.
 */
function SubmissionsRouteComponent() {
  const t = useT();
  const { me, loginError, needsTotp, handleLogin } = useAuthGate();
  const search = useSearch({ from: '/submissions' });
  if (me.isLoading) return <p>{t('common.loading')}</p>;
  if (!me.data) {
    return (
      <>
        <p>{t('submissions.gate')}</p>
        <LoginForm onSubmit={handleLogin} error={loginError} needsTotp={needsTotp} />
        <RecoveryLink />
      </>
    );
  }
  // Keyed by the search values: a nav click to plain /submissions after a
  // deep link reuses the component, and un-keyed state kept the old filters
  // while the URL claimed none. A search change from OUTSIDE (nav, links)
  // remounts with fresh seeds; typing in the filter boxes (local state,
  // no search change) is untouched.
  return (
    <SubmissionsPage
      key={`${search.problem ?? ''}|${search.user ?? ''}|${search.contest ?? ''}`}
      {...(search.problem !== undefined ? { initialProblem: search.problem } : {})}
      {...(search.user !== undefined ? { initialUser: search.user } : {})}
      {...(search.contest !== undefined ? { initialContest: search.contest } : {})}
    />
  );
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
const problemsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/problems',
  // `tag` normalises to an array whichever way it arrives. TanStack Router
  // owns serializing `search` and JSON-encodes an array (`?tag=["do-thi"]`),
  // which is what a chip link produces and what its own parser hands back;
  // the string branch is for a URL typed or trimmed by hand (`?tag=do-thi`,
  // the API's own repeated-parameter spelling), which must narrow the list
  // rather than be silently ignored. This is the SPA's URL, not a request:
  // the page turns whatever comes out of here into repeated `?tag=`
  // parameters when it actually calls `GET /problems`.
  //
  // A bound outside 1-10 is dropped rather than passed on: the API answers
  // 422 for it, and a hand-edited URL should narrow to nothing rather than
  // break the page.
  validateSearch: (
    search: Record<string, unknown>,
  ): { tag?: string[]; difficultyMin?: number; difficultyMax?: number } => {
    const raw = search.tag;
    const tag = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
    const bound = (value: unknown): number | undefined => {
      const n = Number(value);
      return value !== undefined && value !== '' && Number.isInteger(n) && n >= 1 && n <= 10 ? n : undefined;
    };
    const min = bound(search.difficultyMin);
    const max = bound(search.difficultyMax);
    return {
      ...(tag.length > 0 ? { tag } : {}),
      ...(min !== undefined ? { difficultyMin: min } : {}),
      ...(max !== undefined ? { difficultyMax: max } : {}),
    };
  },
  component: ProblemsRouteComponent,
});
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
  // `contest` is optional and omitted when absent rather than set to
  // `undefined`: `exactOptionalPropertyTypes` distinguishes the two, and a
  // present-but-undefined key would travel into the request body.
  validateSearch: (search: Record<string, unknown>): { problem: string; contest?: string } => ({
    problem: typeof search.problem === 'string' ? search.problem : DEFAULT_PROBLEM_CODE,
    ...(typeof search.contest === 'string' ? { contest: search.contest } : {}),
  }),
  component: SubmitRouteComponent,
});
const submissionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/submissions',
  // Deep-linkable filters: the problem page links `?problem=`, profiles
  // link `?user=`. Absent keys are omitted, never present-but-undefined.
  validateSearch: (
    search: Record<string, unknown>,
  ): { problem?: string; user?: string; contest?: string } => ({
    ...(typeof search.problem === 'string' ? { problem: search.problem } : {}),
    ...(typeof search.user === 'string' ? { user: search.user } : {}),
    ...(typeof search.contest === 'string' ? { contest: search.contest } : {}),
  }),
  component: SubmissionsRouteComponent,
});
const submissionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/submissions/$id',
  component: SubmissionRouteComponent,
});

// The three screens Phase 3f's emails link to. `validateSearch` keeps `?token=`
// off `unknown` — the pages read it through `useSearch`, and a missing token is
// a state each of them handles rather than a crash.
const tokenSearch = (search: Record<string, unknown>): { token?: string } =>
  typeof search.token === 'string' ? { token: search.token } : {};

function ContestRouteComponent() {
  const { key } = useParams({ from: '/contests/$key' });
  return <ContestPage contestKey={key} />;
}
function ContestEditRouteComponent() {
  const { key } = useParams({ from: '/contests/$key/edit' });
  // Keyed, for the same reason `ProblemEditRouteComponent` is: the router
  // reuses a mounted component across `$key` changes, and an edit form whose
  // state survives that saves contest A's values over contest B.
  return <ContestEditPage key={key} contestKey={key} />;
}
function ScoreboardRouteComponent() {
  const { key } = useParams({ from: '/contests/$key/scoreboard' });
  return <ScoreboardPage contestKey={key} />;
}
function OrgRouteComponent() {
  const { slug } = useParams({ from: '/orgs/$slug' });
  return <OrgPage slug={slug} />;
}
function SubmissionRouteComponent() {
  const { id } = useParams({ from: '/submissions/$id' });
  return <SubmissionPage id={Number(id)} />;
}
function UserRouteComponent() {
  const { username } = useParams({ from: '/users/$username' });
  return <UserPage username={username} />;
}

const contestsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/contests',
  component: ContestsPage,
});
const contestNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/contests/new',
  component: ContestNewPage,
});
const contestRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/contests/$key',
  component: ContestRouteComponent,
});
const contestEditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/contests/$key/edit',
  component: ContestEditRouteComponent,
});
const scoreboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/contests/$key/scoreboard',
  component: ScoreboardRouteComponent,
});
const orgsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/orgs',
  component: OrgsPage,
});
const orgRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/orgs/$slug',
  component: OrgRouteComponent,
});
const tokensRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account/tokens',
  component: TokensPage,
});
const securityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account/security',
  component: SecurityPage,
});
const notificationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/notifications',
  component: NotificationsPage,
});
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: AdminPage,
});
const userRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/users/$username',
  component: UserRouteComponent,
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  component: RegisterPage,
});

const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/forgot-password',
  component: ForgotPasswordPage,
});
const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset-password',
  validateSearch: tokenSearch,
  component: ResetPasswordPage,
});
const verifyEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/verify-email',
  validateSearch: tokenSearch,
  component: VerifyEmailPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  problemsRoute,
  problemNewRoute,
  problemRoute,
  problemEditRoute,
  problemRevisionsRoute,
  submitRoute,
  submissionsRoute,
  submissionRoute,
  registerRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  verifyEmailRoute,
  contestsRoute,
  contestNewRoute,
  contestRoute,
  contestEditRoute,
  scoreboardRoute,
  orgsRoute,
  orgRoute,
  tokensRoute,
  securityRoute,
  notificationsRoute,
  adminRoute,
  userRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
