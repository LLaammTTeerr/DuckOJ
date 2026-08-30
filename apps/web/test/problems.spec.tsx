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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api.js';
import { ProblemsPage, formatMemoryMb } from '../src/routes/problems.js';
import { ProblemPage } from '../src/routes/problem.js';

// Establishes the pattern for mocking the SDK client directly (no existing
// spec in this repo needed it before Task 11 — submit.tsx/login.tsx's tests
// exercise presentational components with props/callbacks instead). Every
// route file under test here reaches the network only through `api`, so
// mocking the whole module is enough to keep these component tests off any
// real server.
vi.mock('../src/api.js', () => ({
  api: { GET: vi.fn(), POST: vi.fn() },
}));

const mockedGet = vi.mocked(api.GET);

/**
 * Dispatches a mocked `GET` response by path: each key's value is either
 * one response reused for every call to that path, or an array consumed
 * one response per call (holding the last entry once exhausted) —
 * `/problems`'s "load more" test needs page 1 then page 2, everything else
 * needs one fixed response.
 */
function mockApiGet(handlers: Record<string, unknown>): void {
  const queues = new Map<string, unknown[]>(
    Object.entries(handlers).map(([path, value]) => [path, Array.isArray(value) ? [...value] : [value]]),
  );
  mockedGet.mockImplementation((async (path: string) => {
    // The page polls the shared `['me']` entry for the New-problem link;
    // default to signed-out unless a test overrides it explicitly.
    if (path === '/auth/me' && !queues.has(path)) return apiResponse(undefined);
    // The list page's filter bar fetches the tag vocabulary; default it to
    // empty so every test that does not care about tags stays a one-line
    // mock, exactly as `/auth/me` above does for the New-problem link.
    if (path === '/tags' && !queues.has(path)) return apiResponse({ items: [] });
    const queue = queues.get(path);
    if (!queue || queue.length === 0) {
      throw new Error(`unmocked GET ${path}`);
    }
    return queue.length > 1 ? queue.shift() : queue[0];
  }) as never);
}

function apiResponse(data: unknown) {
  return { data, error: undefined, response: new Response() };
}

/**
 * `ProblemsPage` and `ProblemPage` now render a `<Link>` each (the
 * problem-row link, "Submit a solution"), and `<Link>` throws when rendered
 * without a router in context — it reaches into `router.stores.location`
 * unconditionally. This is a router just for that: a minimal tree with only
 * the two paths these two components' `<Link>`s target, on an isolated
 * in-memory history so it neither reads nor writes jsdom's real
 * `window.location`, and no relation to the app's real route tree in
 * `router.tsx`. `RouterContextProvider` (not `RouterProvider`) is used
 * deliberately: it only puts a router into context, without also rendering
 * the router's own matched-route tree over `ui` below.
 */
const testRootRoute = createRootRoute();
const testProblemRoute = createRoute({ getParentRoute: () => testRootRoute, path: '/problems/$code' });
const testSubmitRoute = createRoute({ getParentRoute: () => testRootRoute, path: '/submit' });
// Tag chips link back into the filtered list (`/problems?tag=`), so that
// path has to resolve here too.
const testProblemsRoute = createRoute({ getParentRoute: () => testRootRoute, path: '/problems' });
// D49's statistics link every solver and every fastest submission.
const testUserRoute = createRoute({ getParentRoute: () => testRootRoute, path: '/users/$username' });
const testSubmissionRoute = createRoute({ getParentRoute: () => testRootRoute, path: '/submissions/$id' });
const testRouter = createRouter({
  routeTree: testRootRoute.addChildren([
    testProblemsRoute,
    testProblemRoute,
    testSubmitRoute,
    testUserRoute,
    testSubmissionRoute,
  ]),
  history: createMemoryHistory({ initialEntries: ['/problems'] }),
});

function renderWithClient(ui: ReactElement) {
  // A fresh, no-retry client per test: without `retry: false` a mocked 404
  // (or any rejected queryFn) retries several times with backoff before
  // settling into its error state, which is exactly the kind of thing that
  // silently turns a fast assertion into a flaky multi-second timeout.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RouterContextProvider router={testRouter}>{ui}</RouterContextProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  mockedGet.mockReset();
});

