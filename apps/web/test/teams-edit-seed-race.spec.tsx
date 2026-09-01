/**
 * The edit form must not offer a box it is about to overwrite (B-33, D183).
 *
 * `apps/web/e2e/organiser.spec.ts` journey 2 went red the day F-50's web half
 * was deployed: the walk typed a third pupil into the roster, the PATCH came
 * back `200` instead of the one-seat rule's `409`, and the roster on the
 * server had not moved. The request bytes, captured off the live edge with
 * `page.on('request')`, say why — the teacher typed
 * `fe42-a1, fe42-a2, fe42-c1` and the body carried
 * `{"members":["fe42-a1","fe42-a2"], ...}`.
 *
 * The mechanism is in `TeamForm`:
 *
 *  1. clicking Sửa mounts the form and fires `GET
 *     /orgs/{slug}/teams/{teamSlug}`;
 *  2. while that is in flight the form rendered all three fields — editable,
 *     empty, with nothing saying they were provisional;
 *  3. when the response lands the seed effect runs with `first === true`,
 *     and the `first` branch overwrites regardless of `dirty` (it has to:
 *     `loadNewer` reopens the guard by clearing `seededFrom`, and THAT reseed
 *     is the admin asking for it). `reseeded` is only announced when
 *     `!first`, so this one is silent;
 *  4. Lưu then sends the roster the server already had, at `200`, and the
 *     pupil the teacher added is nowhere.
 *
 * It was survivable until D182. `TeamMembers` used to fetch every row's
 * detail under this same `['org-team', slug, teamSlug]` key, so the cache was
 * warm before anyone clicked Sửa and the seed was effectively synchronous.
 * Removing that N+1 was right and removed the accidental prefetch with it,
 * which is how a performance fix turned into a silent write of stale data.
 *
 * Both tests are red against the deployed bundle and green after the gate.
 */
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const patch = vi.fn();
vi.mock('../src/api.js', () => ({
  api: {
    GET: (...a: unknown[]) => get(...a),
    POST: vi.fn(),
    PATCH: (...a: unknown[]) => patch(...a),
    DELETE: vi.fn(),
  },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params }: Record<string, unknown>) => (
    <a href={String(to)} data-params={JSON.stringify(params)}>
      {children as React.ReactNode}
    </a>
  ),
}));

const { OrgTeams } = await import('../src/routes/teams.js');

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const ME = { username: 'co-giao', globalRole: 'user' };
const ROSTER = ['an', 'binh'];

/**
 * The panel answers at once; the team's own detail is held open until the
 * test lets it go — a provincial link, not a localhost one.
 */
function mockApi(): { landTheRoster: () => void } {
  let land: () => void = () => {};
  const detail = new Promise<unknown>((resolve) => {
    land = () =>
      resolve({
        data: {
          slug: 'doi-1',
          name: 'Đội 1',
          orgSlug: 'thpt',
          orgName: 'THPT Chuyên',
          inRunningContest: false,
          version: 'v1',
          members: ROSTER.map((username) => ({ username, displayName: username })),
          contests: [],
        },
        error: undefined,
      });
  });
  get.mockImplementation((path: string) => {
    if (path === '/auth/me') return Promise.resolve({ data: ME });
    if (path === '/orgs/{slug}/teams') {
      return Promise.resolve({
        data: {
          items: [
            {
              slug: 'doi-1',
              name: 'Đội 1',
              orgSlug: 'thpt',
              orgName: 'THPT Chuyên',
              memberCount: ROSTER.length,
              members: ROSTER.map((username) => ({
                username,
                displayName: username,
                joinedAt: '',
              })),
              createdAt: '',
              inRunningContest: false,
            },
          ],
          nextCursor: null,
        },
        error: undefined,
      });
    }
    return detail;
  });
  patch.mockImplementation(() => Promise.resolve({ data: {}, error: undefined }));
  return { landTheRoster: () => land() };
}

afterEach(() => {
  get.mockReset();
  patch.mockReset();
});

describe('the team edit form, while the roster it edits is still in flight', () => {
  it('offers no editable field it is about to overwrite', async () => {
    const user = userEvent.setup();
    mockApi();
    const view = wrap(<OrgTeams slug="thpt" canManage />);
    await screen.findByRole('link', { name: 'an' });
    await user.click(screen.getByRole('button', { name: 'Sửa' }));

    // The heading is up, so the form IS open and this is not a race with
    // mounting it — what must not be up is a box.
    expect(await screen.findByRole('heading', { name: 'Sửa' })).toBeTruthy();
    expect(
      view.container.querySelector('textarea'),
      'a roster box the seed is about to replace was offered to the teacher',
    ).toBeNull();
    expect(view.container.querySelector('input')).toBeNull();
    // And the wait is said out loud, with a way out of it.
    expect(screen.getByText('Đang tải…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hủy' })).toBeTruthy();
  });

  it('sends the roster the teacher typed, not the one it seeded over', async () => {
    const user = userEvent.setup();
    const { landTheRoster } = mockApi();
    const view = wrap(<OrgTeams slug="thpt" canManage />);
    await screen.findByRole('link', { name: 'an' });
    await user.click(screen.getByRole('button', { name: 'Sửa' }));

    // A teacher types into the box the moment one is offered — which is the
    // whole point: a box that is offered is a box that gets typed into.
    const early = view.container.querySelector('textarea');
    if (early !== null) {
      await user.clear(early);
      await user.type(early, 'an, binh, chi');
    }

    landTheRoster();
    const box = await screen.findByLabelText('Thành viên');
    await waitFor(() => {
      expect((box as HTMLTextAreaElement).value).not.toBe('');
    });
    if (early === null) {
      await user.clear(box);
      await user.type(box, 'an, binh, chi');
    }

    await user.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => {
      expect(patch).toHaveBeenCalled();
    });
    const body = (patch.mock.calls[0]![1] as { body: { members: string[] } }).body;
    expect(body.members, 'the save carried the roster the form seeded over the typing').toEqual([
      'an',
      'binh',
      'chi',
    ]);
  });
});
