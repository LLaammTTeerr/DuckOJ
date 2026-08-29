import type { ReactElement } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterContextProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api.js';
import { SubmissionsPage } from '../src/routes/submissions.js';

// Same mocking pattern as test/problems.spec.tsx: `SubmissionsPage` reaches
// the network only through `api`, so mocking the module is enough.
vi.mock('../src/api.js', () => ({
  api: { GET: vi.fn(), POST: vi.fn() },
}));

const mockedGet = vi.mocked(api.GET);

afterEach(() => {
  mockedGet.mockReset();
});

// `SubmissionsPage` renders a `<Link to="/problems/$code">` per row, same
// reason `problems.spec.tsx` needs one: `<Link>` throws outside a router.
const testRootRoute = createRootRoute();
const testProblemRoute = createRoute({ getParentRoute: () => testRootRoute, path: '/problems/$code' });
const testRouter = createRouter({
  routeTree: testRootRoute.addChildren([testProblemRoute]),
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
  createdAt: '2026-01-01T00:00:00Z',
};

describe('SubmissionsPage', () => {
  it('renders a row per submission, verdict as a badge, and points as points/maxPoints', async () => {
    mockedGet.mockResolvedValueOnce({
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
    expect(within(rows[1]!).getByText('100/100')).toBeInTheDocument();

    // SUBMISSION_B: still grading — no verdict, no points, both render as
    // the neutral "pend" badge / em dash, never blank.
    expect(within(rows[2]!).getByText('—', { selector: 'span' })).toHaveClass('badge', 'pend');
    expect(within(rows[2]!).getByText('—', { selector: 'td' })).toBeInTheDocument();
  });

  it('links each row to its problem', async () => {
    mockedGet.mockResolvedValueOnce({
      data: { items: [SUBMISSION_A], nextCursor: null },
      error: undefined,
      response: new Response(),
    } as never);

    renderWithClient(<SubmissionsPage />);

    expect(await screen.findByRole('link', { name: 'aplusb' })).toHaveAttribute('href', '/problems/aplusb');
  });

  it('links the id to the detail page and the user to their profile', async () => {
    mockedGet.mockResolvedValueOnce({
      data: { items: [SUBMISSION_A], nextCursor: null },
      error: undefined,
      response: new Response(),
    } as never);

    renderWithClient(<SubmissionsPage />);

    expect(await screen.findByRole('link', { name: '42' })).toHaveAttribute('href', '/submissions/42');
    expect(screen.getByRole('link', { name: SUBMISSION_A.username })).toHaveAttribute(
      'href',
      `/users/${SUBMISSION_A.username}`,
    );
  });

  it('seeds the filters from the deep link, and queries with them from the first request', async () => {
    mockedGet.mockResolvedValue({
      data: { items: [], nextCursor: null },
      error: undefined,
      response: new Response(),
    } as never);

    renderWithClient(<SubmissionsPage initialProblem="aplusb" initialUser="kim" initialContest="spring" />);
    await screen.findByText(/Không tìm thấy bài nộp nào/);

    const [, options] = mockedGet.mock.calls[0] as unknown as [
      string,
      { params: { query: Record<string, string> } },
    ];
    expect(options.params.query.problem).toBe('aplusb');
    expect(options.params.query.user).toBe('kim');
    expect(options.params.query.contest).toBe('spring');
  });

  it('re-queries with a problem filter when the problem field changes', async () => {
    mockedGet.mockResolvedValue({
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
    mockedGet.mockResolvedValue({
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
    mockedGet
      .mockResolvedValueOnce({
        data: { items: [SUBMISSION_A], nextCursor: 'cursor-1' },
        error: undefined,
        response: new Response(),
      } as never)
      .mockResolvedValueOnce({
        data: { items: [SUBMISSION_B], nextCursor: null },
        error: undefined,
        response: new Response(),
      } as never);

    renderWithClient(<SubmissionsPage />);
    await screen.findByText('42');
    expect(screen.queryByText('41')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Tải thêm$/ }));

    await screen.findByText('41');
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('41')).toBeInTheDocument();
  });

  it('shows an error state when the request fails', async () => {
    mockedGet.mockResolvedValueOnce({
      data: undefined,
      error: { type: 'about:blank', title: 'Unauthorized', status: 401, code: 'not_signed_in' },
      response: new Response(),
    } as never);

    renderWithClient(<SubmissionsPage />);

    expect(await screen.findByText(/Không tải được danh sách bài nộp/)).toBeInTheDocument();
  });
});
