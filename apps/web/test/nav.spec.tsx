/**
 * The navigation information architecture — D76.
 *
 * Two shells, one component. The desktop bar groups twelve items into three
 * named clusters; the phone bar is five tabs and an overflow sheet. Which one
 * renders is a JS media query (`window.matchMedia`), because a sheet cannot
 * exist as a CSS state and rendering both trees would put every link in the
 * document twice.
 *
 * jsdom does not implement `matchMedia` at all, which is exactly what makes
 * this testable in both directions: absent, the app answers "desktop" (and
 * the whole pre-existing suite goes on exercising the bar it always did);
 * stubbed to match, it answers "phone".
 */
import { render, screen, waitFor, within } from '@testing-library/react';
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

const STUDENT = {
  id: 1,
  username: 'hocsinh1',
  displayName: 'Hoc Sinh 1',
  globalRole: 'user',
  totpEnabled: false,
};
const ADMIN = { ...STUDENT, id: 2, username: 'quantri', displayName: 'Quan Tri', globalRole: 'admin' };

/** Signed in as `me` (or signed out for `null`), with `unread` on the bell. */
function serve(me: typeof STUDENT | null, unread = 0): void {
  get.mockImplementation((path: string) =>
    path === '/auth/me'
      ? Promise.resolve({ data: me ?? undefined })
      : Promise.resolve({ data: { unreadCount: unread, items: [] } }),
  );
}

/**
 * `matchMedia`, which jsdom does not have. Installed as a real stub rather
 * than `vi.stubGlobal(() => ({ matches: true }))` alone because the hook
 * subscribes to `change`, and a stub with no `addEventListener` would throw
 * on mount — the nav has to survive both shapes.
 */
function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

