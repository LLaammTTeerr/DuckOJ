/**
 * The team's own page (D99 as amended by F-25).
 *
 * It prints what the team has actually done — the contests it entered, who
 * held each entry — and links out to the board rather than inventing a rank
 * of its own.
 */
import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('../src/api.js', () => ({
  api: { GET: (...a: unknown[]) => get(...a), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params }: Record<string, unknown>) => (
    <a href={String(to)} data-params={JSON.stringify(params)}>
      {children as React.ReactNode}
    </a>
  ),
}));

const { TeamPage } = await import('../src/routes/teams.js');

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const ME = { username: 'co-giao', globalRole: 'user' };

function summary(over: Record<string, unknown> = {}) {
  return {
    slug: 'doi-1',
    name: 'Đội 1',
    orgSlug: 'thpt',
    orgName: 'THPT Chuyên',
    memberCount: 2,
    createdAt: '',
    inRunningContest: false,
    ...over,
  };
}

function detail(over: Record<string, unknown> = {}) {
  return {
    ...summary(),
    members: [{ username: 'anh', displayName: 'Anh', joinedAt: '' }],
    contests: [],
    canEdit: true,
    ...over,
  };
}

afterEach(() => {
  get.mockReset();
});

describe('a team’s own page', () => {
  it('prints its people, the contests it entered, and who held each entry', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/auth/me') return Promise.resolve({ data: ME });
      return Promise.resolve({
        data: detail({
          inRunningContest: true,
          contests: [
            {
              key: 'tinh2026',
              name: 'Thi tỉnh 2026',
              startTime: new Date('2026-03-01T01:00:00Z').toISOString(),
              endTime: new Date('2026-03-01T06:00:00Z').toISOString(),
              running: true,
              isDisqualified: false,
              captain: 'anh',
            },
          ],
        }),
      });
    });
    wrap(<TeamPage slug="thpt" teamSlug="doi-1" />);

    expect(await screen.findByRole('heading', { name: 'Đội 1', level: 1 })).toBeInTheDocument();
    // Twice, deliberately: once on the roster and once as the captain who
    // holds the entry — the account D99 keys disqualification by.
    expect(screen.getAllByRole('link', { name: 'anh' })).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Thi tỉnh 2026' })).toBeInTheDocument();
    // The board, not a rank computed here: a standing belongs to the fold
    // that produces it, and means nothing yet for a round still running.
    expect(screen.getByRole('link', { name: 'Bảng điểm' })).toBeInTheDocument();
    expect(screen.getByRole('status').textContent).toMatch(/đang thi/i);
  });

  it('answers one sentence for a team that is missing, hidden, or not the viewer’s', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/auth/me') return Promise.resolve({ data: ME });
      return Promise.resolve({ error: { code: 'team_not_found' }, response: { status: 404 } });
    });
    wrap(<TeamPage slug="thpt" teamSlug="bi-mat" />);

    // `findByText`, not `findByRole('alert')`: the sign-in notice is also an
    // alert and renders first, so waiting on the ROLE would resolve on it.
    expect(await screen.findByText(/Không có đội này/i)).toBeInTheDocument();
  });
});
