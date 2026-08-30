/**
 * The admin panel. The gate test matters most: the panel renders nothing
 * actionable for a non-admin — cosmetic (the API re-decides), but a setter
 * seeing Rate buttons that all 403 would reasonably file it as a bug.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

/** An empty-but-healthy dashboard: every panel present, nothing to report. */
const DASHBOARD = {
  queue: { queued: 0, running: 0, expiredLeases: 0, failed: 0, oldestQueuedSeconds: null },
  judges: [],
  workers: [],
  recentFailures: [],
  refusalsLastHour: [],
  dependencies: { database: 'up', redis: 'up' },
  runtime: { apiWorkers: 4, judgedConcurrency: 1 },
  generatedAt: '2026-08-29T10:00:00Z',
};

function serve(role: string, contests = [CONTEST], dashboard: unknown = DASHBOARD) {
  get.mockImplementation((path: string) => {
    if (path === '/auth/me') return Promise.resolve({ data: { username: 'root', displayName: 'Root', globalRole: role } });
    if (path === '/contests') return Promise.resolve({ data: { items: contests, nextCursor: null } });
    if (path === '/admin/dashboard') return Promise.resolve({ data: dashboard });
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

  /**
   * The note above this button told an administrator, for two decisions,
   * that there were no recovery codes and that a reset was "the only way
   * back into the account" — false since D39, and the expensive kind of
   * false: it invites an admin to strip somebody's second factor for a
   * person who is holding eight codes that would have signed them in
   * without anybody's help.
   */
  it('sends the admin to look for a recovery code first (D39)', async () => {
    serve('admin');
    wrap(<AdminPage />);
    const note = await screen.findByText(/mất thiết bị xác thực/);
    expect(note).toHaveTextContent('mã khôi phục');
    expect(note).not.toHaveTextContent('Không có mã dự phòng');
    // And it says what the reset costs: disable() clears the codes too.
    expect(note).toHaveTextContent(/xoá|xóa/);
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

/**
 * D47 — the operations dashboard.
 *
 * The interesting assertions are the ones about what a number MEANS on
 * screen: an empty queue must not read as "queued a moment ago", a judge
 * that never handshook must not read as "seen at the epoch", and the
 * reclaim button must say something when it moved nothing.
 */
describe('AdminPage operations dashboard (D47)', () => {
  it('shows the queue depth and the fleet, every entity linked', async () => {
    serve('admin', [CONTEST], {
      ...DASHBOARD,
      queue: { queued: 3, running: 1, expiredLeases: 2, failed: 0, oldestQueuedSeconds: 300 },
      judges: [
        { name: 'judge0', driver: 'dmoj', lastSeen: '2026-08-29T09:59:30Z', online: true },
        { name: 'judge1', driver: 'dmoj', lastSeen: null, online: false },
      ],
      workers: [
        { workerId: 'judged-1#1', currentSubmissionId: 42, currentJobId: 7, gradedLastHour: 9, internalErrorsLastHour: 1 },
      ],
      recentFailures: [
        {
          submissionId: 41,
          problemCode: 'aplusb',
          username: 'kim',
          verdict: 'IE',
          state: 'errored',
          judgedAt: '2026-08-29T09:50:00Z',
          createdAt: '2026-08-29T09:49:00Z',
        },
      ],
      refusalsLastHour: [{ purpose: 'login', count: 12 }],
    });
    wrap(<AdminPage />);

    // The oldest wait is a duration, not a timestamp: 300 s reads as minutes.
    expect(await screen.findByText('5 phút')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /judge0/ })).toHaveTextContent('trực tuyến');
    // Never handshaken is "never", never a formatted epoch.
    expect(screen.getByRole('row', { name: /judge1/ })).toHaveTextContent('chưa kết nối');
    expect(screen.getByRole('row', { name: /judged-1#1/ })).toHaveTextContent('#42');
    expect(screen.getByRole('link', { name: 'aplusb' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'kim' })).toBeInTheDocument();
    // The purpose stays a machine key — it is what you grep the log for.
    expect(screen.getByRole('row', { name: /login/ })).toHaveTextContent('12');
  });

  /**
   * Two rows of bare numbers with no heading over them: the queue block and
   * the runtime block. Both headings were written into the catalogue and
   * used by nothing — the panel-parity test in `i18n.spec.tsx` is what
   * found them, and the fix is to render them, not to delete a label the
   * screen visibly wants.
   */
  it('names its two stat blocks, as the judge and worker tables are named', async () => {
    serve('admin');
    wrap(<AdminPage />);
    expect(await screen.findByRole('heading', { name: 'Hàng đợi chấm' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Cấu hình đang chạy' })).toBeInTheDocument();
  });

  it('says an empty queue has no oldest wait rather than showing a zero', async () => {
    serve('admin');
    wrap(<AdminPage />);
    expect(await screen.findByText(/Chờ lâu nhất/)).toBeInTheDocument();
    expect(screen.queryByText('0 giây')).toBeNull();
  });

  it('admits it was not told judged\'s concurrency instead of printing a guess', async () => {
    serve('admin', [CONTEST], { ...DASHBOARD, runtime: { apiWorkers: 4, judgedConcurrency: null } });
    wrap(<AdminPage />);
    // An em dash, not a blank and not a word in the number column: a cell
    // left empty in a row of counts reads as zero threads. The reason rides
    // in the tooltip.
    const cell = await screen.findByTitle(/JUDGED_CONCURRENCY/);
    expect(cell).toHaveTextContent('\u2014');
  });

  it('requeues expired leases and reports how many moved', async () => {
    serve('admin');
    post.mockResolvedValue({ data: { reclaimed: 2, jobIds: [4, 5] } });
    wrap(<AdminPage />);

    await userEvent.click(await screen.findByRole('button', { name: /Đưa lại vào hàng đợi/ }));
    expect(post).toHaveBeenCalledWith('/admin/grading/reclaim', {});
    expect(await screen.findByRole('status')).toHaveTextContent('Đã đưa lại 2 công việc chấm');
  });

  it('says so when the button moved nothing, rather than going quiet', async () => {
    serve('admin');
    post.mockResolvedValue({ data: { reclaimed: 0, jobIds: [] } });
    wrap(<AdminPage />);

    await userEvent.click(await screen.findByRole('button', { name: /Đưa lại vào hàng đợi/ }));
    expect(await screen.findByRole('status')).toHaveTextContent(/chưa lượt thuê nào hết hạn/);
  });

  it('surfaces a connection failure on the reclaim (M11 shape)', async () => {
    serve('admin');
    post.mockRejectedValue(new TypeError('Failed to fetch'));
    wrap(<AdminPage />);

    await userEvent.click(await screen.findByRole('button', { name: /Đưa lại vào hàng đợi/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Không kết nối được/);
  });

  it('reports a dashboard that will not load instead of rendering empty panels', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/auth/me') return Promise.resolve({ data: { username: 'root', displayName: 'Root', globalRole: 'admin' } });
      if (path === '/contests') return Promise.resolve({ data: { items: [], nextCursor: null } });
      if (path === '/admin/dashboard') return Promise.resolve({ error: { detail: 'nope' } });
      return Promise.resolve({ data: undefined });
    });
    wrap(<AdminPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Không tải được bảng vận hành/);
  });

  it('stops polling while the tab is hidden, and resumes when it is not', async () => {
    // A dashboard left open in a background tab polled every fifteen seconds
    // forever. TanStack Query's `refetchIntervalInBackground` defaults to
    // false and its focus manager reads `document.visibilityState`, so this
    // holds today — the test exists because turning that default on is one
    // word, and nothing else would notice.
    serve('admin');
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      wrap(<AdminPage />);
      await screen.findByRole('heading', { name: /Vận hành/ });
      const before = get.mock.calls.filter((call) => call[0] === '/admin/dashboard').length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(get.mock.calls.filter((call) => call[0] === '/admin/dashboard')).toHaveLength(before);

      hidden.mockReturnValue('visible');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(
        get.mock.calls.filter((call) => call[0] === '/admin/dashboard').length,
      ).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls every fifteen seconds, so a stale board is never left on screen', async () => {
    // Pinned as a literal: the refresh interval is the whole promise of the
    // panel ("a live snapshot"), and a silently-dropped `refetchInterval`
    // would leave a dashboard that looks right and never changes.
    const source = readFileSync(resolve(process.cwd(), 'src/routes/admin.tsx'), 'utf8');
    expect(source).toContain('refetchInterval: 15_000');
  });
});