const PROBLEM_A = {
  id: 1,
  code: 'aplusb',
  name: 'A Plus B',
  visibility: 'public' as const,
  hasPublishedRevision: true,
  timeMs: 1000,
  memoryKb: 65536,
  testCount: 3,
  me: null,
  tags: [],
  difficulty: null,
  attemptedCount: 0,
  solvedCount: 0,
};

const PROBLEM_B = {
  id: 2,
  code: 'bplusc',
  name: 'B Plus C',
  visibility: 'public' as const,
  hasPublishedRevision: true,
  timeMs: 2000,
  memoryKb: 131072,
  testCount: 12,
  me: null,
  tags: [],
  difficulty: null,
  attemptedCount: 0,
  solvedCount: 0,
};

const PROBLEM_DRAFT_ONLY = {
  id: 3,
  code: 'draftonly',
  name: 'Draft Only',
  visibility: 'public' as const,
  hasPublishedRevision: false,
  timeMs: null,
  memoryKb: null,
  testCount: null,
  me: null,
  tags: [],
  difficulty: null,
  attemptedCount: 0,
  solvedCount: 0,
};

describe('formatMemoryMb', () => {
  it('renders a whole number of MB bare', () => {
    expect(formatMemoryMb(65536)).toBe('64 MB');
    expect(formatMemoryMb(131072)).toBe('128 MB');
  });

  it('renders a non-whole number of MB to one decimal place', () => {
    expect(formatMemoryMb(1536)).toBe('1.5 MB');
  });

  it('renders null as an em dash', () => {
    expect(formatMemoryMb(null)).toBe('—');
  });
});

