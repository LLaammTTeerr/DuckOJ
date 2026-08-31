/**
 * The screens themselves under a slow, a failing and an empty API (D140–D142).
 *
 * `test/states.spec.tsx` proves the components; this proves the WIRING — which
 * is where every one of these bugs actually lived. Each case below was seen
 * first in Chromium against `vite preview` with `page.route`, and the numbers
 * in the comments are from those runs.
 */
import type { ReactElement } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  useNavigate: () => vi.fn(),
}));

const { ContestPage, ScoreboardPage, ContestsPage } = await import('../src/routes/contests.js');
const { SubmissionPage } = await import('../src/routes/submission.js');
const { OrgPage } = await import('../src/routes/orgs.js');
const { MyProgressPage } = await import('../src/routes/progress.js');
const { NotificationsPage } = await import('../src/routes/notifications.js');
const { ProblemsPage } = await import('../src/routes/problems.js');
const { ProblemPage } = await import('../src/routes/problem.js');
const { OrgSets } = await import('../src/routes/problem-sets.js');
const { ContestMonitorPage } = await import('../src/routes/contest-monitor.js');

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const ME = {
  id: 1,
  username: 'hocsinh1',
  displayName: 'Học sinh 1',
  globalRole: 'user',
  email: 'a@b.c',
  emailVerified: true,
  totpEnabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** What `openapi-fetch` hands back for a failed request. */
function failure(status: number, detail?: string) {
  return { error: { detail, code: 'internal_error' }, response: { status } };
}

/** A request that never answers — what a dead school uplink looks like. */
function pending() {
  return new Promise<never>(() => {});
}

/**
 * Every read but `/auth/me` behaves one way; the viewer always resolves.
 *
 * Signing the reader in is not incidental. `MyProgressPage` renders its
 * signed-out line when `me` is absent, and `notificationsQueryOptions` calls
 * a 401 an ANSWER — so a blanket failing mock exercises the gate rather than
 * the failure the case is about.
 */
function everythingElse(answer: () => unknown) {
  get.mockImplementation((path: string) =>
    path === '/auth/me' ? Promise.resolve({ data: ME, response: { status: 200 } }) : answer(),
  );
}

beforeEach(() => {
  everythingElse(() => Promise.resolve({ data: { items: [], nextCursor: null }, response: { status: 200 } }));
});

afterEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  del.mockReset();
});

describe('a 500 must not read as "it does not exist"', () => {
  it('contest page: says the server broke, not that the round is missing', async () => {
    // Measured: `/contests/probe-cup` under a 500 painted exactly
    // "Không có kỳ thi này." — the one sentence that sends a competitor at
    // the bell to the wrong person for help.
    everythingElse(() => Promise.resolve(failure(500)));
    wrap(<ContestPage contestKey="probe-cup" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Máy chủ đang gặp sự cố/);
    expect(alert).not.toHaveTextContent(/Không có kỳ thi này/);
  });

  it('contest page: still says "no such contest" for an actual 404', async () => {
    everythingElse(() => Promise.resolve(failure(404)));
    wrap(<ContestPage contestKey="nope" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Không có kỳ thi này/);
  });

  it('submission page: a 500 is not "no such submission"', async () => {
    everythingElse(() => Promise.resolve(failure(500)));
    wrap(<SubmissionPage id={7} />);
    expect(await screen.findByRole('alert')).not.toHaveTextContent(/Không có bài nộp này/);
  });

  it('problem page: a 500 is not "no such problem"', async () => {
    // `if (error) return null` — every failure folded into the absent case,
    // and the comment above it said the API only ever answers 404 here.
    everythingElse(() => Promise.resolve(failure(500)));
    wrap(<ProblemPage code="aplusb" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Không tải được bài tập này/);
    expect(screen.queryByText('Không có bài tập này.')).not.toBeInTheDocument();
  });

  it('org page: a 500 is not "no such organisation"', async () => {
    everythingElse(() => Promise.resolve(failure(500)));
    wrap(<OrgPage slug="probe-org" />);
    expect(await screen.findByRole('alert')).not.toHaveTextContent(/Không có tổ chức này/);
  });
});

