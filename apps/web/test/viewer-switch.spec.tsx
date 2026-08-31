/**
 * B-34 — two pupils, one browser.
 *
 * `SignOutButton` has removed every non-`['me']` entry since P5, with a
 * comment saying why: those answers belong to the person leaving, and
 * "leaving those to refetch would paint one person's data under the next
 * person's session". Signing IN did not do it, and signing in is the half
 * where the next person is already present.
 *
 * The sequence is the ordinary one on a shared school machine: a session ends
 * without the button — it expired, or a password change on another device
 * revoked it (D32/D141) — the shell drops back to the sign-in form with a full
 * cache behind it, and the next pupil signs in on that same tab.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
vi.mock('../src/api.js', () => ({
  api: { GET: (...a: unknown[]) => get(...a), POST: (...a: unknown[]) => post(...a) },
}));

const { useAuthGate } = await import('../src/router.js');
const { LocaleProvider } = await import('../src/i18n/index.js');

/** What the departing pupil's tab was holding. */
const DEPARTED = { unreadCount: 3, items: [{ id: 7, kind: 'contest_started' }] };

afterEach(() => {
  get.mockReset();
  post.mockReset();
});

/** A component that is nothing but the hook's sign-in call. */
function SignInProbe(): React.ReactNode {
  const { handleLogin } = useAuthGate();
  return (
    <button
      type="button"
      onClick={() => {
        void handleLogin({
          usernameOrEmail: 'hocsinh2',
          password: 'a-long-enough-password',
          totpCode: undefined,
          recoveryCode: undefined,
        });
      }}
    >
      sign in
    </button>
  );
}

function seededClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['notifications'], DEPARTED);
  client.setQueryData(['submissions', 'hocsinh1'], [{ id: 42 }]);
  return client;
}

describe('signing in on a tab the previous viewer left behind', () => {
  it('drops their cached answers and keeps the me entry', async () => {
    get.mockResolvedValue({ data: undefined });
    post.mockResolvedValue({ data: { user: { id: 2, username: 'hocsinh2' } } });
    const client = seededClient();

    render(
      <QueryClientProvider client={client}>
        <LocaleProvider initialLocale="vi">
          <SignInProbe />
        </LocaleProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'sign in' }));

    expect(post).toHaveBeenCalledWith('/auth/login', expect.anything());
    expect(client.getQueryData(['notifications'])).toBeUndefined();
    expect(client.getQueryData(['submissions', 'hocsinh1'])).toBeUndefined();
    // `['me']` survives, because the whole shell keys its `enabled` flags off
    // it and a removed entry leaves a mounted observer rendering what it last
    // saw — the trap `SignOutButton` documents. It is refetched, not dropped.
    expect(client.getQueryState(['me'])).toBeDefined();
  });

  it('leaves the cache alone when the sign-in was refused', async () => {
    get.mockResolvedValue({ data: undefined });
    post.mockResolvedValue({ error: { code: 'invalid_credentials', detail: 'no' } });
    const client = seededClient();

    render(
      <QueryClientProvider client={client}>
        <LocaleProvider initialLocale="vi">
          <SignInProbe />
        </LocaleProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'sign in' }));

    // A mistyped password is not a viewer swap. Throwing the tab's state away
    // on every failed attempt would make a typo cost a full reload.
    expect(client.getQueryData(['notifications'])).toEqual(DEPARTED);
  });
});

// The other sign-in path — `/register`'s chained login — is pinned in
// `register.spec.tsx`, which mocks `@tanstack/react-router` wholesale and so
// cannot live in this file beside a real import of `src/router.js`.
