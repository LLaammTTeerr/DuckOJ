import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
vi.mock('../src/api.js', () => ({
  api: { GET: (...a: unknown[]) => get(...a), POST: (...a: unknown[]) => post(...a) },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { ContestPage, ScoreboardPage } = await import('../src/routes/contests.js');

/** A fresh client per render: no retries, so an error surfaces immediately. */
function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/**
 * `GET /contests/{key}/clarifications` is the third request the contest page
 * makes (D31's Q&A panel). Every mock here answers it with an empty feed
 * rather than falling through to the participation stub — a query function
 * that returns the wrong shape (or `undefined`, which TanStack Query treats
 * as a failure) puts an error banner on the page these tests are reading.
 */
const NO_CLARIFICATIONS = { data: { items: [] } };

const RUNNING = {
  key: 'spring',
  name: 'Spring Open',
  format: 'icpc',
  startTime: new Date(Date.now() - 60_000).toISOString(),
  endTime: new Date(Date.now() + 3_600_000).toISOString(),
  problems: [{ code: 'aplusb', name: 'A plus B', label: 'A', points: 100 }],
};

afterEach(() => {
  get.mockReset();
  post.mockReset();
});

describe('ContestPage', () => {
  it('offers to join, and only offers Submit once joined', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/contests/{key}/clarifications') return Promise.resolve(NO_CLARIFICATIONS);
      return path === '/contests/{key}'
        ? Promise.resolve({ data: RUNNING })
        : Promise.resolve({ data: undefined });
    });
    wrap(<ContestPage contestKey="spring" />);

    expect(await screen.findByRole('button', { name: /^Tham gia$/ })).toBeInTheDocument();
    // Until you join, submitting to a contest problem would be practice — so
    // the page does not offer a link that silently means something else.
    expect(screen.getByText(/Tham gia để nộp bài/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Nộp bài$/ })).toBeNull();
  });

  it('does not ask whether a VISITOR has joined', async () => {
    // `GET /contests/{key}/me` is session-only: signed out it answers 401,
    // not 404, so asking it unconditionally put a red line in the console of
    // every anonymous visitor to a contest page — the most public page the
    // app has. Found by Task P5's journey 6, whose watchdog fails on any
    // 4xx that is not documented as by-design.
    get.mockImplementation((path: string) => {
      if (path === '/contests/{key}/clarifications') return Promise.resolve(NO_CLARIFICATIONS);
      return path === '/contests/{key}'
        ? Promise.resolve({ data: RUNNING })
        : Promise.resolve({ data: undefined });
    });
    wrap(<ContestPage contestKey="spring" />);

    // The page still renders, and still offers the join it cannot yet know
    // about.
    expect(await screen.findByRole('button', { name: /^Tham gia$/ })).toBeInTheDocument();
    expect(get.mock.calls.map(([path]) => path as string)).not.toContain('/contests/{key}/me');
  });

  it('shows the window and attempt once joined', async () => {
    const endTime = new Date(Date.now() + 1_800_000).toISOString();
    get.mockImplementation((path: string) => {
      if (path === '/contests/{key}/clarifications') return Promise.resolve(NO_CLARIFICATIONS);
      return path === '/contests/{key}'
        ? Promise.resolve({ data: RUNNING })
        : Promise.resolve({ data: { id: 1, contestKey: 'spring', virtual: 0, startTime: RUNNING.startTime, endTime, isDisqualified: false } });
    });
    wrap(<ContestPage contestKey="spring" />);

    expect(await screen.findByRole('status')).toHaveTextContent(/Đang thi chính thức/);
    expect(screen.getByRole('link', { name: /^Nộp bài$/ })).toBeInTheDocument();
  });

  it('refuses to offer a join before the contest starts', async () => {
    const upcoming = {
      ...RUNNING,
      startTime: new Date(Date.now() + 3_600_000).toISOString(),
      endTime: new Date(Date.now() + 7_200_000).toISOString(),
    };
    get.mockImplementation((path: string) => {
      if (path === '/contests/{key}/clarifications') return Promise.resolve(NO_CLARIFICATIONS);
      return path === '/contests/{key}'
        ? Promise.resolve({ data: upcoming })
        : Promise.resolve({ data: undefined });
    });
    wrap(<ContestPage contestKey="spring" />);
    expect(await screen.findByRole('button', { name: /^Tham gia$/ })).toBeDisabled();
  });

  it('surfaces the server message when joining is refused', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/contests/{key}/clarifications') return Promise.resolve(NO_CLARIFICATIONS);
      return path === '/contests/{key}'
        ? Promise.resolve({ data: RUNNING })
        : Promise.resolve({ data: undefined });
    });
    post.mockResolvedValue({ error: { detail: 'This organization admits members by invitation only.' } });
    wrap(<ContestPage contestKey="spring" />);
    await userEvent.click(await screen.findByRole('button', { name: /^Tham gia$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/invitation only/i);
  });
});

