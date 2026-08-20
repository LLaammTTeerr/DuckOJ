import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoginForm, type LoginValues } from './routes/login.js';
import { SubmitPage } from './routes/submit.js';
import { ProblemsPage } from './routes/problems.js';
import { ProblemPage } from './routes/problem.js';
import { api } from './api.js';

const queryClient = new QueryClient();

type Route = { name: 'problems' } | { name: 'problem'; code: string } | { name: 'root' };

// There is still no router — `@tanstack/react-router` remains an open
// question the rest of this file's history explains — so this is the
// smallest thing that lets Task 11's two pages have real, bookmarkable
// URLs without resolving that question: read `window.location.pathname`
// once per render and match it against the two shapes the problems browser
// needs. Everything else falls through to `root`, which keeps today's
// auth-gate behaviour exactly as it was. Links to these pages (in
// problems.tsx/problem.tsx) are plain `<a href>` — a full navigation, not a
// client-side transition — which this matches: there is no History API
// listener here, so a route only ever changes on an actual page load.
function parseRoute(pathname: string): Route {
  if (pathname === '/problems' || pathname === '/problems/') return { name: 'problems' };
  const match = /^\/problems\/([^/]+)\/?$/.exec(pathname);
  if (match) return { name: 'problem', code: decodeURIComponent(match[1]!) };
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

  if (route.name === 'problems') return <ProblemsPage />;
  if (route.name === 'problem') return <ProblemPage code={route.code} />;

  if (me.isLoading) return <p>Loading…</p>;
  if (!me.data) return <LoginForm onSubmit={handleLogin} error={loginError} needsTotp={needsTotp} />;

  return (
    <>
      <p>Signed in as {me.data.displayName}.</p>
      <SubmitPage />
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
