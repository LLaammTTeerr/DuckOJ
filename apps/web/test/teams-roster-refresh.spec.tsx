/**
 * A roster saved in the teams form has to appear on the panel that saved it
 * (F-42, found by `e2e/organiser.spec.ts` journey 2 against the live stack).
 *
 * `OrgTeams.refresh()` invalidated `['org-teams', slug]` — the SUMMARY list,
 * which carries a member COUNT and no names. The names on each row come from
 * `TeamMembers`, whose own query is keyed `['org-team', slug, teamSlug]`, and
 * TanStack Query matches invalidations by key PREFIX: `'org-teams'` and
 * `'org-team'` are different first elements, so that query was never
 * invalidated by anything. The same key backs the edit form's prefill.
 *
 * Two consequences, and the second is the serious one:
 *
 *  1. a teacher who adds a pupil sees the count go to 2 and the names stay at
 *     one, which reads as a save that half worked;
 *  2. re-opening the edit form prefills from that same stale cache — and
 *     `members` REPLACES the whole roster, which the form's own comment calls
 *     out as the dangerous case. So the next save writes the PRE-EDIT roster
 *     back and silently drops the pupil who was just added.
 *
 * Driven through the panel rather than asserted on a query key, because the
 * bug is not that a key was missing — it is that the screen lied.
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

afterEach(() => {
  get.mockReset();
  patch.mockReset();
});

describe('the teams panel after a roster edit', () => {
  it('shows the pupil who was just added, without a reload', async () => {
    // The server's state, mutated by the PATCH exactly as the real one is.
    let members = ['an'];
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
                memberCount: members.length,
                // The names ride on the SUMMARY since D182, so the list
                // invalidation is what puts a newly added pupil on screen.
                members: members.map((username) => ({
                  username,
                  displayName: username,
                  joinedAt: '',
                })),
                createdAt: '',
                inRunningContest: false,
              },
            ],
          },
          error: undefined,
        });
      }
      return Promise.resolve({
        data: {
          slug: 'doi-1',
          name: 'Đội 1',
          orgSlug: 'thpt',
          orgName: 'THPT Chuyên',
          inRunningContest: false,
          members: members.map((username) => ({ username, displayName: username })),
          contests: [],
        },
        error: undefined,
      });
    });
    patch.mockImplementation((_path: string, init: { body: { members: string[] } }) => {
      members = init.body.members;
      return Promise.resolve({ data: {}, error: undefined });
    });

    wrap(<OrgTeams slug="thpt" canManage />);
    await screen.findByRole('link', { name: 'an' });

    await userEvent.click(screen.getByRole('button', { name: 'Sửa' }));
    const box = await screen.findByLabelText('Thành viên');
    await waitFor(() => {
      expect(box).toHaveValue('an');
    });
    await userEvent.clear(box);
    await userEvent.type(box, 'an, binh');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }));

    expect(patch).toHaveBeenCalled();
    // The panel's own names, not the count beside them.
    expect(await screen.findByRole('link', { name: 'binh' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'an' })).toBeInTheDocument();
  });

  it('does not prefill the next edit with the roster it replaced', async () => {
    // The data loss. `members` REPLACES the whole roster, so an edit form
    // prefilled from a stale cache writes back the pupil list as it was
    // BEFORE the save the teacher just made.
    let members = ['an'];
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
                memberCount: members.length,
                // The names ride on the SUMMARY since D182, so the list
                // invalidation is what puts a newly added pupil on screen.
                members: members.map((username) => ({
                  username,
                  displayName: username,
                  joinedAt: '',
                })),
                createdAt: '',
                inRunningContest: false,
              },
            ],
          },
          error: undefined,
        });
      }
      return Promise.resolve({
        data: {
          slug: 'doi-1',
          name: 'Đội 1',
          orgSlug: 'thpt',
          orgName: 'THPT Chuyên',
          inRunningContest: false,
          members: members.map((username) => ({ username, displayName: username })),
          contests: [],
        },
        error: undefined,
      });
    });
    patch.mockImplementation((_path: string, init: { body: { members: string[] } }) => {
      members = init.body.members;
      return Promise.resolve({ data: {}, error: undefined });
    });

    wrap(<OrgTeams slug="thpt" canManage />);
    await screen.findByRole('link', { name: 'an' });

    await userEvent.click(screen.getByRole('button', { name: 'Sửa' }));
    const first = await screen.findByLabelText('Thành viên');
    await waitFor(() => {
      expect(first).toHaveValue('an');
    });
    await userEvent.clear(first);
    await userEvent.type(first, 'an, binh');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    await screen.findByRole('link', { name: 'binh' });

    // Straight back in, the way a teacher who has one more pupil to add does.
    await userEvent.click(screen.getByRole('button', { name: 'Sửa' }));
    const second = await screen.findByLabelText('Thành viên');
    await waitFor(() => {
      expect(second, 'the edit form was prefilled with the roster it replaced').toHaveValue(
        'an, binh',
      );
    });
  });
});
