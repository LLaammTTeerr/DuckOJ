import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoginForm, type LoginValues } from './routes/login.js';
import { SubmitPage } from './routes/submit.js';
import { api } from './api.js';

const queryClient = new QueryClient();

/**
 * There is no router yet — `@tanstack/react-router` remains an open
 * question, per the task brief — so this is a plain auth gate: sign in, or
 * see the submit page. `LoginForm` and the `/auth/me` check both already
 * existed (an earlier phase's scaffold) but nothing rendered them; wiring
 * them together here is what makes Task 15's "open the page, sign in,
 * submit" manual check reachable at all.
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
