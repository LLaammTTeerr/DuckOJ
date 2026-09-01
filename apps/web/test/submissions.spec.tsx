import type { ReactElement } from 'react';
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api.js';
import { SubmissionsPage } from '../src/routes/submissions.js';

// Same mocking pattern as test/problems.spec.tsx: `SubmissionsPage` reaches
// the network only through `api`, so mocking the module is enough.
vi.mock('../src/api.js', () => ({
  api: { GET: vi.fn(), POST: vi.fn() },
}));

const mockedGet = vi.mocked(api.GET);

/**
 * The `languages` rows the column reads its display names from (F-39). The
 * list used to print `languageKey` verbatim, which only looked like a word
 * while `cpp17` was the only row.
 */
const LANGUAGE_ROWS = [
  {
    key: 'cpp17',
    name: 'C++17',
    extension: 'cpp',
    isActive: true,
    timeMultiplierPct: 100,
    memoryExtraKb: 0,
  },
  {
    key: 'python3',
    name: 'Python 3',
    extension: 'py',
    isActive: true,
    timeMultiplierPct: 300,
    memoryExtraKb: 32768,
  },
];

/**
 * Answers queued for `GET /submissions`, oldest first.
 *
 * The page now makes TWO requests — the list and the language catalogue — so
 * a bare `mockResolvedValueOnce` is no longer safe: `mockResolvedValueOnce`
 * hands its value to whichever call arrives next, regardless of path, and the
 * catalogue query would silently eat the page a test had queued for the list.
 * Routing by path first, and only then consuming the queue, keeps every
 * `answerOnce` below meaning exactly what `mockResolvedValueOnce` used to.
 */
let queued: unknown[] = [];
let standing: unknown = { data: { items: [], nextCursor: null } };

function installMock(): void {
  queued = [];
  standing = { data: { items: [], nextCursor: null } };
  mockedGet.mockImplementation((path: unknown) => {
    if (path === '/languages') return Promise.resolve({ data: { items: LANGUAGE_ROWS } });
    return Promise.resolve(queued.length > 0 ? queued.shift() : standing);
  });
}

/** One answer for the next `GET /submissions` — `mockResolvedValueOnce`. */
function answerOnce(value: unknown): void {
  queued.push(value);
}

/** The answer for every `GET /submissions` — `mockResolvedValue`. */
function answerAlways(value: unknown): void {
  standing = value;
}

beforeEach(() => {
  installMock();
});

afterEach(() => {
  mockedGet.mockReset();
});

// `SubmissionsPage` renders a `<Link to="/problems/$code">` per row, same
// reason `problems.spec.tsx` needs one: `<Link>` throws outside a router.
const testRootRoute = createRootRoute();
const testProblemRoute = createRoute({
  getParentRoute: () => testRootRoute,
  path: '/problems/$code',
});
const testContestRoute = createRoute({
  getParentRoute: () => testRootRoute,
  path: '/contests/$key',
});
const testRouter = createRouter({
  routeTree: testRootRoute.addChildren([testProblemRoute, testContestRoute]),
  history: createMemoryHistory({ initialEntries: ['/submissions'] }),
});

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RouterContextProvider router={testRouter}>{ui}</RouterContextProvider>
    </QueryClientProvider>,
  );
}

const SUBMISSION_A = {
  id: 42,
  problemCode: 'aplusb',
  username: 'alice',
  languageKey: 'cpp17',
  state: 'done' as const,
  verdict: 'AC' as const,
  points: 100,
  maxPoints: 100,
  contestKey: 'spring-2026',
  contestLabel: 'Spring Cup 2026',
  teamName: null,
  createdAt: '2026-01-01T00:00:00Z',
};

const SUBMISSION_B = {
  id: 41,
  problemCode: 'aplusb',
  username: 'bob',
  languageKey: 'py3',
  state: 'grading' as const,
  verdict: null,
  points: null,
  maxPoints: null,
  // A practice submission: no contest, so nothing to link to.
  contestKey: null,
  contestLabel: null,
  teamName: null,
  createdAt: '2026-01-01T00:00:00Z',
};

