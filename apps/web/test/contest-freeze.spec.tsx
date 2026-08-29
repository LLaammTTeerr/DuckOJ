/**
 * The freeze window on screen (D22): the banner that says the board is
 * incomplete, and the `?+n` cells that say where.
 *
 * `?+n` is deliberately untranslated, for the same reason `+`, `−` and the
 * `m` minute suffix are: it is scoreboard notation, not prose.
 */
import type { ReactElement } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const navigate = vi.fn();
vi.mock('../src/api.js', () => ({
  api: {
    GET: (...a: unknown[]) => get(...a),
    POST: (...a: unknown[]) => post(...a),
    PATCH: (...a: unknown[]) => patch(...a),
  },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => navigate,
}));

const { ScoreboardPage } = await import('../src/routes/contests.js');
const { ContestNewPage } = await import('../src/routes/contest-new.js');
const { ContestEditPage } = await import('../src/routes/contest-edit.js');

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const FROZEN_AT = '2026-03-01T13:00:00.000Z';

/** The same instant the banner prints, re-derived here rather than imported. */
const FROZEN_TIME = new Date(FROZEN_AT).toLocaleTimeString('vi-VN', {
  hour: '2-digit',
  minute: '2-digit',
});

/** The same day, likewise re-derived rather than imported. */
const FROZEN_DAY = new Date(FROZEN_AT).toLocaleDateString('vi-VN');

function board(opts: { frozen: boolean; pending?: Record<string, number> }) {
  return {
    label_by_problem: { aplusb: 'A', sum: 'B' },
    problems: [
      { code: 'aplusb', label: 'A', points: 100, points_scaling_factor: null, total_ac: 1, first_solve: 'alice' },
      { code: 'sum', label: 'B', points: 100, points_scaling_factor: null, total_ac: 0, first_solve: null },
    ],
    ranking: [
      {
        rank: 1,
        participant: 'alice',
        virtual: 0,
        is_disqualified: false,
        score: 100,
        cumtime: 60,
        tiebreaker: 0,
        frozen_score: 0,
        frozen_cumtime: 0,
        frozen_tiebreaker: 0,
        submission_count: 1,
        format_data: { aplusb: { points: 100, time: 60 } },
        ...(opts.pending ? { pending: opts.pending } : {}),
      },
    ],
    frozen: opts.frozen,
    frozenAt: opts.frozen ? FROZEN_AT : null,
  };
}

function routeGet(data: unknown): void {
  get.mockImplementation((path: string) =>
    path === '/contests/{key}'
      ? Promise.resolve({ data: { key: 'spring', name: 'Spring', canEdit: false } })
      : Promise.resolve({ data }),
  );
}

const CONTEST = {
  id: 1,
  key: 'spring',
  name: 'Spring Open',
  startTime: new Date(Date.now() + 3_600_000).toISOString(),
  endTime: new Date(Date.now() + 7_200_000).toISOString(),
  format: 'icpc',
  visibility: 'public' as const,
  pointsPrecision: 3,
  frozenLastMinutes: 20,
  timeLimitSeconds: null,
  isRated: false,
  createdAt: new Date().toISOString(),
  formatConfig: null,
  canEdit: true,
  problems: [{ code: 'aplusb', name: 'A plus B', label: 'A', points: 100, partial: true, order: 0 }],
};

afterEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  navigate.mockReset();
});

describe('a frozen scoreboard', () => {
  it('says so, in Vietnamese, naming the DAY it froze when that is not today (m17)', async () => {
    routeGet(board({ frozen: true, pending: { sum: 1 } }));
    wrap(<ScoreboardPage contestKey="spring" />);

    // `frozenAt` is the CONTEST's freeze instant while `frozen` is
    // per-participation (D22), so a virtual entrant weeks later sees a time
    // that is not today's. `HH:MM` alone reads as this afternoon.
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(`Bảng điểm đang đóng băng từ ${FROZEN_DAY} ${FROZEN_TIME}`);
  });

  it('drops the date when the board froze today', async () => {
    const todayAt = new Date();
    todayAt.setHours(13, 0, 0, 0);
    routeGet({ ...board({ frozen: true }), frozenAt: todayAt.toISOString() });
    wrap(<ScoreboardPage contestKey="spring" />);

    const time = todayAt.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(`Bảng điểm đang đóng băng từ ${time}`);
    expect(banner).not.toHaveTextContent(todayAt.toLocaleDateString('vi-VN'));
  });

  it('marks the hidden attempts on the cells that hold them', async () => {
    routeGet(board({ frozen: true, pending: { aplusb: 2, sum: 1 } }));
    wrap(<ScoreboardPage contestKey="spring" />);

    const alice = (await screen.findByText('alice')).closest('tr')!;
    const cells = within(alice).getAllByRole('cell');
    // Rank, participant, score, cumtime, then one per problem.
    expect(cells[4]).toHaveTextContent('100 · 1m ?+2');
    // No visible submission on B at all: the count stands alone rather than
    // hanging off an em-dash that would read as "nothing happened here".
    expect(cells[5]).toHaveTextContent('?+1');
    expect(cells[5]).not.toHaveTextContent('—');
  });

  it('leaves an unfrozen board with no banner and no markers', async () => {
    routeGet(board({ frozen: false }));
    wrap(<ScoreboardPage contestKey="spring" />);

    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    const alice = screen.getByText('alice').closest('tr')!;
    expect(within(alice).getAllByRole('cell')[5]).toHaveTextContent('—');
  });
});

describe('the freeze field on the contest forms', () => {
  it('is sent on create', async () => {
    post.mockResolvedValue({ data: { key: 'spring' } });
    wrap(<ContestNewPage />);

    await userEvent.type(screen.getByLabelText('Mã kỳ thi'), 'spring');
    await userEvent.type(screen.getByLabelText('Tên'), 'Spring');
    await userEvent.type(screen.getByLabelText('Bắt đầu'), '2026-03-01T09:00');
    await userEvent.type(screen.getByLabelText('Kết thúc'), '2026-03-01T14:00');
    await userEvent.clear(screen.getByLabelText('Đóng băng (phút)'));
    await userEvent.type(screen.getByLabelText('Đóng băng (phút)'), '30');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo kỳ thi' }));

    expect(post.mock.calls[0]![1].body.frozenLastMinutes).toBe(30);
  });

  it('prefills from the contest on edit, and sends what it was given back', async () => {
    get.mockResolvedValue({ data: CONTEST });
    patch.mockResolvedValue({ data: CONTEST });
    wrap(<ContestEditPage contestKey="spring" />);

    // A number, not a string: the edit form's freeze box is `type="number"`
    // so a browser refuses non-integers before the handler ever sees them
    // (m6's other half).
    expect(await screen.findByLabelText('Đóng băng (phút)')).toHaveValue(20);
    await userEvent.click(screen.getByRole('button', { name: 'Lưu kỳ thi' }));

    expect(patch.mock.calls[0]![1].body.frozenLastMinutes).toBe(20);
  });
});
