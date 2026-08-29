/**
 * Signing out.
 *
 * `POST /auth/logout` has existed since Phase 1 and had no control anywhere
 * in the app: the only way to end a session was to clear the cookie by hand.
 * On the shared school machines this project is aimed at, "the previous
 * pupil is still signed in" is the default state that produces.
 *
 * Found by Task P5's journey 5, which cannot test "logging in again asks for
 * the second factor" without a way to log out first.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
vi.mock('../src/api.js', () => ({
  api: { GET: (...a: unknown[]) => get(...a), POST: (...a: unknown[]) => post(...a) },
}));

const { ShellNav } = await import('../src/router.js');
const { LocaleProvider } = await import('../src/i18n/index.js');

const ME = {
  id: 1,
  username: 'hocsinh1',
  displayName: 'Hoc Sinh 1',
  globalRole: 'user',
  totpEnabled: false,
};

afterEach(() => {
  get.mockReset();
  post.mockReset();
});

/**
 * The real nav under a router context built the way `i18n.spec.tsx` builds
 * one — `<Link>` throws without a router, and the point of this spec is the
 * shipped nav, not a stand-in that could drift from it.
 */
function renderShell() {
  const testRootRoute = createRootRoute();
  const testRouter = createRouter({
    routeTree: testRootRoute.addChildren([
      createRoute({ getParentRoute: () => testRootRoute, path: '/' }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterContextProvider router={testRouter}>
        <LocaleProvider initialLocale="vi">
          <ShellNav />
        </LocaleProvider>
      </RouterContextProvider>
    </QueryClientProvider>,
  );
  return client;
}

describe('ShellNav', () => {
  it('offers a sign-out control to a signed-in viewer, and none to a visitor', async () => {
    // Signed in: `GET /auth/me` answers with the viewer, the bell polls.
    get.mockImplementation((path: string) =>
      path === '/auth/me'
        ? Promise.resolve({ data: ME })
        : Promise.resolve({ data: { unreadCount: 0, items: [] } }),
    );
    renderShell();

    await screen.findByRole('button', { name: 'Đăng xuất' });
    // The signed-in nav shows the display name, not the sign-in link — so
    // sign-out is the only way out, and it has to be there.
    expect(screen.queryByRole('link', { name: 'Đăng nhập' })).not.toBeInTheDocument();
  });

  it('ends the session on the server and puts the shell back to signed out', async () => {
    let signedIn = true;
    get.mockImplementation((path: string) =>
      path === '/auth/me'
        ? Promise.resolve({ data: signedIn ? ME : undefined })
        : Promise.resolve({ data: { unreadCount: 0, items: [] } }),
    );
    post.mockImplementation(() => {
      signedIn = false;
      return Promise.resolve({ data: undefined });
    });

    renderShell();
    await userEvent.click(await screen.findByRole('button', { name: 'Đăng xuất' }));

    expect(post).toHaveBeenCalledWith('/auth/logout');
    // The nav must actually change: a button that calls the endpoint and
    // leaves the display name on screen is the bug this test exists for.
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Đăng nhập' })).toBeInTheDocument();
    });
    expect(screen.queryByText('Hoc Sinh 1')).not.toBeInTheDocument();
  });

  it('signs out locally even when the server call fails', async () => {
    // A session whose cookie the server has already forgotten still has to
    // end in the browser — otherwise the one case where signing out matters
    // most (a machine someone else is about to use) is the case it refuses.
    let signedIn = true;
    get.mockImplementation((path: string) =>
      path === '/auth/me'
        ? Promise.resolve({ data: signedIn ? ME : undefined })
        : Promise.resolve({ data: { unreadCount: 0, items: [] } }),
    );
    post.mockImplementation(() => {
      signedIn = false;
      return Promise.reject(new Error('network down'));
    });

    renderShell();
    await userEvent.click(await screen.findByRole('button', { name: 'Đăng xuất' }));

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Đăng nhập' })).toBeInTheDocument();
    });
  });
});
