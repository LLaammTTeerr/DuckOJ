import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('../src/api.js', () => ({ api: { GET: (...a: unknown[]) => get(...a) } }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { MyProgressPage, PublicProgressPanel } = await import('../src/routes/progress.js');
const { LocaleProvider } = await import('../src/i18n/index.js');

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const ME = {
  id: 1,
  username: 'kim',
  displayName: 'Kim',
  globalRole: 'user',
  locale: null,
  timezone: null,
};

const HEATMAP = {
  timezone: 'Asia/Ho_Chi_Minh',
  from: '2026-01-01',
  to: '2026-01-14',
  days: [
    { date: '2026-01-02', count: 3 },
    { date: '2026-01-05', count: 12 },
  ],
};

const PROGRESS = {
  byTag: [
    { slug: 'quy-hoach-dong', nameVi: 'Quy hoạch động', nameEn: 'Dynamic programming', attempted: 4, solved: 2 },
  ],
  byDifficulty: [
    { difficulty: 3, attempted: 3, solved: 2 },
    { difficulty: null, attempted: 1, solved: 0 },
  ],
  heatmap: HEATMAP,
  streak: { current: 4, longest: 9, lastDate: '2026-01-05' },
  recent: [
    {
      id: 77,
      problemCode: 'aplusb',
      problemName: 'A+B',
      verdict: 'AC',
      points: 100,
      createdAt: '2026-01-05T03:00:00Z',
    },
  ],
  upcomingContests: [
    {
      key: 'tinh-2026',
      name: 'Thi tỉnh 2026',
      startTime: '2026-01-06T01:00:00Z',
      endTime: '2026-01-06T05:00:00Z',
      endsAt: '2026-01-06T05:00:00Z',
    },
  ],
  homework: [
    {
      orgSlug: 'thpt-a',
      orgName: 'THPT A',
      slug: 'tuan-1',
      name: 'Tuần 1',
      deadline: '2026-01-09T17:00:00Z',
      total: 5,
      solved: 2,
    },
  ],
};

const EMPTY = {
  byTag: [],
  byDifficulty: [],
  heatmap: { ...HEATMAP, days: [] },
  streak: { current: 0, longest: 0, lastDate: null },
  recent: [],
  upcomingContests: [],
  homework: [],
};

const RATED = {
  items: [
    { contestKey: 'a', contestName: 'A', endTime: '2026-01-01T00:00:00Z', rank: 3, ratingBefore: 1400, ratingAfter: 1450, delta: 50 },
    { contestKey: 'b', contestName: 'B', endTime: '2026-01-02T00:00:00Z', rank: 1, ratingBefore: 1450, ratingAfter: 1520, delta: 70 },
  ],
  nextCursor: null,
};

function serve(progress: unknown, rating: unknown = { items: [], nextCursor: null }, me: unknown = ME) {
  get.mockImplementation((path: string) => {
    if (path === '/auth/me') return Promise.resolve({ data: me });
    if (path === '/users/me/progress') return Promise.resolve({ data: progress });
    if (path === '/users/{username}/progress') return Promise.resolve({ data: progress });
    return Promise.resolve({ data: rating });
  });
}

afterEach(() => get.mockReset());

describe('MyProgressPage', () => {
  it('shows the tiles, the bars, what is due and the last verdicts', async () => {
    serve(PROGRESS, RATED);
    wrap(<MyProgressPage />);

    expect(await screen.findByRole('heading', { name: 'Tiến độ của tôi' })).toBeInTheDocument();
    // Solved and attempted are summed off the difficulty bars — one shape of
    // the same data, never a second server-side counter to drift.
    expect(screen.getByText('Số bài đã giải').parentElement).toHaveTextContent('2');
    expect(screen.getByText('Số bài đã thử').parentElement).toHaveTextContent('4');
    expect(screen.getByText('Chuỗi hiện tại').parentElement).toHaveTextContent('4 ngày');
    expect(screen.getByText('Chuỗi dài nhất').parentElement).toHaveTextContent('9 ngày');

    // The zone the days were bucketed in is stated: a calendar that does not
    // say whose midnight it used is a calendar two readers will disagree on.
    expect(screen.getByText(/Asia\/Ho_Chi_Minh/)).toBeInTheDocument();

    expect(screen.getByRole('row', { name: /Quy hoạch động/ })).toHaveTextContent('4');
    // The unrated bucket is named rather than shown as a blank row.
    expect(screen.getByRole('row', { name: /chưa xếp độ khó/ })).toBeInTheDocument();

    expect(screen.getByText('Thi tỉnh 2026')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Tuần 1/ })).toHaveTextContent('2/5');
    expect(screen.getByRole('row', { name: /A\+B/ })).toBeInTheDocument();
  });

  it('draws one heatmap cell per day of the served range, titled with its count', async () => {
    serve(PROGRESS);
    wrap(<MyProgressPage />);

    const calendar = await screen.findByRole('img', { name: /bài nộp trong một năm qua/ });
    // 14 days served, and the sparse days are FILLED IN: a quiet fortnight
    // must not shorten the calendar.
    expect(calendar.querySelectorAll('rect')).toHaveLength(14);
    expect(calendar.querySelectorAll('title')[1]).toHaveTextContent('2026-01-02: 3 bài nộp');
    // A day nobody submitted on is still drawn, at the faintest step.
    expect(calendar.querySelectorAll('rect')[0]).toHaveAttribute('fill-opacity', '0.07');
    expect(calendar.querySelectorAll('rect')[1]).toHaveAttribute('fill-opacity', '0.48');

    // The scroller is a tab stop: a year of weeks is wider than a phone, and
    // a scroll container with no `tabindex` is unreachable from a keyboard.
    const scroller = screen.getByRole('group', { name: 'Hoạt động' });
    expect(scroller).toHaveClass('grid-scroll');
    expect(scroller).toHaveAttribute('tabindex', '0');
  });

  it('draws the rating sparkline only once there are two points to join', async () => {
    serve(PROGRESS, RATED);
    const { unmount } = wrap(<MyProgressPage />);
    expect(await screen.findByRole('img', { name: 'Rating từ 1450 đến 1520' })).toBeInTheDocument();
    // The band's title and colour are `packages/glicko2` data (D46).
    expect(screen.getByText('Chuyên gia')).toHaveClass('rank', 'specialist');
    unmount();

    get.mockReset();
    serve(PROGRESS, { items: [RATED.items[0]], nextCursor: null });
    wrap(<MyProgressPage />);
    expect(await screen.findByRole('heading', { name: 'Tiến độ của tôi' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Rating từ/ })).not.toBeInTheDocument();
  });

  it('says what is empty rather than showing four blank tables', async () => {
    serve(EMPTY);
    wrap(<MyProgressPage />);
    expect(await screen.findByRole('heading', { name: 'Tiến độ của tôi' })).toBeInTheDocument();
    expect(screen.getAllByText(/Chưa tính bài nào/)).toHaveLength(2);
    expect(screen.getByText('Bạn không đang dự kỳ thi nào.')).toBeInTheDocument();
    expect(screen.getByText('Không có bài nào đến hạn.')).toBeInTheDocument();
    expect(screen.getByText('Bạn chưa nộp bài nào.')).toBeInTheDocument();
    // Unrated: no band, no sparkline, and never a `null` on screen.
    expect(screen.getByText('chưa xếp hạng')).toBeInTheDocument();
  });

  it('asks the reader to sign in, and never calls the endpoint that would 401', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/auth/me') return Promise.resolve({ data: null });
      return Promise.resolve({ data: EMPTY });
    });
    wrap(<MyProgressPage />);
    expect(await screen.findByText('Đăng nhập để xem tiến độ của bạn.')).toBeInTheDocument();
    expect(get.mock.calls.map((call) => call[0])).not.toContain('/users/me/progress');
  });

  it('renders the English catalogue under the English locale', async () => {
    serve(PROGRESS, RATED);
    wrap(
      <LocaleProvider initialLocale="en">
        <MyProgressPage />
      </LocaleProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'My progress' })).toBeInTheDocument();
    expect(screen.getByText('Current streak')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Dynamic programming/ })).toBeInTheDocument();
  });
});

