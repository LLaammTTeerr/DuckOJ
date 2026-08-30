/**
 * Team contests on the web (D99): the join picker, what a member who never
 * pressed Join is told, and what the scoreboard does with a row that is a
 * team rather than a person.
 *
 * The three things pinned here are the three that are silently wrong if the
 * page treats a team like a competitor: the join body carries `teamSlug`,
 * the DQ button sends the CAPTAIN's username (the route is keyed by an
 * account, and a team's name names none), and the team's name never becomes
 * a `/users/{name}` link.
 */
import type { ReactElement } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
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
  Link: ({ children, to, params, title }: Record<string, unknown>) => (
    <a href={String(to)} data-params={JSON.stringify(params)} title={title as string | undefined}>
      {children as React.ReactNode}
    </a>
  ),
}));

const { ContestPage, ScoreboardPage } = await import('../src/routes/contests.js');

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const HOUR = 3_600_000;

function contest(over: Record<string, unknown> = {}) {
  return {
    key: 'doi',
    name: 'Vòng đồng đội',
    format: 'icpc',
    startTime: new Date(Date.now() - HOUR).toISOString(),
    endTime: new Date(Date.now() + HOUR).toISOString(),
    visibility: 'public',
    pointsPrecision: 3,
    frozenLastMinutes: 0,
    timeLimitSeconds: null,
    isRated: false,
    participationMode: 'team',
    maxTeamSize: 3,
    orgs: [{ slug: 'thpt', name: 'THPT Chuyên' }],
    canEdit: false,
    problems: [],
    ...over,
  };
}

/**
 * `GET /users/me/teams?contest=` — ONE request across every school (D99 as
 * amended by F-25), and the server's own eligibility verdict per row. The
 * picker used to ask `/orgs/{slug}/teams` once per organization the contest
 * named.
 */
const MY_TEAMS = {
  items: [
    {
      slug: 'doi-1',
      name: 'Đội 1',
      orgSlug: 'thpt',
      orgName: 'THPT Chuyên',
      memberCount: 2,
      createdAt: '',
      inRunningContest: false,
      eligible: true,
      ineligibleReason: null,
    },
    // A team the server says may NOT enter: the picker offers it, disabled,
    // with the server's own reason beside it — greying it out for a rule
    // this page re-derived is exactly what the `?contest=` exists to avoid.
    {
      slug: 'doi-to',
      name: 'Đội To',
      orgSlug: 'thpt',
      orgName: 'THPT Chuyên',
      memberCount: 5,
      createdAt: '',
      inRunningContest: false,
      eligible: false,
      ineligibleReason: 'contest_team_too_large',
    },
  ],
  truncated: false,
};

afterEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
});

