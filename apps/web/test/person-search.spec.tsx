/**
 * The three screens that got a search box, and what each of them sends
 * (D185).
 *
 * F-49 recorded `GET /users?q=` as fully built server-side with **zero
 * callers**, and a five-thousand-pupil roster as two hundred presses of "load
 * more" to reach one pupil. This file pins the wiring, and the wiring is where
 * a search goes wrong in ways a screenshot cannot show:
 *
 *  - the term has to be in the QUERY KEY, or a search's cursor is carried into
 *    the unfiltered walk's seek and truncates it silently (D180);
 *  - the term has to reach the SERVER, because a client-side filter over the
 *    twenty-five rows already loaded is not a search of a school at all;
 *  - the team picker has to append through the same setter typing uses, or it
 *    reopens the silent-overwrite class D183 closed;
 *  - and the roster has to print the NAME it matched, or a teacher who
 *    searched `nguyen` is looking at a column of `hs000123` again.
 *
 * The fixtures use real Vietnamese names for the same reason the API spec
 * does: `displayName` and `username` differ in this product precisely because
 * one of them is a person's name and the other is a number D61 minted.
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

const { OrgPage } = await import('../src/routes/orgs.js');
const { OrgTeams } = await import('../src/routes/teams.js');
const { AdminPage } = await import('../src/routes/admin.js');

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const ME = { username: 'co-giao', globalRole: 'admin' };
const ORG = {
  id: 1,
  slug: 'thpt-chuyen',
  name: 'THPT Chuyên',
  about: null,
  visibility: 'public',
  joinPolicy: 'invite',
  myRole: 'owner',
  createdAt: '',
};

function member(username: string, displayName: string) {
  return { username, displayName, role: 'member', joinedAt: '' };
}

/** The whole school, and the two rows a search for `nguyen` answers. */
const ROSTER = [
  member('hs000001', 'Nguyễn Văn An'),
  member('hs000002', 'Nguyễn Thị Bình'),
  member('hs000003', 'Hoàng Thị Lan'),
];
const MATCHES = [ROSTER[0]!, ROSTER[1]!];

/** Enough of the operations dashboard for the admin page to render at all. */
const DASHBOARD = {
  queue: { queued: 0, running: 0, expiredLeases: 0, failed: 0, oldestQueuedSeconds: null },
  blockedJobs: [],
  judges: [],
  workers: [],
  recentFailures: [],
  refusalsLastHour: [],
  dependencies: { database: 'up', redis: 'up' },
  runtime: { apiWorkers: 4, judgedConcurrency: 1 },
  mail: {
    transport: 'smtp',
    configured: true,
    host: 'smtp.example',
    port: 587,
    secure: false,
    authenticated: true,
    from: 'DuckOJ <no-reply@duckoj.local>',
  },
  generatedAt: '2026-08-29T10:00:00Z',
};

afterEach(() => {
  get.mockReset();
  patch.mockReset();
});

describe('the org roster search (D185)', () => {
  it('sends `q` to the server and prints the name it matched', async () => {
    const asked: (string | undefined)[] = [];
    get.mockImplementation((path: string, init?: Record<string, unknown>) => {
      if (path === '/auth/me') return Promise.resolve({ data: ME });
      if (path === '/orgs/{slug}') return Promise.resolve({ data: ORG });
      if (path === '/orgs/{slug}/members') {
        const q = (init?.params as { query?: { q?: string } } | undefined)?.query?.q;
        asked.push(q);
        return Promise.resolve({
          data: { items: q === undefined ? ROSTER : MATCHES, nextCursor: null },
          response: { status: 200 },
        });
      }
      return Promise.resolve({ data: { items: [], nextCursor: null }, response: { status: 200 } });
    });

    wrap(<OrgPage slug="thpt-chuyen" />);
    // The roster arrives whole, and the display name rides beside the account
    // — the half of D185 that makes the answer readable.
    expect(await screen.findByText('Nguyễn Văn An')).toBeTruthy();
    expect(screen.getByText('Hoàng Thị Lan')).toBeTruthy();

    await userEvent.type(screen.getByLabelText(/tìm thành viên|find a member/i), 'nguyen');

    // The server was asked. A box that filtered the loaded page would leave
    // `asked` as `[undefined]` and still look right on screen.
    await waitFor(() => {
      expect(asked).toContain('nguyen');
    });
    await waitFor(() => {
      expect(screen.queryByText('Hoàng Thị Lan')).toBeNull();
    });
    expect(screen.getByText('Nguyễn Văn An')).toBeTruthy();
  });

  it('says nobody MATCHED, rather than that the school is empty', async () => {
    get.mockImplementation((path: string, init?: Record<string, unknown>) => {
      if (path === '/auth/me') return Promise.resolve({ data: ME });
      if (path === '/orgs/{slug}') return Promise.resolve({ data: ORG });
      if (path === '/orgs/{slug}/members') {
        const q = (init?.params as { query?: { q?: string } } | undefined)?.query?.q;
        return Promise.resolve({
          data: { items: q === undefined ? ROSTER : [], nextCursor: null },
          response: { status: 200 },
        });
      }
      return Promise.resolve({ data: { items: [], nextCursor: null }, response: { status: 200 } });
    });

    wrap(<OrgPage slug="thpt-chuyen" />);
    expect(await screen.findByText('Nguyễn Văn An')).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/tìm thành viên|find a member/i), 'khong-co-ai');

    // "No visible members", said to a teacher who has just mistyped a name, is
    // a claim about the school and it is false.
    expect(await screen.findByText(/khớp với|matches/i)).toBeTruthy();
  });
});

