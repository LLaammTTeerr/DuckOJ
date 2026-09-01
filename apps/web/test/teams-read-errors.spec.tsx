/**
 * What the teams screens say when the server did not answer (B-18 finding 6,
 * residual).
 *
 * `openapi-fetch` RESOLVES an HTTP error rather than rejecting, so
 * `const { data } = await api.GET(...)` followed by `?? []` or `?? null` is a
 * clean-looking line that turns every 500 into a fact about the world: "this
 * school has no teams", "no such team", an edit form with an empty roster
 * box. B-4 replaced these once, B-8 found nine survivors and made `read()`
 * the shape, and `teams.tsx` shipped with four more.
 *
 * Each test below drives one of the four, because the right answer differs
 * per site: a 404 on a team's own page IS an answer, and a 500 on the same
 * request is not.
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

const { OrgTeams, TeamPage } = await import('../src/routes/teams.js');

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const ME = { username: 'co-giao', globalRole: 'user' };

/** What `openapi-fetch` hands back for a refusal it could decode. */
function failure(status: number, code = 'server_error') {
  return { data: undefined, error: { detail: 'nope', code }, response: { status } };
}

function summary(over: Record<string, unknown> = {}) {
  return {
    slug: 'doi-1',
    name: 'Đội 1',
    orgSlug: 'thpt',
    orgName: 'THPT Chuyên',
    memberCount: 2,
    members: [
      { username: 'an', displayName: 'An', joinedAt: '' },
      { username: 'binh', displayName: 'Bình', joinedAt: '' },
    ],
    createdAt: '',
    inRunningContest: false,
    ...over,
  };
}

afterEach(() => {
  get.mockReset();
});

describe('the org teams panel', () => {
  it('says the list could not be read rather than "no teams yet"', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/auth/me') return Promise.resolve({ data: ME });
      return Promise.resolve(failure(500));
    });
    wrap(<OrgTeams slug="thpt" canManage />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBeTruthy();
    // The empty state is a claim about the school, and it must not be made
    // on the strength of a failed request.
    expect(screen.queryByText('Chưa có đội nào.')).toBeNull();
  });

  /**
   * D182 replaced this case. There used to be a per-row `GET
   * /orgs/{slug}/teams/{teamSlug}` behind every roster on the panel, and this
   * test pinned what a row said when that request failed on its own — a
   * failure mode that now cannot happen, because the names ride on the
   * summary. What is asserted instead is the property that removed it: the
   * panel renders a roster having made NO request for it.
   */
  it('prints a roster without asking a second time for it', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/auth/me') return Promise.resolve({ data: ME });
      if (path === '/orgs/{slug}/teams')
        return Promise.resolve({ data: { items: [summary()], nextCursor: null } });
      return Promise.resolve(failure(500));
    });
    wrap(<OrgTeams slug="thpt" canManage />);

    expect(await screen.findByRole('link', { name: 'an' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'binh' })).toBeTruthy();
    // The N+1, said as an assertion: one list request, and no detail request
    // behind the row. Twenty-five rows used to mean twenty-five of these.
    expect(
      get.mock.calls.filter((call) => call[0] === '/orgs/{slug}/teams/{teamSlug}'),
    ).toHaveLength(0);
  });

  it('refuses to open an edit form on a roster it could not load', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/auth/me') return Promise.resolve({ data: ME });
      if (path === '/orgs/{slug}/teams')
        return Promise.resolve({ data: { items: [summary()], nextCursor: null } });
      return Promise.resolve(failure(500));
    });
    const view = wrap(<OrgTeams slug="thpt" canManage />);
    (await screen.findByRole('button', { name: 'Sửa' })).click();

    // A form rendered over a failed load shows an EMPTY members box, and
    // `members` replaces the whole roster — so the save that looks like a
    // no-op is the one that empties the team.
    await screen.findAllByRole('alert');
    expect(view.container.querySelector('textarea')).toBeNull();
  });
});

describe("a team's own page", () => {
  it('still says "no such team" for a 404, which is an answer', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/auth/me') return Promise.resolve({ data: ME });
      return Promise.resolve(failure(404, 'team_not_found'));
    });
    wrap(<TeamPage slug="thpt" teamSlug="doi-1" />);
    expect(
      await screen.findByText('Không có đội này, hoặc bạn không được xem.'),
    ).toBeTruthy();
  });

  it('does not say "no such team" for a 500, which is not', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/auth/me') return Promise.resolve({ data: ME });
      return Promise.resolve(failure(500));
    });
    wrap(<TeamPage slug="thpt" teamSlug="doi-1" />);

    // By text, not by role: `me` is still pending on the first pass and the
    // sign-in prompt is an alert too, so `findByRole('alert')` would match
    // that one and pass whatever this page went on to say.
    expect(await screen.findByText('Không đọc được đội này.')).toBeTruthy();
    expect(screen.queryByText('Không có đội này, hoặc bạn không được xem.')).toBeNull();
  });
});