describe('SubmissionsPage', () => {
  it('renders a row per submission, verdict as a badge, and points as points/maxPoints', async () => {
    answerOnce({
      data: { items: [SUBMISSION_A, SUBMISSION_B], nextCursor: null },
      error: undefined,
      response: new Response(),
    } as never);

    renderWithClient(<SubmissionsPage />);

    expect(await screen.findByText('42')).toBeInTheDocument();
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(3); // header + 2 submissions

    // SUBMISSION_A: a real AC verdict, using the shared .badge glyph system.
    expect(within(rows[1]!).getByText('AC')).toHaveClass('badge', 'ac');
    // F-39: the language column names the row rather than printing its key.
    expect(within(rows[1]!).getByText('C++17')).toBeInTheDocument();
    expect(within(rows[1]!).queryByText('cpp17')).toBeNull();
    expect(within(rows[1]!).getByText('100/100')).toBeInTheDocument();

    // SUBMISSION_B: still grading — no verdict, no points, both render as
    // the neutral "pend" badge / em dash, never blank.
    expect(within(rows[2]!).getByText('—', { selector: 'span' })).toHaveClass('badge', 'pend');
    // Two em-dashed cells on this row now: the contest (a practice
    // submission belongs to none) and the points (nothing graded yet). Both
    // are the same "empty on purpose" glyph, never a blank cell.
    expect(within(rows[2]!).getAllByText('—', { selector: 'td' })).toHaveLength(2);
  });

  it('names each filter box in words a reader can see, not a bare sigil', async () => {
    // The three filter boxes were labelled "#", "@" and "%" — the real
    // wording lived only in `aria-label`, so a sighted teacher looking for
    // "filter by contest key" saw a percent sign and had to guess. The
    // caption is now the visible label, tied to its box by `htmlFor` so
    // clicking it focuses the field (a screen reader's experience is
    // unchanged: the same string was already its accessible name).
    answerOnce({
      data: { items: [SUBMISSION_A], nextCursor: null },
      error: undefined,
      response: new Response(),
    } as never);

    renderWithClient(<SubmissionsPage />);
    await screen.findByText('42');

    for (const [caption, placeholder] of [
      ['Lọc theo mã bài', 'mã bài'],
      ['Lọc theo tên đăng nhập', 'tên đăng nhập'],
      ['Lọc theo mã kỳ thi', 'mã kỳ thi'],
    ] as const) {
      const label = screen.getByText(caption, { selector: 'label' });
      const box = screen.getByLabelText(caption);
      expect(label).toHaveAttribute('for', box.getAttribute('id'));
      expect(box).toHaveAttribute('placeholder', placeholder);
    }
    // And the sigils are gone from the rendered page.
    for (const sigil of ['#', '@', '%']) {
      expect(screen.queryByText(sigil, { selector: 'span' })).toBeNull();
    }
  });

  it('tells an empty list what to do next, and says which emptiness it is', async () => {
    // "Không tìm thấy bài nộp nào." and nothing else: true, useless, and the
    // first thing a new pupil sees on this screen. An empty list has exactly
    // two causes and they want opposite actions — nothing submitted yet
    // (go and solve something) versus a filter that matched nothing (clear
    // it) — and the old line could not tell them apart.
    answerAlways({
      data: { items: [], nextCursor: null },
      error: undefined,
      response: new Response(),
    } as never);

    const view = renderWithClient(<SubmissionsPage />);
    // No filter: the way out is a problem to solve.
    expect(await screen.findByText('Chưa có bài nộp nào.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Chọn một bài tập' })).toHaveAttribute(
      'href',
      '/problems',
    );
    expect(screen.queryByRole('button', { name: 'Xoá bộ lọc' })).toBeNull();
    view.unmount();

    // A filter that matched nothing: the way out is to drop the filter, and
    // pressing it puts the unfiltered list back.
    renderWithClient(<SubmissionsPage initialProblem="khong-co-bai-nay" />);
    expect(await screen.findByText('Không có bài nộp nào khớp bộ lọc.')).toBeInTheDocument();
    const clear = screen.getByRole('button', { name: 'Xoá bộ lọc' });
    await userEvent.click(clear);
    expect(screen.getByLabelText('Lọc theo mã bài')).toHaveValue('');
    expect(screen.getByText('Chưa có bài nộp nào.')).toBeInTheDocument();
  });

  it('links each row to its problem', async () => {
    answerOnce({
      data: { items: [SUBMISSION_A], nextCursor: null },
      error: undefined,
      response: new Response(),
    } as never);

    renderWithClient(<SubmissionsPage />);

    expect(await screen.findByRole('link', { name: 'aplusb' })).toHaveAttribute(
      'href',
      '/problems/aplusb',
    );
  });

  it('links the id to the detail page and the user to their profile', async () => {
    answerOnce({
      data: { items: [SUBMISSION_A], nextCursor: null },
      error: undefined,
      response: new Response(),
    } as never);

    renderWithClient(<SubmissionsPage />);

    expect(await screen.findByRole('link', { name: '42' })).toHaveAttribute(
      'href',
      '/submissions/42',
    );
    expect(screen.getByRole('link', { name: SUBMISSION_A.username })).toHaveAttribute(
      'href',
      `/users/${SUBMISSION_A.username}`,
    );
  });

  it('links a contest submission to its contest and leaves a practice row unlinked', async () => {
    answerOnce({
      data: { items: [SUBMISSION_A, SUBMISSION_B], nextCursor: null },
      error: undefined,
      response: new Response(),
    } as never);

    renderWithClient(<SubmissionsPage />);

    // The contest's NAME is what a competitor recognizes; the key is what the
    // URL is built from. Contest names are content and never translated.
    const link = await screen.findByRole('link', { name: 'Spring Cup 2026' });
    expect(link).toHaveAttribute('href', '/contests/spring-2026');

    // The practice row shows the same em dash every other empty cell uses —
    // never a link to nowhere, and never blank.
    const rows = screen.getAllByRole('row');
    expect(within(rows[2]!).queryByRole('link', { name: /Spring/ })).toBeNull();
  });

  it('labels a team submission with "(đội <team>)" beside the submitter (D117)', async () => {
    answerOnce({
      data: {
        items: [{ ...SUBMISSION_A, username: 'bob', teamName: 'Đội Rồng' }],
        nextCursor: null,
      },
      error: undefined,
      response: new Response(),
    } as never);

    renderWithClient(<SubmissionsPage />);

    // The submitter is still their own profile link; the team rides beside it.
    expect(await screen.findByRole('link', { name: 'bob' })).toHaveAttribute('href', '/users/bob');
    const userCell = screen.getByRole('link', { name: 'bob' }).closest('td')!;
    expect(userCell).toHaveTextContent(/đội Đội Rồng/);
  });

  it('seeds the filters from the deep link, and queries with them from the first request', async () => {
    answerAlways({
      data: { items: [], nextCursor: null },
      error: undefined,
      response: new Response(),
    } as never);

    renderWithClient(
      <SubmissionsPage initialProblem="aplusb" initialUser="kim" initialContest="spring" />,
    );
    await screen.findByText(/Không có bài nộp nào khớp bộ lọc/);

    // The FIRST `/submissions` call, not the first call outright: the page
    // also fetches `/languages` for the column's display names (F-39), and
    // which of the two React starts first is not this test's business.
    const call = (mockedGet.mock.calls as unknown as [string, unknown][]).find(
      ([path]) => path === '/submissions',
    );
    const [, options] = call as [string, { params: { query: Record<string, string> } }];
    expect(options.params.query.problem).toBe('aplusb');
    expect(options.params.query.user).toBe('kim');
    expect(options.params.query.contest).toBe('spring');
  });

  it('re-queries with a problem filter when the problem field changes', async () => {
    answerAlways({
      data: { items: [SUBMISSION_A], nextCursor: null },
      error: undefined,
      response: new Response(),
    } as never);

    renderWithClient(<SubmissionsPage />);
    await screen.findByText('42');

    await userEvent.type(screen.getByLabelText(/Lọc theo mã bài/), 'aplusb');

    await waitFor(() => {
      const last = mockedGet.mock.calls.at(-1);
      expect(last?.[1]).toMatchObject({ params: { query: { problem: 'aplusb' } } });
    });
  });

  it('re-queries with a verdict filter when the verdict select changes', async () => {
    answerAlways({
      data: { items: [SUBMISSION_A], nextCursor: null },
      error: undefined,
      response: new Response(),
    } as never);

    renderWithClient(<SubmissionsPage />);
    await screen.findByText('42');

    await userEvent.selectOptions(screen.getByLabelText(/^Kết quả$/), 'WA');

    await waitFor(() => {
      const last = mockedGet.mock.calls.at(-1);
      expect(last?.[1]).toMatchObject({ params: { query: { verdict: 'WA' } } });
    });
  });

  it('appends the next page instead of replacing the first on "load more"', async () => {
    answerOnce({
      data: { items: [SUBMISSION_A], nextCursor: 'cursor-1' },
      error: undefined,
      response: new Response(),
    });
    answerOnce({
      data: { items: [SUBMISSION_B], nextCursor: null },
      error: undefined,
      response: new Response(),
    });

    renderWithClient(<SubmissionsPage />);
    await screen.findByText('42');
    expect(screen.queryByText('41')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Tải thêm$/ }));

    await screen.findByText('41');
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('41')).toBeInTheDocument();
  });

  it('shows an error state when the request fails', async () => {
    answerOnce({
      data: undefined,
      error: { type: 'about:blank', title: 'Unauthorized', status: 401, code: 'not_signed_in' },
      response: new Response(),
    } as never);

    renderWithClient(<SubmissionsPage />);

    expect(await screen.findByText(/Không tải được danh sách bài nộp/)).toBeInTheDocument();
  });
});
