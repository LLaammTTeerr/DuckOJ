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
    get.mockImplementation((path: string) =>
      path === '/contests/{key}'
        ? Promise.resolve({ data: RUNNING })
        : Promise.resolve({ data: undefined }),
    );
    wrap(<ContestPage contestKey="spring" />);

    expect(await screen.findByRole('button', { name: /^join$/i })).toBeInTheDocument();
    // Until you join, submitting to a contest problem would be practice — so
    // the page does not offer a link that silently means something else.
    expect(screen.getByText(/join to submit/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /submit/i })).toBeNull();
  });

  it('shows the window and attempt once joined', async () => {
    const endTime = new Date(Date.now() + 1_800_000).toISOString();
    get.mockImplementation((path: string) =>
      path === '/contests/{key}'
        ? Promise.resolve({ data: RUNNING })
        : Promise.resolve({ data: { id: 1, contestKey: 'spring', virtual: 0, startTime: RUNNING.startTime, endTime, isDisqualified: false } }),
    );
    wrap(<ContestPage contestKey="spring" />);

    expect(await screen.findByRole('status')).toHaveTextContent(/competing live/i);
    expect(screen.getByRole('link', { name: /submit/i })).toBeInTheDocument();
  });

  it('refuses to offer a join before the contest starts', async () => {
    const upcoming = {
      ...RUNNING,
      startTime: new Date(Date.now() + 3_600_000).toISOString(),
      endTime: new Date(Date.now() + 7_200_000).toISOString(),
    };
    get.mockImplementation((path: string) =>
      path === '/contests/{key}' ? Promise.resolve({ data: upcoming }) : Promise.resolve({ data: undefined }),
    );
    wrap(<ContestPage contestKey="spring" />);
    expect(await screen.findByRole('button', { name: /join/i })).toBeDisabled();
  });

  it('surfaces the server message when joining is refused', async () => {
    get.mockImplementation((path: string) =>
      path === '/contests/{key}' ? Promise.resolve({ data: RUNNING }) : Promise.resolve({ data: undefined }),
    );
    post.mockResolvedValue({ error: { detail: 'This organization admits members by invitation only.' } });
    wrap(<ContestPage contestKey="spring" />);
    await userEvent.click(await screen.findByRole('button', { name: /^join$/i }));
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
  });

  it('says so when nobody has competed', async () => {
    get.mockResolvedValue({ data: { label_by_problem: {}, problems: [], ranking: [] } });
    wrap(<ScoreboardPage contestKey="spring" />);
    expect(await screen.findByText(/nobody has competed/i)).toBeInTheDocument();
  });
});