describe("the team form's roster picker (D185)", () => {
  it('searches the SCHOOL and appends the account it found to what is typed', async () => {
    const searched: (string | undefined)[] = [];
    get.mockImplementation((path: string, init?: Record<string, unknown>) => {
      if (path === '/auth/me') return Promise.resolve({ data: ME });
      if (path === '/orgs/{slug}/teams') {
        return Promise.resolve({ data: { items: [], nextCursor: null }, response: { status: 200 } });
      }
      if (path === '/orgs/{slug}/members') {
        const q = (init?.params as { query?: { q?: string } } | undefined)?.query?.q;
        searched.push(q);
        return Promise.resolve({ data: { items: MATCHES, nextCursor: null }, response: { status: 200 } });
      }
      return Promise.resolve({ data: { items: [], nextCursor: null }, response: { status: 200 } });
    });

    wrap(<OrgTeams slug="thpt-chuyen" canManage />);
    await userEvent.click(await screen.findByRole('button', { name: /lập đội|assemble a team/i }));

    const box = screen.getByRole('textbox', { name: /thành viên|members/i });
    await userEvent.type(box, 'hs000009');

    await userEvent.type(screen.getByLabelText(/tìm học sinh|find a pupil/i), 'nguyen');
    await waitFor(() => {
      // The org roster, not `GET /users`: a teammate must already be in this
      // school, so a picker over the whole judge would offer people the save
      // is about to refuse.
      expect(searched).toContain('nguyen');
    });

    await userEvent.click(await screen.findByRole('button', { name: /Nguyễn Văn An/ }));

    // APPENDED. `members` replaces the whole roster on save, so a picker that
    // overwrote the box would be D183's data loss wearing a convenience.
    expect((box as HTMLTextAreaElement).value).toBe('hs000009, hs000001');

    // And picking the same person twice is not two seats.
    await userEvent.click(screen.getByRole('button', { name: /Nguyễn Văn An/ }));
    expect((box as HTMLTextAreaElement).value).toBe('hs000009, hs000001');
  });
});

describe('the admin account lookup (D185)', () => {
  it('is the first caller `GET /users?q=` has ever had, and it fills the box', async () => {
    const searched: (string | undefined)[] = [];
    get.mockImplementation((path: string, init?: Record<string, unknown>) => {
      if (path === '/auth/me') return Promise.resolve({ data: ME });
      if (path === '/users') {
        const q = (init?.params as { query?: { q?: string } } | undefined)?.query?.q;
        searched.push(q);
        return Promise.resolve({
          data: {
            items: [
              {
                id: 1,
                username: 'hs000001',
                displayName: 'Nguyễn Văn An',
                globalRole: 'user',
                country: null,
                rating: null,
                maxRating: null,
                createdAt: '',
              },
            ],
            nextCursor: null,
          },
          response: { status: 200 },
        });
      }
      if (path === '/admin/dashboard') {
        return Promise.resolve({ data: DASHBOARD, response: { status: 200 } });
      }
      return Promise.resolve({ data: { items: [], nextCursor: null }, response: { status: 200 } });
    });

    wrap(<AdminPage />);
    const box = await screen.findByLabelText(/tìm tài khoản|find an account/i);
    await userEvent.type(box, 'nguyen');
    await waitFor(() => {
      expect(searched).toContain('nguyen');
    });

    await userEvent.click(await screen.findByRole('button', { name: /Nguyễn Văn An/ }));
    // The username box is FILLED, not bypassed: the dangerous verbs on this
    // screen still read the field they always read, and an admin who knows
    // the username still types it.
    expect((screen.getAllByRole('textbox', { name: /tên đăng nhập|username/i })[0] as HTMLInputElement).value).toBe(
      'hs000001',
    );
  });
});