describe('ProblemsPage', () => {
  it('renders a row for each problem returned by the API', async () => {
    mockApiGet({ '/problems': apiResponse({ items: [PROBLEM_A, PROBLEM_B], nextCursor: null }) });

    renderWithClient(<ProblemsPage />);

    expect(await screen.findByText('aplusb')).toBeInTheDocument();
    expect(screen.getByText('bplusc')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2 problems
  });

  // Regression coverage for the three problem-list bugs found by screenshot
  // (task report): a single free-text `1000 ms / 65536 KB` cell, memory
  // shown in unreadable raw KB, and — separately — the `me` column.
  it('renders time and memory as separate, right-aligned numeric columns, memory in MB', async () => {
    mockApiGet({ '/problems': apiResponse({ items: [PROBLEM_A, PROBLEM_B], nextCursor: null }) });

    renderWithClient(<ProblemsPage />);
    await screen.findByText('aplusb');

    const rows = screen.getAllByRole('row');
    // rows[0] is the header row.
    expect(within(rows[0]!).getByRole('columnheader', { name: 'Thời gian' })).toHaveClass('num');
    expect(within(rows[0]!).getByRole('columnheader', { name: 'Bộ nhớ' })).toHaveClass('num');

    // PROBLEM_A: 1000 ms / 65536 KB (64 MB, whole).
    expect(within(rows[1]!).getByText('1000 ms')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('64 MB')).toBeInTheDocument();
    // Neither raw KB nor a concatenated "ms / KB" cell exists anywhere.
    expect(screen.queryByText(/65536 KB/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ms \//)).not.toBeInTheDocument();

    // PROBLEM_B: 2000 ms / 131072 KB (128 MB, whole).
    expect(within(rows[2]!).getByText('2000 ms')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('128 MB')).toBeInTheDocument();
  });

  it('renders a right-aligned tests column, and an em dash for a problem with no published revision', async () => {
    mockApiGet({
      '/problems': apiResponse({ items: [PROBLEM_A, PROBLEM_DRAFT_ONLY], nextCursor: null }),
    });

    renderWithClient(<ProblemsPage />);
    await screen.findByText('aplusb');

    const rows = screen.getAllByRole('row');
    expect(within(rows[0]!).getByRole('columnheader', { name: 'Test' })).toHaveClass('num');
    // Tests is the third `.num` column (after Time, Mem) — cell index 4
    // (code, name, time, mem, tests, me).
    // PROBLEM_A: testCount 3.
    expect(within(rows[1]!).getAllByRole('cell')[4]).toHaveTextContent('3');
    // PROBLEM_DRAFT_ONLY: no published revision, so testCount is null —
    // rendered the same way as timeMs/memoryKb in that case.
    expect(within(rows[2]!).getAllByRole('cell')[4]).toHaveTextContent('—');
  });

  it('renders a plain dash — never a "pending" badge — for a problem with no `me`, and issues no /submissions request', async () => {
    mockApiGet({ '/problems': apiResponse({ items: [PROBLEM_A], nextCursor: null }) });

    renderWithClient(<ProblemsPage />);
    await screen.findByText('aplusb');

    const row = screen.getAllByRole('row')[1]!;
    // `pend`'s "." glyph means "still grading" on the submit screen; a
    // problem never attempted is not pending anything.
    const dash = within(row).getAllByText('—').at(-1)!;
    expect(dash).not.toHaveClass('badge');
    expect(dash).not.toHaveClass('pend');
    // `me` is server-computed on `GET /problems` now (spec
    // `2026-08-21-best-verdict-design.md`) — this page never calls
    // `/submissions` at all, signed in or not.
    expect(mockedGet).not.toHaveBeenCalledWith('/submissions', expect.anything());
  });

  it('renders the "me" verdict straight off `GET /problems`\' response, with no other request', async () => {
    mockApiGet({
      '/problems': apiResponse({
        items: [
          { ...PROBLEM_A, me: { verdict: 'AC', points: 100, maxPoints: 100 } },
          PROBLEM_B,
        ],
        nextCursor: null,
      }),
    });

    renderWithClient(<ProblemsPage />);
    await screen.findByText('aplusb');

    const rows = screen.getAllByRole('row');
    expect(within(rows[1]!).getByText('AC')).toHaveClass('badge', 'ac');
    // bplusc: `me: null` on the response — a plain dash, not a badge. The
    // LAST dash in the row: the difficulty column now renders one too, and
    // only the `me` cell's carries `muted`.
    expect(within(rows[2]!).getAllByText('—').at(-1)!).toHaveClass('muted');

    // Exactly the one call to /problems — never /submissions.
    expect(mockedGet.mock.calls.filter((c) => c[0] === '/problems')).toHaveLength(1);
    expect(mockedGet).not.toHaveBeenCalledWith('/submissions', expect.anything());
  });

  it('re-queries the API when the search box changes', async () => {
    mockApiGet({ '/problems': apiResponse({ items: [PROBLEM_A], nextCursor: null }) });

    renderWithClient(<ProblemsPage />);
    await screen.findByText('aplusb');

    await userEvent.type(screen.getByLabelText(/^Tìm kiếm$/), 'plus');

    await waitFor(() => {
      const problemsCalls = mockedGet.mock.calls.filter((c) => c[0] === '/problems');
      expect(problemsCalls.at(-1)?.[1]).toMatchObject({ params: { query: { q: 'plus' } } });
    });
  });

  it('appends the next page instead of replacing the first on "load more"', async () => {
    mockApiGet({
      '/problems': [
        apiResponse({ items: [PROBLEM_A], nextCursor: 'cursor-1' }),
        apiResponse({ items: [PROBLEM_B], nextCursor: null }),
      ],
    });

    renderWithClient(<ProblemsPage />);
    await screen.findByText('aplusb');
    expect(screen.queryByText('bplusc')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Tải thêm$/ }));

    await screen.findByText('bplusc');
    // Both rows are still present — the second page appended, it did not
    // replace the first.
    expect(screen.getByText('aplusb')).toBeInTheDocument();
    expect(screen.getByText('bplusc')).toBeInTheDocument();
  });
});

describe('ProblemPage', () => {
  it('renders the statement HTML into the document', async () => {
    mockedGet.mockResolvedValueOnce({
      data: {
        ...PROBLEM_A,
        statement: '## Statement\n\nAdd two numbers.',
        testCount: 3,
        totalPoints: 100,
        checkerKind: 'wcmp',
        createdAt: '2026-01-01T00:00:00Z',
      },
      error: undefined,
      response: new Response(),
    } as never);

    renderWithClient(<ProblemPage code="aplusb" />);

    // The statement's own heading ("## Statement") renders as an <h3>:
    // renderStatement demotes every statement heading one level so none can
    // compete with the page's own <h1> ("A Plus B (aplusb)"). Asserting on it,
    // and on the body text beside it, confirms the rendered Markdown — not
    // just the problem's name — actually reached the document.
    const statementHeading = await screen.findByRole('heading', { name: 'Statement', level: 3 });
    expect(
      within(statementHeading.parentElement ?? document.body).getByText(/Add two numbers\./),
    ).toBeInTheDocument();

    // The printable statement: a plain <a> straight at the API route, code
    // interpolated — not a router Link, the PDF lives outside the SPA.
    const pdf = screen.getByRole('link', { name: 'PDF' });
    expect(pdf).toHaveAttribute('href', '/api/v1/problems/aplusb/statement.pdf');
  });

  it('does not create a script element from a statement containing <script>', async () => {
    mockedGet.mockResolvedValueOnce({
      data: {
        ...PROBLEM_A,
        statement: '<script>alert(1)</script>\n\nHarmless text.',
        testCount: 3,
        totalPoints: 100,
        checkerKind: 'wcmp',
        createdAt: '2026-01-01T00:00:00Z',
      },
      error: undefined,
      response: new Response(),
    } as never);

    const { container } = renderWithClient(<ProblemPage code="aplusb" />);

    await screen.findByText(/Harmless text\./);
    expect(container.querySelector('script')).toBeNull();
  });

  /**
   * D94. The fixture makes the statement's table and the API's samples say
   * exactly the same thing — modulo the trailing newline a test FILE has and
   * a table cell cannot — so the assertions below cannot pass by accident.
   */
  const SAMPLED = {
    ...PROBLEM_A,
    statement: '## Bài toán\n\nCộng hai số.\n\n## Ví dụ\n\n| Dữ liệu vào | Kết quả |\n| --- | --- |\n| `2 3` | `5` |\n',
    testCount: 3,
    totalPoints: 100,
    checkerKind: 'wcmp',
    createdAt: '2026-01-01T00:00:00Z',
    samples: [{ input: '2 3\n', output: '5\n', explanation: null, truncated: false }],
  };

  function mockDetail(detail: unknown): void {
    mockedGet.mockResolvedValueOnce({ data: detail, error: undefined, response: new Response() } as never);
  }

  it("renders the samples from data and hides the statement's table that duplicates them", async () => {
    mockDetail(SAMPLED);
    const { container } = renderWithClient(<ProblemPage code="aplusb" />);

    await screen.findByRole('heading', { name: 'Ví dụ 1' });
    // The sample files, verbatim, in their own <pre> blocks.
    expect(screen.getByText('2 3')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    // The duplicate table is gone — and so is the heading it was the whole
    // body of, which would otherwise read as a section nobody wrote.
    expect(container.querySelector('table')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Ví dụ', level: 3 })).toBeNull();
    // Everything the statement actually said is still on the page.
    expect(screen.getByText(/Cộng hai số\./)).toBeInTheDocument();
  });

  it('keeps a table that says something the samples do not', async () => {
    mockDetail({
      ...SAMPLED,
      // The API knows one sample; the statement's table shows two. Hiding it
      // would take away the reader's only copy of the second.
      statement: SAMPLED.statement + '| `1 1` | `2` |\n',
    });
    const { container } = renderWithClient(<ProblemPage code="aplusb" />);

    await screen.findByRole('heading', { name: 'Ví dụ 1' });
    expect(container.querySelector('table')).not.toBeNull();
  });

  it('copies a sample file to the clipboard, byte for byte', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mockDetail(SAMPLED);
    renderWithClient(<ProblemPage code="aplusb" />);

    await screen.findByRole('heading', { name: 'Ví dụ 1' });
    await userEvent.click(screen.getAllByRole('button', { name: 'Sao chép' })[0]!);
    // The newline the FILE has, not the trimmed cell the table showed.
    expect(writeText).toHaveBeenCalledWith('2 3\n');
    expect(await screen.findByRole('button', { name: 'Đã sao chép' })).toBeInTheDocument();
  });

  it('renders no samples section, and touches no table, against an API that sends no samples key', async () => {
    const { samples: _unused, ...withoutSamples } = SAMPLED;
    mockDetail(withoutSamples);
    const { container } = renderWithClient(<ProblemPage code="aplusb" />);

    await screen.findByText(/Cộng hai số\./);
    expect(screen.queryByRole('heading', { name: 'Ví dụ 1' })).toBeNull();
    expect(container.querySelector('table')).not.toBeNull();
  });

  it('renders "No such problem." for a 404, without distinguishing absent from invisible', async () => {
    mockedGet.mockResolvedValueOnce({
      data: undefined,
      error: { type: 'about:blank', title: 'Not Found', status: 404, code: 'problem_not_found', detail: 'No such problem.' },
      response: new Response(),
    } as never);

    renderWithClient(<ProblemPage code="does-not-exist" />);

    expect(await screen.findByText('Không có bài tập này.')).toBeInTheDocument();
  });
});

describe('ProblemPage authoring links', () => {
  const DETAIL = {
    ...PROBLEM_A,
    statement: 'Add.',
    testCount: 3,
    totalPoints: 100,
    checkerKind: 'wcmp',
    createdAt: '2026-01-01T00:00:00Z',
    members: [{ username: 'kim', role: 'owner' }],
  };

  it('a listed member sees Edit and Revisions; the Submissions link is for everyone', async () => {
    mockApiGet({
      '/problems/{code}': apiResponse(DETAIL),
      '/auth/me': apiResponse({ username: 'kim', displayName: 'Kim', globalRole: 'user' }),
    });
    renderWithClient(<ProblemPage code="aplusb" />);
    expect(await screen.findByRole('link', { name: 'Sửa' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Phiên bản' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tất cả bài nộp' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bài nộp của tôi' })).toBeInTheDocument();
  });

  it('a plain signed-in stranger gets no authoring links', async () => {
    mockApiGet({
      '/problems/{code}': apiResponse(DETAIL),
      '/auth/me': apiResponse({ username: 'stranger', displayName: 'S', globalRole: 'user' }),
    });
    renderWithClient(<ProblemPage code="aplusb" />);
    await screen.findByRole('link', { name: 'Tất cả bài nộp' });
    expect(screen.queryByRole('link', { name: 'Sửa' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Phiên bản' })).toBeNull();
  });
});

describe('problem statistics (D49)', () => {
  const STATS = {
    totalSubmissions: 8,
    attemptedUsers: 4,
    solvedUsers: 2,
    acceptanceRate: 0.25,
    verdicts: [
      { key: 'WA', count: 5 },
      { key: 'AC', count: 3 },
    ],
    languages: [{ key: 'cpp17', count: 8 }],
    fastest: [
      {
        submissionId: 42,
        username: 'nam',
        timeMs: 12,
        memoryKb: 2048,
        createdAt: '2026-01-02T00:00:00Z',
      },
    ],
    firstSolver: { submissionId: 7, username: 'mai', createdAt: '2026-01-01T00:00:00Z' },
  };
  const DETAIL = {
    ...PROBLEM_A,
    statement: 'Add.',
    totalPoints: 100,
    checkerKind: 'wcmp',
    createdAt: '2026-01-01T00:00:00Z',
    attemptedCount: 4,
    solvedCount: 2,
  };

  it('shows the counts, the fastest table and the first solver, each entity a hyperlink', async () => {
    mockApiGet({
      '/problems/{code}': apiResponse(DETAIL),
      '/problems/{code}/stats': apiResponse(STATS),
    });

    renderWithClient(<ProblemPage code="aplusb" />);

    await screen.findByRole('heading', { name: 'Thống kê' });
    expect(screen.getByText(/8 lượt nộp/)).toBeInTheDocument();
    // A percentage with no decimals — 41 % versus 41.3 % is not a fact
    // anybody acts on.
    expect(screen.getByText(/25% được chấp nhận/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'mai' })).toBeInTheDocument();
    const fastest = screen.getByRole('link', { name: 'nam' });
    expect(fastest).toHaveAttribute('href', '/users/nam');
    expect(screen.getByRole('link', { name: '#42' })).toHaveAttribute('href', '/submissions/42');
  });

  it('renders nothing at all when the statistics cannot be read', async () => {
    // Commentary on the problem, never a banner over it: a statement must
    // render even when an aggregate fails.
    mockApiGet({
      '/problems/{code}': apiResponse(DETAIL),
      '/problems/{code}/stats': { data: undefined, error: { code: 'problem_not_found' }, response: new Response() },
    });

    renderWithClient(<ProblemPage code="aplusb" />);

    await screen.findByRole('heading', { name: /A Plus B/ });
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Thống kê' })).toBeNull();
    });
  });

  it('shows solved / attempted on every list row', async () => {
    mockApiGet({
      '/problems': apiResponse({
        items: [{ ...PROBLEM_A, attemptedCount: 4, solvedCount: 2 }],
        nextCursor: null,
      }),
    });

    renderWithClient(<ProblemsPage />);
    await screen.findByText('aplusb');

    const row = screen.getAllByRole('row')[1]!;
    expect(within(row).getAllByRole('cell')[5]).toHaveTextContent('2 / 4');
    expect(within(screen.getAllByRole('row')[0]!).getByRole('columnheader', { name: 'Đã giải' })).toHaveClass('num');
  });
});

/**
 * D109 — the "Thảo luận" section on the problem page. `mockApiGet` dispatches
 * by path so the detail, stats and comments requests the page fires are each
 * answered; the comments response is the one under test.
 */
const PROBLEM_DETAIL = {
  ...PROBLEM_A,
  statement: 'Add two numbers.',
  sourceAccess: 'private' as const,
  totalPoints: 100,
  checkerKind: 'wcmp',
  createdAt: '2026-01-01T00:00:00Z',
  members: [],
  orgSlugs: [],
  editorial: null,
  editorialAvailable: false,
  samples: [],
  publishedVersion: 1,
};

function comment(over: Record<string, unknown>) {
  return {
    id: 1,
    parentId: null,
    author: { username: 'alice' },
    body: 'first!',
    createdAt: '2026-02-01T00:00:00Z',
    editedAt: null,
    deletedAt: null,
    replies: [],
    ...over,
  };
}

describe('ProblemDiscussion (D109)', () => {
  it('renders a thread with its author and body, and a reply', async () => {
    mockApiGet({
      '/problems/{code}': apiResponse(PROBLEM_DETAIL),
      '/problems/{code}/stats': apiResponse(null),
      '/problems/{code}/comments': apiResponse({
        items: [
          comment({
            id: 5,
            body: 'How do I start?',
            author: { username: 'alice' },
            replies: [
              {
                id: 6,
                parentId: 5,
                author: { username: 'bob' },
                body: 'Read the statement.',
                createdAt: '2026-02-01T01:00:00Z',
                editedAt: null,
                deletedAt: null,
              },
            ],
          }),
        ],
        nextCursor: null,
        hiddenDuringContest: false,
      }),
    });

    renderWithClient(<ProblemPage code="aplusb" />);

    await screen.findByRole('heading', { name: 'Thảo luận' });
    expect(await screen.findByText('How do I start?')).toBeInTheDocument();
    expect(screen.getByText('Read the statement.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'alice' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'bob' })).toBeInTheDocument();
  });

  it('shows the contest note instead of the thread when hidden (D109)', async () => {
    mockApiGet({
      '/problems/{code}': apiResponse(PROBLEM_DETAIL),
      '/problems/{code}/stats': apiResponse(null),
      '/problems/{code}/comments': apiResponse({ items: [], nextCursor: null, hiddenDuringContest: true }),
    });

    renderWithClient(<ProblemPage code="aplusb" />);

    await screen.findByRole('heading', { name: 'Thảo luận' });
    expect(await screen.findByText(/hidden while you are competing|bị ẩn trong khi bạn đang thi/)).toBeInTheDocument();
  });

  it('renders a deleted comment that anchors a reply as a tombstone', async () => {
    mockApiGet({
      '/problems/{code}': apiResponse(PROBLEM_DETAIL),
      '/problems/{code}/stats': apiResponse(null),
      '/problems/{code}/comments': apiResponse({
        items: [
          comment({
            id: 7,
            author: null,
            body: null,
            deletedAt: '2026-02-02T00:00:00Z',
            replies: [
              {
                id: 8,
                parentId: 7,
                author: { username: 'carol' },
                body: 'still here',
                createdAt: '2026-02-02T01:00:00Z',
                editedAt: null,
                deletedAt: null,
              },
            ],
          }),
        ],
        nextCursor: null,
        hiddenDuringContest: false,
      }),
    });

    renderWithClient(<ProblemPage code="aplusb" />);

    await screen.findByRole('heading', { name: 'Thảo luận' });
    // The tombstone placeholder, and the reply it still anchors.
    expect(await screen.findByText(/comment deleted|đã bị xóa/)).toBeInTheDocument();
    expect(screen.getByText('still here')).toBeInTheDocument();
  });
});
