import type { ReactElement } from 'react';
import { render, screen, within } from '@testing-library/react';
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
import { HomePage, pickContest } from '../src/routes/home.js';

// `HomePage` reaches the network only through `api`, exactly like
// `submissions.spec.tsx` — mocking the module is the whole of the fixture.
vi.mock('../src/api.js', () => ({
  api: { GET: vi.fn(), POST: vi.fn() },
}));

const mockedGet = vi.mocked(api.GET);

const testRootRoute = createRootRoute();
const children = [
  '/problems',
  '/problems/$code',
  '/problems/new',
  '/contests',
  '/contests/$key',
  '/contests/$key/scoreboard',
  '/submissions',
].map((path) => createRoute({ getParentRoute: () => testRootRoute, path }));
const testRouter = createRouter({
  routeTree: testRootRoute.addChildren(children),
  history: createMemoryHistory({ initialEntries: ['/'] }),
});

function renderHome(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RouterContextProvider router={testRouter}>{ui}</RouterContextProvider>
    </QueryClientProvider>,
  );
}

const ME = { username: 'hocsinh1', displayName: 'Hoc Sinh 1', globalRole: 'user' };

const HOUR = 3_600_000;
function contest(key: string, startsInMs: number, lengthMs = 2 * HOUR) {
  const start = Date.now() + startsInMs;
  return {
    key,
    name: `Round ${key}`,
    format: 'icpc',
    startTime: new Date(start).toISOString(),
    endTime: new Date(start + lengthMs).toISOString(),
    orgs: [],
  };
}

const SUBMISSION = {
  id: 42,
  problemCode: 'aplusb',
  username: 'hocsinh1',
  languageKey: 'cpp17',
  state: 'done' as const,
  verdict: 'AC' as const,
  points: 100,
  maxPoints: 100,
  contestKey: null,
  contestLabel: null,
  teamName: null,
  frozen: false,
  createdAt: '2026-01-01T00:00:00Z',
};

/** Answers `GET /contests` and `GET /submissions` from one table. */
function serve(contests: unknown[], submissions: unknown[]) {
  mockedGet.mockImplementation(((path: string) => {
    if (path === '/contests') return Promise.resolve({ data: { items: contests } });
    if (path === '/submissions') return Promise.resolve({ data: { items: submissions, nextCursor: null } });
    return Promise.resolve({ data: null, error: { code: 'not_mocked' } });
  }) as unknown as typeof api.GET);
}

beforeEach(() => {
  mockedGet.mockReset();
});
afterEach(() => {
  mockedGet.mockReset();
});

/**
 * D138. The landing page's job, signed in, is the two questions a pupil
 * actually opens it with on contest day: when does it start, and did my last
 * attempt pass? Both are answered from endpoints the app already calls.
 */
describe('the signed-in home', () => {
  it('names the running round, not the one that starts sooner in the future', () => {
    const finished = contest('old', -10 * HOUR);
    const running = contest('now', -HOUR);
    const soon = contest('soon', HOUR);
    // A running round always wins: it is the one the reader is IN.
    expect(pickContest([finished, soon, running], Date.now())?.key).toBe('now');
    // With none running, the NEAREST start in the future — never a finished
    // one, because a home page counting down to nothing is worse than one
    // that says there is nothing.
    expect(pickContest([finished, contest('later', 5 * HOUR), soon], Date.now())?.key).toBe('soon');
    expect(pickContest([finished], Date.now())).toBeNull();
    expect(pickContest([], Date.now())).toBeNull();
  });

  it('leads with the round in progress, its phase and its countdown', async () => {
    serve([contest('now', -HOUR)], [SUBMISSION]);
    renderHome(<HomePage me={ME} />);

    const link = await screen.findByRole('link', { name: 'Round now' });
    expect(link).toHaveAttribute('href', '/contests/now');
    // The chip and the clock are the SAME components the contest screens use
    // (D134/D135), so the home page can never drift out of step with them.
    const panel = link.closest('.home-panel')!;
    expect(within(panel as HTMLElement).getByText('đang diễn ra')).toHaveClass('phase', 'running');
    expect(within(panel as HTMLElement).getByRole('timer')).toHaveTextContent(/Kết thúc sau/);
  });

  it('shows the reader’s own recent verdicts as badges', async () => {
    serve([], [SUBMISSION]);
    renderHome(<HomePage me={ME} />);

    const badge = await screen.findByText('AC');
    expect(badge).toHaveClass('badge', 'ac');
    // Filtered to the viewer — a home page listing somebody else's attempts
    // answers nobody's question.
    expect(mockedGet).toHaveBeenCalledWith('/submissions', {
      params: { query: { user: 'hocsinh1' } },
    });
    expect(screen.getByRole('link', { name: 'aplusb' })).toHaveAttribute('href', '/problems/aplusb');
    expect(screen.getByRole('link', { name: 'Tất cả bài nộp của tôi' })).toHaveAttribute(
      'href',
      '/submissions',
    );
  });

  it('says which emptiness it is, with the action that resolves it', async () => {
    serve([], []);
    renderHome(<HomePage me={ME} />);

    expect(
      await screen.findByText('Không có kỳ thi nào đang diễn ra hoặc sắp diễn ra.', { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tất cả kỳ thi' })).toHaveAttribute('href', '/contests');
    expect(screen.getByRole('link', { name: 'Chọn một bài tập' })).toHaveAttribute(
      'href',
      '/problems',
    );
  });

  it('asks a visitor’s browser for nothing', () => {
    serve([contest('now', -HOUR)], [SUBMISSION]);
    renderHome(<HomePage me={null} />);

    // Both panels are gated on a viewer: `GET /submissions` 401s signed out,
    // and a landing page that fires two doomed requests at every visitor is
    // load with nothing to show for it.
    expect(mockedGet).not.toHaveBeenCalled();
    expect(screen.queryByText('Bài nộp gần đây')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Đăng nhập' })).toBeInTheDocument();
  });
});
