/**
 * The organiser's controls on the scoreboard: DQ / un-DQ per row, and what a
 * disqualified row looks like.
 *
 * Who sees the controls is the server's answer (`canEdit` on the contest
 * detail), never a guess from `me` — so the page is pinned against both
 * answers rather than against a role.
 */
import type { ReactElement } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const patch = vi.fn();
vi.mock('../src/api.js', () => ({
  api: { GET: (...a: unknown[]) => get(...a), POST: vi.fn(), PATCH: (...a: unknown[]) => patch(...a) },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { ScoreboardPage } = await import('../src/routes/contests.js');

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function row(participant: string, isDq: boolean, rank: number) {
  return {
    rank,
    participant,
    virtual: 0,
    is_disqualified: isDq,
    score: 100,
    cumtime: 60,
    tiebreaker: 0,
    frozen_score: 0,
    frozen_cumtime: 0,
    frozen_tiebreaker: 0,
    submission_count: 1,
    format_data: { aplusb: { points: 100, time: 60 } },
  };
}

const BOARD = {
  label_by_problem: { aplusb: 'A' },
  problems: [
    { code: 'aplusb', label: 'A', points: 100, points_scaling_factor: null, total_ac: 1, first_solve: 'clean' },
  ],
  ranking: [row('clean', false, 1), row('cheat', true, 2)],
};

/** `/contests/{key}` answers `canEdit`; the scoreboard route answers `BOARD`. */
function routeGet(canEdit: boolean): void {
  get.mockImplementation((path: string) =>
    path === '/contests/{key}'
      ? Promise.resolve({ data: { key: 'spring', name: 'Spring', canEdit } })
      : Promise.resolve({ data: BOARD }),
  );
}

afterEach(() => {
  get.mockReset();
  patch.mockReset();
});

describe('a disqualified row', () => {
  it('is marked [DQ] and struck through, for every viewer', async () => {
    routeGet(false);
    wrap(<ScoreboardPage contestKey="spring" />);

    const cheat = (await screen.findByText('cheat')).closest('tr')!;
    expect(within(cheat).getByText('[DQ]')).toBeInTheDocument();
    expect(cheat).toHaveClass('dq');

    const clean = screen.getByText('clean').closest('tr')!;
    expect(within(clean).queryByText('[DQ]')).toBeNull();
    expect(clean).not.toHaveClass('dq');
  });
});

describe('the DQ controls', () => {
  it('are hidden unless the server says the caller runs the contest', async () => {
    routeGet(false);
    wrap(<ScoreboardPage contestKey="spring" />);
    expect(await screen.findByText('cheat')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /DQ clean/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /un-DQ cheat/ })).toBeNull();
  });

  it('offer DQ for a qualified row and un-DQ for a disqualified one', async () => {
    routeGet(true);
    patch.mockResolvedValue({ data: { id: 1, isDisqualified: true } });
    wrap(<ScoreboardPage contestKey="spring" />);

    await userEvent.click(await screen.findByRole('button', { name: 'DQ clean' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/contests/{key}/participants/{username}', {
        params: { path: { key: 'spring', username: 'clean' } },
        body: { disqualified: true },
      }),
    );

    patch.mockClear();
    await userEvent.click(screen.getByRole('button', { name: 'un-DQ cheat' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/contests/{key}/participants/{username}', {
        params: { path: { key: 'spring', username: 'cheat' } },
        body: { disqualified: false },
      }),
    );
  });

  it('report a refusal, and a transport failure never wedges the row', async () => {
    routeGet(true);
    patch.mockResolvedValue({ error: { code: 'contest_forbidden', detail: 'You do not run this contest.' } });
    wrap(<ScoreboardPage contestKey="spring" />);
    await userEvent.click(await screen.findByRole('button', { name: 'DQ clean' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not run this contest.');

    patch.mockRejectedValue(new TypeError('Failed to fetch'));
    const button = screen.getByRole('button', { name: 'un-DQ cheat' });
    await userEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach the server/i);
    await waitFor(() => expect(button).not.toBeDisabled());
  });
});
