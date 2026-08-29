/**
 * The admin panel. The gate test matters most: the panel renders nothing
 * actionable for a non-admin — cosmetic (the API re-decides), but a setter
 * seeing Rate buttons that all 403 would reasonably file it as a bug.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();
vi.mock('../src/api.js', () => ({
  api: {
    GET: (...a: unknown[]) => get(...a),
    POST: (...a: unknown[]) => post(...a),
    PATCH: (...a: unknown[]) => patch(...a),
    DELETE: (...a: unknown[]) => del(...a),
  },
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { AdminPage } = await import('../src/routes/admin.js');

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const CONTEST = {
  id: 1,
  key: 'spring',
  name: 'Spring Open',
  startTime: '2026-03-01T09:00:00Z',
  endTime: '2026-03-01T14:00:00Z',
  format: 'icpc',
  visibility: 'public',
  pointsPrecision: 3,
  frozenLastMinutes: 0,
  timeLimitSeconds: null,
  isRated: false,
  createdAt: '2026-02-01T00:00:00Z',
};

function serve(role: string, contests = [CONTEST]) {
  get.mockImplementation((path: string) => {
    if (path === '/auth/me') return Promise.resolve({ data: { username: 'root', displayName: 'Root', globalRole: role } });
    if (path === '/contests') return Promise.resolve({ data: { items: contests, nextCursor: null } });
    return Promise.resolve({ data: undefined });
  });
}

afterEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  del.mockReset();
  vi.restoreAllMocks();
});

describe('AdminPage', () => {
  it('shows a setter nothing but "Admins only"', async () => {
    serve('setter');
    wrap(<AdminPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Chỉ dành cho quản trị viên/);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('grants a role and reports what the server actually granted', async () => {
    serve('admin');
    patch.mockResolvedValue({ data: { id: 2, username: 'kim', globalRole: 'setter' } });
    wrap(<AdminPage />);

    await userEvent.type(await screen.findByLabelText(/^Tên đăng nhập$/), 'kim');
    await userEvent.click(screen.getByRole('button', { name: /^Cấp$/ }));
    expect(patch).toHaveBeenCalledWith('/admin/users/{username}', {
      params: { path: { username: 'kim' } },
      body: { globalRole: 'setter' },
    });
    expect(await screen.findByRole('status')).toHaveTextContent('kim hiện có quyền người ra đề.');
  });

  it('refuses to grant with an empty username', async () => {
    serve('admin');
    wrap(<AdminPage />);
    expect(await screen.findByRole('button', { name: /^Cấp$/ })).toBeDisabled();
  });

  it('rates an unrated contest and shows how far the replay reached', async () => {
    serve('admin');
    post.mockResolvedValue({ data: { contestsRated: 7 } });
    wrap(<AdminPage />);

    await userEvent.click(await screen.findByRole('button', { name: /^Bật tính rating$/ }));
    expect(post).toHaveBeenCalledWith('/admin/contests/{key}/rate', {
      params: { path: { key: 'spring' } },
    });
    expect(await screen.findByRole('status')).toHaveTextContent(/7 kỳ thi đang tính vào rating/);
  });

  it('offers Unrate — not Rate — for a contest that is already rated', async () => {
    serve('admin', [{ ...CONTEST, isRated: true }]);
    wrap(<AdminPage />);
    expect(await screen.findByRole('button', { name: /^Tắt tính rating$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Bật tính rating$/ })).toBeNull();
  });

  it('surfaces the API detail when a grant is refused', async () => {
    serve('admin');
    patch.mockResolvedValue({ error: { detail: 'You cannot remove your own admin role.' } });
    wrap(<AdminPage />);
    await userEvent.type(await screen.findByLabelText(/^Tên đăng nhập$/), 'root');
    await userEvent.click(screen.getByRole('button', { name: /^Cấp$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/your own admin role/i);
  });
});

/**
 * M11 — both write handlers used to have no `try/catch` and no busy flag, and
 * the rating button no `disabled`. openapi-fetch RETHROWS network-level
 * failures rather than resolving them to `{ error }`, so an API restart
 * mid-request produced an unhandled rejection in the console and nothing at
 * all on screen; and the rating replay — the most consequential retroactive
 * operation in the system — was double-clickable.
 */
describe('AdminPage write handlers (M11)', () => {
  it('surfaces a connection failure on the grant instead of an unhandled rejection', async () => {
    serve('admin');
    patch.mockRejectedValue(new TypeError('Failed to fetch'));
    wrap(<AdminPage />);

    await userEvent.type(await screen.findByLabelText(/^Tên đăng nhập$/), 'kim');
    await userEvent.click(screen.getByRole('button', { name: /^Cấp$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Không kết nối được/);
  });

  it('surfaces a connection failure on the rating replay', async () => {
    serve('admin');
    post.mockRejectedValue(new TypeError('Failed to fetch'));
    wrap(<AdminPage />);

    await userEvent.click(await screen.findByRole('button', { name: /^Bật tính rating$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Không kết nối được/);
  });

  it('fires exactly one rating replay for a double-click', async () => {
    serve('admin');
    let settle: (value: unknown) => void = () => undefined;
    post.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    wrap(<AdminPage />);

    const button = await screen.findByRole('button', { name: /^Bật tính rating$/ });
    await userEvent.click(button);
    // Still in flight: the button must refuse the second click rather than
    // queue a second replay of an operation that rewrites every rating after
    // the contest.
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(post).toHaveBeenCalledTimes(1);

    settle({ data: { contestsRated: 1 } });
  });
});

/**
 * M9 — the admin's TOTP reset, from the panel. Behind `confirm()` for the
 * same reason the rejudge button is: it removes a security control from
 * somebody else's account and there is no undo.
 */
describe('AdminPage TOTP reset (M9)', () => {
  it('resets a lost authenticator after a confirmation', async () => {
    serve('admin');
    del.mockResolvedValue({ data: undefined });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    wrap(<AdminPage />);

    await userEvent.type(await screen.findByLabelText(/^Người dùng cần đặt lại$/), 'kim');
    await userEvent.click(screen.getByRole('button', { name: /^Tắt xác thực hai bước$/ }));
    expect(del).toHaveBeenCalledWith('/admin/users/{username}/totp', {
      params: { path: { username: 'kim' } },
    });
    expect(await screen.findByRole('status')).toHaveTextContent(/kim/);
  });

  it('does nothing when the confirmation is declined', async () => {
    serve('admin');
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    wrap(<AdminPage />);

    await userEvent.type(await screen.findByLabelText(/^Người dùng cần đặt lại$/), 'kim');
    await userEvent.click(screen.getByRole('button', { name: /^Tắt xác thực hai bước$/ }));
    expect(del).not.toHaveBeenCalled();
  });

  it('shows the API refusal rather than claiming success', async () => {
    serve('admin');
    del.mockResolvedValue({ error: { code: 'user_not_found', detail: 'No such user: kim.' } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    wrap(<AdminPage />);

    await userEvent.type(await screen.findByLabelText(/^Người dùng cần đặt lại$/), 'kim');
    await userEvent.click(screen.getByRole('button', { name: /^Tắt xác thực hai bước$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No such user: kim.');
  });
});
