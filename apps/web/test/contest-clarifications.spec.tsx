/**
 * The contest-day Q&A panel (D31).
 *
 * Three claims worth pinning, all of them about who is offered what: a
 * participant gets an ask form and no answer controls, an organiser gets the
 * announcement form and the per-row publish button, and a visitor who has
 * not joined is told to join rather than shown a form the server would
 * refuse. The fourth is the polling contract — 30 s while the contest runs,
 * and nothing at all once it has finished.
 */
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock('../src/api.js', () => ({
  api: {
    GET: (...a: unknown[]) => get(...a),
    POST: (...a: unknown[]) => post(...a),
    PATCH: (...a: unknown[]) => patch(...a),
  },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { ContestPage } = await import('../src/routes/contests.js');

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const RUNNING = {
  key: 'spring',
  name: 'Spring',
  format: 'icpc',
  // A window wide enough that the page reads `running` whenever this suite
  // happens to run — the panel's polling depends on that phase.
  startTime: '2020-01-01T00:00:00.000Z',
  endTime: '2400-01-01T00:00:00.000Z',
  pointsPrecision: 3,
  canEdit: false,
  orgs: [],
  problems: [{ code: 'aplusb', name: 'A+B', label: 'A', points: 100, partial: true, order: 0 }],
};

const QUESTION = {
  id: 7,
  problemCode: 'aplusb',
  askedBy: 'student',
  question: 'Is the array 1-indexed?',
  answer: null,
  answeredBy: null,
  answeredAt: null,
  visibility: 'private' as const,
  createdAt: '2026-03-01T10:00:00.000Z',
};

const ANNOUNCEMENT = {
  id: 8,
  problemCode: null,
  askedBy: 'boss',
  question: null,
  answer: 'Problem A has been rejudged.',
  answeredBy: 'boss',
  answeredAt: '2026-03-01T10:05:00.000Z',
  visibility: 'public' as const,
  createdAt: '2026-03-01T10:05:00.000Z',
};

/** Routes the three GETs the contest page makes. */
function routeGet(opts: {
  canEdit?: boolean;
  joined?: boolean;
  items?: unknown[];
  truncated?: boolean;
  contest?: Record<string, unknown>;
}): void {
  get.mockImplementation((path: string) => {
    if (path === '/contests/{key}') {
      return Promise.resolve({ data: { ...RUNNING, ...opts.contest, canEdit: opts.canEdit === true } });
    }
    if (path === '/contests/{key}/me') {
      return Promise.resolve({ data: opts.joined === true ? { id: 1, virtual: 0, endTime: '2400-01-01T00:00:00.000Z' } : undefined });
    }
    if (path === '/contests/{key}/clarifications') {
      return Promise.resolve({
        data: { items: opts.items ?? [], truncated: opts.truncated === true },
      });
    }
    return Promise.resolve({ data: { username: 'student', globalRole: 'user' } });
  });
}

afterEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
});

describe('the Q&A panel', () => {
  it('shows announcements and a participant their own private question', async () => {
    routeGet({ joined: true, items: [ANNOUNCEMENT, QUESTION] });
    wrap(<ContestPage contestKey="spring" />);

    expect(await screen.findByText('Problem A has been rejudged.')).toBeInTheDocument();
    expect(screen.getByText('Is the array 1-indexed?')).toBeInTheDocument();
    // The private marker is what tells the asker nobody else can read it —
    // without it a student cannot tell a pending question from a published
    // one, which is the only question they actually have about their own row.
    expect(screen.getByText(/chỉ bạn và ban tổ chức thấy/)).toBeInTheDocument();
    expect(screen.getByText('Đang chờ trả lời.')).toBeInTheDocument();
  });

  it('says so when the feed was capped, and stays quiet when it was not (D63)', async () => {
    routeGet({ joined: true, items: [ANNOUNCEMENT], truncated: true });
    const view = wrap(<ContestPage contestKey="spring" />);
    expect(await screen.findByText(/200 mục mới nhất/)).toBeInTheDocument();
    view.unmount();

    routeGet({ joined: true, items: [ANNOUNCEMENT], truncated: false });
    wrap(<ContestPage contestKey="spring" />);
    await screen.findByText('Problem A has been rejudged.');
    expect(screen.queryByText(/200 mục mới nhất/)).not.toBeInTheDocument();
  });

  it('lets a joined participant ask, and sends the problem they chose', async () => {
    routeGet({ joined: true, items: [] });
    post.mockResolvedValue({ data: QUESTION });
    wrap(<ContestPage contestKey="spring" />);

    const box = await screen.findByLabelText('Hỏi ban tổ chức');
    await userEvent.type(box, 'Is N up to 1e9?');
    await userEvent.click(screen.getByRole('button', { name: 'Gửi' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/contests/{key}/clarifications', {
        params: { path: { key: 'spring' } },
        body: { question: 'Is N up to 1e9?', problemCode: null },
      }),
    );
  });

  it('offers no ask form to somebody who has not joined', async () => {
    routeGet({ joined: false, items: [ANNOUNCEMENT] });
    wrap(<ContestPage contestKey="spring" />);

    expect(await screen.findByText('Problem A has been rejudged.')).toBeInTheDocument();
    expect(screen.getByText('Tham gia kỳ thi để đặt câu hỏi.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Hỏi ban tổ chức')).toBeNull();
  });

  it('gives an organiser the announcement form and the per-row publish button', async () => {
    routeGet({ canEdit: true, joined: true, items: [QUESTION] });
    patch.mockResolvedValue({ data: { ...QUESTION, visibility: 'public' } });
    post.mockResolvedValue({ data: ANNOUNCEMENT });
    wrap(<ContestPage contestKey="spring" />);

    await userEvent.type(await screen.findByLabelText('Đăng thông báo'), 'Ten minutes left.');
    await userEvent.click(screen.getByRole('button', { name: 'Đăng' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/contests/{key}/announcements', {
        params: { path: { key: 'spring' } },
        body: { text: 'Ten minutes left.', problemCode: null },
      }),
    );

    // Publishing sends `visibility` ALONE: an organiser who has not touched
    // the answer box must not have an empty answer written over the row.
    await userEvent.click(screen.getByRole('button', { name: 'Công bố' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/contests/{key}/clarifications/{id}', {
        params: { path: { key: 'spring', id: '7' } },
        body: { visibility: 'public' },
      }),
    );

    patch.mockClear();
    await userEvent.type(screen.getByLabelText('Trả lời #7'), 'Yes.');
    await userEvent.click(screen.getByRole('button', { name: 'Trả lời' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/contests/{key}/clarifications/{id}', {
        params: { path: { key: 'spring', id: '7' } },
        body: { answer: 'Yes.' },
      }),
    );
  });

  it('a participant is never offered the answer or publish controls', async () => {
    routeGet({ canEdit: false, joined: true, items: [QUESTION] });
    wrap(<ContestPage contestKey="spring" />);

    expect(await screen.findByText('Is the array 1-indexed?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Công bố' })).toBeNull();
    expect(screen.queryByLabelText('Trả lời #7')).toBeNull();
    expect(screen.queryByLabelText('Đăng thông báo')).toBeNull();
  });

  it('polls every 30 s while the contest runs, and not once it has finished', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      routeGet({ joined: true, items: [] });
      wrap(<ContestPage contestKey="spring" />);
      await waitFor(() =>
        expect(get).toHaveBeenCalledWith('/contests/{key}/clarifications', expect.anything()),
      );
      const first = get.mock.calls.filter(([path]) => path === '/contests/{key}/clarifications').length;

      await vi.advanceTimersByTimeAsync(31_000);
      await waitFor(() =>
        expect(
          get.mock.calls.filter(([path]) => path === '/contests/{key}/clarifications').length,
        ).toBeGreaterThan(first),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not poll a finished contest', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      routeGet({
        joined: true,
        items: [],
        contest: { startTime: '2020-01-01T00:00:00.000Z', endTime: '2020-01-02T00:00:00.000Z' },
      });
      wrap(<ContestPage contestKey="spring" />);
      await waitFor(() =>
        expect(get).toHaveBeenCalledWith('/contests/{key}/clarifications', expect.anything()),
      );
      const first = get.mock.calls.filter(([path]) => path === '/contests/{key}/clarifications').length;

      await vi.advanceTimersByTimeAsync(120_000);
      expect(
        get.mock.calls.filter(([path]) => path === '/contests/{key}/clarifications').length,
      ).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });
});