describe('joining a team contest', () => {
  it('offers the caller’s own teams and sends the chosen slug', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/contests/{key}') return Promise.resolve({ data: contest() });
      if (path === '/auth/me') return Promise.resolve({ data: { username: 'anh', globalRole: 'user' } });
      if (path === '/users/me/teams') return Promise.resolve({ data: MY_TEAMS });
      // Not joined yet: the endpoint's own 404, which the page reads as a
      // state rather than an error.
      // `read()` decides on the RESPONSE's status as well as the body, so a
      // "not joined" mock has to carry both halves.
      return Promise.resolve({
        error: { code: 'participation_not_found', detail: 'You have not joined this contest.' },
        response: { status: 404 },
      });
    });
    post.mockResolvedValue({ data: { id: 7 } });
    wrap(<ContestPage contestKey="doi" />);

    const picker = await screen.findByRole('combobox');
    expect(within(picker).getByRole('option', { name: /Đội 1/ })).toBeInTheDocument();
    // The ineligible one is offered and refused, with the server's reason.
    const tooBig = within(picker).getByRole('option', { name: /Đội To/ });
    expect(tooBig).toBeDisabled();
    expect(tooBig.textContent).toMatch(/quá đông/);
    // Exactly one request for the whole picker, whatever the contest's
    // organizations are — the thing this endpoint exists for.
    await waitFor(() =>
      expect(get.mock.calls.filter((call) => call[0] === '/users/me/teams')).toHaveLength(1),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Tham gia' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/contests/{key}/join', {
        params: { path: { key: 'doi' } },
        body: { teamSlug: 'doi-1' },
      }),
    );
  });

  it('says so, rather than offering a picker, when the viewer is on no team', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/contests/{key}') return Promise.resolve({ data: contest() });
      if (path === '/auth/me') return Promise.resolve({ data: { username: 'ai', globalRole: 'user' } });
      if (path === '/users/me/teams') return Promise.resolve({ data: { items: [], truncated: false } });
      // `read()` decides on the RESPONSE's status as well as the body, so a
      // "not joined" mock has to carry both halves.
      return Promise.resolve({
        error: { code: 'participation_not_found', detail: 'You have not joined this contest.' },
        response: { status: 404 },
      });
    });
    wrap(<ContestPage contestKey="doi" />);

    expect(await screen.findByText(/không thuộc đội nào/i)).toBeInTheDocument();
    // The button is there and refuses to fire: a Join with no team is a 422
    // the server would answer, and offering it would teach nothing.
    expect(screen.getByRole('button', { name: 'Tham gia' })).toBeDisabled();
  });

  it('sends no team at all for an individual contest', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/contests/{key}')
        return Promise.resolve({ data: contest({ participationMode: 'individual', orgs: [] }) });
      if (path === '/auth/me') return Promise.resolve({ data: { username: 'anh', globalRole: 'user' } });
      // `read()` decides on the RESPONSE's status as well as the body, so a
      // "not joined" mock has to carry both halves.
      return Promise.resolve({
        error: { code: 'participation_not_found', detail: 'You have not joined this contest.' },
        response: { status: 404 },
      });
    });
    post.mockResolvedValue({ data: { id: 7 } });
    wrap(<ContestPage contestKey="doi" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Tham gia' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/contests/{key}/join', {
        params: { path: { key: 'doi' } },
        body: {},
      }),
    );
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('tells a member who never pressed Join that they are competing on the team’s row', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/contests/{key}') return Promise.resolve({ data: contest() });
      if (path === '/auth/me') return Promise.resolve({ data: { username: 'binh', globalRole: 'user' } });
      if (path === '/users/me/teams') return Promise.resolve({ data: MY_TEAMS });
      if (path === '/contests/{key}/me')
        return Promise.resolve({
          data: {
            id: 7,
            contestKey: 'doi',
            virtual: 0,
            startTime: new Date().toISOString(),
            endTime: new Date(Date.now() + HOUR).toISOString(),
            isDisqualified: false,
            team: { slug: 'doi-1', name: 'Đội 1', orgSlug: 'thpt', members: ['anh', 'binh'] },
          },
        });
      // Joining opens the clarifications panel, which reads its own feed.
      return Promise.resolve({ data: { items: [] } });
    });
    wrap(<ContestPage contestKey="doi" />);

    expect(await screen.findByText(/Đang thi với đội Đội 1 \(anh, binh\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tham gia' })).toBeNull();
  });
});

/* ------------------------------------------------------- the scoreboard */

const TEAM_BOARD = {
  label_by_problem: { aplusb: 'A' },
  problems: [
    { code: 'aplusb', label: 'A', points: 100, points_scaling_factor: null, total_ac: 1, first_solve: 'Đội 1' },
  ],
  ranking: [
    {
      rank: 1,
      participant: 'Đội 1',
      virtual: 0,
      is_disqualified: false,
      score: 100,
      cumtime: 60,
      tiebreaker: 0,
      frozen_score: 0,
      frozen_cumtime: 0,
      frozen_tiebreaker: 0,
      submission_count: 1,
      format_data: { aplusb: { points: 100, time: 60 } },
    },
  ],
  frozen: false,
  frozenAt: null,
  teams: {
    'Đội 1': {
      slug: 'doi-1',
      name: 'Đội 1',
      orgSlug: 'thpt',
      orgName: 'THPT Chuyên',
      captain: 'anh',
      members: ['anh', 'binh'],
    },
  },
};

function boardGet(canEdit: boolean): void {
  get.mockImplementation((path: string) =>
    path === '/contests/{key}'
      ? Promise.resolve({ data: { key: 'doi', name: 'Vòng đồng đội', canEdit } })
      : Promise.resolve({ data: TEAM_BOARD }),
  );
}

describe('a team row on the scoreboard', () => {
  it('names the team, links its school rather than a profile, and lists its members', async () => {
    boardGet(false);
    wrap(<ScoreboardPage contestKey="doi" />);

    const name = await screen.findByText('Đội 1');
    // The team's name is NOT a username: a `/users/Đội 1` link would 404.
    expect(name.closest('a')!.getAttribute('href')).toBe('/orgs/$slug');
    expect(name.closest('a')!.title).toContain('anh, binh');

    const rowEl = name.closest('tr')!;
    expect(within(rowEl).getByText('anh').closest('a')!.getAttribute('href')).toBe('/users/$username');
    expect(within(rowEl).getByText('binh')).toBeInTheDocument();
  });

  it('disqualifies through the captain’s account, not through the team’s name', async () => {
    boardGet(true);
    patch.mockResolvedValue({ data: { id: 1, isDisqualified: true } });
    wrap(<ScoreboardPage contestKey="doi" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Hủy tư cách Đội 1' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/contests/{key}/participants/{username}', {
        // `Đội 1` names no account; `anh` holds the participation (D99).
        params: { path: { key: 'doi', username: 'anh' } },
        body: { disqualified: true },
      }),
    );
  });
});
