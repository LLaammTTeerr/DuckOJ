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
import { ProblemsPage } from '../src/routes/problems.js';
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
const testRouter = createRouter({
  routeTree: testRootRoute.addChildren([testProblemRoute, testSubmitRoute]),
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
};

const PROBLEM_B = {
  id: 2,
  code: 'bplusc',
  name: 'B Plus C',
  visibility: 'public' as const,
  hasPublishedRevision: true,
  timeMs: 2000,
  memoryKb: 131072,
};

describe('ProblemsPage', () => {
  it('renders a row for each problem returned by the API', async () => {
    mockedGet.mockResolvedValueOnce({
      data: { items: [PROBLEM_A, PROBLEM_B], nextCursor: null },
      error: undefined,
      response: new Response(),
    } as never);

    renderWithClient(<ProblemsPage />);

    expect(await screen.findByText('aplusb')).toBeInTheDocument();
    expect(screen.getByText('bplusc')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2 problems
  });

  it('re-queries the API when the search box changes', async () => {
    mockedGet.mockResolvedValue({
      data: { items: [PROBLEM_A], nextCursor: null },
      error: undefined,
      response: new Response(),
    } as never);

    renderWithClient(<ProblemsPage />);
    await screen.findByText('aplusb');

    await userEvent.type(screen.getByLabelText(/search/i), 'plus');

    await waitFor(() => {
      const lastCall = mockedGet.mock.calls.at(-1);
      expect(lastCall?.[1]).toMatchObject({ params: { query: { q: 'plus' } } });
    });
  });

  it('appends the next page instead of replacing the first on "load more"', async () => {
    mockedGet
      .mockResolvedValueOnce({
        data: { items: [PROBLEM_A], nextCursor: 'cursor-1' },
        error: undefined,
        response: new Response(),
      } as never)
      .mockResolvedValueOnce({
        data: { items: [PROBLEM_B], nextCursor: null },
        error: undefined,
        response: new Response(),
      } as never);

    renderWithClient(<ProblemsPage />);
    await screen.findByText('aplusb');
    expect(screen.queryByText('bplusc')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /load more/i }));

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

  it('renders "No such problem." for a 404, without distinguishing absent from invisible', async () => {
    mockedGet.mockResolvedValueOnce({
      data: undefined,
      error: { type: 'about:blank', title: 'Not Found', status: 404, code: 'problem_not_found', detail: 'No such problem.' },
      response: new Response(),
    } as never);

    renderWithClient(<ProblemPage code="does-not-exist" />);

    expect(await screen.findByText('No such problem.')).toBeInTheDocument();
  });
});