function renderShell() {
  const testRootRoute = createRootRoute();
  const testRouter = createRouter({
    routeTree: testRootRoute.addChildren([
      createRoute({ getParentRoute: () => testRootRoute, path: '/' }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RouterContextProvider router={testRouter}>
        <LocaleProvider initialLocale="vi">
          <ShellNav />
        </LocaleProvider>
      </RouterContextProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  get.mockReset();
  post.mockReset();
  vi.unstubAllGlobals();
});

describe('the desktop bar groups what used to be one flat row', () => {
  it('puts the four places you go to work in one named cluster', async () => {
    serve(STUDENT);
    renderShell();

    const main = await screen.findByRole('group', { name: 'Khu vực chính' });
    // Exactly these four, in this order: where the work is. Anything else in
    // here is an item that has drifted out of the account or reference
    // cluster, which is the flat row this decision replaced.
    expect(within(main).getAllByRole('link').map((el) => el.textContent)).toEqual([
      'Bài tập',
      'Kỳ thi',
      'Bài nộp',
      'Tổ chức',
    ]);
  });

  it('puts the account items in their own cluster, and leaves them visible', async () => {
    serve(STUDENT);
    renderShell();

    // Wait on a SIGNED-IN item, not on the cluster: the cluster is in the
    // first paint (holding the two ways in) while `GET /auth/me` is still in
    // flight, so `findByRole('group')` resolves against the visitor's bar.
    await screen.findByRole('button', { name: 'Đăng xuất' });
    const account = screen.getByRole('group', { name: 'Tài khoản' });
    // The grouping is VISUAL, not a dropdown: on a shared school machine a
    // sign-out that costs a discovery click is a sign-out nobody takes, and
    // the e2e journeys assert both this button and the display name are
    // visible with no interaction at all.
    expect(within(account).getByRole('button', { name: 'Đăng xuất' })).toBeInTheDocument();
    expect(within(account).getByRole('link', { name: 'Hoc Sinh 1' })).toBeInTheDocument();
    // 'Tiến độ' (D83) belongs here rather than in the main cluster: it is a
    // page about the reader, not a place the work lives.
    for (const label of ['Tiến độ', 'Cài đặt', 'Bảo mật', 'Mã truy cập', 'Mật khẩu']) {
      expect(within(account).getByRole('link', { name: label })).toBeInTheDocument();
    }
    // And the bell, named with its count as a sentence rather than a glyph.
    expect(within(account).getByRole('link', { name: /Thông báo/ })).toBeInTheDocument();
  });

  it('offers a visitor the two ways in, and none of the account items', async () => {
    serve(null);
    renderShell();

    const account = await screen.findByRole('group', { name: 'Tài khoản' });
    expect(within(account).getByRole('link', { name: 'Đăng nhập' })).toBeInTheDocument();
    expect(within(account).getByRole('link', { name: 'Đăng ký' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Đăng xuất' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Bảo mật' })).not.toBeInTheDocument();
  });

  it('shows the admin console only to an admin', async () => {
    serve(STUDENT);
    const view = renderShell();
    await screen.findByRole('link', { name: 'Bài tập' });
    expect(screen.queryByRole('link', { name: 'Quản trị' })).not.toBeInTheDocument();
    view.unmount();

    serve(ADMIN);
    renderShell();
    await screen.findByRole('link', { name: 'Quản trị' });
    const resources = screen.getByRole('group', { name: 'Tài nguyên' });
    expect(within(resources).getByRole('link', { name: 'Quản trị' })).toBeInTheDocument();
  });

  it('names the landmark, so a screen reader can jump to it', async () => {
    serve(null);
    renderShell();
    expect(await screen.findByRole('navigation', { name: 'Điều hướng DuckOJ' })).toBeInTheDocument();
  });
});

describe('the phone bar is a real tab bar', () => {
  it('carries at most five tabs, signed in and signed out alike', async () => {
    stubMatchMedia(true);
    serve(STUDENT);
    const view = renderShell();

    await screen.findByRole('link', { name: /Thông báo/ });
    const bar = screen.getByRole('navigation', { name: 'Điều hướng DuckOJ' });
    // The whole point of D67's concern 1: the old bar had twelve items and
    // scrolled sideways. Five is the ceiling a thumb can hit without aiming.
    const signedIn = within(bar).getAllByRole('link').length + within(bar).getAllByRole('button').length;
    expect(signedIn).toBeLessThanOrEqual(5);
    expect(within(bar).getByRole('link', { name: 'Bài tập' })).toBeInTheDocument();
    expect(within(bar).getByRole('link', { name: 'Kỳ thi' })).toBeInTheDocument();
    expect(within(bar).getByRole('link', { name: 'Bài nộp' })).toBeInTheDocument();
    expect(within(bar).getByRole('link', { name: /Thông báo/ })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Thêm' })).toBeInTheDocument();
    view.unmount();

    serve(null);
    renderShell();
    const visitorBar = await screen.findByRole('navigation', { name: 'Điều hướng DuckOJ' });
    await screen.findByRole('link', { name: 'Đăng nhập' });
    const signedOut =
      within(visitorBar).getAllByRole('link').length + within(visitorBar).getAllByRole('button').length;
    expect(signedOut).toBeLessThanOrEqual(5);
    // A bell with no session behind it is a dead tab; signing in is what a
    // visitor is here to do that is not already a tab.
    expect(within(visitorBar).getByRole('link', { name: 'Đăng nhập' })).toBeInTheDocument();
    expect(within(visitorBar).queryByRole('link', { name: /Thông báo/ })).not.toBeInTheDocument();
  });

  it('holds everything else in the sheet, so no route is more than two taps away', async () => {
    stubMatchMedia(true);
    serve(ADMIN);
    renderShell();

    await userEvent.click(await screen.findByRole('button', { name: 'Thêm' }));

    const sheet = screen.getByRole('dialog', { name: 'Thêm lựa chọn' });
    for (const label of [
      'Tổ chức',
      'Quan Tri',
      'Tiến độ',
      'Cài đặt',
      'Bảo mật',
      'Mã truy cập',
      'Mật khẩu',
      'Quản trị',
      'Trợ giúp',
      'API',
    ]) {
      expect(within(sheet).getByRole('link', { name: label }), label).toBeInTheDocument();
    }
    expect(within(sheet).getByRole('button', { name: 'Đăng xuất' })).toBeInTheDocument();
    // The language switch travels with the sheet, not the tab bar: a reader
    // who cannot read the tabs still has to be able to reach it, but it is
    // not one of the five things a thumb reaches for all day.
    expect(within(sheet).getByRole('group', { name: 'Ngôn ngữ' })).toBeInTheDocument();
  });

  it('gates the admin item in the sheet too', async () => {
    stubMatchMedia(true);
    serve(STUDENT);
    renderShell();

    await userEvent.click(await screen.findByRole('button', { name: 'Thêm' }));
    const sheet = screen.getByRole('dialog', { name: 'Thêm lựa chọn' });
    expect(within(sheet).queryByRole('link', { name: 'Quản trị' })).not.toBeInTheDocument();
  });
});

describe('the More sheet', () => {
  async function openSheet(): Promise<HTMLElement> {
    stubMatchMedia(true);
    serve(STUDENT);
    renderShell();
    await userEvent.click(await screen.findByRole('button', { name: 'Thêm' }));
    return screen.getByRole('dialog', { name: 'Thêm lựa chọn' });
  }

  it('is a modal, announced as one, and says so on the button that opens it', async () => {
    const sheet = await openSheet();
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    const more = screen.getByRole('button', { name: 'Thêm' });
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(more).toHaveAttribute('aria-haspopup', 'dialog');
    expect(more).toHaveAttribute('aria-controls', sheet.id);
  });

  it('moves focus into itself on open, and back to the trigger on close', async () => {
    const sheet = await openSheet();
    await waitFor(() => {
      expect(sheet.contains(document.activeElement)).toBe(true);
    });

    await userEvent.click(within(sheet).getByRole('button', { name: 'Đóng' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Focus back on the trigger, not on <body>: a keyboard reader who lands
    // at the top of the document after every dismissal walks the whole page
    // again to get back to where they were.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Thêm' }));
    expect(screen.getByRole('button', { name: 'Thêm' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes on Escape', async () => {
    await openSheet();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes when the backdrop is clicked', async () => {
    await openSheet();
    // The backdrop is a real <button> — a dismiss target is a control — but
    // deliberately out of the accessibility tree and the tab order, since it
    // only duplicates the named close button for a pointer. Hence the
    // querySelector: there is no role to ask for, on purpose.
    const backdrop = document.querySelector<HTMLElement>('.nav-sheet-backdrop');
    expect(backdrop).not.toBeNull();
    await userEvent.click(backdrop!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('traps Tab, so the focus ring cannot walk out behind the scrim', async () => {
    const sheet = await openSheet();
    const focusables = [...sheet.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();

    last?.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(first);

    first?.focus();
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(last);
  });

  it('closes itself when a link inside it is taken', async () => {
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole('link', { name: 'Cài đặt' }));
    // A sheet still covering the page after the route under it changed is a
    // page the reader cannot see.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
