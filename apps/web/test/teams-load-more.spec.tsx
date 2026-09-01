/**
 * The teams panel can reach page two (D177).
 *
 * **The defect this pins.** `OrgTeams` used a plain `useQuery` and read
 * `.items`, so `nextCursor` — the only thing the API offers to reach the rest
 * of a school — went on the floor. The server's default page of twenty-five
 * therefore behaved as a hard CEILING: a school with forty-six teams (one on
 * the live judge has exactly that) rendered twenty-five and offered no way
 * onward, and the panel looked complete while it did it.
 *
 * A "load more" button by itself is not the assertion. The assertion is that
 * the second request carries the FIRST page's `nextCursor` — a button that
 * re-asks page one is the bug wearing the fix's clothes — and that both pages
 * end up on screen at once, which is what `useInfiniteQuery` buys over a
 * replace-the-page pager.
 */
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const { OrgTeams } = await import('../src/routes/teams.js');

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const ME = { username: 'co-giao', globalRole: 'user' };

function summary(slug: string) {
  return {
    slug,
    name: slug.toUpperCase(),
    orgSlug: 'thpt',
    orgName: 'THPT Chuyên',
    memberCount: 3,
    // Carried on the SUMMARY since D182 — the panel used to fetch these one
    // HTTP request per row.
    members: [{ username: 'an', displayName: 'An', joinedAt: '' }],
    createdAt: '',
    inRunningContest: false,
  };
}

/** Twenty-five rows and a cursor, then two rows and none — a 27-team school. */
function page(slugs: string[], nextCursor: string | null) {
  return { data: { items: slugs.map(summary), nextCursor }, response: { status: 200 } };
}

afterEach(() => {
  get.mockReset();
});

describe('the org teams panel past one page', () => {
  it('offers "load more" and sends the first page’s cursor to get the rest', async () => {
    const first = Array.from({ length: 25 }, (_, i) => `doi-${String(i + 1)}`);
    const second = ['doi-26', 'doi-27'];
    const cursors: (string | undefined)[] = [];

    get.mockImplementation((path: string, init?: Record<string, unknown>) => {
      if (path === '/auth/me') return Promise.resolve({ data: ME });
      if (path === '/orgs/{slug}/teams') {
        const params = init?.params as { query?: { cursor?: string } } | undefined;
        const cursor = params?.query?.cursor;
        cursors.push(cursor);
        return Promise.resolve(
          cursor === undefined ? page(first, '901') : page(second, null),
        );
      }
      // The per-row detail query the panel fires for names; irrelevant here.
      return Promise.resolve({ data: { members: [] }, response: { status: 200 } });
    });

    wrap(<OrgTeams slug="thpt" canManage />);
    expect(await screen.findByText('DOI-1')).toBeTruthy();
    expect(screen.queryByText('DOI-26')).toBeNull();

    const more = await screen.findByRole('button', { name: /tải thêm|load more/i });
    await userEvent.click(more);

    // The rest of the school arrives...
    expect(await screen.findByText('DOI-27')).toBeTruthy();
    // ...WITHOUT losing the first page, which is the whole point of appending.
    expect(screen.getByText('DOI-1')).toBeTruthy();
    // ...and it was asked for with the cursor the server issued, not page one
    // again.
    expect(cursors).toEqual([undefined, '901']);

    // Nothing left to fetch, so nothing left to offer.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /tải thêm|load more/i })).toBeNull();
    });
  });

  it('offers nothing when the school fits on one page', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/auth/me') return Promise.resolve({ data: ME });
      if (path === '/orgs/{slug}/teams') return Promise.resolve(page(['doi-1'], null));
      return Promise.resolve({ data: { members: [] }, response: { status: 200 } });
    });

    wrap(<OrgTeams slug="thpt" canManage />);
    expect(await screen.findByText('DOI-1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /tải thêm|load more/i })).toBeNull();
  });
});