describe('a failed read offers a way to ask again', () => {
  it('scoreboard: Thử lại re-issues the request', async () => {
    everythingElse(() => Promise.resolve(failure(500)));
    wrap(<ScoreboardPage contestKey="probe-cup" />);
    const retry = await screen.findByRole('button', { name: 'Thử lại' });
    const before = get.mock.calls.length;
    await userEvent.click(retry);
    await waitFor(() => {
      expect(get.mock.calls.length).toBeGreaterThan(before);
    });
  });

  it('progress: a failed read is retryable', async () => {
    everythingElse(() => Promise.resolve(failure(500)));
    wrap(<MyProgressPage />);
    expect(await screen.findByRole('button', { name: 'Thử lại' })).toBeInTheDocument();
  });
});

describe('loading reserves the space the answer will need', () => {
  it('scoreboard: the heading is on screen while the board loads', async () => {
    // Measured against a 3s-delayed route: the whole page was one grey
    // "Đang tải…" at the top of 720px of nothing, and every pixel moved when
    // the board arrived.
    everythingElse(pending);
    const { container } = wrap(<ScoreboardPage contestKey="probe-cup" />);
    expect(await screen.findByRole('heading', { name: /Bảng điểm/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(container.querySelectorAll('.skeleton-row').length).toBeGreaterThan(0);
    });
  });

  it('contests list: the table head is drawn before the rows arrive', async () => {
    everythingElse(pending);
    const { container } = wrap(<ContestsPage />);
    await waitFor(() => {
      expect(container.querySelectorAll('.skeleton-row').length).toBeGreaterThan(0);
    });
    expect(screen.getByRole('columnheader', { name: /Kỳ thi/ })).toBeInTheDocument();
  });

  it('problems list: skeleton rows, not a bare sentence', async () => {
    everythingElse(pending);
    const { container } = wrap(<ProblemsPage />);
    await waitFor(() => {
      expect(container.querySelectorAll('.skeleton-row').length).toBeGreaterThan(0);
    });
  });
});

describe('a polling screen that fails stops saying "loading"', () => {
  it('monitor: names the panel and offers a retry instead of a spinner', async () => {
    // Measured: fourteen seconds of solid 500s and the page still said
    // "Đang tải…" and nothing else.
    everythingElse(() => Promise.resolve(failure(500)));
    wrap(<ContestMonitorPage contestKey="probe-cup" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Không tải được màn hình theo dõi/);
    expect(screen.queryByText('Đang tải…')).not.toBeInTheDocument();
  });
});

describe('the last swallow', () => {
  it('org sets: a 500 is not "your teacher has assigned you nothing"', async () => {
    // `data?.items ?? []` — B-8's shape, one more survivor. This panel draws
    // an empty array as `sets.empty`, so a failed read told a pupil there is
    // no homework.
    everythingElse(() => Promise.resolve(failure(500)));
    // `canManage` so the panel renders at all: for a plain member it hides
    // itself when the list is empty, which is exactly what made the swallow
    // invisible for so long.
    wrap(<OrgSets slug="probe-org" canManage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Máy chủ đang gặp sự cố/);
    expect(screen.queryByText('Chưa có bài tập nào.')).not.toBeInTheDocument();
  });
});

describe('an empty list teaches the next action', () => {
  it('notifications: not just "Chưa có gì."', async () => {
    get.mockImplementation((path: string) =>
      path === '/auth/me'
        ? Promise.resolve({ data: ME, response: { status: 200 } })
        : Promise.resolve({ data: { items: [], unreadCount: 0 }, response: { status: 200 } }),
    );
    wrap(<NotificationsPage />);
    const empty = await screen.findByText(/Chưa có thông báo nào/);
    const block = empty.closest('.empty') as HTMLElement | null;
    expect(block).not.toBeNull();
    // One way forward, not a dead end.
    expect(within(block!).getByRole('link')).toBeInTheDocument();
  });

  it('problems: a filter that matched nothing is not "there are no problems"', async () => {
    wrap(<ProblemsPage initialFilters={{ tags: [], difficultyMin: 800 }} />);
    expect(await screen.findByText(/khớp bộ lọc/)).toBeInTheDocument();
  });

  it('problems: nothing at all still says how to start', async () => {
    wrap(<ProblemsPage />);
    expect(await screen.findByText(/Chưa có bài tập nào/)).toBeInTheDocument();
  });
});
