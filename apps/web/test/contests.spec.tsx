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

const { ContestPage, ContestsPage, ScoreboardPage } = await import('../src/routes/contests.js');

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
  orgs: [],
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

describe('ContestPage booklet link (D48)', () => {
  it('links the PDF booklet in the reader\'s own language, once there are problems', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/contests/{key}/clarifications') return Promise.resolve(NO_CLARIFICATIONS);
      return path === '/contests/{key}'
        ? Promise.resolve({ data: RUNNING })
        : Promise.resolve({ data: undefined });
    });
    wrap(<ContestPage contestKey="spring" />);

    const link = await screen.findByRole('link', { name: /Tải đề \(PDF\)/ });
    expect(link).toHaveAttribute('href', '/api/v1/contests/spring/booklet.pdf?lang=vi');
  });

  it('offers no booklet before the start, when the problem list is concealed', async () => {
    // Pre-start the API answers 404 here, and `problems` comes back empty
    // for exactly the visitors the link would be aimed at.
    get.mockImplementation((path: string) => {
      if (path === '/contests/{key}/clarifications') return Promise.resolve(NO_CLARIFICATIONS);
      return path === '/contests/{key}'
        ? Promise.resolve({
            data: {
              ...RUNNING,
              startTime: new Date(Date.now() + 60_000).toISOString(),
              problems: [],
            },
          })
        : Promise.resolve({ data: undefined });
    });
    wrap(<ContestPage contestKey="spring" />);

    expect(await screen.findByRole('link', { name: /Bảng điểm/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Tải đề/ })).toBeNull();
  });
});

/**
 * The results exports (D71). The API's gate is the PERSON — an organiser may
 * export at any hour, because these documents are folded from the live,
 * unfrozen board — and "after the end" lives HERE, in the web, because that
 * is when an organiser wants them and offering them mid-contest invites
 * printing a board that is still moving. F12 shipped both links with no test
 * on either half of that condition; this is that test.
 */