describe('PublicProgressPanel', () => {
  it('shows the bars and the calendar, and nothing the owner’s own page adds', async () => {
    serve(PROGRESS);
    wrap(<PublicProgressPanel username="kim" />);

    expect(await screen.findByRole('heading', { name: 'Hoạt động' })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Quy hoạch động/ })).toBeInTheDocument();
    // The four owner-only panels must not appear on somebody else's profile,
    // whatever the endpoint happened to return.
    expect(screen.queryByText('Chuỗi hiện tại')).not.toBeInTheDocument();
    expect(screen.queryByText('Bài tập về nhà')).not.toBeInTheDocument();
    expect(screen.queryByText('Kết quả gần đây')).not.toBeInTheDocument();
    expect(screen.queryByText('Kỳ thi đang diễn ra')).not.toBeInTheDocument();
  });

  it('reads the PUBLIC route, not the owner’s', async () => {
    serve(PROGRESS);
    wrap(<PublicProgressPanel username="kim" />);
    await screen.findByRole('heading', { name: 'Hoạt động' });
    const paths = get.mock.calls.map((call) => call[0]);
    expect(paths).toContain('/users/{username}/progress');
    expect(paths).not.toContain('/users/me/progress');
  });

  it('stays silent while it is loading rather than claiming an empty year', async () => {
    get.mockImplementation(() => new Promise(() => undefined));
    wrap(<PublicProgressPanel username="kim" />);
    expect(screen.getByText('Đang tải…')).toBeInTheDocument();
    expect(within(document.body).queryByRole('img')).not.toBeInTheDocument();
  });
});
