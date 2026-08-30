/**
 * The classroom problem-set screens (D66).
 *
 * What is asserted here is what the API cannot: that an on-time result and a
 * late one are two different cells on the page rather than one that quietly
 * replaced the other, that a problem the viewer may no longer open is shown
 * without a link, and that the grid's scroll container is reachable from a
 * keyboard — the WCAG 2.1.1 gap final-review m21 recorded against every
 * other table in this app.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
const patch = vi.fn();
vi.mock('../src/api.js', () => ({
  api: {
    GET: (...a: unknown[]) => get(...a),
    POST: (...a: unknown[]) => post(...a),
    DELETE: (...a: unknown[]) => del(...a),
    PATCH: (...a: unknown[]) => patch(...a),
  },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { OrgSets, ProblemSetPage, ProblemSetProgressPage } = await import(
  '../src/routes/problem-sets.js'
);

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const ME = { username: 'pupil', displayName: 'Pupil', globalRole: 'user' };

const SUMMARY = {
  slug: 'tuan-1',
  name: 'Tuần 1',
  description: null,
  deadline: '2026-09-01T15:00:00Z',
  itemCount: 2,
  solvedCount: 1,
  createdAt: '2026-08-01T00:00:00Z',
};

const ATTEMPT_WA = {
  verdict: 'WA',
  points: 40,
  maxPoints: 100,
  submittedAt: '2026-08-30T10:00:00Z',
  solvedAt: null,
};
const ATTEMPT_AC = {
  verdict: 'AC',
  points: 100,
  maxPoints: 100,
  submittedAt: '2026-09-02T10:00:00Z',
  solvedAt: '2026-09-02T10:00:00Z',
};

const DETAIL = {
  ...SUMMARY,
  items: [
    {
      code: 'aplusb',
      name: 'A+B',
      order: 0,
      points: 100,
      visible: true,
      me: { onTime: ATTEMPT_WA, late: ATTEMPT_AC },
    },
    { code: 'gone', name: 'Withdrawn', order: 1, points: 50, visible: false, me: null },
  ],
};

const GRID = {
  slug: 'tuan-1',
  name: 'Tuần 1',
  deadline: '2026-09-01T15:00:00Z',
  columns: [{ code: 'aplusb', name: 'A+B', points: 100 }],
  rows: [
    { username: 'anna', displayName: 'Anna', role: 'member', cells: [{ onTime: ATTEMPT_AC, late: null }] },
    { username: 'bao', displayName: 'Bao', role: 'member', cells: [null] },
  ],
  nextCursor: null,
};

function serve(routes: Record<string, unknown>, me: unknown = ME) {
  get.mockImplementation((path: string) => {
    if (path === '/auth/me') return Promise.resolve({ data: me });
    if (path in routes) return Promise.resolve({ data: routes[path] });
    return Promise.resolve({ data: undefined });
  });
}

afterEach(() => {
  get.mockReset();
  post.mockReset();
  del.mockReset();
  patch.mockReset();
});

describe('OrgSets', () => {
  it('shows each set with its deadline and the viewer’s own progress', async () => {
    serve({ '/orgs/{slug}/sets': { items: [SUMMARY], nextCursor: null } });
    wrap(<OrgSets slug="hanoi" canManage={false} />);
    expect(await screen.findByText('Tuần 1')).toBeTruthy();
    expect(screen.getByText('1/2')).toBeTruthy();
  });

  it('renders nothing at all for a member with no sets, and the assign button for a teacher', async () => {
    serve({ '/orgs/{slug}/sets': { items: [], nextCursor: null } });
    const plain = wrap(<OrgSets slug="hanoi" canManage={false} />);
    // Waited for on the REQUEST, not on the absence: "nothing rendered yet"
    // and "nothing to render" look identical one tick after mount, so an
    // assertion that only waits for emptiness passes before the answer has
    // even arrived.
    await waitFor(() => {
      expect(get.mock.calls.some((call) => call[0] === '/orgs/{slug}/sets')).toBe(true);
    });
    await act(async () => {
      await Promise.resolve();
    });
    // Not "no sets yet" — a school that has assigned none should not grow a
    // heading over an empty table on every visitor's screen.
    expect(plain.container.textContent).toBe('');
    plain.unmount();

    wrap(<OrgSets slug="hanoi" canManage />);
    expect(await screen.findByRole('button', { name: 'Giao bài tập' })).toBeTruthy();
  });

  it('never asks for the sets of a school while signed out', async () => {
    serve({ '/orgs/{slug}/sets': { items: [SUMMARY], nextCursor: null } }, undefined);
    wrap(<OrgSets slug="hanoi" canManage={false} />);
    // The route needs a session, so a request fired without one could only
    // 401 — which the e2e smoke run treats as a broken request.
    await waitFor(() => {
      expect(get).toHaveBeenCalled();
    });
    expect(get.mock.calls.some((call) => call[0] === '/orgs/{slug}/sets')).toBe(false);
  });
});

describe('ProblemSetPage', () => {
  it('shows the on-time result and the late one as two separate cells', async () => {
    serve({ '/orgs/{slug}/sets/{setSlug}': DETAIL, '/orgs/{slug}': { slug: 'hanoi', name: 'Hanoi', myRole: 'member' } });
    wrap(<ProblemSetPage slug="hanoi" setSlug="tuan-1" />);

    const row = (await screen.findByText('A+B')).closest('tr')!;
    // The homework counts the WA it got before the deadline, and says the
    // pupil solved it anyway two days later. One cell could only tell one of
    // those two truths.
    expect(within(row).getByText('WA')).toBeTruthy();
    expect(within(row).getByText('AC')).toBeTruthy();
    // And the two cells are headed, or the second column is a number under
    // somebody else's heading.
    expect(screen.getByRole('columnheader', { name: 'Nộp muộn' })).toBeTruthy();
  });

  it('shows a problem the viewer may no longer open without a link to it', async () => {
    serve({ '/orgs/{slug}/sets/{setSlug}': DETAIL, '/orgs/{slug}': { slug: 'hanoi', name: 'Hanoi', myRole: 'member' } });
    wrap(<ProblemSetPage slug="hanoi" setSlug="tuan-1" />);

    const row = (await screen.findByText('Withdrawn')).closest('tr')!;
    expect(within(row).queryByRole('link')).toBeNull();
    expect(within(row).getByText(/không xem được/)).toBeTruthy();
  });

  it('offers the grid, the edit form and withdrawal only to somebody who runs the school', async () => {
    serve({ '/orgs/{slug}/sets/{setSlug}': DETAIL, '/orgs/{slug}': { slug: 'hanoi', name: 'Hanoi', myRole: 'member' } });
    const pupil = wrap(<ProblemSetPage slug="hanoi" setSlug="tuan-1" />);
    await screen.findByText('A+B');
    expect(screen.queryByRole('button', { name: 'Sửa bài tập' })).toBeNull();
    pupil.unmount();

    serve({ '/orgs/{slug}/sets/{setSlug}': DETAIL, '/orgs/{slug}': { slug: 'hanoi', name: 'Hanoi', myRole: 'owner' } });
    wrap(<ProblemSetPage slug="hanoi" setSlug="tuan-1" />);
    expect(await screen.findByRole('button', { name: 'Sửa bài tập' })).toBeTruthy();
  });

  it('sends the edited problem list, in the teacher’s order, as a whole', async () => {
    serve({ '/orgs/{slug}/sets/{setSlug}': DETAIL, '/orgs/{slug}': { slug: 'hanoi', name: 'Hanoi', myRole: 'owner' } });
    patch.mockResolvedValue({ data: DETAIL });
    wrap(<ProblemSetPage slug="hanoi" setSlug="tuan-1" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Sửa bài tập' }));
    // The form seeds from the set, so the two problems are already picked.
    await userEvent.click(screen.getAllByRole('button', { name: 'Xuống' })[0]!);
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }));

    await waitFor(() => {
      expect(patch).toHaveBeenCalled();
    });
    const body = (patch.mock.calls[0]![1] as { body: { problems: { code: string }[] } }).body;
    expect(body.problems.map((p) => p.code)).toEqual(['gone', 'aplusb']);
  });
});

describe('ProblemSetProgressPage', () => {
  it('puts the grid in a focusable, labelled scroll container with a sticky header', async () => {
    serve({ '/orgs/{slug}/sets/{setSlug}/progress': GRID });
    wrap(<ProblemSetProgressPage slug="hanoi" setSlug="tuan-1" />);

    const region = await screen.findByRole('region');
    // m21: the scroll container has to be a tab stop, or the columns past
    // the right edge are unreachable without a mouse.
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.getAttribute('aria-label')).toBeTruthy();
    expect(region.querySelector('table')).toBeTruthy();
  });

  it('draws a cell per member per problem, and an empty one for a pupil who never submitted', async () => {
    serve({ '/orgs/{slug}/sets/{setSlug}/progress': GRID });
    wrap(<ProblemSetProgressPage slug="hanoi" setSlug="tuan-1" />);

    const anna = (await screen.findByText('Anna')).closest('tr')!;
    expect(within(anna).getByText('AC')).toBeTruthy();
    const bao = screen.getByText('Bao').closest('tr')!;
    expect(within(bao).queryByText('AC')).toBeNull();
    expect(within(bao).getByText('—')).toBeTruthy();
  });

  it('links the CSV straight at the API, with format=csv', async () => {
    serve({ '/orgs/{slug}/sets/{setSlug}/progress': GRID });
    wrap(<ProblemSetProgressPage slug="hanoi" setSlug="tuan-1" />);

    const link = await screen.findByRole('link', { name: 'Tải CSV' });
    expect(link.getAttribute('href')).toContain('/orgs/hanoi/sets/tuan-1/progress?format=csv');
  });
});