describe('ContestPage results export links (D71)', () => {
  const FINISHED = {
    ...RUNNING,
    startTime: new Date(Date.now() - 7_200_000).toISOString(),
    endTime: new Date(Date.now() - 60_000).toISOString(),
  };

  function serveContest(contest: unknown) {
    get.mockImplementation((path: string) => {
      if (path === '/contests/{key}/clarifications') return Promise.resolve(NO_CLARIFICATIONS);
      return path === '/contests/{key}'
        ? Promise.resolve({ data: contest })
        : Promise.resolve({ data: undefined });
    });
  }

  it('offers both exports to an organiser once the contest is over', async () => {
    serveContest({ ...FINISHED, canEdit: true });
    wrap(<ContestPage contestKey="spring" />);

    expect(await screen.findByRole('link', { name: /Kết quả \(CSV\)/ })).toHaveAttribute(
      'href',
      '/api/v1/contests/spring/results.csv',
    );
    // No `?lang=`, unlike the booklet: a standings sheet has no statement to
    // translate, so results.pdf takes no language (D71).
    expect(screen.getByRole('link', { name: /Kết quả \(PDF\)/ })).toHaveAttribute(
      'href',
      '/api/v1/contests/spring/results.pdf',
    );
  });

  it('offers neither while the contest is still running, organiser or not', async () => {
    serveContest({ ...RUNNING, canEdit: true });
    wrap(<ContestPage contestKey="spring" />);

    // The booklet IS offered mid-contest — so this asserts the results links
    // are absent on a page that is otherwise fully rendered, not that the
    // page failed to load.
    expect(await screen.findByRole('link', { name: /Tải đề \(PDF\)/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Kết quả/ })).toBeNull();
  });

  it('offers neither to a competitor reading a finished contest', async () => {
    serveContest({ ...FINISHED, canEdit: false });
    wrap(<ContestPage contestKey="spring" />);

    expect(await screen.findByRole('link', { name: /Bảng điểm/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Kết quả/ })).toBeNull();
  });

  // D88: cloning is an organiser action, and the link is gated on the same
  // `canEdit` the server computes — never on a guess from `me`.
  it('offers "Nhân bản kỳ thi" to an organiser and to nobody else', async () => {
    serveContest({ ...FINISHED, canEdit: true });
    const organiser = wrap(<ContestPage contestKey="spring" />);
    expect(await screen.findByRole('link', { name: /Nhân bản kỳ thi/ })).toBeInTheDocument();
    organiser.unmount();

    serveContest({ ...FINISHED, canEdit: false });
    wrap(<ContestPage contestKey="spring" />);
    expect(await screen.findByRole('link', { name: /Bảng điểm/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Nhân bản kỳ thi/ })).toBeNull();
  });

  it('offers neither when the API did not say whether this reader runs it', async () => {
    // `canEdit` absent — an older API, or a response shape that changed.
    // Fail closed: a link that 403s is worse than no link.
    serveContest(FINISHED);
    wrap(<ContestPage contestKey="spring" />);

    expect(await screen.findByRole('link', { name: /Bảng điểm/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Kết quả/ })).toBeNull();
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

/**
 * The contest list can reach page two, and can ask for the round that is on
 * (D180).
 *
 * **The defect this pins.** `ContestsPage` fired `GET /contests` with no
 * parameters at all, read `.items` and dropped `nextCursor`: 167 rounds on
 * the live judge, 25 on screen, and **142 unreachable from any control**. The
 * list also never asked for `phase`, which D151 built for exactly this
 * reader — so the one question a contest list is opened with, "which round is
 * on?", could only be answered by reading a page of the oldest rounds the
 * judge has ever run.
 *
 * Both halves are asserted, and the second cursor grammar with them: a
 * `phase` page is ordered by START TIME and its cursor is `<millis>_<id>`
 * (D151), so the walk has to carry that composite through unchanged and has
 * to START OVER when the filter changes. A stale id cursor sent to a
 * start-time page is the mismatched-seek bug D177 caught in the API, wearing
 * a different hat.
 */
describe('ContestsPage past one page (D180)', () => {
  function round(n: number) {
    return {
      key: `round-${String(n)}`,
      name: `Round ${String(n)}`,
      format: 'icpc',
      startTime: new Date(Date.now() - 86_400_000 * n).toISOString(),
      endTime: new Date(Date.now() - 86_400_000 * n + 3_600_000).toISOString(),
      orgs: [],
      isRated: false,
    };
  }
  function rounds(from: number, to: number) {
    return Array.from({ length: to - from + 1 }, (_, i) => round(from + i));
  }

  type Ask = { phase?: string | undefined; cursor?: string | undefined };

  function serve(asks: Ask[], pages: Record<string, unknown>) {
    get.mockImplementation((path: string, init?: Record<string, unknown>) => {
      if (path === '/auth/me') return Promise.resolve({ data: undefined });
      if (path !== '/contests') return Promise.resolve({ data: undefined });
      const query = (init?.params as { query?: Ask } | undefined)?.query ?? {};
      asks.push({ phase: query.phase, cursor: query.cursor });
      const key = `${query.phase ?? 'all'}:${query.cursor ?? ''}`;
      return Promise.resolve({ data: pages[key] ?? { items: [], nextCursor: null } });
    });
  }

  it('offers "load more" and sends the first page’s cursor for the rest', async () => {
    const asks: Ask[] = [];
    serve(asks, {
      'all:': { items: rounds(1, 25), nextCursor: '25' },
      'all:25': { items: rounds(26, 27), nextCursor: null },
    });
    wrap(<ContestsPage />);

    expect(await screen.findByText('Round 1')).toBeInTheDocument();
    expect(screen.queryByText('Round 26')).toBeNull();

    await userEvent.click(await screen.findByRole('button', { name: /tải thêm|load more/i }));

    expect(await screen.findByText('Round 27')).toBeInTheDocument();
    expect(screen.getByText('Round 1')).toBeInTheDocument();
    expect(asks).toEqual([
      { phase: undefined, cursor: undefined },
      { phase: undefined, cursor: '25' },
    ]);
    expect(screen.queryByRole('button', { name: /tải thêm|load more/i })).toBeNull();
  });

  it('asks the API for the round that is happening, and says so upward', async () => {
    const asks: Ask[] = [];
    serve(asks, {
      'all:': { items: rounds(1, 2), nextCursor: null },
      'running:': { items: [round(9)], nextCursor: null },
    });
    const seen: (string | undefined)[] = [];
    wrap(<ContestsPage onPhaseChange={(next) => seen.push(next)} />);
    await screen.findByText('Round 1');

    await userEvent.selectOptions(
      screen.getByLabelText(/giai đoạn|phase/i),
      'running',
    );
    expect(await screen.findByText('Round 9')).toBeInTheDocument();
    expect(asks.at(-1)).toEqual({ phase: 'running', cursor: undefined });
    // The URL is told, so the filtered list is a link a teacher can send.
    expect(seen).toEqual(['running']);
  });

  it('walks a phase page with D151’s composite cursor, and starts over when the filter changes', async () => {
    const asks: Ask[] = [];
    serve(asks, {
      'active:': { items: rounds(1, 2), nextCursor: '1772000000000_9' },
      'active:1772000000000_9': { items: [round(30)], nextCursor: null },
      'all:': { items: rounds(40, 41), nextCursor: null },
    });
    wrap(<ContestsPage initialPhase="active" />);
    await screen.findByText('Round 1');
    await userEvent.click(await screen.findByRole('button', { name: /tải thêm|load more/i }));
    expect(await screen.findByText('Round 30')).toBeInTheDocument();
    expect(asks).toEqual([
      { phase: 'active', cursor: undefined },
      { phase: 'active', cursor: '1772000000000_9' },
    ]);

    // Back to everything: a start-time cursor must NOT be carried into an
    // id-ordered page — that is the mismatched seek, and it silently
    // truncates the walk.
    await userEvent.selectOptions(screen.getByLabelText(/giai đoạn|phase/i), '');
    expect(await screen.findByText('Round 40')).toBeInTheDocument();
    expect(asks.at(-1)).toEqual({ phase: undefined, cursor: undefined });
  });
});