describe('ScoreboardPage', () => {
  it('renders the ranking in the goldens own field names', async () => {
    get.mockResolvedValue({
      data: {
        label_by_problem: { aplusb: 'A' },
        problems: [{ code: 'aplusb', label: 'A', points: 100, points_scaling_factor: null, total_ac: 1, first_solve: 'kim' }],
        ranking: [
          {
            rank: 1,
            participant: 'kim',
            virtual: 0,
            is_disqualified: false,
            score: 100,
            cumtime: 300,
            tiebreaker: 0,
            frozen_score: 0,
            frozen_cumtime: 0,
            frozen_tiebreaker: 0,
            submission_count: 1,
            format_data: { aplusb: { points: 100, time: 300 } },
          },
        ],
      },
    });
    wrap(<ScoreboardPage contestKey="spring" />);

    const row = await screen.findByRole('row', { name: /kim/i });
    expect(row).toHaveTextContent('100');
    expect(row).toHaveTextContent('300');
    // A non-icpc cell: points with the scoring minute beside them.
    expect(row).toHaveTextContent('100 \u00b7 5m');
  });

  it('renders icpc cells in attempt-ledger convention', async () => {
    const base = {
      rank: 1,
      virtual: 0,
      is_disqualified: false,
      tiebreaker: 0,
      frozen_score: 0,
      frozen_cumtime: 0,
      frozen_tiebreaker: 0,
    };
    get.mockResolvedValue({
      data: {
        label_by_problem: { a: 'A', b: 'B', c: 'C' },
        problems: [
          { code: 'a', label: 'A', points: 100, points_scaling_factor: null, total_ac: 1, first_solve: 'kim' },
          { code: 'b', label: 'B', points: 100, points_scaling_factor: null, total_ac: 0, first_solve: null },
          { code: 'c', label: 'C', points: 100, points_scaling_factor: null, total_ac: 0, first_solve: null },
        ],
        ranking: [
          {
            ...base,
            participant: 'kim',
            score: 100,
            cumtime: 75,
            submission_count: 6,
            format_data: {
              // Solved on the third try at minute 55.
              a: { points: 100, time: 3300, tries: 3 },
              // Two failed tries, unsolved: the ledger shows what it cost.
              b: { points: 0, time: 0, tries: 2 },
              // Never attempted.
              c: { points: 0, time: 0, tries: 0 },
            },
          },
        ],
      },
    });
    wrap(<ScoreboardPage contestKey="spring" />);

    const row = await screen.findByRole('row', { name: /kim/i });
    expect(row).toHaveTextContent('100 (+2, 55m)');
    expect(row).toHaveTextContent('\u22122');
    expect(row).toHaveTextContent('\u2014');
  });

  it('says so when nobody has competed', async () => {
    get.mockResolvedValue({ data: { label_by_problem: {}, problems: [], ranking: [] } });
    wrap(<ScoreboardPage contestKey="spring" />);
    expect(await screen.findByText(/Chưa có ai dự thi/)).toBeInTheDocument();
  });
});

describe('contest submissions links', () => {
  it('links All submissions for everyone and My submissions only when signed in', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/contests/{key}/clarifications') return Promise.resolve(NO_CLARIFICATIONS);
      if (path === '/contests/{key}') return Promise.resolve({ data: RUNNING });
      if (path === '/auth/me')
        return Promise.resolve({ data: { username: 'kim', displayName: 'Kim', globalRole: 'user' } });
      return Promise.resolve({ data: undefined });
    });
    wrap(<ContestPage contestKey="spring" />);
    expect(await screen.findByRole('link', { name: 'Tất cả bài nộp' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bài nộp của tôi' })).toBeInTheDocument();

    get.mockImplementation((path: string) => {
      if (path === '/contests/{key}/clarifications') return Promise.resolve(NO_CLARIFICATIONS);
      return path === '/contests/{key}'
        ? Promise.resolve({ data: RUNNING })
        : Promise.resolve({ data: undefined });
    });
    wrap(<ContestPage contestKey="spring" />);
    expect((await screen.findAllByRole('link', { name: 'Tất cả bài nộp' })).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('link', { name: 'Bài nộp của tôi' })).toHaveLength(1);
  });
});

describe('ContestPage join transport safety', () => {
  it('disables Join while the request is in flight', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/contests/{key}/clarifications') return Promise.resolve(NO_CLARIFICATIONS);
      return path === '/contests/{key}'
        ? Promise.resolve({ data: RUNNING })
        : Promise.resolve({ data: undefined });
    });
    let resolve!: (value: unknown) => void;
    post.mockImplementation(() => new Promise((r) => { resolve = r; }));
    wrap(<ContestPage contestKey="spring" />);
    const button = await screen.findByRole('button', { name: /^Tham gia$/ });
    await userEvent.click(button);
    expect(button).toBeDisabled();
    resolve({ error: undefined });
    expect(await screen.findByRole('button', { name: /^Tham gia$/ })).toBeEnabled();
  });

  it('surfaces a connection message when the join request cannot reach the server', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/contests/{key}/clarifications') return Promise.resolve(NO_CLARIFICATIONS);
      return path === '/contests/{key}'
        ? Promise.resolve({ data: RUNNING })
        : Promise.resolve({ data: undefined });
    });
    post.mockRejectedValue(new TypeError('fetch failed'));
    wrap(<ContestPage contestKey="spring" />);
    await userEvent.click(await screen.findByRole('button', { name: /^Tham gia$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Không kết nối được máy chủ/);
    expect(screen.getByRole('button', { name: /^Tham gia$/ })).toBeEnabled();
  });
});

describe('score display precision', () => {
  it('trims repeating floats on the scoreboard — score and cell alike', async () => {
    get.mockResolvedValue({
      data: {
        label_by_problem: { a: 'A' },
        problems: [
          { code: 'a', label: 'A', points: 100, points_scaling_factor: null, total_ac: 1, first_solve: 'kim' },
        ],
        ranking: [
          {
            rank: 1,
            participant: 'kim',
            virtual: 0,
            is_disqualified: false,
            // An ioi16 subtask worth 100/3: raw, this printed
            // `33.333333333` into a column sized for three digits.
            score: 33.333333333,
            cumtime: 0,
            tiebreaker: 0,
            frozen_score: 0,
            frozen_cumtime: 0,
            frozen_tiebreaker: 0,
            submission_count: 1,
            format_data: { a: { points: 66.666666666, time: 600 } },
          },
        ],
      },
    });
    wrap(<ScoreboardPage contestKey="spring" />);

    const row = await screen.findByRole('row', { name: /kim/i });
    expect(row).toHaveTextContent('33.33');
    expect(row).toHaveTextContent('66.67 · 10m');
    expect(row).not.toHaveTextContent('33.333333333');
    expect(row).not.toHaveTextContent('66.666666666');
  });

  it("formats the contest problems table with the contest's own pointsPrecision", async () => {
    get.mockImplementation((path: string) =>
      path === '/contests/{key}'
        ? Promise.resolve({
            data: {
              ...RUNNING,
              pointsPrecision: 3,
              problems: [{ code: 'aplusb', name: 'A plus B', label: 'A', points: 33.333333333 }],
            },
          })
        : Promise.resolve({ data: undefined }),
    );
    wrap(<ContestPage contestKey="spring" />);

    // Three decimals because the contest says three — not the default two.
    expect(await screen.findByText('33.333')).toBeInTheDocument();
  });
});
